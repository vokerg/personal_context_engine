import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ContentFile,
  ContentRef,
  ContentStore,
  ContentStoreErrorCode,
  FinalizeRequest,
  ListPendingOptions,
  PendingPage,
  TransitionRequest,
  TransitionResult,
} from "./port.js";
import { ContentStoreError } from "./port.js";

const FILE_NAME = "[a-zA-Z0-9][a-zA-Z0-9._-]*\\.md";
const INBOX_PATH = new RegExp(`^inbox/(${FILE_NAME})$`);
const REJECTED_PATH = new RegExp(`^rejected/(${FILE_NAME})$`);
const NOTES_PATH = new RegExp(
  `^notes/[0-9]{4}/(0[1-9]|1[0-2])/(${FILE_NAME})$`,
);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type PathKind = "inbox" | "notes" | "rejected" | "any";

function invalid(code: ContentStoreErrorCode): never {
  const descriptions: Record<ContentStoreErrorCode, string> = {
    INVALID_PATH: "Content path is not permitted.",
    INVALID_CURSOR: "Pending cursor is invalid.",
    INVALID_LIMIT: "Pending page limit is invalid.",
    NOT_FOUND: "Content entry is missing.",
    REVISION_CONFLICT: "Source revision changed; re-read before retrying.",
    DESTINATION_CONFLICT: "Destination already contains different content.",
    UNSAFE_ENTRY: "Content sandbox contains an unsafe entry.",
    INVALID_CONTENT: "Content must be valid UTF-8 within the size limit.",
    PERMISSION_DENIED: "Content sandbox access was denied.",
    IO_ERROR: "Content sandbox operation failed.",
  };
  throw new ContentStoreError(code, descriptions[code]);
}

function assertPath(path: string, kind: PathKind = "any"): void {
  if (
    typeof path !== "string" ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    !(kind === "inbox"
      ? INBOX_PATH.test(path)
      : kind === "notes"
        ? NOTES_PATH.test(path)
        : kind === "rejected"
          ? REJECTED_PATH.test(path)
          : INBOX_PATH.test(path) ||
            NOTES_PATH.test(path) ||
            REJECTED_PATH.test(path))
  ) {
    invalid("INVALID_PATH");
  }
  // Reject dotfiles and suspicious path segments on every platform.
  if (
    path
      .split("/")
      .some((part) => part === "." || part === ".." || part.startsWith("."))
  ) {
    invalid("INVALID_PATH");
  }
  const baseName = path.split("/").at(-1)?.split(".")[0];
  if (baseName && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName)) {
    invalid("INVALID_PATH");
  }
}

function assertRevision(revision: string): void {
  if (!SHA256.test(revision)) invalid("REVISION_CONFLICT");
}

function normalizeError(error: unknown): never {
  if (error instanceof ContentStoreError) throw error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") invalid("NOT_FOUND");
  if (code === "EEXIST") invalid("DESTINATION_CONFLICT");
  if (code === "EACCES" || code === "EPERM") invalid("PERMISSION_DENIED");
  if (code === "ELOOP" || code === "ENOTDIR") invalid("UNSAFE_ENTRY");
  invalid("IO_ERROR");
}

function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Deliberately local, synthetic-only sandbox. No global process chdir, repo or
 * DB access. Does not follow directory/file symlinks or read hard-linked files.
 *
 * External processes rewriting paths during a transition cannot be locked by
 * portable Node filesystem APIs; only run against a trusted, exclusive sandbox.
 */
export class FilesystemContentStore implements ContentStore {
  constructor(private readonly rootDir: string) {
    if (!isAbsolute(rootDir)) invalid("INVALID_PATH");
  }

  private absolute(path: string): string {
    return join(this.rootDir, ...path.split("/"));
  }

