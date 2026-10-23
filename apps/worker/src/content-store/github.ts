import { TextDecoder } from "node:util";
import type {
  ContentFile,
  ContentRef,
  ContentStore,
  ResearchIngressStore,
  FinalizeRequest,
  ListPendingOptions,
  PendingPage,
  TransitionRequest,
  TransitionResult,
} from "./port.js";
import { ContentStoreError } from "./port.js";

const FILE_NAME = "[a-zA-Z0-9][a-zA-Z0-9._-]*\\.md";
const INBOX = new RegExp(`^inbox/(${FILE_NAME})$`);
const REJECTED = new RegExp(`^rejected/(${FILE_NAME})$`);
const NOTES = new RegExp(`^notes/[0-9]{4}/(0[1-9]|1[0-2])/(${FILE_NAME})$`);
// Research JSON is not Markdown v1 and is never finalized or rejected as a note.
const RESEARCH =
  /^research\/inbox\/(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/;
const MAX_RESEARCH_BYTES = 250_000;
const BLOB_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_ATTEMPTS = 4;

type PathKind = "inbox" | "notes" | "any";
interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}
interface Snapshot {
  head: string;
  tree: string;
  entries: Map<string, TreeEntry>;
}

export interface GitHubContentStoreOptions {
  /** Exactly owner/repo, never a URL containing credentials. */
  repository: string;
  branch: string;
  /** Server-side token. Never log, serialize or pass to a browser client. */
  token: string;
  fetch?: typeof fetch;
  /** Injected for deterministic rate-limit tests. */
  sleep?: (milliseconds: number) => Promise<void>;
}

function fail(code: ConstructorParameters<typeof ContentStoreError>[0]): never {
  const messages = {
    INVALID_PATH: "Content path is not permitted.",
    INVALID_CURSOR: "Pending cursor is invalid.",
    INVALID_LIMIT: "Pending page limit is invalid.",
    NOT_FOUND: "Content entry is missing.",
    REVISION_CONFLICT: "Source revision changed; re-read before retrying.",
    DESTINATION_CONFLICT: "Destination already contains different content.",
    UNSAFE_ENTRY: "Content entry has an unsupported Git object type.",
    INVALID_CONTENT: "Content must be valid UTF-8 within the size limit.",
    PERMISSION_DENIED: "GitHub content access was denied.",
    IO_ERROR: "GitHub content operation failed.",
  };
  throw new ContentStoreError(code, messages[code]);
}

function assertPath(path: string, kind: PathKind = "any"): void {
  const valid =
    typeof path === "string" &&
    !path.includes("\\") &&
    (kind === "inbox"
      ? INBOX.test(path)
      : kind === "notes"
        ? NOTES.test(path)
        : INBOX.test(path) || NOTES.test(path) || REJECTED.test(path));
  if (!valid || path.split("/").some((part) => part.startsWith("."))) {
    fail("INVALID_PATH");
  }
  const name = path.split("/").at(-1)?.split(".")[0];
  if (name && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    fail("INVALID_PATH");
  }
}

function assertSha(sha: string): void {
  if (typeof sha !== "string" || !BLOB_SHA.test(sha)) fail("REVISION_CONFLICT");
}

function decodeContent(base64: string, advertisedSize: number): string {
  if (
    !Number.isSafeInteger(advertisedSize) ||
    advertisedSize < 0 ||
    advertisedSize > MAX_FILE_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    )
  ) {
    fail("INVALID_CONTENT");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== advertisedSize || bytes.length > MAX_FILE_BYTES) {
    fail("INVALID_CONTENT");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("INVALID_CONTENT");
  }
}

class BranchMoved extends Error {}

