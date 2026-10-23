import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ResearchArtifactSchema } from "@pce/contracts";
import { createResearchRepository } from "@pce/db";
import type { ResearchIngressStore } from "./content-store/port.js";
import { ContentStoreError } from "./content-store/port.js";

const MAX_PER_PASS = 100;
const DEFAULT_PER_PASS = 50;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface ResearchIngressConfig {
  repository: string;
  branch: string;
  token: string;
}

/** Opt-in reader credentials are distinct from the capture/publisher writers. */
export function researchIngressConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResearchIngressConfig | null {
  const enabled = env.PCE_RESEARCH_INGRESS_ENABLED;
  if (enabled === undefined || enabled === "false") return null;
  if (enabled !== "true") throw new Error("Invalid research ingress gate");
  const repository = env.PCE_RESEARCH_INGRESS_REPOSITORY ?? "";
  const branch = env.PCE_RESEARCH_INGRESS_BRANCH ?? "";
  const token = env.PCE_RESEARCH_INGRESS_TOKEN ?? "";
  if (
    !REPOSITORY.test(repository) ||
    !BRANCH.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    !token ||
    token.length > 4096
  )
    throw new Error("Invalid research ingress configuration");
  return { repository, branch, token };
}

/** Separate from note ingestion checkpoints, scoped to one trusted owner. */
export function researchIngressCheckpointKey(
  owner: string,
  repository: string,
  branch: string,
): string {
  if (
    !OWNER.test(owner) ||
    !REPOSITORY.test(repository) ||
    !BRANCH.test(branch)
  )
    throw new Error("Invalid research checkpoint scope");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "research-inbox-v1",
        owner,
        repository.toLowerCase(),
        branch,
      ]),
    )
    .digest("hex");
}

export interface ResearchImportPassOptions {
  db: PrismaClient;
  store: ResearchIngressStore;
  ownerSubject: string;
  checkpointKey: string;
  limit?: number;
  now?: () => Date;
  /** Synthetic test seam; production uses owner-scoped repository importer. */
  importArtifact?: (
    owner: string,
    content: string,
    path: string,
    revision: string,
  ) => Promise<{ replayed: boolean }>;
}

export interface ResearchImportPassReport {
  scanned: number;
  imported: number;
  replayed: number;
  deferred: number;
  invalid: number;
  hasMore: boolean;
}

/**
 * Finite pass on the EXISTING DB-jobs worker loop; does not browse the web,
 * generate research, mutate source files, or expose private content in logs.
 *
 * The checkpoint advances on failures, but resets at the end of every sweep.
 * Missing parent notes, conflicts and transient reads are retried on the next
 * sweep without deleting either GitHub input file. Replays are idempotent.
 */
export async function runResearchImportPass({
  db,
  store,
  ownerSubject,
  checkpointKey,
  limit = DEFAULT_PER_PASS,
  now = () => new Date(),
  importArtifact,
}: ResearchImportPassOptions): Promise<ResearchImportPassReport> {
  if (!OWNER.test(ownerSubject) || !/^[a-f0-9]{64}$/.test(checkpointKey))
    throw new Error("Invalid research scope");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PER_PASS)
    throw new Error("Invalid research pass limit");
  const importer = importArtifact ?? createResearchRepository(db).importByOwner;
  const checkpoint = await db.ingestionCheckpoint.upsert({
    where: { key: checkpointKey },
    create: { key: checkpointKey },
    update: {},
  });
  const page = await store.listResearch({
    ...(checkpoint.cursor ? { cursor: checkpoint.cursor } : {}),
    limit,
  });
  const report: ResearchImportPassReport = {
    scanned: 0,
    imported: 0,
    replayed: 0,
    deferred: 0,
    invalid: 0,
    hasMore: Boolean(page.nextCursor),
  };
  for (const ref of page.files) {
    report.scanned++;
    const attemptId = createHash("sha256")
      .update(JSON.stringify([checkpointKey, ref.path]))
      .digest("hex");
    const prior = await db.researchIngressAttempt.findUnique({
      where: { id: attemptId },
    });
    const same = prior?.sourceRevision === ref.revision;
    if (
      same &&
      (prior.status === "IMPORTED" ||
        prior.status === "INVALID" ||
        (prior.nextRetryAt && prior.nextRetryAt > now()))
    ) {
      if (prior.status === "IMPORTED") report.replayed++;
      else if (prior.status === "INVALID") report.invalid++;
      else report.deferred++;
      continue;
    }
    let parentNoteId: string | null = null;
    const count = (same ? (prior?.attemptCount ?? 0) : 0) + 1;
    const record = async (status: string, code: string | null) => {
      const data = {
        ownerSubject,
        checkpointKey,
        sourcePath: ref.path,
        sourceRevision: ref.revision,
        parentNoteId,
        status,
        attemptCount: count,
        lastErrorCode: code,
        nextRetryAt:
          status === "RETRY"
            ? new Date(
                now().getTime() +
                  Math.min(3600000, 5000 * 2 ** Math.min(count, 10)),
              )
            : null,
      };
      await db.researchIngressAttempt.upsert({
        where: { id: attemptId },
        create: { id: attemptId, ...data },
        update: data,
      });
    };
    try {
      const read = await store.readResearch(ref.path);
      if (read.path !== ref.path || read.revision !== ref.revision) {
        report.deferred++;
        await record("RETRY", "SOURCE_CHANGED");
        continue;
      }
      try {
        const parsed = ResearchArtifactSchema.safeParse(
          JSON.parse(read.content),
        );
        if (parsed.success) parentNoteId = parsed.data.parentNoteId;
      } catch {
        /* The importer reports malformed input with a fixed status. */
      }
      const receipt = await importer(
        ownerSubject,
        read.content,
        ref.path,
        ref.revision,
      );
      if (receipt.replayed) report.replayed++;
      else report.imported++;
      await record("IMPORTED", null);
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof ContentStoreError &&
          ["INVALID_CONTENT", "UNSAFE_ENTRY", "INVALID_PATH"].includes(
            error.code,
          )) ||
        (error instanceof Error && error.name === "ZodError")
      ) {
        report.invalid++;
        await record("INVALID", "INVALID_ARTIFACT");
      } else {
        report.deferred++;
        await record("RETRY", "DEPENDENCY_OR_SOURCE_UNAVAILABLE");
      }
      // Never log error messages: source text, paths, URLs may be embedded.
    }
  }
  // Retain the last fully visited page boundary, not a speculative tree cursor.
  // End-of-sweep resets allow repairs to missing parent notes and failed writes.
  await db.ingestionCheckpoint.update({
    where: { key: checkpointKey },
    data: { cursor: page.nextCursor ?? null, lastScanAt: now() },
  });
  return report;
}
