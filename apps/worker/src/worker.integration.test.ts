import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNoteRepository } from "@pce/db";
import { ContentStoreError, type ContentStore } from "./content-store/port.js";
import { FilesystemContentStore } from "./content-store/filesystem.js";
import { canonicalNotePath, runIngestionBatch } from "./worker.js";

const testUrl = process.env.PCE_DB_TEST_URL;
const baseTime = Date.parse("2026-10-16T10:00:00Z");
const capturedAt = "2026-10-15T08:30:00+02:00";

describe.skipIf(!testUrl)(
  "durable ingestion with synthetic PostgreSQL and filesystem",
  () => {
    let db: PrismaClient;
    let root: string;
    let store: FilesystemContentStore;
    const noteIds: string[] = [];
    const captureIds: string[] = [];
    const sourcePaths: string[] = [];

    function fixture(
      options: {
        captureId?: string;
        actionHint?: string;
        reviewRequired?: boolean;
        dueAt?: string;
        invalid?: boolean;
      } = {},
    ) {
      const noteId = randomUUID();
      const captureId = options.captureId ?? randomUUID();
      const path = `inbox/${capturedAt.slice(0, 10)}_${noteId}.md`;
      noteIds.push(noteId);
      captureIds.push(captureId);
      sourcePaths.push(path);
      const markdown = `---
schema_version: ${options.invalid ? "2" : "1"}
id: ${noteId}
capture_id: ${captureId}
captured_at: ${capturedAt}
source: import
kind: idea
domains: ["development"]
projects: []
tags: ["synthetic"]
action_hint: ${options.actionHint ?? "none"}
review_required: ${options.reviewRequired ?? false}
title: Synthetic note
${options.dueAt ? `due_at: ${options.dueAt}\n` : ""}timezone: Europe/Prague
---

# Synthetic note

## Summary

Synthetic summary.

## Original input

Synthetic transcription.
`;
      return { noteId, captureId, path, markdown };
    }

    async function seed(input: ReturnType<typeof fixture>) {
      await writeFile(join(root, "inbox", input.path.slice(6)), input.markdown);
    }

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "pce-worker-synthetic-"));
      await mkdir(join(root, "inbox"));
      store = new FilesystemContentStore(root);
      db = new PrismaClient({ datasources: { db: { url: testUrl! } } });
      await db.$connect();
    });

    afterAll(async () => {
      if (db) {
        await db.processingAttempt.deleteMany({
          where: { sourcePath: { in: sourcePaths } },
        });
        await db.note.deleteMany({ where: { id: { in: noteIds } } });
        await db.capture.deleteMany({ where: { id: { in: captureIds } } });
        await db.$disconnect();
      }
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("imports split captures, exact deadlines and unscheduled reminders without effects", async () => {
      const shared = randomUUID();
      const exact = fixture({
        captureId: shared,
        actionHint: "remind",
        dueAt: "2026-10-20T09:00:00+02:00",
      });
      const unscheduled = fixture({
        captureId: shared,
        actionHint: "remind",
        reviewRequired: true,
      });
      const malformed = fixture({ invalid: true });
      await Promise.all([seed(exact), seed(unscheduled), seed(malformed)]);
      const report = await runIngestionBatch({
        db,
        store,
        now: () => new Date(baseTime),
      });
      expect(report.imported).toBe(2);
      expect(report.finalized).toBe(2);
      expect(report.rejected).toBe(1);
      expect(await db.capture.count({ where: { id: shared } })).toBe(1);
      const first = await db.note.findUniqueOrThrow({
        where: { id: exact.noteId },
      });
      const second = await db.note.findUniqueOrThrow({
        where: { id: unscheduled.noteId },
      });
      expect(first.dueAt?.toISOString()).toBe("2026-10-20T07:00:00.000Z");
      expect(first.dueAtRaw).toBe("2026-10-20T09:00:00+02:00");
      expect(first.actionHint).toBe("remind");
      expect(first.canonicalPath).toBe(
        canonicalNotePath(capturedAt, exact.noteId),
      );
      expect(second.dueAt).toBeNull();
      expect(second.reviewRequired).toBe(true);
      expect(second.actionHint).toBe("remind");
      expect(first.state).toBe("FINALIZED");
      expect(second.state).toBe("FINALIZED");
      expect(await store.stat(exact.path)).toBeNull();
      expect(await store.stat(unscheduled.path)).toBeNull();
      expect(
        await readFile(join(root, "rejected", malformed.path.slice(6)), "utf8"),
      ).toBe(malformed.markdown);
      const rejected = await db.processingAttempt.findUniqueOrThrow({
        where: {
          sourcePath_sourceRevision: {
            sourcePath: malformed.path,
            sourceRevision: (
              await store.read("rejected/" + malformed.path.slice(6))
            ).revision,
          },
        },
      });
      expect(rejected.status).toBe("REJECTED");
      expect(rejected.lastErrorCode).toBe("VALIDATION_SCHEMA_VERSION");
    });

    it("retains original inbox bytes during a simulated projection outage then retries", async () => {
      const note = fixture({ actionHint: "remind", reviewRequired: true });
      await seed(note);
      const initial = await runIngestionBatch({
        db,
        store,
        now: () => new Date(baseTime),
        importMarkdown: async () => {
          throw new Error("synthetic DB failure");
        },
      });
      expect(initial.retried).toBe(1);
      expect((await store.read(note.path)).content).toBe(note.markdown);
      const after = await runIngestionBatch({
        db,
        store,
        now: () => new Date(baseTime + 12_000),
      });
      expect(after.finalized).toBe(1);
      expect(
        (await db.note.findUniqueOrThrow({ where: { id: note.noteId } })).dueAt,
      ).toBeNull();
      expect(await db.note.count({ where: { id: note.noteId } })).toBe(1);
    });

    it("reconciles a DB commit when the ContentStore move fails once", async () => {
      const note = fixture();
      await seed(note);
      let failMove = true;
      const failingStore: ContentStore = {
        listPending: (options) => store.listPending(options),
        read: (path) => store.read(path),
        stat: (path) => store.stat(path),
        reject: (request) => store.reject(request),
        finalize: async (request) => {
          if (failMove) {
            failMove = false;
            throw new ContentStoreError("IO_ERROR", "Synthetic interruption.");
          }
          return store.finalize(request);
        },
      };
      const first = await runIngestionBatch({
        db,
        store: failingStore,
        now: () => new Date(baseTime),
      });
      expect(first.imported).toBe(1);
      expect(first.retried).toBe(1);
      expect(await store.stat(note.path)).not.toBeNull();
      expect(
        (await db.note.findUniqueOrThrow({ where: { id: note.noteId } })).state,
      ).toBe("PERSISTED");
      const second = await runIngestionBatch({
        db,
        store,
        now: () => new Date(baseTime + 12_000),
      });
      expect(second.reconciled).toBe(1);
      expect(second.finalized).toBe(1);
      expect(await db.note.count({ where: { id: note.noteId } })).toBe(1);
      expect(await store.stat(note.path)).toBeNull();
    });

    it("reconciles an already moved file after a crash before DB finalization", async () => {
      const note = fixture();
      await seed(note);
      const source = await store.read(note.path);
      await createNoteRepository(db).importMarkdown({
        markdown: source.content,
        sourcePath: source.path,
        sourceRevision: source.revision,
      });
      await db.processingAttempt.create({
        data: {
          sourcePath: source.path,
          sourceRevision: source.revision,
          noteId: note.noteId,
          status: "PERSISTED",
          committedAt: new Date(baseTime),
        },
      });
      await store.finalize({
        sourcePath: source.path,
        expectedRevision: source.revision,
        destinationPath: canonicalNotePath(capturedAt, note.noteId),
      });
      const report = await runIngestionBatch({
        db,
        store,
        now: () => new Date(baseTime + 12_000),
      });
      expect(report.reconciled).toBe(1);
      expect(
        (await db.note.findUniqueOrThrow({ where: { id: note.noteId } })).state,
      ).toBe("FINALIZED");
    });

    it("retries a failed rejection move without losing its durable validation error", async () => {
      const note = fixture({ invalid: true });
      await seed(note);
      const original = await store.read(note.path);
      let failRejection = true;
      const flakyStore: ContentStore = {
        listPending: (options) => store.listPending(options),
        read: (path) => store.read(path),
        stat: (path) => store.stat(path),
        finalize: (request) => store.finalize(request),
        reject: async (request) => {
          if (failRejection) {
            failRejection = false;
            throw new ContentStoreError("IO_ERROR", "Synthetic interruption.");
          }
          return store.reject(request);
        },
      };
      const first = await runIngestionBatch({
        db,
        store: flakyStore,
        now: () => new Date(baseTime),
      });
      expect(first.rejected).toBe(1);
      expect(await store.stat(note.path)).not.toBeNull();
      const before = await db.processingAttempt.findUniqueOrThrow({
        where: {
          sourcePath_sourceRevision: {
            sourcePath: note.path,
            sourceRevision: original.revision,
          },
        },
      });
      expect(before.status).toBe("REJECTED");
      expect(before.lastErrorCode).toBe("VALIDATION_SCHEMA_VERSION");
      await runIngestionBatch({
        db,
        store,
        now: () => new Date(baseTime + 12_000),
      });
      expect(await store.stat(note.path)).toBeNull();
      expect((await store.read("rejected/" + note.path.slice(6))).content).toBe(
        note.markdown,
      );
    });

    it("uses DB compare-and-swap to serialize competing workers", async () => {
      const note = fixture();
      await seed(note);
      const results = await Promise.all([
        runIngestionBatch({
          db,
          store,
          workerId: randomUUID(),
          now: () => new Date(baseTime),
        }),
        runIngestionBatch({
          db,
          store,
          workerId: randomUUID(),
          now: () => new Date(baseTime),
        }),
      ]);
      expect(
        results.reduce((count, report) => count + report.imported, 0),
      ).toBe(1);
      expect(await db.note.count({ where: { id: note.noteId } })).toBe(1);
      expect(await store.stat(note.path)).toBeNull();
    });

    it("resumes a durable bounded scan beyond poison files after restart and wraps to catch new input", async () => {
      const key = "a".repeat(64);
      const fixtures = [fixture(), fixture(), fixture()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      const refs = fixtures.map((n) => ({
        path: n.path,
        revision: "synthetic-revision",
      }));
      const remaining = new Set(refs.map((r) => r.path));
      const boundedStore: ContentStore = {
        listPending: async ({ cursor, limit = 50 } = {}) => {
          const files = refs.filter(
            (r) => remaining.has(r.path) && (!cursor || r.path > cursor),
          );
          const selected = files.slice(0, limit);
          return {
            files: selected,
            ...(files.length > selected.length
              ? { nextCursor: selected.at(-1)!.path }
              : {}),
          };
        },
        read: async (path) => ({
          ...refs.find((r) => r.path === path)!,
          content: fixtures.find((n) => n.path === path)!.markdown,
        }),
        stat: async () => null,
        finalize: async (request) => {
          remaining.delete(request.sourcePath);
          return {
            path: request.destinationPath,
            revision: request.expectedRevision,
            status: "moved",
          };
        },
        reject: async () => {
          throw new Error("No destructive repair");
        },
      };
      try {
        for (const ref of refs.slice(0, 2))
          await db.processingAttempt.create({
            data: {
              sourcePath: ref.path,
              sourceRevision: ref.revision,
              status: "REJECTED",
              lastErrorCode: "PROJECTION_SOURCE_CONFLICT",
            },
          });
        const run = () =>
          runIngestionBatch({
            db,
            store: boundedStore,
            scanCheckpointKey: key,
            scanLimit: 1,
            batchSize: 1,
          });
        expect((await run()).deferred).toBe(1);
        expect(
          (await db.ingestionCheckpoint.findUniqueOrThrow({ where: { key } }))
            .cursor,
        ).toBe(refs[0]!.path);
        expect((await run()).deferred).toBe(1);
        expect((await run()).imported).toBe(1);
        expect(
          (await db.ingestionCheckpoint.findUniqueOrThrow({ where: { key } }))
            .cursor,
        ).toBeNull();
        expect(
          await db.note.count({ where: { id: fixtures[2]!.noteId } }),
        ).toBe(1);
        // Full rescan is required even when no new webhook/commit is reported.
        expect((await run()).deferred).toBe(1);
        const before = await db.ingestionCheckpoint.findUniqueOrThrow({
          where: { key },
        });
        const brokenDb = new Proxy(db, {
          get(target, property) {
            if (property === "processingAttempt")
              return {
                ...target.processingAttempt,
                create: async () => {
                  throw new Error("Synthetic DB outage");
                },
              };
            return Reflect.get(target, property);
          },
        });
        await expect(
          runIngestionBatch({
            db: brokenDb,
            store: boundedStore,
            scanCheckpointKey: key,
            scanLimit: 1,
          }),
        ).rejects.toThrow("Synthetic DB outage");
        expect(
          await db.ingestionCheckpoint.findUniqueOrThrow({ where: { key } }),
        ).toEqual(before);
        expect((await run()).deferred).toBe(1);
      } finally {
        await db.ingestionCheckpoint.deleteMany({ where: { key } });
      }
    });
  },
);