export class GitHubContentStore implements ContentStore, ResearchIngressStore {
  private readonly root: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly http: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: GitHubContentStoreOptions) {
    const [owner, repo, ...extra] = options.repository.split("/");
    if (
      extra.length !== 0 ||
      !owner ||
      !repo ||
      !/^[A-Za-z0-9-]+$/.test(owner) ||
      !/^[A-Za-z0-9._-]+$/.test(repo) ||
      repo.startsWith(".") ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.branch) ||
      options.branch.includes("..") ||
      options.branch.includes("//") ||
      options.branch.endsWith("/") ||
      options.branch.endsWith(".") ||
      options.branch.split("/").some((part) => part.startsWith(".")) ||
      !options.token ||
      !options.token.trim()
    ) {
      fail("INVALID_PATH");
    }
    this.root = `https://api.github.com/repos/${owner}/${repo}`;
    this.branch = options.branch;
    this.token = options.token;
    this.http = options.fetch ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private async request(
    endpoint: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.http(`${this.root}${endpoint}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        if (attempt === MAX_ATTEMPTS - 1) fail("IO_ERROR");
        await this.sleep(50 * 2 ** attempt);
        continue;
      }
      if (response.status === 409 || response.status === 422) {
        if (method === "PATCH") throw new BranchMoved();
        fail("IO_ERROR");
      }
      if (response.status === 404) fail("NOT_FOUND");
      const rateLimited =
        response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after"));
      if (
        response.status === 401 ||
        (response.status === 403 && !rateLimited)
      ) {
        fail("PERMISSION_DENIED");
      }
      const transient =
        response.status === 429 || response.status >= 500 || rateLimited;
      if (transient) {
        if (attempt === MAX_ATTEMPTS - 1) fail("IO_ERROR");
        const retryAfter = Number(response.headers.get("retry-after"));
        const seconds =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 2)
            : 0;
        await this.sleep(seconds > 0 ? seconds * 1000 : 50 * 2 ** attempt);
        continue;
      }
      if (!response.ok) fail("IO_ERROR");
      try {
        const json: unknown = await response.json();
        if (json && typeof json === "object" && !Array.isArray(json)) {
          return json as Record<string, unknown>;
        }
      } catch {
        // Do not include response bodies (they could contain sensitive data).
      }
      fail("IO_ERROR");
    }
    return fail("IO_ERROR");
  }

  private async snapshot(): Promise<Snapshot> {
    const ref = await this.request(`/git/ref/heads/${this.branch}`);
    const head = (ref.object as { sha?: unknown } | undefined)?.sha;
    if (typeof head !== "string" || !BLOB_SHA.test(head)) fail("IO_ERROR");
    const commit = await this.request(`/git/commits/${head}`);
    const tree = (commit.tree as { sha?: unknown } | undefined)?.sha;
    if (typeof tree !== "string" || !BLOB_SHA.test(tree)) fail("IO_ERROR");
    const listing = await this.request(`/git/trees/${tree}?recursive=1`);
    if (
      listing.truncated === true ||
      !Array.isArray(listing.tree) ||
      listing.tree.length > MAX_ENTRIES
    ) {
      fail("IO_ERROR");
    }
    const entries = new Map<string, TreeEntry>();
    for (const raw of listing.tree) {
      if (!raw || typeof raw !== "object") fail("IO_ERROR");
      const entry = raw as TreeEntry;
      if (
        typeof entry.path !== "string" ||
        typeof entry.sha !== "string" ||
        typeof entry.type !== "string" ||
        typeof entry.mode !== "string"
      ) {
        fail("IO_ERROR");
      }
      entries.set(entry.path, entry);
    }
    return { head, tree, entries };
  }

  private entry(snapshot: Snapshot, path: string): TreeEntry | undefined {
    const entry = snapshot.entries.get(path);
    if (entry) {
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !BLOB_SHA.test(entry.sha)
      ) {
        fail("UNSAFE_ENTRY");
      }
      if (
        entry.size !== undefined &&
        (!Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          entry.size > MAX_FILE_BYTES)
      ) {
        fail("INVALID_CONTENT");
      }
    }
    return entry;
  }

  async verifyPrivateRepository(): Promise<void> {
    if ((await this.request("")).private !== true) fail("PERMISSION_DENIED");
  }

  async listPending(options: ListPendingOptions = {}): Promise<PendingPage> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      fail("INVALID_LIMIT");
    }
    if (options.cursor !== undefined) {
      try {
        assertPath(options.cursor, "inbox");
      } catch {
        fail("INVALID_CURSOR");
      }
    }
    const snapshot = await this.snapshot();
    const paths = [...snapshot.entries.keys()]
      .filter((path) => INBOX.test(path))
      .sort()
      .filter((path) => options.cursor === undefined || path > options.cursor);
    const selected = paths.slice(0, limit);
    const files: ContentRef[] = selected.map((path) => {
      assertPath(path, "inbox");
      return { path, revision: this.entry(snapshot, path)!.sha };
    });
    return paths.length > selected.length && selected.length > 0
      ? { files, nextCursor: selected[selected.length - 1]! }
      : { files };
  }

  /** Read-only, independently allowlisted research inbox. No content moves. */
  async listResearch(options: ListPendingOptions = {}): Promise<PendingPage> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_LIMIT");
    if (options.cursor !== undefined && !RESEARCH.test(options.cursor))
      fail("INVALID_CURSOR");
    const snapshot = await this.snapshot();
    const paths = [...snapshot.entries.keys()]
      .filter((path) => RESEARCH.test(path))
      .sort()
      .filter((path) => options.cursor === undefined || path > options.cursor);
    const selected = paths.slice(0, limit);
    const files = selected.map((path) => ({
      path,
      revision: this.entry(snapshot, path)!.sha,
    }));
    return paths.length > selected.length && selected.length > 0
      ? { files, nextCursor: selected[selected.length - 1]! }
      : { files };
  }

  async readResearch(path: string): Promise<ContentFile> {
    if (!RESEARCH.test(path)) fail("INVALID_PATH");
    // GET Contents resolves the CURRENT branch path in one HTTP call. The
    // importer compares its SHA to the scan's observed SHA before DB write.
    const file = await this.request(
      `/contents/${path}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (
      file.type !== "file" ||
      typeof file.sha !== "string" ||
      !BLOB_SHA.test(file.sha)
    )
      fail("UNSAFE_ENTRY");
    if (
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      typeof file.size !== "number" ||
      file.size > MAX_RESEARCH_BYTES
    )
      fail("INVALID_CONTENT");
    const content = decodeContent(file.content.replace(/\s/g, ""), file.size);
    if (Buffer.byteLength(content, "utf8") > MAX_RESEARCH_BYTES)
      fail("INVALID_CONTENT");
    return { path, revision: file.sha, content };
  }

  async stat(path: string): Promise<ContentRef | null> {
    assertPath(path);
    const entry = this.entry(await this.snapshot(), path);
    return entry ? { path, revision: entry.sha } : null;
  }

  async read(path: string): Promise<ContentFile> {
    assertPath(path);
    const entry = this.entry(await this.snapshot(), path);
    if (!entry) fail("NOT_FOUND");
    const blob = await this.request(`/git/blobs/${entry.sha}`);
    if (
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      typeof blob.size !== "number"
    ) {
      fail("INVALID_CONTENT");
    }
    const content = decodeContent(blob.content.replace(/\s/g, ""), blob.size);
    return { path, revision: entry.sha, content };
  }

  async finalize(request: FinalizeRequest): Promise<TransitionResult> {
    assertPath(request.destinationPath, "notes");
    return this.transition(request, request.destinationPath);
  }

  async reject(request: TransitionRequest): Promise<TransitionResult> {
    assertPath(request.sourcePath, "inbox");
    const destinationPath = `rejected/${request.sourcePath.slice(6)}`;
    assertPath(destinationPath);
    return this.transition(request, destinationPath);
  }

  private async transition(
    request: TransitionRequest,
    destinationPath: string,
  ): Promise<TransitionResult> {
    assertPath(request.sourcePath, "inbox");
    assertSha(request.expectedRevision);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const snapshot = await this.snapshot();
      const source = this.entry(snapshot, request.sourcePath);
      const destination = this.entry(snapshot, destinationPath);
      if (!source) {
        if (destination?.sha === request.expectedRevision) {
          return {
            path: destinationPath,
            revision: request.expectedRevision,
            status: "already_finalized",
          };
        }
        fail("NOT_FOUND");
      }
      if (source.sha !== request.expectedRevision) fail("REVISION_CONFLICT");
      if (destination && destination.sha !== request.expectedRevision) {
        fail("DESTINATION_CONFLICT");
      }
      const status = destination ? "recovered" : "moved";
      try {
        const newTree = await this.request("/git/trees", "POST", {
          base_tree: snapshot.tree,
          tree: [
            {
              path: destinationPath,
              mode: "100644",
              type: "blob",
              sha: request.expectedRevision,
            },
            {
              path: request.sourcePath,
              mode: "100644",
              type: "blob",
              sha: null,
            },
          ],
        });
        if (typeof newTree.sha !== "string" || !BLOB_SHA.test(newTree.sha)) {
          fail("IO_ERROR");
        }
        const commit = await this.request("/git/commits", "POST", {
          message: "chore(content): transition pending Markdown",
          tree: newTree.sha,
          parents: [snapshot.head],
        });
        if (typeof commit.sha !== "string" || !BLOB_SHA.test(commit.sha)) {
          fail("IO_ERROR");
        }
        await this.request(`/git/refs/heads/${this.branch}`, "PATCH", {
          sha: commit.sha,
          force: false,
        });
        return { path: destinationPath, revision: source.sha, status };
      } catch (error) {
        if (!(error instanceof BranchMoved)) throw error;
      }
    }
    return fail("REVISION_CONFLICT");
  }
}

/** Never call this in browsers or public PR CI with a real secret. */
export function githubContentStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  http?: typeof fetch,
): GitHubContentStore {
  const repository = env.CONTENT_REPOSITORY;
  const branch = env.CONTENT_BRANCH;
  const token = env.CONTENT_GITHUB_TOKEN;
  if (!repository || !branch || !token) fail("PERMISSION_DENIED");
  return new GitHubContentStore({
    repository,
    branch,
    token,
    ...(http ? { fetch: http } : {}),
  });
}
