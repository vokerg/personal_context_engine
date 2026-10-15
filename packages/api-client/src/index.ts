import { HealthResponseSchema, type HealthResponse } from "@pce/contracts";

/** Explicit URL injection; do not embed backend secrets or presume device localhost. */
export async function getHealth(
  baseUrl: string,
  request: typeof fetch = fetch,
): Promise<HealthResponse> {
  const url = new URL("/health", baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("API URL must be HTTP(S)");
  }
  const response = await request(url);
  if (!response.ok)
    throw new Error(`API health request failed (${response.status})`);
  return HealthResponseSchema.parse(await response.json());
}
