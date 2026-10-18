import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runContentStoreConformance } from "../../test/content-store-conformance.js";
import { GitHubContentStore, githubContentStoreFromEnv } from "./github.js";

interface FakeEntry {
  sha: string;
  type: string;
  mode: string;
  size: number;
}
interface FakeCommit {
  tree: string;
  parent: string | null;
}

const hash = (value: string | Buffer): string =>
  createHash("sha1").update(value).digest("hex");
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(body), { status, headers });

class FakeGitHub {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Map<string, FakeEntry>>();
  readonly commits = new Map<string, FakeCommit>();
  readonly calls: Array<{
    path: string;
    method: string;
    authorization: string | null;
  }> = [];
  readonly delays: number[] = [];
  head: string;
  conflictOnce?: () => void;
  failOnce?: { status: number; headers?: Record<string, string> };
  forbidden = false;
  truncated = false;

  constructor() {
    const tree = this.saveTree(new Map());
    this.head = this.saveCommit(tree, null);
  }

  private saveTree(entries: Map<string, FakeEntry>): string {
    const sha = hash(
      JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b))),
    );
    this.trees.set(sha, new Map(entries));
    return sha;
  }

  private saveCommit(tree: string, parent: string | null): string {
    const sha = hash(`${tree}:${parent ?? ""}`);
    this.commits.set(sha, { tree, parent });
    return sha;
  }

  put(path: string, content: string | Buffer, mode = "100644"): void {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = hash(
      Buffer.concat([Buffer.from(`blob ${bytes.length}\\0`), bytes]),
    );
    this.blobs.set(sha, bytes);
    const current = this.commits.get(this.head)!;
    const next = new Map(this.trees.get(current.tree)!);
    next.set(path, { sha, mode, type: "blob", size: bytes.length });
    this.head = this.saveCommit(this.saveTree(next), this.head);
  }

  store(): GitHubContentStore {
    return new GitHubContentStore({
      repository: "owner/synthetic-repo",
      branch: "main",
      token: "test-token-never-real",
      fetch: this.fetch,
      sleep: async (delay) => {
        this.delays.push(delay);
      },
    });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    this.calls.push({ path, method, authorization });
    if (
      url.origin !== "https://api.github.com" ||
      !path.startsWith("/repos/owner/synthetic-repo/git/")
    ) {
      return json({ error: "unrecognized endpoint" }, 404);
    }
    if (authorization !== "Bearer test-token-never-real" || this.forbidden) {
      return json({ error: "denied" }, 403);
    }
    if (this.failOnce) {
      const { status, headers: retryHeaders } = this.failOnce;
      this.failOnce = undefined;
      return json({ error: "synthetic failure" }, status, retryHeaders);
    }
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: this.head } });
    }
    if (method === "GET" && path.includes("/git/commits/")) {
      const sha = path.split("/").at(-1)!;
      const commit = this.commits.get(sha);
      return commit ? json({ tree: { sha: commit.tree } }) : json({}, 404);
    }
    if (method === "GET" && path.includes("/git/trees/")) {
      const sha = path.split("/").at(-1)!;
      const tree = this.trees.get(sha);
      return tree
        ? json({
            truncated: this.truncated,
            tree: [...tree].map(([name, entry]) => ({
              path: name,
              ...entry,
            })),
          })
        : json({}, 404);
    }
    if (method === "GET" && path.includes("/git/blobs/")) {
      const sha = path.split("/").at(-1)!;
      const bytes = this.blobs.get(sha);
      return bytes
        ? json({
            encoding: "base64",
            // GitHub wraps its base64 blob payload at 60 columns.
            content:
              (bytes.toString("base64").match(/.{1,60}/g) ?? []).join("\n") +
              "\n",
            size: bytes.length,
          })
        : json({}, 404);
    }
    const body = JSON.parse(String(init?.body)) as {
      base_tree?: string;
      tree?: Array<{
        path: string;
        sha: string | null;
        mode: string;
        type: string;
      }>;
      message?: string;
      parents?: string[];
      force?: boolean;
      sha?: string;
    };
    if (method === "POST" && path.endsWith("/git/trees")) {
      const base = this.trees.get(body.base_tree ?? "");
      if (!base) return json({}, 422);
      const next = new Map(base);
      for (const item of body.tree ?? []) {
        if (item.sha === null) {
          next.delete(item.path);
        } else {
          const bytes = this.blobs.get(item.sha);
          if (!bytes) return json({}, 422);
          next.set(item.path, {
            sha: item.sha,
            mode: item.mode,
            type: item.type,
            size: bytes.length,
          });
        }
      }
      return json({ sha: this.saveTree(next) }, 201);
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      if (!this.trees.has(body.tree as unknown as string)) return json({}, 422);
      const tree = body.tree as unknown as string;
      return json(
        { sha: this.saveCommit(tree, body.parents?.[0] ?? null) },
        201,
      );
    }
    if (method === "PATCH" && path.endsWith("/git/refs/heads/main")) {
      if (this.conflictOnce) {
        const conflict = this.conflictOnce;
        this.conflictOnce = undefined;
        conflict();
      }
      const next = this.commits.get(body.sha ?? "");
      if (body.force || !next || next.parent !== this.head)
        return json({}, 422);
      this.head = body.sha!;
      return json({ ref: "refs/heads/main", object: { sha: this.head } });
    }
    return json({ error: "unrecognized request" }, 404);
  };
}

