import { promisify } from "node:util";
import { execFile } from "node:child_process";
const execGit = promisify(execFile);
import { createHash, createHmac } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";

export const subject = "local-developer";
export const issuer = "pce-local-development";
export const audience = "pce-api";

export function localConfig(env) {
  if (env.NODE_ENV && env.NODE_ENV !== "development")
    throw new Error("Local startup requires development mode.");
  if (env.API_HOST && env.API_HOST !== "127.0.0.1")
    throw new Error("Local startup requires API_HOST=127.0.0.1.");
  if (
    env.PCE_INGEST_GITHUB !== undefined &&
    !["true", "false"].includes(env.PCE_INGEST_GITHUB)
  )
    throw new Error("PCE_INGEST_GITHUB must be true or false");
  if (
    env.PCE_LOCAL_BROWSE !== undefined &&
    !["true", "false"].includes(env.PCE_LOCAL_BROWSE)
  )
    throw new Error("PCE_LOCAL_BROWSE must be true or false");
  if (!env.DATABASE_URL) throw new Error("Set DATABASE_URL in the root .env.");
  const port = (value, fallback) => {
    if (value !== undefined && !/^\d{1,5}$/.test(value))
      throw new Error("Invalid local port.");
    const result = Number(value ?? fallback);
    if (result < 1024 || result > 65535) throw new Error("Invalid local port.");
    return result;
  };
  const apiPort = port(env.API_PORT, 3110);
  const webPort = port(env.PCE_WEB_PORT, 4310);
  if (apiPort === webPort) throw new Error("API and web ports must differ.");
  const origins = [
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ];
  return {
    apiPort,
    webPort,
    browseEnabled:
      env.PCE_LOCAL_BROWSE === "true" || env.PCE_DB_SEARCH === "true",
    searchEnabled: env.PCE_DB_SEARCH === "true",
    origin: origins[0],
    origins,
    contentRoot: resolve(
      env.PCE_CONTENT_ROOT ?? "../personal_context_engine_content",
    ),
  };
}

// Validate every file before making any DB write. Never follow content symlinks.
export async function readCaptures(root, { gitSnapshot = false } = {}) {
  const { parseNoteMarkdown, verifyInboxNotePath, NoteValidationError } =
    await import("@pce/core");
  const canonicalRoot = await realpath(root);
  const results = [];
  let rejectedCount = 0;
  const ids = new Set();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Content symlinks are unsupported.");
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = await lstat(path);
        if (stat.size > 1024 * 1024)
          throw new Error("Content file exceeds size limit.");
        let markdown = await readFile(path, "utf8");
        if (gitSnapshot) {
          const actual = relative(canonicalRoot, path).split(sep).join("/");
          const blob = (
            await execGit(
              "git",
              ["-C", canonicalRoot, "show", `HEAD:${actual}`],
              { maxBuffer: 2 * 1024 * 1024 },
            )
          ).stdout;
          if (
            markdown.replaceAll("\r\n", "\n") !== blob.replaceAll("\r\n", "\n")
          )
            throw new Error("Checkout differs from Git snapshot");
          markdown = blob;
        }
        let metadata;
        try {
          ({ metadata } = parseNoteMarkdown(markdown));
        } catch (error) {
          if (!(error instanceof NoteValidationError)) throw error;
          rejectedCount++;
          continue;
        }
        if (ids.has(metadata.id)) throw new Error("Duplicate note identifier.");
        ids.add(metadata.id);
        const sourcePath = `inbox/${metadata.captured_at.slice(0, 10)}_${metadata.id}.md`;
        const actual = relative(canonicalRoot, path).split(sep).join("/");
        if (actual.startsWith("inbox/")) verifyInboxNotePath(actual, metadata);
        else if (
          actual !==
          `notes/${metadata.captured_at.slice(0, 4)}/${metadata.captured_at.slice(5, 7)}/${metadata.id}.md`
        )
          throw new Error("Invalid canonical note path.");
        results.push({
          markdown,
          sourcePath,
          ownerSubject: subject,
          sourceRevision: createHash("sha1")
            .update(`blob ${Buffer.byteLength(markdown)}\0`)
            .update(markdown)
            .digest("hex"),
        });
      }
    }
  }
  for (const name of ["inbox", "notes"]) {
    const path = join(canonicalRoot, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Invalid content directory.");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await walk(path);
  }
  return { captures: results, rejectedCount };
}

