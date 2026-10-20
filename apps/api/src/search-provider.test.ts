import { describe, expect, it, vi } from "vitest";
import { queryEmbeddingProvider } from "./search-provider.js";
const env = {
  PCE_EMBEDDINGS_ENABLED: "true",
  PCE_EMBEDDING_EGRESS_APPROVED: "I_APPROVE_PRIVATE_TEXT_TO_OPENAI",
  OPENAI_API_KEY: "sk-synthetic-private-key-123456789",
  OPENAI_PROJECT_ID: "proj_synthetic",
};
describe("bounded query embedding egress", () => {
  it("is disabled without separate approval and validates credentials without printing them", () => {
    const request = vi.fn();
    expect(queryEmbeddingProvider({}, request)).toBeUndefined();
    expect(
      queryEmbeddingProvider(
        { ...env, PCE_EMBEDDING_EGRESS_APPROVED: "false" },
        request,
      ),
    ).toBeUndefined();
    expect(() =>
      queryEmbeddingProvider(
        { ...env, OPENAI_EMBEDDING_MODEL: "other" },
        request,
      ),
    ).toThrow("Invalid embedding configuration");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses the indexing model/dimensions over bounded HTTPS and sanitizes remote failures", async () => {
    const request = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/embeddings");
      expect(JSON.parse(String(init.body))).toEqual({
        model: "text-embedding-3-small",
        dimensions: 1536,
        input: "Synthetic only.",
        encoding_format: "float",
      });
      expect(init.redirect).toBe("error");
      return new Response(
        JSON.stringify({
          model: "text-embedding-3-small",
          data: [{ embedding: Array(1536).fill(0.1) }],
          usage: { prompt_tokens: 3 },
        }),
      );
    });
    expect(
      (await queryEmbeddingProvider(env, request)!.embed("Synthetic only."))
        .vector,
    ).toHaveLength(1536);
    const bad = queryEmbeddingProvider(
      env,
      async () => new Response(env.OPENAI_API_KEY, { status: 429 }),
    )!;
    await expect(bad.embed("Synthetic.")).rejects.toThrow(
      /^Query embedding unavailable$/,
    );
  });
});
