import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PrismaClient,
  createBrowseRepository,
  createNoteArchiveRepository,
  createNoteRemovalRepository,
  createNoteRepository,
  createNoteTagRepository,
  createSearchRepository,
  createTagFacetRepository,
} from "./index.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "remove-owner-" + randomUUID();
const foreign = "remove-foreign-" + randomUUID();
const ownId = randomUUID();
const foreignId = randomUUID();
const captureIds = [randomUUID(), randomUUID()];
const paths = [
  `inbox/2026-10-24_${ownId}.md`,
  `inbox/2026-10-24_${foreignId}.md`,
];

const markdown = (id: string, captureId: string) => `---
schema_version: 1
id: ${id}
capture_id: ${captureId}
captured_at: 2026-10-24T19:00:00+02:00
source: import
kind: memo
domains: [testing]
projects: [removal]
tags: [keep-me]
action_hint: none
review_required: false
title: Synthetic removable note
---

# Synthetic removable note

## Summary

Synthetic removal text.

## Original input

Synthetic removal text.
`;

describe.skipIf(!url)("owner-scoped reversible note removal", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
    const notes = createNoteRepository(db);
    await notes.importMarkdown({
      markdown: markdown(ownId, captureIds[0]!),
      ownerSubject: owner,
      sourcePath: paths[0]!,
      sourceRevision: "revision-1",
    });
    await notes.importMarkdown({
      markdown: markdown(foreignId, captureIds[1]!),
      ownerSubject: foreign,
      sourcePath: paths[1]!,
      sourceRevision: "revision-1",
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.dbProcessingJob.deleteMany({
      where: { noteId: { in: [ownId, foreignId] } },
    });
    await db.noteTagOverride.deleteMany({
      where: { noteId: { in: [ownId, foreignId] } },
    });
    await db.processingAttempt.deleteMany({
      where: { sourcePath: { in: paths } },
    });
    await db.note.deleteMany({ where: { id: { in: [ownId, foreignId] } } });
    await db.capture.deleteMany({ where: { id: { in: captureIds } } });
    await db.$disconnect();
  });

  it("hides only the verified owner's note from normal reads while preserving source data", async () => {
    const before = await db.note.findUniqueOrThrow({ where: { id: ownId } });
    const archive = createNoteArchiveRepository(db);
    expect(await archive.setArchivedByOwner(foreign, ownId, true)).toBeNull();
    expect(await archive.setArchivedByOwner(owner, ownId, true)).toBe(
      "archived",
    );
    expect(await archive.setArchivedByOwner(owner, ownId, true)).toBe(
      "archived",
    );
    expect(
      (await createSearchRepository(db).getByOwner(owner, ownId))?.status,
    ).toBe("archived");
    const browse = createBrowseRepository(
      db,
      undefined,
      "note-removal-test-cursor-secret-1234567890",
    );
    expect((await browse.pageByOwner(owner)).notes).toEqual([]);
    expect(
      (await browse.pageByOwner(owner, { status: "archived" })).notes[0],
    ).toMatchObject({
      id: ownId,
      status: "archived",
    });
    expect(
      (await browse.pageByOwner(owner, { status: "all" })).notes[0]?.id,
    ).toBe(ownId);
    expect(
      (await createTagFacetRepository(db).listTagsByOwner(owner, "active"))
        .tags,
    ).toEqual([]);
    expect(
      (await createTagFacetRepository(db).listTagsByOwner(owner, "archived"))
        .tags,
    ).toEqual([{ slug: "keep-me", count: 1 }]);

    const removal = createNoteRemovalRepository(db);
    expect(await removal.removeByOwner(foreign, ownId)).toBe(false);
    const removedAt = new Date("2026-10-24T18:30:00.000Z");
    expect(await removal.removeByOwner(owner, ownId, removedAt)).toBe(true);
    expect(await removal.removeByOwner(owner, ownId)).toBe(false);
    expect(await archive.setArchivedByOwner(owner, ownId, false)).toBeNull();

    const stored = await db.note.findUniqueOrThrow({ where: { id: ownId } });
    expect(stored.removedAt).toEqual(removedAt);
    expect(stored.removedBy).toBe(owner);
    expect(stored.originalInput).toBe(before.originalInput);
    expect(stored.contentHash).toBe(before.contentHash);
    expect(stored.sourceRevision).toBe(before.sourceRevision);

    const notes = createNoteRepository(db);
    const source = {
      markdown: markdown(ownId, captureIds[0]!),
      ownerSubject: owner,
      sourcePath: paths[0]!,
      sourceRevision: "revision-1",
    };
    expect((await notes.importMarkdown(source)).result).toBe("replayed");
    expect(
      (
        await notes.importMarkdown({
          ...source,
          sourceRevision: "revision-2",
          expectedPreviousRevision: "revision-1",
        })
      ).result,
    ).toBe("updated");
    const reimported = await db.note.findUniqueOrThrow({ where: { id: ownId } });
    expect(reimported.removedAt).toEqual(removedAt);
    expect(reimported.removedBy).toBe(owner);
    expect(reimported.originalInput).toBe(before.originalInput);
    expect(reimported.archivedAt).toEqual(stored.archivedAt);

    const search = createSearchRepository(db);
    expect(await search.getByOwner(owner, ownId)).toBeNull();
    expect(
      await search.searchByOwner(owner, { query: "Synthetic removal" }),
    ).toEqual([]);
    expect((await browse.pageByOwner(owner)).notes).toEqual([]);
    expect(await createTagFacetRepository(db).listTagsByOwner(owner)).toEqual({
      tags: [],
      truncated: false,
    });
    expect(
      await createNoteTagRepository(db).changeByOwner(owner, ownId, {
        operation: "add",
        slug: "another-tag",
        expectedRevision: 0,
      }),
    ).toBeNull();
    expect((await search.getByOwner(foreign, foreignId))?.id).toBe(foreignId);
  });
});
