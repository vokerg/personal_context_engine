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
  return {
    apiPort,
    webPort,
    origin: `http://127.0.0.1:${webPort}`,
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

export function createLocalReader(db, allowedIds) {
  const owned = (owner) => ({ ownerSubject: owner, id: { in: allowedIds } });
  const preview = { id: true, title: true, summary: true, capturedAt: true };
  const dto = (note) => ({
    ...note,
    capturedAt: note.capturedAt.toISOString(),
  });
  return {
    async listByOwner(owner) {
      if (owner !== subject) return [];
      return (
        await db.note.findMany({
          where: owned(owner),
          select: preview,
          orderBy: [{ capturedAt: "desc" }, { id: "asc" }],
        })
      ).map(dto);
    },
    async getByOwner(owner, id) {
      if (owner !== subject || !allowedIds.includes(id)) return null;
      const note = await db.note.findFirst({
        where: { ...owned(owner), id },
        select: { ...preview, body: true },
      });
      return note ? dto(note) : null;
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

export function sessionAllowed(request, origin) {
  return (
    request.method === "GET" &&
    request.headers.host === new URL(origin).host &&
    (!request.headers.origin || request.headers.origin === origin) &&
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
      const oldBytes = await readFile(
        join(checkoutRoot, input.sourcePath),
        "utf8",
      );
      const blob = (
        await execGit(
          "git",
          ["-C", checkoutRoot, "show", `HEAD:${input.sourcePath}`],
          { maxBuffer: 2 * 1024 * 1024 },
        )
      ).stdout;
      sameBytes =
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