runContentStoreConformance("github fake", async () => {
  const fake = new FakeGitHub();
  return {
    store: fake.store(),
    seedPending: async (name, content) => {
      fake.put(`inbox/${name}`, content);
      return `inbox/${name}`;
    },
    seedDestination: async (path, content) => {
      fake.put(path, content);
    },
    cleanup: async () => {},
  };
});

describe("GitHub ContentStore safety and concurrency", () => {
  it("refuses incomplete or unsafe configuration without network access", () => {
    const bad = ["../wrong", "owner/repo/extra", "owner/repo?token=secret"];
    for (const repository of bad) {
      expect(
        () =>
          new GitHubContentStore({
            repository,
            branch: "main",
            token: "synthetic",
          }),
      ).toThrow();
    }
    expect(
      () =>
        new GitHubContentStore({
          repository: "owner/repo",
          branch: "../main",
          token: "synthetic",
        }),
    ).toThrow();
    expect(() => githubContentStoreFromEnv({})).toThrow();
  });

  it("keeps the credential only in headers and never contacts non-Git endpoints", async () => {
    const fake = new FakeGitHub();
    fake.put("inbox/a.md", "synthetic");
    const store = fake.store();
    const original = await store.read("inbox/a.md");
    await store.reject({
      sourcePath: original.path,
      expectedRevision: original.revision,
    });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(
      fake.calls.every(
        (call) =>
          call.path.startsWith("/repos/owner/synthetic-repo/git/") &&
          !call.path.includes("test-token-never-real") &&
          call.authorization === "Bearer test-token-never-real",
      ),
    ).toBe(true);
    expect(fake.calls.some((call) => call.method === "PATCH")).toBe(true);
  });

  it("retries 429 with Retry-After, and refuses unauthorized access", async () => {
    const fake = new FakeGitHub();
    fake.put("inbox/rate.md", "synthetic");
    const store = fake.store();
    fake.failOnce = { status: 429, headers: { "retry-after": "1" } };
    expect((await store.read("inbox/rate.md")).content).toBe("synthetic");
    expect(fake.delays).toEqual([1000]);
    fake.failOnce = {
      status: 403,
      headers: { "retry-after": "1", "x-ratelimit-remaining": "40" },
    };
    expect((await store.listPending()).files).toHaveLength(1);
    expect(fake.delays).toEqual([1000, 1000]);
    fake.forbidden = true;
    await expect(store.listPending()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("rejects truncated listings, unsafe Git modes and invalid blob encodings", async () => {
    const fake = new FakeGitHub();
    const store = fake.store();
    fake.put("inbox/link.md", "synthetic", "120000");
    await expect(store.listPending()).rejects.toMatchObject({
      code: "UNSAFE_ENTRY",
    });
    await expect(store.read("inbox/link.md")).rejects.toMatchObject({
      code: "UNSAFE_ENTRY",
    });
    fake.put("inbox/link.md", "synthetic");
    fake.truncated = true;
    await expect(store.listPending()).rejects.toMatchObject({
      code: "IO_ERROR",
    });
    fake.truncated = false;
    fake.put("inbox/CON.md", "reserved path");
    await expect(store.listPending()).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    fake.put("inbox/bad.md", Buffer.from([0xc3, 0x28]));
    await expect(store.read("inbox/bad.md")).rejects.toMatchObject({
      code: "INVALID_CONTENT",
    });
    fake.put("inbox/large.md", Buffer.alloc(1024 * 1024 + 1));
    await expect(store.read("inbox/large.md")).rejects.toMatchObject({
      code: "INVALID_CONTENT",
    });
  });

  it("rebases an atomic transition after a concurrent unrelated branch advance", async () => {
    const fake = new FakeGitHub();
    fake.put("inbox/race.md", "synthetic");
    const store = fake.store();
    const source = await store.read("inbox/race.md");
    fake.conflictOnce = () => fake.put("inbox/other.md", "parallel writer");
    const moved = await store.finalize({
      sourcePath: source.path,
      expectedRevision: source.revision,
      destinationPath: "notes/2026/10/race.md",
    });
    expect(moved.status).toBe("moved");
    expect((await store.read("inbox/other.md")).content).toBe(
      "parallel writer",
    );
    expect(await store.stat("inbox/race.md")).toBeNull();
    expect((await store.read("notes/2026/10/race.md")).content).toBe(
      "synthetic",
    );
  });

  it("never deletes a newer source after a concurrent edit", async () => {
    const fake = new FakeGitHub();
    fake.put("inbox/race.md", "initial");
    const store = fake.store();
    const source = await store.read("inbox/race.md");
    fake.conflictOnce = () => fake.put("inbox/race.md", "new revision");
    await expect(
      store.finalize({
        sourcePath: source.path,
        expectedRevision: source.revision,
        destinationPath: "notes/2026/10/race.md",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await store.read("inbox/race.md")).content).toBe("new revision");
    expect(await store.stat("notes/2026/10/race.md")).toBeNull();
  });

  it("treats concurrent duplicate finalization as already finalized", async () => {
    const fake = new FakeGitHub();
    fake.put("inbox/twice.md", "synthetic");
    const a = fake.store();
    const b = fake.store();
    const source = await a.read("inbox/twice.md");
    const request = {
      sourcePath: source.path,
      expectedRevision: source.revision,
      destinationPath: "notes/2026/10/twice.md",
    };
    const statuses = await Promise.all([
      a.finalize(request),
      b.finalize(request),
    ]);
    expect(statuses.map((result) => result.status).sort()).toEqual([
      "already_finalized",
      "moved",
    ]);
  });
});

describe("runtime private repository verification", () => {
  it("requires an explicit private metadata response before ingestion", async () => {
    for (const body of [{ private: false }, {}, { private: true }]) {
      const calls: string[] = [];
      const store = new GitHubContentStore({
        repository: "owner/synthetic-repo",
        branch: "main",
        token: "synthetic",
        fetch: async (url, init) => {
          calls.push(String(url));
          expect(init?.method).toBe("GET");
          return json(body);
        },
      });
      if (body.private === true) await store.verifyPrivateRepository();
      else
        await expect(store.verifyPrivateRepository()).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
      expect(calls).toEqual([
        "https://api.github.com/repos/owner/synthetic-repo",
      ]);
    }
  });
});
