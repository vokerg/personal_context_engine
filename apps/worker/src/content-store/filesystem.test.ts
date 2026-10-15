import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runContentStoreConformance } from "../../test/content-store-conformance.js";
import { FilesystemContentStore } from "./filesystem.js";

const temporaryRoots: string[] = [];
async function sandbox(): Promise<{
  root: string;
  store: FilesystemContentStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "pce-content-store-"));
  temporaryRoots.push(root);
  return { root, store: new FilesystemContentStore(root) };
}

runContentStoreConformance("filesystem", async () => {
  const { root, store } = await sandbox();
  return {
    store,
    seedPending: async (name, content) => {
      await mkdir(join(root, "inbox"), { recursive: true });
      await writeFile(join(root, "inbox", name), content);
      return `inbox/${name}`;
    },
    seedDestination: async (path, content) => {
      const fullPath = join(root, ...path.split("/"));
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      temporaryRoots.splice(temporaryRoots.indexOf(root), 1);
    },
  };
});

describe("filesystem adapter safety", () => {
  it("rejects relative sandbox roots", () => {
    expect(() => new FilesystemContentStore("./example")).toThrow();
  });

  it("rejects a symlink to a file outside the sandbox", async () => {
    const { root, store } = await sandbox();
    try {
      const external = join(root, "external.txt");
      await writeFile(external, "not a sandbox inbox entry");
      await mkdir(join(root, "inbox"));
      await symlink(external, join(root, "inbox", "link.md"));
      await expect(store.read("inbox/link.md")).rejects.toMatchObject({
        code: "UNSAFE_ENTRY",
      });
      await expect(store.listPending()).rejects.toMatchObject({
        code: "UNSAFE_ENTRY",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked destination directories", async () => {
    const { root, store } = await sandbox();
    try {
      await mkdir(join(root, "inbox"));
      await writeFile(join(root, "inbox", "note.md"), "synthetic");
      const { revision } = await store.read("inbox/note.md");
      await mkdir(join(root, "notes"));
      await symlink(join(root, "inbox"), join(root, "notes", "2026"));
      await expect(
        store.finalize({
          sourcePath: "inbox/note.md",
          expectedRevision: revision,
          destinationPath: "notes/2026/10/note.md",
        }),
      ).rejects.toMatchObject({ code: "UNSAFE_ENTRY" });
      expect((await store.read("inbox/note.md")).content).toBe("synthetic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 and oversized inputs without deleting them", async () => {
    const { root, store } = await sandbox();
    try {
      await mkdir(join(root, "inbox"));
      await writeFile(
        join(root, "inbox", "invalid.md"),
        Buffer.from([0xc3, 0x28]),
      );
      await writeFile(
        join(root, "inbox", "oversized.md"),
        Buffer.alloc(1024 * 1024 + 1),
      );
      await expect(store.read("inbox/invalid.md")).rejects.toMatchObject({
        code: "INVALID_CONTENT",
      });
      await expect(store.read("inbox/oversized.md")).rejects.toMatchObject({
        code: "INVALID_CONTENT",
      });
      expect((await readdir(join(root, "inbox"))).sort()).toEqual([
        "invalid.md",
        "oversized.md",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "surfaces denied filesystem permissions without exposing paths",
    async () => {
      const { root, store } = await sandbox();
      const inbox = join(root, "inbox");
      try {
        await mkdir(inbox);
        await writeFile(join(inbox, "private.md"), "synthetic");
        await chmod(inbox, 0o000);
        await expect(store.read("inbox/private.md")).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
      } finally {
        await chmod(inbox, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not overwrite an existing destination during a racing finalize", async () => {
    const { root, store } = await sandbox();
    try {
      await mkdir(join(root, "inbox"));
      await writeFile(join(root, "inbox", "parallel.md"), "synthetic");
      const source = await store.read("inbox/parallel.md");
      const request = {
        sourcePath: source.path,
        expectedRevision: source.revision,
        destinationPath: "notes/2026/10/parallel.md",
      };
      const results = await Promise.allSettled([
        store.finalize(request),
        store.finalize(request),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(await store.stat(source.path)).toBeNull();
      expect((await store.read(request.destinationPath)).content).toBe(
        "synthetic",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
