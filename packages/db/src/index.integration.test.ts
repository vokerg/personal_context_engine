import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createNoteRepository } from "./index.js";
import { createTagFacetRepository } from "./tags.js";

const url = process.env.PCE_DB_TEST_URL;
// Real PostgreSQL only. The normal public workspace suite remains synthetic
// and requires no DB; database.yml provides a fresh PostgreSQL service.
describe.skipIf(!url)("PostgreSQL note projection integration", () => {
  let prisma: PrismaClient;
  const noteIds: string[] = [];
  const captureIds: string[] = [];
  const sourcePaths: string[] = [];

  function fixture(
    options: {
      noteId?: string;
      captureId?: string;
      capturedAt?: string;
      summary?: string;
      original?: string;
      tags?: string[];
      projects?: string[];
    } = {},
  ) {
    const noteId = options.noteId ?? randomUUID();
    const captureId = options.captureId ?? randomUUID();
    const capturedAt = options.capturedAt ?? "2026-10-15T08:30:00+02:00";
    const path = `inbox/${capturedAt.slice(0, 10)}_${noteId}.md`;
    noteIds.push(noteId);
    captureIds.push(captureId);
    sourcePaths.push(path);
    const markdown = `---
schema_version: 1
id: ${noteId}
capture_id: ${captureId}
captured_at: ${capturedAt}
source: import
kind: idea
domains: ["development"]
projects: ${JSON.stringify(options.projects ?? ["sample-project"])}
tags: ${JSON.stringify(options.tags ?? ["synthetic"])}
action_hint: none
review_required: false
title: Synthetic sample
occurred_at: 2026-10-14T16:00:00+02:00
due_at: 2026-10-20T09:00:00+02:00
timezone: Europe/Prague
---

# Synthetic sample

## Summary

${options.summary ?? "Synthetic summary."}

## Original input

${options.original ?? "Synthetic input."}
`;
    return {
      noteId,
      captureId,
      sourcePath: path,
      markdown,
      sourceRevision: "r-" + randomUUID(),
    };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: url! } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    if (!prisma) return;
    // Only delete synthetic IDs created by this test session.
    await prisma.processingAttempt.deleteMany({
      where: { sourcePath: { in: sourcePaths } },
    });
    await prisma.note.deleteMany({ where: { id: { in: noteIds } } });
    await prisma.capture.deleteMany({ where: { id: { in: captureIds } } });
    await prisma.$disconnect();
  });

  it("keeps explicit ownership stable across replay and rejects adoption or reassignment", async () => {
    const repository = createNoteRepository(prisma);
    const input = fixture();
    await repository.importMarkdown({
      ...input,
      ownerSubject: "local-developer",
    });
    expect((await repository.getNote(input.noteId))?.ownerSubject).toBe(
      "local-developer",
    );
    expect(
      (
        await repository.importMarkdown({
          ...input,
          ownerSubject: "local-developer",
        })
      ).result,
    ).toBe("replayed");
    await expect(
      repository.importMarkdown({ ...input, ownerSubject: "another-owner" }),
    ).rejects.toMatchObject({ code: "OWNER_CONFLICT" });
    await expect(repository.importMarkdown(input)).rejects.toMatchObject({
      code: "OWNER_CONFLICT",
    });
    const unowned = fixture();
    await repository.importMarkdown(unowned);
    await expect(
      repository.importMarkdown({
        ...unowned,
        ownerSubject: "local-developer",
      }),
    ).rejects.toMatchObject({ code: "OWNER_CONFLICT" });
  });

  it("persists a note with UTC instants and unchanged source offsets", async () => {
    const input = fixture();
    const repository = createNoteRepository(prisma);
    expect(await repository.importMarkdown(input)).toEqual({
      noteId: input.noteId,
      result: "created",
    });
    const note = await repository.getNote(input.noteId);
    expect(note?.capturedAt.toISOString()).toBe("2026-10-15T06:30:00.000Z");
    expect(note?.capturedAtRaw).toBe("2026-10-15T08:30:00+02:00");
    expect(note?.dueAt?.toISOString()).toBe("2026-10-20T07:00:00.000Z");
    expect(note?.dueAtRaw).toBe("2026-10-20T09:00:00+02:00");
    expect(note?.timezone).toBe("Europe/Prague");
    expect(note?.domains).toEqual(["development"]);
    expect(note?.projects).toEqual(["sample-project"]);
    expect(note?.tags).toEqual(["synthetic"]);
    expect(note?.originalInput).toBe("Synthetic input.\n");
    expect(note?.state).toBe("PERSISTED");
    expect(
      (await prisma.capture.findUnique({ where: { id: input.captureId } }))?.id,
    ).toBe(input.captureId);
    expect(await repository.importMarkdown(input)).toMatchObject({
      result: "replayed",
    });
    expect(await prisma.note.count({ where: { id: input.noteId } })).toBe(1);
  });

  it("groups multiple notes under one capture without cloning the capture", async () => {
    const captureId = randomUUID();
    const first = fixture({ captureId, original: "First segment." });
    const second = fixture({ captureId, original: "Second segment." });
    const repository = createNoteRepository(prisma);
    await repository.importMarkdown(first);
    await repository.importMarkdown(second);
    expect(await prisma.capture.count({ where: { id: captureId } })).toBe(1);
    expect(await prisma.note.count({ where: { captureId } })).toBe(2);
  });

  it("requires compare-and-swap for changed revisions and restores pending finalization", async () => {
    const input = fixture();
    const repository = createNoteRepository(prisma);
    await repository.importMarkdown(input);
    await prisma.note.update({
      where: { id: input.noteId },
      data: {
        state: "FINALIZED",
        canonicalPath: "notes/2026/10/" + input.noteId + ".md",
      },
    });
    const updated = {
      ...input,
      sourceRevision: "r-" + randomUUID(),
      markdown: input.markdown.replace(
        "Synthetic summary.",
        "Updated synthetic summary.",
      ),
    };
    await expect(repository.importMarkdown(updated)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(
      await repository.importMarkdown({
        ...updated,
        expectedPreviousRevision: input.sourceRevision,
      }),
    ).toMatchObject({ result: "updated" });
    const actual = await repository.getNote(input.noteId);
    expect(actual?.summary).toBe("Updated synthetic summary.");
    expect(actual?.state).toBe("PERSISTED");
    expect(actual?.canonicalPath).toBeNull();
    await expect(repository.importMarkdown(input)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
  });

  it("rejects content changes with an unchanged source revision", async () => {
    const input = fixture();
    const repository = createNoteRepository(prisma);
    await repository.importMarkdown(input);
    await expect(
      repository.importMarkdown({
        ...input,
        markdown: input.markdown.replace(
          "Synthetic summary.",
          "Changed summary.",
        ),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("rejects capture metadata collisions without deleting its original notes", async () => {
    const captureId = randomUUID();
    const first = fixture({ captureId });
    const second = fixture({
      captureId,
      capturedAt: "2026-10-15T09:30:00+02:00",
    });
    const repository = createNoteRepository(prisma);
    await repository.importMarkdown(first);
    await expect(repository.importMarkdown(second)).rejects.toMatchObject({
      code: "CAPTURE_CONFLICT",
    });
    expect(await prisma.note.count({ where: { captureId } })).toBe(1);
  });

  it("serializes concurrent upserts for a single note ID", async () => {
    const input = fixture();
    const repository = createNoteRepository(prisma);
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => repository.importMarkdown(input)),
    );
    expect(outcomes.filter((value) => value.result === "created")).toHaveLength(
      1,
    );
    expect(
      outcomes.filter((value) => value.result === "replayed"),
    ).toHaveLength(3);
    expect(await prisma.note.count({ where: { id: input.noteId } })).toBe(1);
  });

  it("enforces durable processing uniqueness and restricts capture deletion", async () => {
    const input = fixture();
    await createNoteRepository(prisma).importMarkdown(input);
    await prisma.processingAttempt.create({
      data: {
        sourcePath: input.sourcePath,
        sourceRevision: input.sourceRevision,
      },
    });
    await expect(
      prisma.processingAttempt.create({
        data: {
          sourcePath: input.sourcePath,
          sourceRevision: input.sourceRevision,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.capture.delete({ where: { id: input.captureId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("counts observed tags per owner, snapshot and revision", async () => {
    const repository = createNoteRepository(prisma);
    const first = fixture({ tags: ["alpha", "shared"] });
    const second = fixture({ tags: ["shared"] });
    const foreign = fixture({ tags: ["foreign", "shared"] });
    const legacy = fixture({ tags: ["legacy"] });
    await repository.importMarkdown({
      ...first,
      ownerSubject: "facet-owner-a",
    });
    await repository.importMarkdown({
      ...second,
      ownerSubject: "facet-owner-a",
    });
    await repository.importMarkdown({
      ...foreign,
      ownerSubject: "facet-owner-b",
    });
    await repository.importMarkdown(legacy);
    const all = createTagFacetRepository(prisma);
    expect(await all.listTagsByOwner("facet-owner-a")).toEqual({
      tags: [
        { slug: "alpha", count: 1 },
        { slug: "shared", count: 2 },
      ],
      truncated: false,
    });
    expect(await all.listTagsByOwner("facet-owner-b")).toEqual({
      tags: [
        { slug: "foreign", count: 1 },
        { slug: "shared", count: 1 },
      ],
      truncated: false,
    });
    expect(await all.listTagsByOwner("absent")).toEqual({
      tags: [],
      truncated: false,
    });
    expect(
      await createTagFacetRepository(prisma, [first.noteId]).listTagsByOwner(
        "facet-owner-a",
      ),
    ).toEqual({
      tags: [
        { slug: "alpha", count: 1 },
        { slug: "shared", count: 1 },
      ],
      truncated: false,
    });
    expect(
      await createTagFacetRepository(prisma, []).listTagsByOwner(
        "facet-owner-a",
      ),
    ).toEqual({ tags: [], truncated: false });
    await repository.importMarkdown({
      ...first,
      ownerSubject: "facet-owner-a",
      expectedPreviousRevision: first.sourceRevision,
      sourceRevision: "r-" + randomUUID(),
      markdown: first.markdown.replace('["alpha","shared"]', '["alpha"]'),
    });
    expect(await all.listTagsByOwner("facet-owner-a")).toEqual({
      tags: [
        { slug: "alpha", count: 1 },
        { slug: "shared", count: 1 },
      ],
      truncated: false,
    });
  });

  it("preserves existing state after an invalid input", async () => {
    const input = fixture();
    await createNoteRepository(prisma).importMarkdown(input);
    const invalid = input.markdown.replace(
      "schema_version: 1",
      "schema_version: 2",
    );
    await expect(
      createNoteRepository(prisma).importMarkdown({
        ...input,
        markdown: invalid,
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_VERSION" });
    expect(await prisma.note.count({ where: { id: input.noteId } })).toBe(1);
  });
});
