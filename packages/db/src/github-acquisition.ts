import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { GitHubSyncStatus, GitHubSyncResult } from "@pce/contracts";
import {
  GitHubContentStore,
  type GitHubContentStoreOptions,
} from "./github-content-store.js";
import type { ListPendingOptions, PendingPage } from "./content-store-port.js";

export function githubFetchConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitHubContentStoreOptions | null {
  const gate = env.PCE_GITHUB_FETCH_ENABLED;
  if (gate !== undefined && gate !== "true" && gate !== "false")
    throw new Error("Invalid GitHub fetch gate");
  if (gate !== "true") return null;
  if (env.PCE_INGEST_GITHUB === "true" || env.WORKER_ALLOW_GITHUB_WRITES)
    throw new Error("Stop legacy ingestion before enabling staging");
  const {
    CONTENT_REPOSITORY: repository,
    CONTENT_BRANCH: branch,
    CONTENT_GITHUB_TOKEN: token,
  } = env;
  if (
    !repository ||
    !branch ||
    !token ||
    repository.length > 256 ||
    branch.length > 128 ||
    token.length > 4096
  )
    throw new Error("GitHub fetch configuration incomplete");
  // Validate using the existing adapter without opening a network connection.
  new GitHubContentStore({ repository, branch, token });
  return { repository: repository.toLowerCase(), branch, token };
}

interface ArtifactFile {
  path: string;
  revision: string;
  rawContent: Uint8Array;
}
interface ArtifactReader {
  listArtifacts(options?: ListPendingOptions): Promise<PendingPage>;
  readArtifact(path: string): Promise<ArtifactFile>;
}
const scopeKey = (owner: string, repository: string, branch: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "github-staging-v1",
        owner,
        repository.toLowerCase(),
        branch,
      ]),
    )
    .digest("hex");

/** Acquisition commits only originals and discovery progress; never canonical data. */
export async function acquireGitHubArtifacts(
  db: PrismaClient,
  owner: string,
  config: GitHubContentStoreOptions,
  options: {
    store?: ArtifactReader;
    limit?: number;
    timeBudgetMs?: number;
  } = {},
): Promise<GitHubSyncResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:|@-]{0,127}$/.test(owner))
    throw new TypeError("Invalid staging owner");
  const limit = options.limit ?? 10;
  const budget = options.timeBudgetMs ?? 15000;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > 30000
  )
    throw new TypeError("Invalid acquisition bounds");
  const deadline = Date.now() + budget;
  const store =
    options.store ??
    new GitHubContentStore({
      ...config,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        }),
    });
  const key = scopeKey(owner, config.repository, config.branch);
  const checkpoint = await db.ingestionCheckpoint.upsert({
    where: { key },
    create: { key },
    update: {},
  });
  const page = await store.listArtifacts({
    ...(checkpoint.cursor ? { cursor: checkpoint.cursor } : {}),
    limit,
  });
  const report: GitHubSyncResult = {
    examined: 0,
    staged: 0,
    alreadyStaged: 0,
    failed: 0,
    hasMore: false,
  };
  let cursor = checkpoint.cursor;
  let completedPage = true;
  let scanFailed = checkpoint.cursor ? checkpoint.reconciliationPending : false;
  for (const ref of page.files) {
    if (Date.now() >= deadline) {
      completedPage = false;
      break;
    }
    report.examined++;
    const identity = {
      ownerSubject: owner,
      provider: "github",
      repository: config.repository.toLowerCase(),
      branch: config.branch,
      sourcePath: ref.path,
      sourceRevision: ref.revision,
    };
    if (
      await db.ingestionStaging.findUnique({
        where: {
          ownerSubject_provider_repository_branch_sourcePath_sourceRevision:
            identity,
        },
        select: { id: true },
      })
    ) {
      report.alreadyStaged++;
    } else {
      let file: ArtifactFile;
      try {
        file = await store.readArtifact(ref.path);
        if (file.path !== ref.path || file.revision !== ref.revision)
          throw new Error("Source changed");
      } catch {
        // Unsafe/unreadable sources remain in GitHub. Count the failure and
        // revisit on the next sweep, without starving later independent files.
        report.failed++;
        scanFailed = true;
        cursor = ref.path;
        continue;
      }
      const rawContent = Buffer.from(file.rawContent);
      const contentHash = createHash("sha256").update(rawContent).digest("hex");
      const artifactType = ref.path.startsWith("tasks/")
        ? "task"
        : ref.path.startsWith("research/")
          ? "research"
          : "note";
      const inserted = await db.ingestionStaging.createMany({
        data: [{ ...identity, artifactType, rawContent, contentHash }],
        skipDuplicates: true,
      });
      if (inserted.count) report.staged++;
      else report.alreadyStaged++;
    }
    cursor = ref.path;
  }
  report.hasMore = !completedPage || Boolean(page.nextCursor);
  await db.ingestionCheckpoint.updateMany({
    where: { key, version: checkpoint.version },
    data: {
      cursor: report.hasMore ? cursor : null,
      version: { increment: 1 },
      reconciliationPending: scanFailed,
      ...(completedPage && !page.nextCursor && !scanFailed
        ? { lastScanAt: new Date() }
        : {}),
    },
  });
  return report;
}

export async function githubSyncStatus(
  db: PrismaClient,
  owner: string,
  config: GitHubContentStoreOptions | null,
): Promise<GitHubSyncStatus> {
  const checkpoint = config
    ? await db.ingestionCheckpoint.findUnique({
        where: { key: scopeKey(owner, config.repository, config.branch) },
      })
    : null;
  const groups = await db.ingestionStaging.groupBy({
    by: ["status"],
    where: { ownerSubject: owner },
    _count: true,
  });
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count]));
  return {
    enabled: Boolean(config),
    reason: config
      ? null
      : "GitHub fetching is disabled on this API. Use a GitHub-capable local worker or ask the operator to verify API egress before enabling it.",
    lastSuccessfulScan: checkpoint?.lastScanAt?.toISOString() ?? null,
    hasMore: Boolean(checkpoint?.cursor),
    pending: (counts.PENDING ?? 0) + (counts.RETRY ?? 0) + (counts.LEASED ?? 0),
    processed: counts.PROCESSED ?? 0,
    invalid: counts.INVALID ?? 0,
  };
}

export function createGitHubSyncService(
  db: PrismaClient,
  owner: string,
  config: GitHubContentStoreOptions | null,
) {
  return {
    allowedOwner: owner,
    status: (subject: string) => {
      if (subject !== owner) throw new TypeError("Invalid sync owner");
      return githubSyncStatus(db, subject, config);
    },
    acquire: (subject: string) => {
      if (subject !== owner || !config) throw new TypeError("Sync unavailable");
      return acquireGitHubArtifacts(db, subject, config);
    },
  };
}
