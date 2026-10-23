import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, createNoteRepository } from "./index.js";
import { createTagRegistryRepository } from "./tag-registry.js";
import { createTagFacetRepository } from "./tags.js";

const url = process.env.PCE_DB_TEST_URL;
const owner = "tag-owner-" + randomUUID();
const other = "tag-other-" + randomUUID();
const noteIds: string[] = [],
  captureIds: string[] = [];
const notes: Array<{
  markdown: string;
  sourcePath: string;
  sourceRevision: string;
}> = [];
function synthetic(ownerSubject: string, tags: string[]) {
  const id = randomUUID(),
    captureId = randomUUID();
  noteIds.push(id);
  captureIds.push(captureId);
  const markdown = `---
schema_version: 1
id: ${id}
capture_id: ${captureId}
captured_at: 2026-10-22T07:00:00+02:00
source: import
kind: memo
domains: []
projects: []
tags: ${JSON.stringify(tags)}
action_hint: none
review_required: false
title: Synthetic approval test
---

# Synthetic approval test

## Summary

Synthetic only.

## Original input

Synthetic only.
`;
  const input = {
    ownerSubject,
    markdown,
    sourcePath: `inbox/2026-10-22_${id}.md`,
    sourceRevision: "test-" + id,
  };
  notes.push(input);
  return input;
}

