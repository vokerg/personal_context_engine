import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, createNoteRepository } from "./index.js";
import { createBrowseRepository, BrowseCursorError } from "./browse.js";

const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)("gated owner-scoped SQL browsing", () => {
  const ids: string[] = [],
    captures: string[] = [];
  let db: PrismaClient;
  const secret = "synthetic-signing-key-".repeat(3);
  let hidden: string;
  let foreign: string;
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: url! } } });
    ids.push(...Array.from({ length: 57 }, () => randomUUID()).sort());
    for (let i = 0; i < 57; i++) {
      const id = ids[i]!,
        capture = randomUUID();
      captures.push(capture);
      const original =
        i === 54
          ? "Only original has literal%_Needle. <script>untrusted()</script>"
          : "Synthetic original.";
      const projects =
        i === 0
          ? Array.from({ length: 100 }, (_, n) => `a-${n}`)
          : i === 1
            ? Array.from({ length: 100 }, (_, n) => `b-${n}`)
            : ["project-local"];
      await createNoteRepository(db).importMarkdown({
        ownerSubject: i === 56 ? "foreign-owner" : "browse-owner",
        sourceRevision: "synthetic-" + id,
        sourcePath: `inbox/2026-10-18_${id}.md`,
        markdown: `---\nschema_version: 1\nid: ${id}\ncapture_id: ${capture}\ncaptured_at: 2026-10-18T10:00:00+02:00\nsource: import\nkind: memo\ndomains: []\nprojects: ${JSON.stringify(projects)}\ntags: [focus]\naction_hint: none\nreview_required: false\ntitle: Synthetic ${i}\n---\n\n# Synthetic ${i}\n\n## Summary\n\n${"Large synthetic summary. ".repeat(40)}\n\n## Original input\n\n${original}\n`,
      });
    }
    hidden = ids[55]!;
    foreign = ids[56]!;
  });
  afterAll(async () => {
    if (!db) return;
    await db.note.deleteMany({ where: { id: { in: ids } } });
    await db.capture.deleteMany({ where: { id: { in: captures } } });
    await db.$disconnect();
  });
  const accessible = () => ids.filter((id) => id !== hidden);
  const repo = () => createBrowseRepository(db, accessible(), secret);

  it("paginates equal timestamps without duplicates and bounds summaries/payloads in SQL", async () => {
    let cursor: string | undefined;
    const found: string[] = [];
    do {
      const page = await repo().pageByOwner(
        "browse-owner",
        cursor ? { cursor } : {},
      );
      expect(page.notes.length).toBeLessThanOrEqual(24);
      for (const note of page.notes) {
        expect(note.summary.length).toBeLessThanOrEqual(320);
        expect(note).not.toHaveProperty("originalInput");
        found.push(note.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(
      ids.filter((id) => id !== hidden && id !== foreign).sort(),
    );
    expect(new Set(found).size).toBe(55);
  });
  it("searches originals outside the first page and treats wildcard/SQL text literally", async () => {
    const matching = await repo().pageByOwner("browse-owner", {
      q: "literal%_needle",
      tag: "focus",
      project: "project-local",
      kind: "memo",
      start: "2026-10-18T08:00:00Z",
      end: "2026-10-18T08:00:01Z",
    });
    expect(matching.notes.map((n) => n.id)).toEqual([ids[54]]);
    for (const filters of [
      { q: "%not-a-wildcard_" },
      { q: "' OR 1=1 --" },
      { project: "missing" },
      { kind: "idea" },
      { end: "2026-10-18T08:00:00Z" },
      { tag: "missing" },
    ]) {
      expect((await repo().pageByOwner("browse-owner", filters)).notes).toEqual(
        [],
      );
    }
    expect((await repo().pageByOwner("unknown-owner")).notes).toEqual([]);
  });
  it("rejects forged, cross-owner, changed-filter, stale-snapshot and restarted-server cursors", async () => {
    const cursor = (await repo().pageByOwner("browse-owner")).nextCursor!;
    const tampered = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as string[];
    tampered[0] = tampered[0]!.replace(ids[0]!, foreign);
    const altered = Buffer.from(
      JSON.stringify([tampered[0] + " ", tampered[1]]),
    ).toString("base64url");
    for (const invalid of ["bad", altered])
      await expect(
        repo().pageByOwner("browse-owner", { cursor: invalid }),
      ).rejects.toBeInstanceOf(BrowseCursorError);
    await expect(
      repo().pageByOwner("foreign-owner", { cursor }),
    ).rejects.toBeInstanceOf(BrowseCursorError);
    await expect(
      repo().pageByOwner("browse-owner", { cursor, q: "different" }),
    ).rejects.toBeInstanceOf(BrowseCursorError);
    await expect(
      createBrowseRepository(db, ids, secret).pageByOwner("browse-owner", {
        cursor,
      }),
    ).rejects.toBeInstanceOf(BrowseCursorError);
    await expect(
      createBrowseRepository(
        db,
        accessible(),
        "different-secret-".repeat(3),
      ).pageByOwner("browse-owner", { cursor }),
    ).rejects.toBeInstanceOf(BrowseCursorError);
  });
  it("can browse DB-owned originals without a checkout snapshot while retaining owner isolation", async () => {
    const all = createBrowseRepository(db, undefined, secret);
    let cursor: string | undefined;
    const found: string[] = [];
    do {
      const page = await all.pageByOwner(
        "browse-owner",
        cursor ? { cursor } : {},
      );
      found.push(...page.notes.map((n) => n.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(ids.filter((id) => id !== foreign).sort());
    expect((await all.facetsByOwner("browse-owner")).kinds).toEqual([
      { slug: "memo", count: 56 },
    ]);
    expect(
      await createBrowseRepository(db, [], secret).pageByOwner("browse-owner"),
    ).toEqual({ notes: [], nextCursor: null });
    const restricted = (await repo().pageByOwner("browse-owner")).nextCursor!;
    await expect(
      all.pageByOwner("browse-owner", { cursor: restricted }),
    ).rejects.toBeInstanceOf(BrowseCursorError);
  });
  it("facets include only observed owner/snapshot data, with an explicit project cap", async () => {
    const facets = await repo().facetsByOwner("browse-owner");
    expect(facets.projects.length).toBe(200);
    expect(facets.truncated).toBe(true);
    expect(facets.kinds).toEqual([{ slug: "memo", count: 55 }]);
    expect(await repo().facetsByOwner("unknown")).toEqual({
      projects: [],
      kinds: [],
      truncated: false,
    });
    expect(
      await createBrowseRepository(db, [], secret).facetsByOwner(
        "browse-owner",
      ),
    ).toEqual({ projects: [], kinds: [], truncated: false });
  });
});
