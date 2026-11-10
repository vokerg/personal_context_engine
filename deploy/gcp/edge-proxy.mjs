// Optional stateless gateway. All API/authentication/domain work stays on GCP.
// Runtime configuration is operator-owned; no caller can choose the upstream.
const allowedMethods = new Set([
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS",
]);
const forwardedHeaders = [
  "host", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-for", "x-real-ip", "cf-connecting-ip",
];
const failure = (status, code) => new Response(JSON.stringify({ error: code }), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function origin(value) {
  if (typeof value !== "string") throw new Error("Invalid configuration");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value ||
      url.username || url.password || url.hostname.endsWith(".invalid"))
    throw new Error("Invalid configuration");
  return url;
}

export async function proxy(request, env, fetchOrigin = fetch) {
  let upstream, publicOrigin, incoming;
  try {
    upstream = origin(env.UPSTREAM_ORIGIN);
    publicOrigin = origin(env.PUBLIC_ORIGIN);
    incoming = new URL(request.url);
    if (upstream.origin === publicOrigin.origin) throw new Error("Proxy loop");
  } catch {
    return failure(503, "GATEWAY_NOT_CONFIGURED");
  }
  if (incoming.origin !== publicOrigin.origin) return failure(421, "WRONG_ORIGIN");
  if (!allowedMethods.has(request.method)) return failure(405, "METHOD_NOT_ALLOWED");
  const size = request.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > 307200))
    return failure(413, "PAYLOAD_TOO_LARGE");

  // Assign components rather than resolving a caller path as a relative URL:
  // paths beginning with // must never replace the trusted destination host.
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  try {
    const outgoing = new Request(upstream, request);
    for (const header of forwardedHeaders) outgoing.headers.delete(header);
    const response = await fetchOrigin(outgoing, {
      redirect: "manual",
      // A zero TTL still forces a cache write. Negative per-status TTLs bypass
      // storage entirely, including when an upstream returns cacheable headers.
      cf: { cacheEverything: false, cacheTtlByStatus: { "100-599": -1 } },
    });
    const result = new Response(response.body, response);
    result.headers.set("cache-control", "no-store");
    return result;
  } catch {
    // Never include request URLs, tokens, cookies, payloads or exception text.
    return failure(502, "UPSTREAM_UNAVAILABLE");
  }
}

export default {
  fetch(request, env) {
    // Cloudflare's third argument is ExecutionContext, not a fetch adapter.
    return proxy(request, env);
  },
};
