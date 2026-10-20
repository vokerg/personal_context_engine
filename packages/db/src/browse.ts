import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

const PAGE_SIZE = 24;
export interface BrowseQuery {
  q?: string | undefined;
  tag?: string | undefined;
  project?: string | undefined;
  kind?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  cursor?: string | undefined;
}
export class BrowseCursorError extends Error {
  constructor() {
    super("Invalid browse cursor");
    this.name = "BrowseCursorError";
  }
}

/** Owner-scoped DB reader with an optional additional local snapshot allowlist. */
export function createBrowseRepository(
  db: PrismaClient,
  allowedIds: readonly string[] | undefined,
  cursorSecret: string,
) {
  if (Buffer.byteLength(cursorSecret) < 32)
    throw new Error("Browse signing key required");
  const sign = (payload: string) =>
    createHmac("sha256", cursorSecret).update(payload).digest("base64url");
  const scope = (
    owner: string,
    ids: readonly string[] | undefined,
  ) => Prisma.sql`
    n."ownerSubject" = ${owner}
    ${ids ? Prisma.sql`AND n.id = ANY(${[...ids]}::text[])` : Prisma.empty}`;
  return {
    async pageByOwner(owner: string, query: BrowseQuery = {}) {
      const ids = allowedIds ? [...allowedIds].sort() : undefined;
      const { cursor, ...filters } = query;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            owner,
            ids,
            filters.q ?? "",
            filters.tag ?? "",
            filters.project ?? "",
            filters.kind ?? "",
            filters.start ?? "",
            filters.end ?? "",
          ]),
        )
        .digest("hex");
      let seek = Prisma.empty;
      if (cursor) {
        try {
          const signed: unknown = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          );
          if (
            !Array.isArray(signed) ||
            signed.length !== 2 ||
            typeof signed[0] !== "string" ||
            typeof signed[1] !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(signed[1]) ||
            !timingSafeEqual(
              Buffer.from(sign(signed[0])),
              Buffer.from(signed[1]),
            )
          )
            throw new BrowseCursorError();
          const value: unknown = JSON.parse(signed[0]);
          if (
            !Array.isArray(value) ||
            value.length !== 3 ||
            value[0] !== fingerprint ||
            typeof value[1] !== "string" ||
            new Date(value[1]).toISOString() !== value[1] ||
            typeof value[2] !== "string" ||
            !/^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
              value[2],
            )
          )
            throw new BrowseCursorError();
          const at = new Date(value[1]);
          seek = Prisma.sql`AND (n."capturedAt" < ${at} OR (n."capturedAt" = ${at} AND n.id COLLATE "C" > ${value[2]}))`;
        } catch {
          throw new BrowseCursorError();
        }
      }
      if (ids?.length === 0) return { notes: [], nextCursor: null };
      const rows = await db.$queryRaw<
        Array<{
          id: string;
          title: string;
          summary: string;
          tags: string[];
          capturedAt: Date;
        }>
      >(Prisma.sql`
        SELECT n.id, n.title, left(n.summary, 320) AS summary, n.tags, n."capturedAt"
        FROM notes n WHERE ${scope(owner, ids)}
        ${filters.tag ? Prisma.sql`AND ${filters.tag} = ANY(n.tags)` : Prisma.empty}
        ${filters.project ? Prisma.sql`AND ${filters.project} = ANY(n.projects)` : Prisma.empty}
        ${filters.kind ? Prisma.sql`AND n.kind = ${filters.kind}` : Prisma.empty}
        ${filters.start ? Prisma.sql`AND n."capturedAt" >= ${new Date(filters.start)}` : Prisma.empty}
        ${filters.end ? Prisma.sql`AND n."capturedAt" < ${new Date(filters.end)}` : Prisma.empty}
        ${filters.q ? Prisma.sql`AND strpos(lower(n.title || E'\n' || n.summary || E'\n' || n.body || E'\n' || n."originalInput"), lower(${filters.q})) > 0` : Prisma.empty}
        ${seek}
        ORDER BY n."capturedAt" DESC, n.id COLLATE "C" ASC LIMIT ${PAGE_SIZE + 1}
      `);
      const notes = rows
        .slice(0, PAGE_SIZE)
        .map((n) => ({ ...n, capturedAt: n.capturedAt.toISOString() }));
      const last = notes.at(-1);
      const payload = last
        ? JSON.stringify([fingerprint, last.capturedAt, last.id])
        : "";
      return {
        notes,
        nextCursor:
          rows.length > PAGE_SIZE && last
            ? Buffer.from(JSON.stringify([payload, sign(payload)])).toString(
                "base64url",
              )
            : null,
      };
    },
    async facetsByOwner(owner: string) {
      const ids = allowedIds ? [...allowedIds] : undefined;
      if (ids?.length === 0)
        return { projects: [], kinds: [], truncated: false };
      const [projects, kinds] = await Promise.all([
        db.$queryRaw<Array<{ slug: string; count: bigint }>>(Prisma.sql`
          SELECT p.slug, count(DISTINCT n.id)::bigint AS count
          FROM notes n CROSS JOIN LATERAL unnest(n.projects) p(slug)
          WHERE ${scope(owner, ids)} GROUP BY p.slug
          ORDER BY p.slug COLLATE "C" ASC LIMIT 201`),
        db.$queryRaw<Array<{ slug: string; count: bigint }>>(Prisma.sql`
          SELECT n.kind AS slug, count(*)::bigint AS count FROM notes n
          WHERE ${scope(owner, ids)} GROUP BY n.kind ORDER BY n.kind COLLATE "C" ASC LIMIT 7`),
      ]);
      const dto = (rows: Array<{ slug: string; count: bigint }>) =>
        rows.map((r) => ({ slug: r.slug, count: Number(r.count) }));
      return {
        projects: dto(projects.slice(0, 200)),
        kinds: dto(kinds),
        truncated: projects.length > 200,
      };
    },
  };
}
