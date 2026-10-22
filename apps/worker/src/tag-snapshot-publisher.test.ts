import { describe, expect, it } from "vitest";
import {
  APPROVED_TAGS_PATH,
  SnapshotPublishError,
  createApprovedTagsPublisher,
  serializeApprovedTags,
  snapshotPublisherConfig,
  type ApprovedTagSnapshot,
} from "./tag-snapshot-publisher.js";

const snapshot: ApprovedTagSnapshot = {
  schema_version: 1,
  revision: 4,
  tags: [
    {
      slug: "bakery",
      display_name: "Bäckerei 日本語",
      description: 'Bread "and" baking',
    },
    { slug: "future", display_name: null, description: null },
  ],
};

function github(
  options: {
    private?: boolean;
    initial?: string;
    failure?: number;
    conflict?: boolean;
  } = {},
) {
  let contents = options.initial ?? null;
  let sha = "a".repeat(40);
  let writes = 0;
  const calls: Array<{ path: string; method: string }> = [];
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method });
    if (options.failure) return new Response("{}", { status: options.failure });
    if (url.pathname === "/repos/owner/private-content") {
      return Response.json({
        full_name: "owner/private-content",
        private: options.private ?? true,
        archived: false,
      });
    }
    if (
      url.pathname !==
      "/repos/owner/private-content/contents/" + APPROVED_TAGS_PATH
    )
      throw new Error("Unexpected path");
    if (method === "GET") {
      if (contents === null)
        return Response.json({ message: "Not found" }, { status: 404 });
      return Response.json({
        type: "file",
        sha,
        content: Buffer.from(contents, "utf8").toString("base64"),
        encoding: "base64",
        size: Buffer.byteLength(contents),
      });
    }
    if (method !== "PUT") throw new Error("Unexpected method");
    if (options.conflict) return Response.json({}, { status: 409 });
    const body = JSON.parse(String(init?.body)) as {
      sha?: string;
      branch: string;
      content: string;
    };
    expect(body.branch).toBe("main");
    expect(body.sha).toBe(contents === null ? undefined : sha);
    contents = Buffer.from(body.content, "base64").toString("utf8");
    sha = "b".repeat(40);
    writes++;
    return Response.json({}, { status: 201 });
  };
  return {
    publisher: createApprovedTagsPublisher({
      repository: "owner/private-content",
      branch: "main",
      token: "synthetic-never-real",
      http,
    }),
    calls,
    get writes() {
      return writes;
    },
    get contents() {
      return contents;
    },
  };
}

