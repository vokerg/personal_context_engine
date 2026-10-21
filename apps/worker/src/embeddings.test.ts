import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIEmbeddingProvider,
  EmbeddingProviderError,
  runEmbeddingPass,
  type EmbeddingQueue,
} from "./embeddings.js";

const vector = Array<number>(1536).fill(0.125);
function fakeQueue(overrides: Partial<EmbeddingQueue> = {}): EmbeddingQueue {
  const jobs = [
    { id: "job-a", chunkId: "chunk-a", text: "Synthetic.", attemptCount: 1 },
  ];
  return {
    checkpointScan: vi.fn(async () => {}),
    candidateNotes: vi.fn(async () => ["note-a"]),
    prepareNote: vi.fn(async () => ({ status: "synchronized", count: 1 })),
    claim: vi.fn(async () => jobs.shift() ?? null),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    reservedTokensToday: vi.fn(async () => 0),
    ...overrides,
  };
}

describe("asynchronous embedding pass with fake provider (no network)", () => {
  it("indexes a bounded owner-only queue without touching a content store", async () => {
    const queue = fakeQueue();
    const embed = vi.fn(async () => ({ vector, usageTokens: 5 }));
    const report = await runEmbeddingPass({
      queue,
      provider: { embed },
      ownerSubject: "synthetic-owner",
      workerId: "worker",
      now: () => new Date("2026-10-19T09:00:00Z"),
    });
    expect(report).toMatchObject({
      prepared: 1,
      requests: 1,
      ready: 1,
      retry: 0,
    });
    expect(queue.candidateNotes).toHaveBeenCalledWith(
      "synthetic-owner",
      undefined,
    );
    expect(queue.claim).toHaveBeenCalledWith(
      "synthetic-owner",
      "worker",
      expect.any(Date),
    );
    expect(queue.complete).toHaveBeenCalledWith(
      "synthetic-owner",
      "worker",
      "job-a",
      vector,
      5,
      expect.any(Date),
    );
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("bounds paid requests and refuses more work when daily owner budget is reached", async () => {
    const queue = fakeQueue({ reservedTokensToday: async () => 60_000 });
    const embed = vi.fn();
    const report = await runEmbeddingPass({
      queue,
      provider: { embed },
      ownerSubject: "synthetic-owner",
    });
    expect(report.dailyLimitReached).toBe(true);
    expect(report.requests).toBe(0);
    expect(queue.claim).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("lets the durable claim decide whether a short chunk fits the remaining daily budget", async () => {
    const queue = fakeQueue({ reservedTokensToday: async () => 59000 });
    const embed = vi.fn(async () => ({ vector, usageTokens: 5 }));
    const report = await runEmbeddingPass({
      queue,
      provider: { embed },
      ownerSubject: "synthetic-owner",
    });
    expect(report.ready).toBe(1);
    expect(report.dailyLimitReached).toBe(false);
    expect(report.remainingTokens).toBe(1000);
  });

  it("retries transient provider errors and terminally rejects bad vector dimensions", async () => {
    const retry = fakeQueue();
    const transient = await runEmbeddingPass({
      queue: retry,
      ownerSubject: "owner-a",
      provider: {
        embed: async () => {
          throw new EmbeddingProviderError("RATE_LIMIT", true);
        },
      },
    });
    expect(transient.retry).toBe(1);
    expect(retry.fail).toHaveBeenCalledWith(
      "owner-a",
      expect.any(String),
      "job-a",
      "RATE_LIMIT",
      true,
      1,
      expect.any(Date),
    );

    const invalid = fakeQueue();
    const bad = await runEmbeddingPass({
      queue: invalid,
      ownerSubject: "owner-a",
      provider: { embed: async () => ({ vector: [3], usageTokens: 1 }) },
    });
    expect(bad.failed).toBe(1);
    expect(invalid.complete).not.toHaveBeenCalled();
    expect(invalid.fail).toHaveBeenCalledWith(
      "owner-a",
      expect.any(String),
      "job-a",
      "INVALID_RESPONSE",
      false,
      1,
      expect.any(Date),
    );
  });

  it("treats expired/deleted lease completion as stale, not success", async () => {
    const queue = fakeQueue({ complete: async () => false });
    const result = await runEmbeddingPass({
      queue,
      ownerSubject: "owner-a",
      provider: { embed: async () => ({ vector, usageTokens: 5 }) },
    });
    expect(result.stale).toBe(1);
    expect(result.ready).toBe(0);
  });

  it("uses a server-only POST with strict model and sanitizes remote errors", async () => {
    const key = "sk-synthetic-private-key-123456789";
    const provider = createOpenAIEmbeddingProvider(
      key,
      "proj_synthetic",
      async (url, init) => {
        expect(url).toBe("https://api.openai.com/v1/embeddings");
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${key}`,
        );
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          model: "text-embedding-3-small",
          input: "Synthetic only.",
          encoding_format: "float",
          dimensions: 1536,
        });
        return new Response(
          JSON.stringify({
            data: [{ embedding: vector }],
            usage: { prompt_tokens: 6 },
          }),
          { status: 200 },
        );
      },
    );
    await expect(provider.embed("Synthetic only.")).resolves.toEqual({
      vector,
      usageTokens: 6,
    });

    for (const status of [400, 429, 500]) {
      const failureProvider = createOpenAIEmbeddingProvider(
        key,
        "proj_synthetic",
        async () => new Response(key + " private", { status }),
      );
      await expect(failureProvider.embed("Synthetic.")).rejects.toMatchObject({
        code:
          status === 429
            ? "RATE_LIMIT"
            : status === 500
              ? "PROVIDER_5XX"
              : "PROVIDER_4XX",
        retryable: status !== 400,
      });
    }
    const malformed = createOpenAIEmbeddingProvider(
      key,
      "proj_synthetic",
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1] }], usage: {} })),
    );
    await expect(malformed.embed("Synthetic.")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("bounds each pass even when a replacement queue always returns work", async () => {
    const queue = fakeQueue({
      claim: async () => ({
        id: "job",
        chunkId: "chunk",
        text: "Synthetic.",
        attemptCount: 1,
      }),
    });
    const embed = vi.fn(async () => ({ vector, usageTokens: 1 }));
    const result = await runEmbeddingPass({
      queue,
      provider: { embed },
      ownerSubject: "owner-a",
    });
    expect(result.requests).toBe(4);
    expect(embed).toHaveBeenCalledTimes(4);
    expect(queue.checkpointScan).toHaveBeenCalledWith("owner-a", "note-a");
  });

  it("does not send oversized private input even through a replaceable queue or provider", async () => {
    const text = "x".repeat(8193);
    const queue = fakeQueue({
      claim: vi
        .fn()
        .mockResolvedValueOnce({
          id: "job",
          chunkId: "chunk",
          text,
          attemptCount: 1,
        })
        .mockResolvedValue(null),
    });
    const embed = vi.fn();
    expect(
      (
        await runEmbeddingPass({
          queue,
          provider: { embed },
          ownerSubject: "owner-a",
        })
      ).failed,
    ).toBe(1);
    expect(embed).not.toHaveBeenCalled();
    const request = vi.fn();
    const provider = createOpenAIEmbeddingProvider(
      "sk-synthetic-private-key-123456789",
      "proj_synthetic",
      request,
    );
    await expect(provider.embed(text)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves scan progress unchanged if preparation fails before durable completion", async () => {
    const queue = fakeQueue({
      prepareNote: async () => {
        throw new Error("DB unavailable");
      },
    });
    await expect(
      runEmbeddingPass({
        queue,
        provider: { embed: vi.fn() },
        ownerSubject: "owner-a",
      }),
    ).rejects.toThrow();
    expect(queue.checkpointScan).not.toHaveBeenCalled();
  });
});
