import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentStore } from "../src/content-store/port.js";
import { ContentStoreError } from "../src/content-store/port.js";

export interface ContentStoreFixture {
  store: ContentStore;
  seedPending(name: string, content: string): Promise<string>;
  seedDestination(path: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Reusable contract suite for the local adapter and the future fake GitHub
 * adapter. Only the fixture seeding/teardown mechanism is provider-specific.
 */
export function runContentStoreConformance(
  adapterName: string,
  createFixture: () => Promise<ContentStoreFixture>,
): void {
  describe(`${adapterName} conformance`, () => {
    let fixture: ContentStoreFixture | undefined;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture?.cleanup();
      fixture = undefined;
    });

    const getFixture = (): ContentStoreFixture => {
      if (!fixture) throw new Error("Test fixture not created");
      return fixture;
    };

    it("reads exact bytes and a stable source revision", async () => {
      const f = getFixture();
      const path = await f.seedPending("a.md", "# Synthetic note\n");
      const first = await f.store.read(path);
      const second = await f.store.read(path);
      expect(first.content).toBe("# Synthetic note\n");
      // A provider revision is opaque: GitHub may use a blob or commit SHA.
      expect(first.revision).toEqual(expect.any(String));
      expect(first.revision.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      expect(await f.store.stat(path)).toEqual({
        path,
        revision: first.revision,
      });
    });

    it("discovers only inbox files in bounded, deterministic pages", async () => {
      const f = getFixture();
      for (const name of ["c.md", "a.md", "b.md"]) {
        await f.seedPending(name, name);
      }
      await f.seedDestination("notes/2026/10/hidden.md", "synthetic");
      await f.seedDestination("rejected/old.md", "synthetic");
      const first = await f.store.listPending({ limit: 2 });
      expect(first.files.map((entry) => entry.path)).toEqual([
        "inbox/a.md",
        "inbox/b.md",
      ]);
      expect(first.nextCursor).toBeDefined();
      const second = await f.store.listPending({
        cursor: first.nextCursor,
        limit: 2,
      });
      expect(second.files.map((entry) => entry.path)).toEqual(["inbox/c.md"]);
      expect(second.nextCursor).toBeUndefined();
      expect(
        (await f.store.listPending({ cursor: "inbox/c.md" })).files,
      ).toEqual([]);
    });

    it("rejects invalid scan limits and cursors", async () => {
      const store = getFixture().store;
      await expect(store.listPending({ limit: 0 })).rejects.toMatchObject({
        code: "INVALID_LIMIT",
      });
      await expect(store.listPending({ limit: 101 })).rejects.toMatchObject({
        code: "INVALID_LIMIT",
      });
      await expect(
        store.listPending({ limit: Number.NaN }),
      ).rejects.toBeInstanceOf(ContentStoreError);
      await expect(
        store.listPending({ cursor: "../outside.md" }),
      ).rejects.toBeInstanceOf(ContentStoreError);
    });

    it("finalizes without overwriting and exposes replay status", async () => {
      const f = getFixture();
      const sourcePath = await f.seedPending("item.md", "# Synthetic\n");
      const source = await f.store.read(sourcePath);
      const destinationPath = "notes/2026/10/item.md";
      const request = {
        sourcePath,
        expectedRevision: source.revision,
        destinationPath,
      };
      const completed = await f.store.finalize(request);
      expect(completed).toEqual({
        path: destinationPath,
        revision: source.revision,
        status: "moved",
      });
      expect(await f.store.stat(sourcePath)).toBeNull();
      expect((await f.store.read(destinationPath)).content).toBe(
        source.content,
      );
      expect((await f.store.finalize(request)).status).toBe(
        "already_finalized",
      );
    });

    it("detects revision changes before moving source", async () => {
      const f = getFixture();
      const sourcePath = await f.seedPending("change.md", "old");
      const source = await f.store.read(sourcePath);
      await f.seedPending("change.md", "new");
      await expect(
        f.store.finalize({
          sourcePath,
          expectedRevision: source.revision,
          destinationPath: "notes/2026/10/change.md",
        }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      expect((await f.store.read(sourcePath)).content).toBe("new");
      expect(await f.store.stat("notes/2026/10/change.md")).toBeNull();
    });

    it("does not overwrite a destination on collision", async () => {
      const f = getFixture();
      const sourcePath = await f.seedPending("collision.md", "new content");
      await f.seedDestination(
        "notes/2026/10/collision.md",
        "different content",
      );
      const source = await f.store.read(sourcePath);
      await expect(
        f.store.finalize({
          sourcePath,
          expectedRevision: source.revision,
          destinationPath: "notes/2026/10/collision.md",
        }),
      ).rejects.toMatchObject({ code: "DESTINATION_CONFLICT" });
      expect((await f.store.read(sourcePath)).content).toBe("new content");
      expect((await f.store.read("notes/2026/10/collision.md")).content).toBe(
        "different content",
      );
    });

    it("recovers a partial copy/delete without duplicating the note", async () => {
      const f = getFixture();
      const sourcePath = await f.seedPending(
        "recover.md",
        "synthetic recovery",
      );
      const source = await f.store.read(sourcePath);
      const destinationPath = "notes/2026/10/recover.md";
      await f.seedDestination(destinationPath, source.content);
      const result = await f.store.finalize({
        sourcePath,
        expectedRevision: source.revision,
        destinationPath,
      });
      expect(result.status).toBe("recovered");
      expect(await f.store.stat(sourcePath)).toBeNull();
      expect((await f.store.read(destinationPath)).revision).toBe(
        source.revision,
      );
    });

    it("preserves rejected input and supports explicit replay", async () => {
      const f = getFixture();
      const sourcePath = await f.seedPending("invalid.md", "---\nbroken: [\n");
      const source = await f.store.read(sourcePath);
      const request = { sourcePath, expectedRevision: source.revision };
      expect((await f.store.reject(request)).status).toBe("moved");
      expect(await f.store.stat(sourcePath)).toBeNull();
      expect((await f.store.read("rejected/invalid.md")).content).toBe(
        source.content,
      );
      expect((await f.store.reject(request)).status).toBe("already_finalized");
    });

    it("refuses to replace a conflicting rejected file", async () => {
      const f = getFixture();
      const sourcePath = await f.seedPending(
        "invalid-collision.md",
        "new input",
      );
      const source = await f.store.read(sourcePath);
      await f.seedDestination("rejected/invalid-collision.md", "old input");
      await expect(
        f.store.reject({
          sourcePath,
          expectedRevision: source.revision,
        }),
      ).rejects.toMatchObject({ code: "DESTINATION_CONFLICT" });
      expect((await f.store.read(sourcePath)).content).toBe("new input");
    });

    it("refuses unrelated destination content during replay", async () => {
      const f = getFixture();
      const referencePath = await f.seedPending("reference.md", "reference");
      const reference = await f.store.read(referencePath);
      const missing = {
        sourcePath: "inbox/missing.md",
        destinationPath: "notes/2026/10/missing.md",
        expectedRevision: reference.revision,
      };
      await f.seedDestination(missing.destinationPath, "unrelated content");
      await expect(f.store.finalize(missing)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect((await f.store.read(missing.destinationPath)).content).toBe(
        "unrelated content",
      );
    });

    it("reports missing files and disallows unsafe paths", async () => {
      const store = getFixture().store;
      await expect(store.read("inbox/missing.md")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await store.stat("inbox/missing.md")).toBeNull();
      for (const path of [
        "../etc/passwd",
        "/tmp/secret.md",
        "inbox/../secret.md",
        "inbox/..\\secret.md",
        "inbox/.hidden.md",
        "inbox/CON.md",
        "notes/2026/10/NUL.md",
        "ledgers/daily/note.md",
      ]) {
        await expect(store.read(path)).rejects.toMatchObject({
          code: "INVALID_PATH",
        });
      }
    });
  });
}
