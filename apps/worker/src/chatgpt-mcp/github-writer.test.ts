import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildChatContextNote, type ChatContextInput } from "./capture.js";
import { GitHubChatContextWriter } from "./github-writer.js";

const hash = (x: string) => createHash("sha1").update(x).digest("hex");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const input: ChatContextInput = {
  request_id: "44444444-5555-4666-8777-888888888888",
  mode: "brief",
  title: "Synthetic brainstorming",
  summary: "A fictional experiment was proposed.",
  source_text: "What if a made-up engine kept simple synthetic logs?",
};
type TreeFile = { sha: string; mode: string; type: string; path: string };
class FakeGitHub {
  private readonly blobs = new Map<string, string>();
  private readonly trees = new Map<string, TreeFile[]>();
  private readonly commits = new Map<
    string,
    { tree: string; parent: string | null }
  >();
  head: string;
  privateRepo = true;
  forbidden = false;
  conflictOnce = false;
  writes = 0;

  constructor() {
    const tree = hash("initial tree");
    this.trees.set(tree, []);
    this.head = this.commit(tree, null);
  }
  private commit(tree: string, parent: string | null) {
    const sha = hash(tree + (parent ?? ""));
    this.commits.set(sha, { tree, parent });
    return sha;
  }
  files(): TreeFile[] {
    return this.trees.get(this.commits.get(this.head)!.tree)!;
  }
  read(path: string): string | undefined {
    const file = this.files().find((entry) => entry.path === path);
    return file ? this.blobs.get(file.sha) : undefined;
  }
  writer() {
    return new GitHubChatContextWriter({
      repository: "owner/private-content",
      branch: "main",
      token: "synthetic-test-token",
      fetch: this.fetch,
    });
  }
  fetch: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname;
    const method = init?.method ?? "GET";
    if (
      u.origin !== "https://api.github.com" ||
      !path.startsWith("/repos/owner/private-content")
    )
      return json({}, 404);
    if (
      new Headers(init?.headers).get("authorization") !==
        "Bearer synthetic-test-token" ||
      this.forbidden
    )
      return json({}, 403);
    if (path === "/repos/owner/private-content" && method === "GET")
      return json({ private: this.privateRepo, archived: false });
    if (path.endsWith("/git/ref/heads/main") && method === "GET")
      return json({ object: { sha: this.head } });
    if (path.includes("/git/commits/") && method === "GET") {
      const c = this.commits.get(path.split("/").at(-1)!);
      return c ? json({ tree: { sha: c.tree } }) : json({}, 404);
    }
    if (path.includes("/git/trees/") && method === "GET") {
      const t = this.trees.get(path.split("/").at(-1)!);
      return t ? json({ truncated: false, tree: t }) : json({}, 404);
    }
    if (path.includes("/git/blobs/") && method === "GET") {
      const text = this.blobs.get(path.split("/").at(-1)!);
      return text === undefined
        ? json({}, 404)
        : json({
            encoding: "base64",
            size: Buffer.byteLength(text),
            content: Buffer.from(text).toString("base64"),
          });
    }
    const body = JSON.parse(String(init?.body)) as {
      content: string;
      base_tree: string;
      tree: TreeFile[];
      parents: string[];
      sha: string;
      force: boolean;
    };
    if (path.endsWith("/git/blobs") && method === "POST") {
      const raw = Buffer.from(body.content, "base64").toString("utf8");
      const sha = hash(raw);
      this.blobs.set(sha, raw);
      return json({ sha }, 201);
    }
    if (path.endsWith("/git/trees") && method === "POST") {
      const prior = this.trees.get(body.base_tree);
      if (!prior) return json({}, 422);
      const next = [...prior, ...body.tree];
      const sha = hash(JSON.stringify(next));
      this.trees.set(sha, next);
      return json({ sha }, 201);
    }
    if (path.endsWith("/git/commits") && method === "POST") {
      return json({ sha: this.commit(body.tree, body.parents[0]) }, 201);
    }
    if (path.endsWith("/git/refs/heads/main") && method === "PATCH") {
      if (this.conflictOnce) {
        this.conflictOnce = false;
        const current = this.commits.get(this.head)!;
        const newTree = hash("unrelated");
        this.trees.set(newTree, [...this.trees.get(current.tree)!]);
        this.head = this.commit(newTree, this.head);
      }
      const next = this.commits.get(body.sha);
      if (!next || next.parent !== this.head || body.force)
        return json({}, 422);
      this.head = body.sha;
      this.writes++;
      return json({ object: { sha: this.head } });
    }
    return json({}, 404);
  };
}
const artifact = (x = input) =>
  buildChatContextNote(x, "2026-10-16T19:33:00.000Z");
const save = (fake: FakeGitHub, x = input) => {
  const a = artifact(x);
  return fake.writer().save(x, a.note, a.path, a.markdown);
};

describe("private GitHub create-only ChatGPT capture", () => {
  it("saves validated Markdown, idempotently replays, and never overwrites", async () => {
    const fake = new FakeGitHub();
    const created = await save(fake);
    expect(created.status).toBe("created");
    expect(created.path).toBe(artifact().path);
    expect(fake.read(created.path)).toBe(artifact().markdown);
    expect((await save(fake)).status).toBe("already_saved");
    expect(fake.writes).toBe(1);
    await expect(
      save(fake, { ...input, summary: "Different intent." }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.read(created.path)).toBe(artifact().markdown);
  });
  it("refuses a public repository before any write, and rejects denied access", async () => {
    const fake = new FakeGitHub();
    fake.privateRepo = false;
    await expect(save(fake)).rejects.toMatchObject({ code: "NOT_PRIVATE" });
    expect(fake.writes).toBe(0);
    fake.privateRepo = true;
    fake.forbidden = true;
    await expect(save(fake)).rejects.toMatchObject({ code: "PERMISSION" });
  });
  it("retries a concurrent branch advance without losing unrelated changes", async () => {
    const fake = new FakeGitHub();
    fake.conflictOnce = true;
    expect((await save(fake)).status).toBe("created");
    expect(fake.writes).toBe(1);
    expect(fake.read(artifact().path)).toBe(artifact().markdown);
  });
  it("does not accept unsafe repository/branch configuration", () => {
    for (const repository of ["public", "../escape", "owner/repo/extra"]) {
      expect(
        () =>
          new GitHubChatContextWriter({
            repository,
            branch: "main",
            token: "test",
          }),
      ).toThrow();
    }
    expect(
      () =>
        new GitHubChatContextWriter({
          repository: "owner/repo",
          branch: "../main",
          token: "test",
        }),
    ).toThrow();
  });
});