export function createLocalReader(
  db,
  allowedIds,
  { browseEnabled = false, cursorSecret } = {},
) {
  if (browseEnabled && (!cursorSecret || Buffer.byteLength(cursorSecret) < 32))
    throw new Error("Browse signing key required");
  const owned = (owner) => ({
    ownerSubject: owner,
    id: { in: allowedIds },
    removedAt: null,
  });
  const preview = {
    id: true,
    title: true,
    summary: true,
    capturedAt: true,
    tags: true,
    archivedAt: true,
  };
  const dto = ({ archivedAt, ...note }) => ({
    ...note,
    status: archivedAt ? "archived" : "active",
    capturedAt: note.capturedAt.toISOString(),
  });
  const scopedFilters = (owner, filters = {}) => {
    const status = filters.status ?? "active";
    const where = {
      ...owned(owner),
      ...(status === "active"
        ? { archivedAt: null }
        : status === "archived"
          ? { archivedAt: { not: null } }
          : {}),
    };
    if (filters.tag) where.tags = { has: filters.tag };
    if (filters.project) where.projects = { has: filters.project };
    if (filters.kind) where.kind = filters.kind;
    if (filters.from || filters.to) {
      const bounds = {};
      if (filters.from) bounds.gte = new Date(filters.from + "T00:00:00.000Z");
      if (filters.to) {
        const after = new Date(filters.to + "T00:00:00.000Z");
        after.setUTCDate(after.getUTCDate() + 1);
        bounds.lt = after;
      }
      where.capturedAt = bounds;
    }
    return where;
  };
  return {
    ...(browseEnabled
      ? {
          async pageByOwner(owner, query) {
            if (owner !== subject) return { notes: [], nextCursor: null };
            const { createBrowseRepository } = await import("@pce/db");
            return createBrowseRepository(
              db,
              allowedIds,
              cursorSecret,
            ).pageByOwner(owner, query);
          },
          async facetsByOwner(owner, status = "active") {
            if (owner !== subject)
              return { projects: [], kinds: [], truncated: false };
            const { createBrowseRepository } = await import("@pce/db");
            return createBrowseRepository(
              db,
              allowedIds,
              cursorSecret,
            ).facetsByOwner(owner, status);
          },
        }
      : {}),
    async removeByOwner(owner, id) {
      if (owner !== subject || !allowedIds.includes(id)) return false;
      const { createNoteRemovalRepository } = await import("@pce/db");
      return createNoteRemovalRepository(db).removeByOwner(owner, id);
    },
    async setArchivedByOwner(owner, id, archived) {
      if (owner !== subject || !allowedIds.includes(id)) return null;
      const { createNoteArchiveRepository } = await import("@pce/db");
      return createNoteArchiveRepository(db).setArchivedByOwner(
        owner,
        id,
        archived,
      );
    },
    async listByOwner(owner, filters = {}) {
      if (owner !== subject) return [];
      return (
        await db.note.findMany({
          where: scopedFilters(owner, filters),
          select: preview,
          orderBy: [{ capturedAt: "desc" }, { id: "asc" }],
        })
      ).map(dto);
    },
    async listTagsByOwner(owner, status = "active") {
      if (owner !== subject) return { tags: [], truncated: false };
      const { createTagFacetRepository } = await import("@pce/db");
      return createTagFacetRepository(db, allowedIds).listTagsByOwner(
        owner,
        status,
      );
    },
    async getByOwner(owner, id) {
      if (owner !== subject || !allowedIds.includes(id)) return null;
      const note = await db.note.findFirst({
        where: { ...owned(owner), id },
        select: {
          ...preview,
          body: true,
          ...(browseEnabled
            ? {
                originalInput: true,
                capturedAtRaw: true,
                source: true,
                kind: true,
                domains: true,
                projects: true,
                actionHint: true,
                reviewRequired: true,
                occurredAtRaw: true,
                dueAtRaw: true,
                timezone: true,
              }
            : {}),
        },
      });
      if (!note) return null;
      if (!browseEnabled) return dto(note);
      return {
        id: note.id,
        status: note.archivedAt ? "archived" : "active",
        title: note.title,
        summary: note.summary,
        tags: note.tags,
        capturedAt: note.capturedAt.toISOString(),
        body: note.body,
        originalInput: note.originalInput,
        metadata: {
          capturedAtRaw: note.capturedAtRaw,
          source: note.source,
          kind: note.kind,
          domains: note.domains,
          projects: note.projects,
          actionHint: note.actionHint,
          reviewRequired: note.reviewRequired,
          occurredAt: note.occurredAtRaw,
          dueAt: note.dueAtRaw,
          timezone: note.timezone,
        },
      };
    },
  };
}

