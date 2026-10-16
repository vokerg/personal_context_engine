import { parseNoteMarkdown, type Note } from "@pce/core";
import type { ChatContextInput } from "./capture.js";

type Result = {
  status: "created" | "already_saved";
  path: string;
  noteId: string;
};
type Entry = { path: string; sha: string; mode: string; type: string };
type Snapshot = { head: string; treeSha: string; entries: Entry[] };
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export class ChatContextStorageError extends Error {
  constructor(
    public readonly code:
      | "CONFIGURATION"
      | "PERMISSION"
      | "NOT_PRIVATE"
      | "CONFLICT"
      | "RETRYABLE"
      | "FAILED",
  ) {
    super(code);
  }
}

export interface ChatContextWriterOptions {
  repository: string;
  branch: string;
  token: string;
  fetch?: typeof fetch;
}

export class GitHubChatContextWriter {
  private readonly api: string;
  private readonly token: string;
  private readonly branch: string;
  private readonly http: typeof fetch;

  constructor(options: ChatContextWriterOptions) {
    if (
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.repository) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.branch) ||
      options.branch.includes("..") ||
      options.branch.includes("//") ||
      options.branch.split("/").some((part) => part.startsWith(".")) ||
      !options.token?.trim()
    )
      throw new ChatContextStorageError("CONFIGURATION");
    this.api = "https://api.github.com/repos/" + options.repository;
    this.token = options.token;
    this.branch = options.branch;
    this.http = options.fetch ?? fetch;
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.http(this.api + path, {
        method,
        headers: {
          Authorization: "Bearer " + this.token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ChatContextStorageError("RETRYABLE");
    }
    if (response.status === 401 || response.status === 403)
      throw new ChatContextStorageError("PERMISSION");
    if ([409, 422, 429].includes(response.status) || response.status >= 500) {
      throw new ChatContextStorageError("RETRYABLE");
    }
    if (!response.ok) throw new ChatContextStorageError("FAILED");
    try {
      const value: unknown = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // Never expose provider response text or secrets in error messages.
    }
    throw new ChatContextStorageError("FAILED");
  }

  private async assertPrivate(): Promise<void> {
    const repo = await this.request("");
    if (
      repo.private !== true ||
      repo.archived === true ||
      repo.disabled === true
    ) {
      throw new ChatContextStorageError("NOT_PRIVATE");
    }
  }

  private async snapshot(): Promise<Snapshot> {
    const ref = await this.request("/git/ref/heads/" + this.branch);
    const head = (ref.object as { sha?: unknown } | undefined)?.sha;
    if (typeof head !== "string" || !SHA.test(head))
      throw new ChatContextStorageError("FAILED");
    const commit = await this.request("/git/commits/" + head);
    const treeSha = (commit.tree as { sha?: unknown } | undefined)?.sha;
    if (typeof treeSha !== "string" || !SHA.test(treeSha))
      throw new ChatContextStorageError("FAILED");
    const tree = await this.request("/git/trees/" + treeSha + "?recursive=1");
    if (
      tree.truncated !== false ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > 100_000
    ) {
      throw new ChatContextStorageError("FAILED");
    }
    const entries: Entry[] = [];
    for (const entry of tree.tree) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new ChatContextStorageError("FAILED");
      const item = entry as Partial<Entry>;
      if (
        typeof item.path !== "string" ||
        typeof item.sha !== "string" ||
        !SHA.test(item.sha) ||
        typeof item.mode !== "string" ||
        typeof item.type !== "string"
      ) {
        throw new ChatContextStorageError("FAILED");
      }
      entries.push(item as Entry);
    }
    return { head, treeSha, entries };
  }

  private async matchingExisting(
    entries: Entry[],
    input: ChatContextInput,
    note: Note,
  ): Promise<Result | null> {
    const suffix = "/" + note.metadata.id + ".md";
    const inboxSuffix = "_" + note.metadata.id + ".md";
    const matches = entries.filter(
      (entry) =>
        (entry.path.startsWith("inbox/") && entry.path.endsWith(inboxSuffix)) ||
        (entry.path.startsWith("notes/") && entry.path.endsWith(suffix)),
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new ChatContextStorageError("CONFLICT");
    const match = matches[0]!;
    if (match.type !== "blob" || match.mode !== "100644")
      throw new ChatContextStorageError("CONFLICT");
    const blob = await this.request("/git/blobs/" + match.sha);
    if (
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      typeof blob.size !== "number" ||
      blob.size > 1024 * 1024
    )
      throw new ChatContextStorageError("FAILED");
    let existing: Note;
    try {
      const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      if (bytes.byteLength !== blob.size) throw new Error("size mismatch");
      existing = parseNoteMarkdown(bytes);
    } catch {
      throw new ChatContextStorageError("CONFLICT");
    }
    if (
      existing.metadata.id !== note.metadata.id ||
      existing.metadata.capture_id !== note.metadata.capture_id ||
      existing.metadata.title !== note.metadata.title ||
      existing.metadata.kind !== "memo" ||
      existing.metadata.source !== "chatgpt_text" ||
      existing.metadata.tags.length !== 2 ||
      existing.metadata.tags[0] !== "chat-context" ||
      existing.metadata.tags[1] !== input.mode ||
      existing.metadata.review_required !== (input.mode === "brief") ||
      existing.metadata.action_hint !== "none" ||
      existing.body !== note.body ||
      existing.summary !== note.summary ||
      existing.originalInput !== input.source_text
    )
      throw new ChatContextStorageError("CONFLICT");
    return {
      status: "already_saved",
      path: match.path,
      noteId: note.metadata.id,
    };
  }

  /** Safe against concurrent updates: compares branch head and retries create-only. */
  async save(
    input: ChatContextInput,
    note: Note,
    path: string,
    markdown: string,
  ): Promise<Result> {
    await this.assertPrivate();
    if (
      !path.startsWith("inbox/") ||
      path.includes("..") ||
      path !==
        "inbox/" +
          note.metadata.captured_at.slice(0, 10) +
          "_" +
          note.metadata.id +
          ".md"
    ) {
      throw new ChatContextStorageError("CONFIGURATION");
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.snapshot();
      const existing = await this.matchingExisting(
        snapshot.entries,
        input,
        note,
      );
      if (existing) return existing;
      if (snapshot.entries.some((entry) => entry.path === path))
        throw new ChatContextStorageError("CONFLICT");
      const blob = await this.request("/git/blobs", "POST", {
        content: Buffer.from(markdown, "utf8").toString("base64"),
        encoding: "base64",
      });
      if (typeof blob.sha !== "string" || !SHA.test(blob.sha))
        throw new ChatContextStorageError("FAILED");
      const tree = await this.request("/git/trees", "POST", {
        base_tree: snapshot.treeSha,
        tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
      });
      if (typeof tree.sha !== "string" || !SHA.test(tree.sha))
        throw new ChatContextStorageError("FAILED");
      const commit = await this.request("/git/commits", "POST", {
        message: "chore(content): capture ChatGPT conversation context",
        tree: tree.sha,
        parents: [snapshot.head],
      });
      if (typeof commit.sha !== "string" || !SHA.test(commit.sha))
        throw new ChatContextStorageError("FAILED");
      try {
        await this.request("/git/refs/heads/" + this.branch, "PATCH", {
          sha: commit.sha,
          force: false,
        });
        return { status: "created", path, noteId: note.metadata.id };
      } catch (error) {
        if (
          !(error instanceof ChatContextStorageError) ||
          error.code !== "RETRYABLE"
        )
          throw error;
      }
    }
    throw new ChatContextStorageError("RETRYABLE");
  }
}
