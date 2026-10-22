import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, createNoteRepository } from "./index.js";
import { createNoteTagRepository, NoteTagConflictError } from "./note-tags.js";
import { createBrowseRepository } from "./browse.js";
import { createTagFacetRepository } from "./tags.js";
import { createSearchRepository } from "./search.js";
import { createTagRegistryRepository } from "./tag-registry.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "manual-tags-" + randomUUID();
const foreign = "foreign-tags-" + randomUUID();
const ownId = randomUUID();
const otherId = randomUUID();
const captureIds = [randomUUID(), randomUUID()];
const paths = [
  `inbox/2026-10-22_${ownId}.md`,
  `inbox/2026-10-22_${otherId}.md`,
];
const markdown = (id: string, captureId: string, tags: string[]) => `---
schema_version: 1
id: ${id}
capture_id: ${captureId}
captured_at: 2026-10-22T19:00:00+02:00
source: import
kind: memo
domains: []
projects: []
tags: ${JSON.stringify(tags)}
action_hint: none
review_required: false
title: Synthetic manual tags
---

# Synthetic manual tags

## Summary

Synthetic matching text.

## Original input

Synthetic matching text.
`;

describe.skipIf(!url)(
  "manual note tag overrides survive original imports",
  () => {
    let db: PrismaClient;
    beforeAll(async () => {
      db = new PrismaClient({ datasources: { db: { url: url! } } });
      await db.$connect();
      const notes = createNoteRepository(db);
      await notes.importMarkdown({
        markdown: markdown(ownId, captureIds[0]!, ["source-tag"]),
        ownerSubject: owner,
        sourcePath: paths[0]!,
        sourceRevision: "revision-1",
      });
      await notes.importMarkdown({
        markdown: markdown(otherId, captureIds[1]!, ["source-tag"]),
        ownerSubject: foreign,
        sourcePath: paths[1]!,
        sourceRevision: "revision-1",
      });
    });
    afterAll(async () => {
      if (!db) return;
      await db.tagApproval.deleteMany({ where: { ownerSubject: owner } });
      await db.tagRegistryRevision.deleteMany({
        where: { ownerSubject: owner },
      });
      await db.noteTagOverride.deleteMany({
        where: { noteId: { in: [ownId, otherId] } },
      });
      await db.processingAttempt.deleteMany({
        where: { sourcePath: { in: paths } },
      });
      await db.note.deleteMany({ where: { id: { in: [ownId, otherId] } } });
      await db.capture.deleteMany({ where: { id: { in: captureIds } } });
      await db.$disconnect();
    });

    it("keeps source tags and hashes immutable across detach, attach, idempotent replays and concurrency", async () => {
      const tags = createNoteTagRepository(db);
      const source = await db.note.findUniqueOrThrow({ where: { id: ownId } });
      expect(
        await tags.changeByOwner(foreign, ownId, {
          operation: "remove",
          slug: "source-tag",
          expectedRevision: 0,
        }),
      ).toBeNull();
      expect(
        await tags.changeByOwner(owner, ownId, {
          operation: "add",
          slug: "source-tag",
          expectedRevision: 0,
        }),
      ).toMatchObject({
        tags: ["source-tag"],
        changed: false,
        tagEditing: { revision: 0 },
      });
      const removed = await tags.changeByOwner(owner, ownId, {
        operation: "remove",
        slug: "source-tag",
        expectedRevision: 0,
      });
      expect(removed).toMatchObject({
        tags: [],
        changed: true,
        tagEditing: { revision: 1, manualRemoved: ["source-tag"] },
      });
      expect(
        await tags.changeByOwner(owner, ownId, {
          operation: "remove",
          slug: "source-tag",
          expectedRevision: 1,
        }),
      ).toMatchObject({ changed: false, tagEditing: { revision: 1 } });
      await expect(
        tags.changeByOwner(owner, ownId, {
          operation: "add",
          slug: "other-tag",
          expectedRevision: 0,
        }),
      ).rejects.toBeInstanceOf(NoteTagConflictError);
      const added = await tags.changeByOwner(owner, ownId, {
        operation: "add",
        slug: "manual-tag",
        expectedRevision: 1,
      });
      expect(added).toMatchObject({
        tags: ["manual-tag"],
        tagEditing: { revision: 2, manualAdded: ["manual-tag"] },
      });
      const repo = createSearchRepository(db);
      expect((await repo.getByOwner(owner, ownId))?.tags).toEqual([
        "manual-tag",
      ]);
      expect(await repo.getByOwner(foreign, ownId)).toBeNull();
      const facet = createTagFacetRepository(db);
      expect((await facet.listTagsByOwner(owner)).tags).toEqual([
        { slug: "manual-tag", count: 1 },
      ]);
      expect((await facet.listTagsByOwner(foreign)).tags).toEqual([
        { slug: "source-tag", count: 1 },
      ]);
      const browse = createBrowseRepository(
        db,
        undefined,
        "a-long-test-secret-".repeat(4),
      );
      expect(
        (await browse.pageByOwner(owner, { tag: "source-tag" })).notes,
      ).toHaveLength(0);
      expect(
        (await browse.pageByOwner(owner, { tag: "manual-tag" })).notes,
      ).toMatchObject([{ id: ownId, tags: ["manual-tag"] }]);
      expect(
        (
          await repo.searchByOwner(owner, {
            query: "Synthetic",
            tags: ["manual-tag"],
          })
        ).map((r) => r.id),
      ).toContain(ownId);
      expect(
        await repo.searchByOwner(owner, {
          query: "Synthetic",
          tags: ["source-tag"],
        }),
      ).toHaveLength(0);
      await createTagRegistryRepository(db).approveByOwner(
        owner,
        "manual-tag",
        {},
      );
      expect(
        (await createTagRegistryRepository(db).listByOwner(owner)).approved,
      ).toMatchObject([{ slug: "manual-tag", noteCount: 1 }]);
      const replay = await createNoteRepository(db).importMarkdown({
        markdown: markdown(ownId, captureIds[0]!, ["source-tag"]),
        ownerSubject: owner,
        sourcePath: paths[0]!,
        sourceRevision: "revision-1",
      });
      expect(replay.result).toBe("replayed");
      expect((await repo.getByOwner(owner, ownId))?.tags).toEqual([
        "manual-tag",
      ]);
      const current = await db.note.findUniqueOrThrow({ where: { id: ownId } });
      expect([
        current.tags,
        current.contentHash,
        current.sourceRevision,
        current.originalInput,
      ]).toEqual([
        source.tags,
        source.contentHash,
        source.sourceRevision,
        source.originalInput,
      ]);
      // Re-adding a source tag clears its tombstone without rewriting its original.
      expect(
        await tags.changeByOwner(owner, ownId, {
          operation: "add",
          slug: "source-tag",
          expectedRevision: 2,
        }),
      ).toMatchObject({
        tags: ["manual-tag", "source-tag"],
        tagEditing: { revision: 3, manualRemoved: [] },
      });
      await expect(
        tags.changeByOwner(owner, ownId, {
          operation: "add",
          slug: "Bad Slug",
          expectedRevision: 3,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      // Removing a manual-only tag must not create an accumulating source
      // tombstone or prevent the owner from re-attaching it later.
      expect(
        await tags.changeByOwner(owner, ownId, {
          operation: "remove",
          slug: "manual-tag",
          expectedRevision: 3,
        }),
      ).toMatchObject({
        tags: ["source-tag"],
        tagEditing: { revision: 4, manualAdded: [], manualRemoved: [] },
      });
      await tags.changeByOwner(owner, ownId, {
        operation: "add",
        slug: "manual-tag",
        expectedRevision: 4,
      });
      await tags.changeByOwner(owner, ownId, {
        operation: "remove",
        slug: "source-tag",
        expectedRevision: 5,
      });
      // A new GitHub source revision may add tags. Manual removals still
      // take precedence, while genuinely new source tags become visible.
      const revised = await createNoteRepository(db).importMarkdown({
        markdown: markdown(ownId, captureIds[0]!, ["source-tag", "new-source"]),
        ownerSubject: owner,
        sourcePath: paths[0]!,
        sourceRevision: "revision-2",
        expectedPreviousRevision: "revision-1",
      });
      expect(revised.result).toBe("updated");
      expect((await repo.getByOwner(owner, ownId))?.tags).toEqual([
        "manual-tag",
        "new-source",
      ]);
      expect(
        (await db.note.findUniqueOrThrow({ where: { id: ownId } })).tags,
      ).toEqual(["source-tag", "new-source"]);
      // Two tabs at the same revision cannot silently overwrite each other.
      const concurrent = await Promise.allSettled([
        tags.changeByOwner(owner, ownId, {
          operation: "add",
          slug: "tab-one",
          expectedRevision: 6,
        }),
        tags.changeByOwner(owner, ownId, {
          operation: "add",
          slug: "tab-two",
          expectedRevision: 6,
        }),
      ]);
      expect(
        concurrent.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        concurrent.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        concurrent.find((result) => result.status === "rejected"),
      ).toMatchObject({
        reason: { name: "NoteTagConflictError" },
      });
    });
  },
);