  private async ensureDirectory(
    path: string,
    create = false,
  ): Promise<boolean> {
    const parts = path ? path.split("/") : [];
    let current = this.rootDir;
    const directories = [current];
    for (const part of parts) {
      current = join(current, part);
      directories.push(current);
    }
    for (let i = 0; i < directories.length; i += 1) {
      const directory = directories[i];
      if (!directory) invalid("UNSAFE_ENTRY");
      if (create && i > 0) {
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            normalizeError(error);
          }
        }
      }
      try {
        const entry = await lstat(directory);
        if (!entry.isDirectory() || entry.isSymbolicLink())
          invalid("UNSAFE_ENTRY");
      } catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === "ENOENT")
          return false;
        normalizeError(error);
      }
    }
    return true;
  }

  private async readBytes(
    path: string,
  ): Promise<{ bytes: Buffer; revision: string }> {
    assertPath(path);
    if (!(await this.ensureDirectory(path.split("/").slice(0, -1).join("/")))) {
      invalid("NOT_FOUND");
    }
    let handle;
    try {
      // Lstat blocks symlinks on all platforms; O_NOFOLLOW additionally guards
      // against a final-component symlink swap on POSIX.
      const entry = await lstat(this.absolute(path));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
        invalid("UNSAFE_ENTRY");
      handle = await open(
        this.absolute(path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) invalid("UNSAFE_ENTRY");
      if (info.size > MAX_FILE_BYTES) invalid("INVALID_CONTENT");
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_FILE_BYTES) invalid("INVALID_CONTENT");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalid("INVALID_CONTENT");
      }
      return { bytes, revision: revisionOf(bytes) };
    } catch (error) {
      return normalizeError(error);
    } finally {
      await handle?.close();
    }
  }

  async read(path: string): Promise<ContentFile> {
    const { bytes, revision } = await this.readBytes(path);
    return { path, revision, content: bytes.toString("utf8") };
  }

  async stat(path: string): Promise<ContentRef | null> {
    assertPath(path);
    try {
      const { revision } = await this.readBytes(path);
      return { path, revision };
    } catch (error) {
      if (error instanceof ContentStoreError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  }

  async listPending(options: ListPendingOptions = {}): Promise<PendingPage> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      invalid("INVALID_LIMIT");
    }
    if (options.cursor !== undefined) {
      try {
        assertPath(options.cursor, "inbox");
      } catch (error) {
        if (error instanceof ContentStoreError && error.code === "INVALID_PATH")
          invalid("INVALID_CURSOR");
        throw error;
      }
    }
    await this.ensureDirectory("inbox", true);
    let names: string[];
    try {
      const entries = await readdir(this.absolute("inbox"), {
        withFileTypes: true,
      });
      names = entries
        .filter((item) => INBOX_PATH.test(`inbox/${item.name}`))
        .map((item) => item.name)
        .sort();
    } catch (error) {
      normalizeError(error);
    }
    const paths = names
      .map((name) => `inbox/${name}`)
      .filter((path) => options.cursor === undefined || path > options.cursor);
    const selected = paths.slice(0, limit);
    const files: ContentRef[] = [];
    for (const path of selected) {
      const file = await this.read(path);
      files.push({ path, revision: file.revision });
    }
    if (paths.length > selected.length && selected.length > 0) {
      return { files, nextCursor: selected[selected.length - 1]! };
    }
    return { files };
  }

  async finalize(request: FinalizeRequest): Promise<TransitionResult> {
    assertPath(request.destinationPath, "notes");
    return this.transition(request, request.destinationPath);
  }

  async reject(request: TransitionRequest): Promise<TransitionResult> {
    assertPath(request.sourcePath, "inbox");
    const fileName = request.sourcePath.slice("inbox/".length);
    const target = `rejected/${fileName}`;
    assertPath(target, "rejected");
    return this.transition(request, target);
  }

  private async transition(
    request: TransitionRequest,
    destinationPath: string,
  ): Promise<TransitionResult> {
    assertPath(request.sourcePath, "inbox");
    assertRevision(request.expectedRevision);

    const source = await this.stat(request.sourcePath);
    const destination = await this.stat(destinationPath);

    if (!source) {
      if (destination?.revision === request.expectedRevision) {
        return { ...destination, status: "already_finalized" };
      }
      invalid("NOT_FOUND");
    }
    if (source.revision !== request.expectedRevision)
      invalid("REVISION_CONFLICT");
    if (destination && destination.revision !== request.expectedRevision) {
      invalid("DESTINATION_CONFLICT");
    }

    if (destination) {
      // Crash after destination copy, before source deletion: recover only when
      // both sides still match the requested revision.
      await this.removeUnchanged(request.sourcePath, request.expectedRevision);
      return { ...destination, status: "recovered" };
    }

    const { bytes, revision } = await this.readBytes(request.sourcePath);
    if (revision !== request.expectedRevision) invalid("REVISION_CONFLICT");
    await this.ensureDirectory(
      destinationPath.split("/").slice(0, -1).join("/"),
      true,
    );

    let handle;
    let created = false;
    let copied = false;
    try {
      handle = await open(
        this.absolute(destinationPath),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      copied = true;
      await this.removeUnchanged(request.sourcePath, request.expectedRevision);
      return { path: destinationPath, revision, status: "moved" };
    } catch (error) {
      // If source unlink fails, leave the complete destination in place for
      // explicit recovery on retry. Incomplete copies are safe to remove.
      if (created && !copied) {
        try {
          await handle?.close();
          await unlink(this.absolute(destinationPath));
        } catch {
          // Preserve the original failure; never delete the source here.
        }
      }
      return normalizeError(error);
    } finally {
      await handle?.close();
    }
  }

  private async removeUnchanged(
    path: string,
    expectedRevision: string,
  ): Promise<void> {
    const current = await this.stat(path);
    if (!current || current.revision !== expectedRevision)
      invalid("REVISION_CONFLICT");
    try {
      await unlink(this.absolute(path));
    } catch (error) {
      normalizeError(error);
    }
  }
}