describe("approved-tag snapshot publisher (no network)", () => {
  it("uses deterministic versioned JSON, ordered tags and escaped Unicode", () => {
    const out = serializeApprovedTags(snapshot);
    expect(JSON.parse(out)).toEqual(snapshot);
    expect(out.endsWith("\n")).toBe(true);
    expect(serializeApprovedTags(snapshot)).toBe(out);
    expect(() =>
      serializeApprovedTags({
        ...snapshot,
        tags: [...snapshot.tags].reverse(),
      }),
    ).toThrow(SnapshotPublishError);
    expect(() =>
      serializeApprovedTags({
        ...snapshot,
        tags: [snapshot.tags[0], snapshot.tags[0]],
      }),
    ).toThrow(SnapshotPublishError);
    expect(
      serializeApprovedTags({ schema_version: 1, revision: 0, tags: [] }),
    ).toContain('"tags": []');
  });
  it("verifies privacy, writes the sole path, reads back, and avoids duplicate commits", async () => {
    const server = github();
    const first = await server.publisher.publish(snapshot);
    expect(first).toMatchObject({ changed: true });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(server.writes).toBe(1);
    expect(server.contents).toBe(serializeApprovedTags(snapshot));
    expect(await server.publisher.publish(snapshot)).toEqual({
      ...first,
      changed: false,
    });
    expect(server.writes).toBe(1);
    expect(
      server.calls.filter((c) => c.method === "PUT").map((c) => c.path),
    ).toEqual(["/repos/owner/private-content/contents/" + APPROVED_TAGS_PATH]);
  });
  it("publishes 200 Unicode tags exceeding 64 KiB", async () => {
    const large: ApprovedTagSnapshot = {
      schema_version: 1,
      revision: 11,
      tags: Array.from({ length: 200 }, (_, index) => ({
        slug: `topic-${String(index).padStart(3, "0")}`,
        display_name: "Research",
        description: "日本語".repeat(150),
      })),
    };
    expect(Buffer.byteLength(serializeApprovedTags(large))).toBeGreaterThan(
      65536,
    );
    const server = github();
    expect(await server.publisher.publish(large)).toMatchObject({
      changed: true,
    });
    expect(await server.publisher.publish(large)).toMatchObject({
      changed: false,
    });
    expect(server.writes).toBe(1);
  });
  it("refuses a public repository even if contents are missing", async () => {
    const server = github({ private: false });
    await expect(server.publisher.publish(snapshot)).rejects.toMatchObject({
      code: "NOT_PRIVATE",
    });
    expect(server.writes).toBe(0);
  });
  it("does not overwrite newer or conflicting same-revision remote content", async () => {
    const newer = github({
      initial: serializeApprovedTags({ ...snapshot, revision: 5 }),
    });
    await expect(newer.publisher.publish(snapshot)).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
    });
    const conflicting = github({
      initial: serializeApprovedTags({ ...snapshot, tags: [] }),
    });
    await expect(conflicting.publisher.publish(snapshot)).rejects.toMatchObject(
      { code: "REMOTE_CONFLICT" },
    );
    expect(newer.writes + conflicting.writes).toBe(0);
  });
  it("rejects corrupted remotes and compare-and-swap conflicts", async () => {
    await expect(
      github({ initial: "garbage" }).publisher.publish(snapshot),
    ).rejects.toMatchObject({ code: "REMOTE_INVALID" });
    const injected = JSON.stringify({ ...snapshot, x: true }) + "\n";
    await expect(
      github({ initial: injected }).publisher.publish({
        ...snapshot,
        revision: 5,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_INVALID" });
    await expect(
      github({ conflict: true }).publisher.publish(snapshot),
    ).rejects.toMatchObject({ code: "REMOTE_CONFLICT" });
  });
  it("fails closed on authentication/permission errors", async () => {
    for (const failure of [401, 403]) {
      await expect(
        github({ failure }).publisher.publish(snapshot),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });
  it("defaults off and requires a distinct explicit publisher opt-in", () => {
    expect(snapshotPublisherConfig({})).toBeNull();
    expect(
      snapshotPublisherConfig({ PCE_TAG_SNAPSHOT_ENABLED: "false" }),
    ).toBeNull();
    expect(() =>
      snapshotPublisherConfig({
        PCE_TAG_SNAPSHOT_ENABLED: "true",
        PCE_TAG_SNAPSHOT_REPOSITORY: "owner/private-content",
        PCE_TAG_SNAPSHOT_TOKEN: "synthetic",
      }),
    ).toThrow(SnapshotPublishError);
    expect(
      snapshotPublisherConfig({
        PCE_TAG_SNAPSHOT_ENABLED: "true",
        PCE_TAG_SNAPSHOT_ALLOW_WRITES: "I_VERIFIED_PRIVATE_REPOSITORY",
        PCE_TAG_SNAPSHOT_REPOSITORY: "owner/private-content",
        PCE_TAG_SNAPSHOT_TOKEN: "synthetic",
      }),
    ).toMatchObject({ repository: "owner/private-content", branch: "main" });
    expect(() =>
      snapshotPublisherConfig({
        PCE_TAG_SNAPSHOT_ENABLED: "true",
        PCE_TAG_SNAPSHOT_ALLOW_WRITES: "I_VERIFIED_PRIVATE_REPOSITORY",
        PCE_TAG_SNAPSHOT_REPOSITORY: "owner/public/other",
        PCE_TAG_SNAPSHOT_TOKEN: "synthetic",
      }),
    ).toThrow(SnapshotPublishError);
  });
});
