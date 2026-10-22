import { createHash } from "node:crypto";

/** The only path this adapter can write. Never reuse the note content store. */
export const APPROVED_TAGS_PATH = "taxonomy/approved-tags.json";
export type ApprovedTagSnapshot = {
  schema_version: 1;
  revision: number;
  tags: Array<{
    slug: string;
    display_name: string | null;
    description: string | null;
  }>;
};

export type SnapshotPublishErrorCode =
  | "INVALID_CONFIG"
  | "NOT_PRIVATE"
  | "PERMISSION_DENIED"
  | "REMOTE_CONFLICT"
  | "REMOTE_INVALID"
  | "UNAVAILABLE";
export class SnapshotPublishError extends Error {
  constructor(public readonly code: SnapshotPublishErrorCode) {
    super(code);
    this.name = "SnapshotPublishError";
  }
}

const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function serializeApprovedTags(snapshot: ApprovedTagSnapshot): string {
  if (
    snapshot.schema_version !== 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    snapshot.tags.length > 200
  ) throw new SnapshotPublishError("REMOTE_INVALID");
  let last = "";
  for (const tag of snapshot.tags) {
    if (
      !SLUG.test(tag.slug) || tag.slug.length > 64 ||
      (last && tag.slug <= last) ||
      (tag.display_name !== null &&
        (tag.display_name.length === 0 || tag.display_name.length > 120)) ||
      (tag.description !== null && tag.description.length > 500)
    ) throw new SnapshotPublishError("REMOTE_INVALID");
    last = tag.slug;
  }
  return JSON.stringify(snapshot, null, 2) + "\n";
}

export interface SnapshotPublisherConfig {
  repository: string;
  branch: string;
  token: string;
  http?: typeof fetch;
}

/** Dedicated token, explicit opt-in, no shared capture-agent credential. */
export function snapshotPublisherConfig(env: NodeJS.ProcessEnv = process.env): SnapshotPublisherConfig | null {
  if (env.PCE_TAG_SNAPSHOT_ENABLED !== "true") {
    if (env.PCE_TAG_SNAPSHOT_ENABLED && env.PCE_TAG_SNAPSHOT_ENABLED !== "false")
      throw new SnapshotPublishError("INVALID_CONFIG");
    return null;
  }
  if (env.PCE_TAG_SNAPSHOT_ALLOW_WRITES !== "I_VERIFIED_PRIVATE_REPOSITORY")
    throw new SnapshotPublishError("INVALID_CONFIG");
  const repository = env.PCE_TAG_SNAPSHOT_REPOSITORY ?? "";
  const branch = env.PCE_TAG_SNAPSHOT_BRANCH ?? "main";
  const token = env.PCE_TAG_SNAPSHOT_TOKEN ?? "";
  if (
    !REPO.test(repository) || !BRANCH.test(branch) ||
    branch.includes("..") || branch.includes("//") ||
    branch.endsWith("/") || branch.endsWith(".") ||
    branch.split("/").some((part) => part.startsWith(".")) ||
    !token.trim()
  ) throw new SnapshotPublishError("INVALID_CONFIG");
  return { repository, branch, token };
}

type Result = { hash: string; changed: boolean };
export function createApprovedTagsPublisher(config: SnapshotPublisherConfig) {
  if (!REPO.test(config.repository) || !BRANCH.test(config.branch) || !config.token.trim())
    throw new SnapshotPublishError("INVALID_CONFIG");
  const base = `https://api.github.com/repos/${config.repository}`;
  const contents = `/contents/${APPROVED_TAGS_PATH}?ref=${encodeURIComponent(config.branch)}`;
  const http = config.http ?? fetch;

  async function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; value: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await http(base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + config.token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SnapshotPublishError("UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403)
      throw new SnapshotPublishError("PERMISSION_DENIED");
    if ([409, 422].includes(response.status))
      throw new SnapshotPublishError("REMOTE_CONFLICT");
    if (response.status !== 404 && !response.ok)
      throw new SnapshotPublishError("UNAVAILABLE");
    let raw: string;
    try {
      raw = await response.text();
      if (raw.length > 90000) throw new Error("Too large");
      return { status: response.status, value: JSON.parse(raw) as Record<string, unknown> };
    } catch {
      if (response.status === 404) return { status: 404, value: {} };
      throw new SnapshotPublishError("REMOTE_INVALID");
    }
  }

  async function readRemote(): Promise<{ content: string; sha: string } | null> {
    const found = await request(contents);
    if (found.status === 404) return null;
    const { sha, content, encoding, size, type } = found.value;
    if (
      type !== "file" || typeof sha !== "string" || !SHA.test(sha) ||
      encoding !== "base64" || typeof content !== "string" ||
      typeof size !== "number" || size > 65536 || size < 0
    ) throw new SnapshotPublishError("REMOTE_INVALID");
    try {
      const bytes = Buffer.from(content.replace(/\s/g, ""), "base64");
      if (bytes.length !== size) throw new Error("Size mismatch");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const json = JSON.parse(decoded) as Record<string, unknown>;
      if (
        json.schema_version !== 1 ||
        !Number.isSafeInteger(json.revision) ||
        typeof json.revision !== "number" || json.revision < 0 ||
        !Array.isArray(json.tags)
      ) throw new Error("Invalid remote contract");
      return { content: decoded, sha };
    } catch {
      throw new SnapshotPublishError("REMOTE_INVALID");
    }
  }

  return {
    async publish(snapshot: ApprovedTagSnapshot): Promise<Result> {
      const text = serializeApprovedTags(snapshot);
      const hash = createHash("sha256").update(text).digest("hex");
      const metadata = await request("");
      if (
        metadata.value.private !== true ||
        metadata.value.full_name !== config.repository ||
        metadata.value.archived === true
      ) throw new SnapshotPublishError("NOT_PRIVATE");
      const current = await readRemote();
      if (current) {
        if (current.content === text) return { hash, changed: false };
        const previous = JSON.parse(current.content) as { revision: number };
        if (previous.revision >= snapshot.revision)
          throw new SnapshotPublishError("REMOTE_CONFLICT");
      }
      // GitHub Contents API uses the exact previous blob SHA as a CAS token.
      await request(`/contents/${APPROVED_TAGS_PATH}`, "PUT", {
        message: "chore(taxonomy): publish owner-approved tags",
        branch: config.branch,
        content: Buffer.from(text, "utf8").toString("base64"),
        ...(current ? { sha: current.sha } : {}),
      });
      const verified = await readRemote();
      if (!verified || verified.content !== text)
        throw new SnapshotPublishError("REMOTE_CONFLICT");
      return { hash, changed: true };
    },
  };
}
