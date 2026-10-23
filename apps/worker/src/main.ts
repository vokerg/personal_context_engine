import { runEmbeddingLoop } from "./embedding-loop.js";
import { runDbJobPass } from "./db-jobs.js";
import { runTagSnapshotPass } from "./tag-snapshot-jobs.js";
import {
  researchIngressCheckpointKey,
  researchIngressConfig,
  runResearchImportPass,
} from "./research-ingress.js";
import {
  snapshotPublisherConfig,
  createApprovedTagsPublisher,
} from "./tag-snapshot-publisher.js";
import { embeddingConfig } from "./embedding-config.js";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  checkDatabase,
  createDatabaseClient,
  createEmbeddingJobRepository,
} from "@pce/db";
import {
  createOpenAIEmbeddingProvider,
  runEmbeddingPass,
} from "./embeddings.js";
import type { ContentStore } from "./content-store/port.js";
import { FilesystemContentStore } from "./content-store/filesystem.js";
import { GitHubContentStore, githubContentStoreFromEnv } from "./content-store/github.js";
import { runIngestionBatch, workerStatus } from "./worker.js";

// Safe scaffold default. Real writes require an explicit worker mode,
// destination backend and DB config; no implicit private repository access.
const mode = process.env.WORKER_MODE;
if (!mode) {
  console.log(
    `Worker scaffold started (${workerStatus().state}; no ingestion configured)`,
  );
  const heartbeat = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(heartbeat);
    console.log("Worker scaffold stopped");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else {
  void start(mode).catch(() => {
    // Never print exception messages: provider exceptions may contain URLs,
    // tokens, local paths or note data.
    console.error("Worker failed (configuration, storage or database error).");
    process.exitCode = 1;
  });
}

async function start(mode: string): Promise<void> {
  if (mode === "db-jobs-once" || mode === "db-jobs-loop") {
    const owner = process.env.PCE_OWNER_SUBJECT;
    if (!owner || !process.env.DATABASE_URL)
      throw new Error("DB jobs require trusted owner and DB");
    const researchOptions = researchIngressConfig(process.env);
    const ingress = researchOptions ? new GitHubContentStore(researchOptions) : null;
    if (ingress) await ingress.verifyPrivateRepository();
    const publisherOptions = snapshotPublisherConfig(process.env);
    const publisher = publisherOptions
      ? createApprovedTagsPublisher(publisherOptions)
      : null;
    const db = createDatabaseClient();
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (mode === "db-jobs-loop") {
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    }
    try {
      await db.$connect();
      await checkDatabase(db);
      const pass = async () => {
        console.log(
          "DB preparation complete " +
            JSON.stringify(await runDbJobPass(db, owner)),
        );
        if (publisher) {
          console.log(
            "Tag snapshot pass complete " +
              JSON.stringify(await runTagSnapshotPass(db, owner, publisher)),
          );
        }
        if (ingress && researchOptions) {
          const checkpointKey = researchIngressCheckpointKey(
            owner,
            researchOptions.repository,
            researchOptions.branch,
          );
          const report = await runResearchImportPass({
            db,
            store: ingress,
            ownerSubject: owner,
            checkpointKey,
          });
          console.log("Research import pass complete " + JSON.stringify(report));
        }
      };
      if (mode === "db-jobs-loop")
        await runEmbeddingLoop(pass, controller.signal);
      else await pass();
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      await db.$disconnect();
    }
    return;
  }
  if (mode === "embeddings-once" || mode === "embeddings-loop")
    return startEmbeddings(mode === "embeddings-loop");
  if (mode !== "once") throw new Error("Unsupported worker mode.");
  if (!process.env.DATABASE_URL) throw new Error("Database is required.");
  let store: ContentStore;
  let scanCheckpointKey: string | undefined;
  if (process.env.WORKER_CONTENT_BACKEND === "filesystem") {
    const root = process.env.WORKER_CONTENT_ROOT;
    if (!root || !isAbsolute(root))
      throw new Error("Absolute content sandbox required.");
    store = new FilesystemContentStore(root);
  } else if (process.env.WORKER_CONTENT_BACKEND === "github") {
    if (
      process.env.WORKER_ALLOW_GITHUB_WRITES !== "I_VERIFIED_PRIVATE_REPOSITORY"
    ) {
      throw new Error("Explicit private repository opt-in required.");
    }
    const github = githubContentStoreFromEnv();
    await github.verifyPrivateRepository();
    store = github;
    scanCheckpointKey = createHash("sha256")
      .update(
        JSON.stringify([
          "github",
          process.env.CONTENT_REPOSITORY?.toLowerCase(),
          process.env.CONTENT_BRANCH,
          null,
        ]),
      )
      .digest("hex");
  } else {
    throw new Error("Explicit ContentStore backend required.");
  }
  const db = createDatabaseClient();
  try {
    await db.$connect();
    await checkDatabase(db);
    const result = await runIngestionBatch({
      db,
      store,
      ...(scanCheckpointKey ? { scanCheckpointKey } : {}),
    });
    // Counts only; never expose note bodies, paths or identifiers in logs.
    console.log("Worker pass complete " + JSON.stringify(result));
  } finally {
    await db.$disconnect();
  }
}

/** Explicit trusted command; never started by local preview or ingestion. */
async function startEmbeddings(recurring = false): Promise<void> {
  const { owner, key, project, afterNoteId } = embeddingConfig(
    process.env,
    recurring,
  );
  // Validate the provider before opening DB; no content leaves the host if invalid.
  const provider = createOpenAIEmbeddingProvider(key, project);
  const db = createDatabaseClient();
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (recurring) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  try {
    await db.$connect();
    await checkDatabase(db);
    const pass = async () => {
      if (recurring) {
        const preparation = await runDbJobPass(db, owner);
        console.log("DB preparation complete " + JSON.stringify(preparation));
      }
      const report = await runEmbeddingPass({
        queue: createEmbeddingJobRepository(db),
        provider,
        ownerSubject: owner,
        ...(afterNoteId ? { afterNoteId } : {}),
      });
      console.log(
        "Embedding pass complete " +
          JSON.stringify({ at: new Date().toISOString(), ...report }),
      );
    };
    if (recurring) await runEmbeddingLoop(pass, controller.signal);
    else await pass();
  } finally {
    if (recurring) {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
    await db.$disconnect();
  }
}
