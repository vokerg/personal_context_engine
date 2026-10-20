import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@pce/db";
import type { QueryEmbeddingProvider } from "./search.js";
/** Same model/dimension contract as the indexing worker, with a five-second query deadline. */
export function queryEmbeddingProvider(
  env: NodeJS.ProcessEnv,
  request: typeof fetch = fetch,
): QueryEmbeddingProvider | undefined {
  if (
    env.PCE_EMBEDDINGS_ENABLED !== "true" ||
    env.PCE_EMBEDDING_EGRESS_APPROVED !== "I_APPROVE_PRIVATE_TEXT_TO_OPENAI"
  )
    return;
  const key = env.OPENAI_API_KEY,
    project = env.OPENAI_PROJECT_ID;
  if (
    !key ||
    !/^sk-[A-Za-z0-9_-]{20,}$/.test(key) ||
    !project ||
    !/^proj[-_][A-Za-z0-9]+$/.test(project) ||
    (env.OPENAI_EMBEDDING_MODEL ?? EMBEDDING_MODEL) !== EMBEDDING_MODEL
  )
    throw new Error("Invalid embedding configuration");
  return {
    async embed(text) {
      if (!text.trim() || text.length > 500)
        throw new Error("Invalid query bounds");
      try {
        const response = await request("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "OpenAI-Project": project,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: text,
            dimensions: EMBEDDING_DIMENSIONS,
            encoding_format: "float",
          }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Unavailable");
        const body = (await response.json()) as {
          model?: unknown;
          data?: Array<{ embedding?: unknown }>;
          usage?: { prompt_tokens?: unknown };
        };
        if (
          body.model !== EMBEDDING_MODEL ||
          !Array.isArray(body.data) ||
          body.data.length !== 1 ||
          !Array.isArray(body.data[0]?.embedding)
        )
          throw new Error("Invalid response");
        return {
          vector: body.data[0].embedding as number[],
          usageTokens: body.usage?.prompt_tokens as number,
        };
      } catch {
        throw new Error("Query embedding unavailable");
      }
    },
  };
}
