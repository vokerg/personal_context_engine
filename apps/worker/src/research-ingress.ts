import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
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
    try {
      const read = await store.readResearch(ref.path);
      if (read.path !== ref.path || read.revision !== ref.revision) {
        report.deferred++;
        continue;
      }
      const receipt = await importer(
        ownerSubject,
        read.content,
        ref.path,
        ref.revision,
      );
      if (receipt.replayed) report.replayed++;
      else report.imported++;
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof ContentStoreError &&
          error.code === "INVALID_CONTENT") ||
        (error instanceof Error && error.name === "ZodError")
      )
        report.invalid++;
      else report.deferred++;
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