describe.skipIf(!url)("approved registry SQL boundaries", () => {
  let db: PrismaClient;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    await db.$connect();
    const repo = createNoteRepository(db);
    await repo.importMarkdown(synthetic(owner, ["candidate", "shared"]));
    await repo.importMarkdown(synthetic(owner, ["candidate"]));
    await repo.importMarkdown(synthetic(other, ["candidate"]));
  });
  afterAll(async () => {
    if (!db) return;
    await db.tagApproval.deleteMany({
      where: { ownerSubject: { in: [owner, other] } },
    });
    await db.tagRegistryRevision.deleteMany({
      where: { ownerSubject: { in: [owner, other] } },
    });
    await db.processingAttempt.deleteMany({
      where: { sourcePath: { in: notes.map((n) => n.sourcePath) } },
    });
    await db.note.deleteMany({ where: { id: { in: noteIds } } });
    await db.capture.deleteMany({ where: { id: { in: captureIds } } });
    await db.$disconnect();
  });
  it("starts empty, approves candidates atomically, counts distinct owned notes, and preserves source bytes", async () => {
    const registry = createTagRegistryRepository(db);
    const before = await db.note.findMany({ where: { ownerSubject: owner } });
    expect(await registry.listByOwner(owner)).toEqual({
      revision: 0,
      approved: [],
      truncated: false,
    });
    expect(
      (await createTagFacetRepository(db).listTagsByOwner(owner)).tags,
    ).toEqual([
      { slug: "candidate", count: 2 },
      { slug: "shared", count: 1 },
    ]);
    expect(await registry.approveByOwner(owner, "candidate", {})).toEqual({
      slug: "candidate",
      approved: true,
      changed: true,
      revision: 1,
    });
    expect(await registry.approveByOwner(owner, "candidate", {})).toEqual({
      slug: "candidate",
      approved: true,
      changed: false,
      revision: 1,
    });
    const state = await registry.listByOwner(owner);
    expect(state.revision).toBe(1);
    expect(state.approved).toMatchObject([
      { slug: "candidate", displayName: null, description: null, noteCount: 2 },
    ]);
    expect(await registry.listByOwner(other)).toEqual({
      revision: 0,
      approved: [],
      truncated: false,
    });
    const after = await db.note.findMany({ where: { ownerSubject: owner } });
    expect(
      after.map((n) => [n.id, n.tags, n.contentHash, n.sourceRevision]),
    ).toEqual(
      before.map((n) => [n.id, n.tags, n.contentHash, n.sourceRevision]),
    );
  });
  it("supports approved tags with zero notes, metadata updates and reversible unapproval", async () => {
    const registry = createTagRegistryRepository(db);
    expect(
      await registry.approveByOwner(owner, "future-work", {
        displayName: "Future work",
        description: "Owner-approved vocabulary",
      }),
    ).toMatchObject({ changed: true, revision: 2 });
    expect((await registry.listByOwner(owner)).approved).toMatchObject([
      { slug: "candidate", noteCount: 2 },
      { slug: "future-work", noteCount: 0, displayName: "Future work" },
    ]);
    expect(
      await registry.approveByOwner(owner, "future-work", {
        description: "Updated",
      }),
    ).toMatchObject({ changed: true, revision: 3 });
    expect(
      await registry.approveByOwner(owner, "future-work", {
        description: "Updated",
      }),
    ).toMatchObject({ changed: false, revision: 3 });
    expect(await registry.unapproveByOwner(owner, "candidate")).toEqual({
      slug: "candidate",
      approved: false,
      changed: true,
      revision: 4,
    });
    expect(await registry.unapproveByOwner(owner, "candidate")).toEqual({
      slug: "candidate",
      approved: false,
      changed: false,
      revision: 4,
    });
    expect(
      (await createTagFacetRepository(db).listTagsByOwner(owner)).tags,
    ).toContainEqual({ slug: "candidate", count: 2 });
    expect(
      (await registry.listByOwner(owner)).approved.map((t) => t.slug),
    ).toEqual(["future-work"]);
  });
  it("rejects invalid owner/slug/metadata and never mutates another owner's approvals", async () => {
    const registry = createTagRegistryRepository(db);
    for (const slug of ["CAPS", "bad slug", "../bad", "too-".repeat(20)]) {
      await expect(registry.approveByOwner(owner, slug, {})).rejects.toThrow(
        TypeError,
      );
    }
    await expect(
      registry.approveByOwner("bad owner", "ok", {}),
    ).rejects.toThrow(TypeError);
    await expect(
      registry.approveByOwner(owner, "ok", { displayName: " " }),
    ).rejects.toThrow(TypeError);
    await registry.approveByOwner(other, "foreign-only", {});
    expect(
      (await registry.listByOwner(owner)).approved.map((t) => t.slug),
    ).not.toContain("foreign-only");
    expect(
      (await registry.listByOwner(other)).approved.map((t) => t.slug),
    ).toEqual(["foreign-only"]);
  });
  it("paginates and searches beyond 200 approvals with revision and owner isolation", async () => {
    const catalogOwner = "catalog-" + randomUUID();
    const repo = createTagRegistryRepository(db);
    try {
      await db.tagApproval.createMany({
        data: Array.from({ length: 205 }, (_, i) => ({
          ownerSubject: catalogOwner,
          slug: "synthetic-" + String(i).padStart(3, "0"),
          displayName: i === 204 ? "Hidden comet" : null,
        })),
      });
      await db.tagRegistryRevision.create({
        data: { ownerSubject: catalogOwner, revision: 1 },
      });
      await createNoteRepository(db).importMarkdown(
        synthetic(catalogOwner, ["synthetic-204", "candidate-nebula"]),
      );
      expect(
        await repo.listObservedStatusesByOwner(catalogOwner),
      ).toMatchObject({
        revision: 1,
        statuses: [
          { slug: "candidate-nebula", status: "candidate" },
          { slug: "synthetic-204", status: "approved" },
        ],
      });
      expect(
        (await repo.listObservedStatusesByOwner(other)).statuses,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: "synthetic-204" }),
        ]),
      );
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await repo.pageByOwner(catalogOwner, {
          limit: 50,
          ...(after ? { after, revision: 1 } : {}),
        });
        seen.push(...page.approved.map((t) => t.slug));
        after = page.nextCursor ?? undefined;
      } while (after);
      expect(new Set(seen).size).toBe(205);
      expect(
        await repo.pageByOwner(catalogOwner, { q: "COMET", limit: 50 }),
      ).toMatchObject({
        approved: [{ slug: "synthetic-204" }],
        nextCursor: null,
      });
      expect(
        (await repo.pageByOwner(other, { q: "synthetic-204", limit: 50 }))
          .approved,
      ).toEqual([]);
      await repo.unapproveByOwner(catalogOwner, "synthetic-204");
      expect(
        (await repo.pageByOwner(catalogOwner, { q: "comet" })).approved,
      ).toEqual([]);
      await expect(
        repo.pageByOwner(catalogOwner, { after: "synthetic-049", revision: 1 }),
      ).rejects.toMatchObject({ name: "TagCatalogChanged" });
    } finally {
      await db.tagSnapshotOutbox.deleteMany({
        where: { ownerSubject: catalogOwner },
      });
      await db.tagApproval.deleteMany({
        where: { ownerSubject: catalogOwner },
      });
      await db.tagRegistryRevision.deleteMany({
        where: { ownerSubject: catalogOwner },
      });
    }
  });
});
