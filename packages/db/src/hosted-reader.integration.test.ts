import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../../apps/api/src/app.js";
import { createDatabaseNoteReader } from "../../../apps/api/src/database-reader.js";
import { loadApiConfig } from "../../../apps/api/src/config.js";
import {
  PrismaClient,
  createApiCaptureRepository,
  createNoteRepository,
} from "./index.js";

const url = process.env.PCE_DB_TEST_URL;
describe.skipIf(!url)("hosted DB originals reader", () => {
  it("serves API-only originals, pages, facets and tags only for the verified owner", async () => {
    const db = new PrismaClient({ datasources: { db: { url: url! } } });
    const owner = "hosted-" + randomUUID(),
      foreign = "foreign-" + randomUUID();
    const fixtures = Array.from({ length: 3 }, (_, i) => {
      const id = randomUUID(),
        capture = randomUUID();
      return {
        id,
        capture,
        markdown: `---\nschema_version: 1\nid: ${id}\ncapture_id: ${capture}\ncaptured_at: 2026-10-20T09:00:00+02:00\nsource: chatgpt_text\nkind: memo\ndomains: []\nprojects: [synthetic]\ntags: [observed-${i}]\naction_hint: none\nreview_required: false\ntitle: Synthetic hosted ${i}\n---\n\n# Synthetic hosted ${i}\n\n## Summary\n\nSynthetic summary.\n\n## Original input\n\nSynthetic source ${i}.\n`,
      };
    });
    const own = fixtures[0]!,
      other = fixtures[1]!,
      unowned = fixtures[2]!;
    const app = createApp({
      config: loadApiConfig({}),
      dependencies: {
        notes: createDatabaseNoteReader(
          db,
          "synthetic-cursor-secret-".repeat(3),
        ),
        verifyToken: async (token) => ({
          subject: token === "owned" ? owner : foreign,
          scopes: ["notes:read"],
        }),
      },
    });
    const headers = { authorization: "Bearer owned" };
    try {
      for (const [subject, f] of [
        [owner, own],
        [foreign, other],
      ] as const)
        await createApiCaptureRepository(db).persistByOwner(subject, {
          idempotencyKey: "synthetic-hosted-reader",
          notes: [f.markdown],
        });
      await createNoteRepository(db).importMarkdown({
        markdown: unowned.markdown,
        sourceRevision: "synthetic-unowned",
        sourcePath: `inbox/2026-10-20_${unowned.id}.md`,
      });
      for (const path of [
        "/api/v1/browse",
        "/api/v1/browse/facets",
        "/api/v1/tags",
        "/api/v1/notes",
        `/api/v1/notes/${own.id}`,
      ])
        expect((await app.inject(path)).statusCode).toBe(401);
      const page = await app.inject({ url: "/api/v1/browse", headers });
      expect(page.statusCode).toBe(200);
      expect(page.json().notes.map((n: { id: string }) => n.id)).toEqual([
        own.id,
      ]);
      expect(
        (await app.inject({ url: "/api/v1/tags", headers })).json(),
      ).toEqual({ tags: [{ slug: "observed-0", count: 1 }], truncated: false });
      expect(
        (await app.inject({ url: "/api/v1/browse/facets", headers })).json(),
      ).toEqual({
        projects: [{ slug: "synthetic", count: 1 }],
        kinds: [{ slug: "memo", count: 1 }],
        truncated: false,
      });
      expect(
        (
          await app.inject({
            url: "/api/v1/notes?from=2026-10-20&to=2026-10-20",
            headers,
          })
        )
          .json()
          .notes.map((n: { id: string }) => n.id),
      ).toEqual([own.id]);
      expect(
        (
          await app.inject({ url: "/api/v1/notes?from=2026-10-21", headers })
        ).json().notes,
      ).toEqual([]);
      const detail = await app.inject({
        url: `/api/v1/notes/${own.id}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().originalInput).toContain("Synthetic source 0.");
      for (const id of [other.id, unowned.id])
        expect(
          (await app.inject({ url: `/api/v1/notes/${id}`, headers }))
            .statusCode,
        ).toBe(404);
    } finally {
      await app.close();
      await db.apiCaptureReceipt.deleteMany({
        where: { ownerSubject: { in: [owner, foreign] } },
      });
      await db.note.deleteMany({
        where: { id: { in: fixtures.map((f) => f.id) } },
      });
      await db.capture.deleteMany({
        where: { id: { in: fixtures.map((f) => f.capture) } },
      });
      await db.$disconnect();
    }
  });
});
