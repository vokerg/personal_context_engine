import { describe, it, expect } from "vitest";
import { checkOpenAISetup } from "./check-openai-setup.mjs";
const env = {
  OPENAI_API_KEY: "sk-synthetic-not-a-real-key-123456",
  OPENAI_PROJECT_ID: "proj_synthetic",
  PCE_EMBEDDINGS_ENABLED: "false",
};
describe("OpenAI provisioning diagnostics", () => {
  it("checks config offline without contacting a provider or exposing credentials", async () => {
    const result = await checkOpenAISetup(env, {
      request: () => {
        throw new Error("Unexpected network");
      },
    });
    expect(result.code).toBe("LOCAL_CONFIG_READY");
    expect(result.embeddingsEnabled).toBe(false);
    expect(JSON.stringify(result)).not.toContain(env.OPENAI_API_KEY);
    expect(JSON.stringify(result)).not.toContain(env.OPENAI_PROJECT_ID);
  });
  it("reports missing credentials and rejects premature embedding activation", async () => {
    expect((await checkOpenAISetup({})).code).toBe("PROJECT_ID_REQUIRED");
    expect(
      (await checkOpenAISetup({ OPENAI_PROJECT_ID: "proj_synthetic" })).code,
    ).toBe("API_KEY_REQUIRED");
    expect(
      (await checkOpenAISetup({ ...env, PCE_EMBEDDINGS_ENABLED: "true" })).code,
    ).toBe("EMBEDDING_RUNTIME_NOT_IMPLEMENTED");
  });
  it("makes only an explicit read-only request to the official model metadata endpoint", async () => {
    const result = await checkOpenAISetup(env, {
      live: true,
      request: async (url, options) => {
        expect(url).toBe(
          "https://api.openai.com/v1/models/text-embedding-3-small",
        );
        expect(options.method).toBe("GET");
        expect(options.body).toBeUndefined();
        expect(options.redirect).toBe("error");
        expect(options.headers.Authorization).toBe(
          `Bearer ${env.OPENAI_API_KEY}`,
        );
        expect(options.headers["OpenAI-Project"]).toBe(env.OPENAI_PROJECT_ID);
        return new Response(JSON.stringify({ id: "text-embedding-3-small" }));
      },
    });
    expect(result.code).toBe("MODEL_METADATA_ACCESS_VERIFIED");
  });
  it("redacts provider errors, including bodies and thrown credentials", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const result = await checkOpenAISetup(env, {
        live: true,
        request: async () => new Response(env.OPENAI_API_KEY, { status }),
      });
      expect(result.liveCheck).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(env.OPENAI_API_KEY);
    }
    const result = await checkOpenAISetup(env, {
      live: true,
      request: () => {
        throw new Error(env.OPENAI_API_KEY);
      },
    });
    expect(result.code).toBe("NETWORK_OR_PROVIDER_ERROR");
    expect(JSON.stringify(result)).not.toContain(env.OPENAI_API_KEY);
  });
  it("does not silently substitute an unapproved embedding model", async () => {
    expect(
      (
        await checkOpenAISetup({
          ...env,
          OPENAI_EMBEDDING_MODEL: "other-model",
        })
      ).code,
    ).toBe("UNSUPPORTED_PLANNED_MODEL");
  });
});
