import { randomUUID } from "node:crypto";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TOKEN_RESERVATION,
  EMBEDDING_DAILY_TOKEN_LIMIT,
  type EmbeddingJob,
  type EmbeddingFailureCode,
} from "@pce/db";

export type EmbeddingResult = { vector: number[]; usageTokens: number };
export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
}
export class EmbeddingProviderError extends Error {
  constructor(
    public readonly code: EmbeddingFailureCode,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "EmbeddingProviderError";
  }
}

/** Server-only provider. No note bodies, credentials or response bodies logged. */
export function createOpenAIEmbeddingProvider(
  key: string,
  project: string,
  request: typeof fetch = fetch,
): EmbeddingProvider {
  if (
    !/^sk-[A-Za-z0-9_-]{20,}$/.test(key) ||
    !/^proj[-_][A-Za-z0-9]+$/.test(project)
  )
    throw new Error("Invalid server embedding configuration");
  return {
    async embed(text) {
      if (
        !text ||
        Buffer.byteLength(text, "utf8") > EMBEDDING_TOKEN_RESERVATION
      )
        throw new EmbeddingProviderError("INVALID_RESPONSE", false);
      let response: Response;
      try {
        response = await request("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "OpenAI-Project": project,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: text,
            encoding_format: "float",
            dimensions: EMBEDDING_DIMENSIONS,
          }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        throw new EmbeddingProviderError("PROVIDER_UNAVAILABLE", true);
      }
      if (!response.ok) {
        if (response.status === 429)
          throw new EmbeddingProviderError("RATE_LIMIT", true);
        if (response.status >= 500)
          throw new EmbeddingProviderError("PROVIDER_5XX", true);
        throw new EmbeddingProviderError("PROVIDER_4XX", false);
      }
      try {
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object")
          throw new Error("Invalid payload");
        const data = (payload as { data?: unknown }).data;
        const usage = (payload as { usage?: unknown }).usage;
        if (
          !Array.isArray(data) ||
          data.length !== 1 ||
          !data[0] ||
          !Array.isArray(data[0].embedding) ||
          !usage ||
          typeof usage !== "object"
        )
          throw new Error("Invalid embedding response");
        const tokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
        if (
          !Number.isSafeInteger(tokens) ||
          (tokens as number) < 0 ||
          (tokens as number) > 1_000_000 ||
          data[0].embedding.length !== EMBEDDING_DIMENSIONS ||
          data[0].embedding.some(
            (v: unknown) => typeof v !== "number" || !Number.isFinite(v),
          )
        )
          throw new Error("Invalid vector/usage");
        return {
          vector: data[0].embedding as number[],
          usageTokens: tokens as number,
        };
      } catch {
        throw new EmbeddingProviderError("INVALID_RESPONSE", false);
      }
    },
  };
}

export interface EmbeddingQueue {
  candidateNotes(owner: string, afterId?: string): Promise<string[]>;
  prepareNote(
    noteId: string,
    owner: string,
  ): Promise<{ status: string; count: number }>;
  claim(owner: string, worker: string, now: Date): Promise<EmbeddingJob | null>;
  complete(
    owner: string,
    worker: string,
    id: string,
    vector: number[],
    tokens: number,
    now: Date,
  ): Promise<boolean>;
  fail(
    owner: string,
    worker: string,
    id: string,
    code: EmbeddingFailureCode,
    retryable: boolean,
    attempt: number,
    now: Date,
  ): Promise<boolean>;
  reservedTokensToday(owner: string, now: Date): Promise<number>;
  checkpointScan(owner: string, afterNoteId: string | null): Promise<void>;
}

const MAX_REQUESTS = 4;

export interface EmbeddingPassOptions {
  queue: EmbeddingQueue;
  provider: EmbeddingProvider;
  ownerSubject: string;
  workerId?: string;
  afterNoteId?: string;
  now?: () => Date;
}

export async function runEmbeddingPass(options: EmbeddingPassOptions) {
  const { queue, provider, ownerSubject } = options;
  const worker = options.workerId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const prepared = await queue.candidateNotes(
    ownerSubject,
    options.afterNoteId,
  );
  let oversized = 0;
  for (const id of prepared) {
    const result = await queue.prepareNote(id, ownerSubject);
    if (result.status === "oversized") oversized++;
  }
  // Advance only after all preparations commit. Empty page wraps the next
  // pass, so oversized/empty notes cannot starve later notes indefinitely.
  await queue.checkpointScan(ownerSubject, prepared.at(-1) ?? null);
  const report = {
    prepared: prepared.length - oversized,
    oversized,
    requests: 0,
    ready: 0,
    retry: 0,
    failed: 0,
    stale: 0,
    dailyLimitReached: false,
  };
  let reserved = await queue.reservedTokensToday(ownerSubject, now());
  if (reserved + EMBEDDING_TOKEN_RESERVATION > EMBEDDING_DAILY_TOKEN_LIMIT)
    report.dailyLimitReached = true;

  // The DB reserves the worst-case token count atomically with each claim,
  // including retries and expired leases. Local reads are reporting only.
  for (let i = 0; i < MAX_REQUESTS && !report.dailyLimitReached; i++) {
    const job = await queue.claim(ownerSubject, worker, now());
    if (!job) break;
    report.requests++;
    // Validate even replaceable queues before any private-text egress.
    if (
      !job.text ||
      Buffer.byteLength(job.text, "utf8") > EMBEDDING_TOKEN_RESERVATION
    ) {
      await queue.fail(
        ownerSubject,
        worker,
        job.id,
        "INVALID_RESPONSE",
        false,
        job.attemptCount,
        now(),
      );
      report.failed++;
      continue;
    }
    try {
      const answer = await provider.embed(job.text);
      if (
        answer.vector.length !== EMBEDDING_DIMENSIONS ||
        answer.vector.some((v) => !Number.isFinite(v)) ||
        !Number.isSafeInteger(answer.usageTokens) ||
        answer.usageTokens < 0 ||
        answer.usageTokens >
          Math.min(
            EMBEDDING_TOKEN_RESERVATION,
            Buffer.byteLength(job.text, "utf8") + 16,
          )
      )
        throw new EmbeddingProviderError("INVALID_RESPONSE", false);
      const stored = await queue.complete(
        ownerSubject,
        worker,
        job.id,
        answer.vector,
        answer.usageTokens,
        now(),
      );
      if (stored) {
        report.ready++;
      } else {
        report.stale++;
      }
    } catch (error) {
      const classified =
        error instanceof EmbeddingProviderError
          ? error
          : new EmbeddingProviderError("PROVIDER_UNAVAILABLE", true);
      const changed = await queue.fail(
        ownerSubject,
        worker,
        job.id,
        classified.code,
        classified.retryable,
        job.attemptCount,
        now(),
      );
      if (!changed) report.stale++;
      else if (classified.retryable && job.attemptCount < 6) report.retry++;
      else report.failed++;
    }
    reserved = await queue.reservedTokensToday(ownerSubject, now());
    if (reserved + EMBEDDING_TOKEN_RESERVATION > EMBEDDING_DAILY_TOKEN_LIMIT)
      report.dailyLimitReached = true;
  }
  reserved = await queue.reservedTokensToday(ownerSubject, now());
  report.dailyLimitReached =
    reserved + EMBEDDING_TOKEN_RESERVATION > EMBEDDING_DAILY_TOKEN_LIMIT;
  return report;
}