export function mintSession(secret, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const data =
    encode({ alg: "HS256", typ: "JWT" }) +
    "." +
    encode({
      iss: issuer,
      aud: audience,
      sub: subject,
      scope: "notes:read",
      iat: now,
      exp: now + 900,
    });
  return (
    data + "." + createHmac("sha256", secret).update(data).digest("base64url")
  );
}

export function sessionAllowed(request, origins) {
  const allowedOrigins = (Array.isArray(origins) ? origins : [origins]).map(
    (value) => new URL(value).origin,
  );
  const hostOrigin = allowedOrigins.find(
    (value) => new URL(value).host === request.headers.host,
  );
  return (
    request.method === "GET" &&
    hostOrigin !== undefined &&
    (!request.headers.origin || request.headers.origin === hostOrigin) &&
    [undefined, "same-origin", "none"].includes(
      request.headers["sec-fetch-site"],
    ) &&
    ["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
  );
}

// The old preview importer used SHA-256; GitHub uses Git blob IDs. Bridge only
// verified snapshots with the same trusted owner/path, including proven Git
// checkout line-ending conversions. Never adopt arbitrary changed bytes.
export function createOwnedImporter(db, { checkoutRoot } = {}) {
  return async (input) => {
    const { parseNoteMarkdown, verifyInboxNotePath } =
      await import("@pce/core");
    const { createNoteRepository } = await import("@pce/db");
    const metadata = parseNoteMarkdown(input.markdown).metadata;
    verifyInboxNotePath(input.sourcePath, metadata);
    const id = metadata.id;
    const existing = await db.note.findUnique({ where: { id } });
    const sameOwnerPath =
      existing &&
      existing.ownerSubject === subject &&
      existing.sourcePath === input.sourcePath;
    let sameBytes =
      sameOwnerPath &&
      existing.contentHash ===
        createHash("sha256").update(input.markdown).digest("hex");
    if (sameOwnerPath && !sameBytes && checkoutRoot) {
      let oldBytes;
      try {
        oldBytes = await readFile(join(checkoutRoot, input.sourcePath), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const blob =
        oldBytes === undefined
          ? null
          : (
              await execGit(
                "git",
                ["-C", checkoutRoot, "show", `HEAD:${input.sourcePath}`],
                { maxBuffer: 2 * 1024 * 1024 },
              )
            ).stdout;
      sameBytes =
        oldBytes !== undefined &&
        existing.contentHash ===
          createHash("sha256").update(oldBytes).digest("hex") &&
        oldBytes.replaceAll("\r\n", "\n") ===
          input.markdown.replaceAll("\r\n", "\n") &&
        blob === input.markdown;
    }
    if (
      existing &&
      existing.sourceRevision === input.sourceRevision &&
      sameBytes
    ) {
      return { noteId: id, result: "replayed" };
    }
    return createNoteRepository(db).importMarkdown({
      ...input,
      ownerSubject: subject,
      ...(sameBytes
        ? { expectedPreviousRevision: existing.sourceRevision }
        : {}),
    });
  };
}
