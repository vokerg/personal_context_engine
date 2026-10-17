import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** No note data, embeddings, balance APIs or generation requests in this check. */
export async function checkOpenAISetup(
  env,
  { live = false, request = fetch } = {},
) {
  const model = env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const project = env.OPENAI_PROJECT_ID;
  const key = env.OPENAI_API_KEY;
  const result = {
    configured: false,
    embeddingsEnabled: false,
    model,
    liveCheck: "not_requested",
  };
  if (model !== "text-embedding-3-small")
    return { ...result, code: "UNSUPPORTED_PLANNED_MODEL" };
  if (![undefined, "false"].includes(env.PCE_EMBEDDINGS_ENABLED))
    return { ...result, code: "EMBEDDING_RUNTIME_NOT_IMPLEMENTED" };
  if (!project || !/^proj[-_][A-Za-z0-9]+$/.test(project))
    return { ...result, code: "PROJECT_ID_REQUIRED" };
  if (!key || !/^sk-[A-Za-z0-9_-]{20,}$/.test(key))
    return { ...result, code: "API_KEY_REQUIRED" };
  result.configured = true;
  if (!live) return { ...result, code: "LOCAL_CONFIG_READY" };
  try {
    const response = await request(
      `https://api.openai.com/v1/models/${model}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, "OpenAI-Project": project },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      const codes = {
        401: "AUTHENTICATION_FAILED",
        403: "MODEL_ACCESS_DENIED",
        404: "MODEL_NOT_AVAILABLE",
        429: "RATE_OR_QUOTA_LIMIT",
      };
      return {
        ...result,
        liveCheck: "failed",
        code: codes[response.status] ?? "PROVIDER_UNAVAILABLE",
      };
    }
    const body = await response.json();
    if (body.id !== model)
      return {
        ...result,
        liveCheck: "failed",
        code: "UNEXPECTED_MODEL_RESPONSE",
      };
    return {
      ...result,
      liveCheck: "passed",
      code: "MODEL_METADATA_ACCESS_VERIFIED",
    };
  } catch {
    return {
      ...result,
      liveCheck: "failed",
      code: "NETWORK_OR_PROVIDER_ERROR",
    };
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--live"))
      throw new Error("Invalid arguments");
    try {
      process.loadEnvFile(".env");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const result = await checkOpenAISetup(process.env, {
      live: process.argv.includes("--live"),
    });
    console.log(JSON.stringify(result));
    if (
      !["LOCAL_CONFIG_READY", "MODEL_METADATA_ACCESS_VERIFIED"].includes(
        result.code,
      )
    )
      process.exitCode = 1;
  } catch {
    console.error(
      "OpenAI setup check failed: invalid arguments or local configuration.",
    );
    process.exitCode = 1;
  }
}
