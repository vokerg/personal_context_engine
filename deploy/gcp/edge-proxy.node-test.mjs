import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { proxy } from "./edge-proxy.mjs";

const env = {
  PUBLIC_ORIGIN: "https://reserve.example.test",
  UPSTREAM_ORIGIN: "https://gcp.example.test",
};
const request = (path = "/mcp", init) => new Request(env.PUBLIC_ORIGIN + path, init);
const forbiddenFetch = () => { throw new Error("Must not fetch"); };

test("gateway fails closed for placeholders, invalid authorities and proxy loops", async () => {
  for (const settings of [
    {},
    { ...env, UPSTREAM_ORIGIN: "http://gcp.example.test" },
    { ...env, UPSTREAM_ORIGIN: "https://user:secret@gcp.example.test" },
    { ...env, UPSTREAM_ORIGIN: "https://gcp.example.test/path" },
    { ...env, UPSTREAM_ORIGIN: "https://gcp.example.invalid" },
    { ...env, UPSTREAM_ORIGIN: env.PUBLIC_ORIGIN },
  ]) assert.equal((await proxy(request(), settings, forbiddenFetch)).status, 503);
});

test("gateway rejects alternate public authorities, unsupported methods and large bodies", async () => {
  assert.equal((await proxy(new Request("https://preview.example.test/mcp"), env, forbiddenFetch)).status, 421);
  assert.equal((await proxy(request("/mcp", { method: "PROPFIND" }), env, forbiddenFetch)).status, 405);
  assert.equal((await proxy(request("/mcp", { method: "POST", headers: { "content-length": "307201" } }), env, forbiddenFetch)).status, 413);
});

test("discovery is forwarded only to the pinned HTTPS authority without caching or redirect following", async () => {
  let calls = 0;
  const response = await proxy(request("/.well-known/oauth-protected-resource/mcp?test=1"), env, async (outgoing, options) => {
    calls++;
    assert.equal(outgoing.url, env.UPSTREAM_ORIGIN + "/.well-known/oauth-protected-resource/mcp?test=1");
    assert.equal(options.redirect, "manual");
    assert.deepEqual(options.cf, { cacheEverything: false, cacheTtl: 0 });
    return Response.json({ resource: env.PUBLIC_ORIGIN + "/mcp" });
  });
  assert.equal(calls, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).resource, env.PUBLIC_ORIGIN + "/mcp");
});

test("caller paths and forwarding headers cannot select a different upstream", async () => {
  for (const path of ["//attacker.example/path", "/%2f%2fattacker.example/path"]) {
    await proxy(request(path, { headers: {
      host: "attacker.example", forwarded: "host=attacker.example",
      "x-forwarded-host": "attacker.example", "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "http", "x-real-ip": "127.0.0.1",
      "cf-connecting-ip": "127.0.0.1",
    } }), env, async outgoing => {
      assert.equal(new URL(outgoing.url).origin, env.UPSTREAM_ORIGIN);
      for (const header of ["host", "forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip"])
        assert.equal(outgoing.headers.get(header), null);
      return new Response(null, { status: 204 });
    });
  }
});

test("OAuth credentials, Origin, payload bytes and multiple response cookies survive forwarding", async () => {
  const payload = '{"grant_type":"synthetic","value":"Тест"}';
  const response = await proxy(request("/oauth/token", {
    method: "POST", body: payload, headers: {
      origin: env.PUBLIC_ORIGIN, authorization: "Bearer synthetic-access",
      cookie: "pce_session=synthetic-session", "content-type": "application/json",
    },
  }), env, async outgoing => {
    assert.equal(outgoing.method, "POST");
    assert.equal(outgoing.headers.get("origin"), env.PUBLIC_ORIGIN);
    assert.equal(outgoing.headers.get("authorization"), "Bearer synthetic-access");
    assert.equal(outgoing.headers.get("cookie"), "pce_session=synthetic-session");
    assert.equal(await outgoing.text(), payload);
    const headers = new Headers({ "www-authenticate": 'Bearer resource_metadata="' + env.PUBLIC_ORIGIN + '/.well-known/oauth-protected-resource/mcp"' });
    headers.append("set-cookie", "pce_session=synthetic; Secure; HttpOnly");
    headers.append("set-cookie", "pce_csrf=synthetic; Secure");
    return new Response("synthetic response", { status: 200, headers });
  });
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.get("www-authenticate"), /reserve\.example\.test/);
  assert.equal(await response.text(), "synthetic response");
});

test("OAuth callback redirects are returned unchanged instead of being fetched with credentials", async () => {
  const callback = "https://chatgpt.example.test/callback?code=synthetic";
  let calls = 0;
  const response = await proxy(request("/oauth/authorize", { method: "POST", body: "synthetic" }), env, async (_, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 303, headers: { location: callback } });
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), callback);
});

test("upstream failures return only a fixed error without exception/request data", async () => {
  const response = await proxy(request("/mcp?private=synthetic"), env, () => { throw new Error("secret token and private body"); });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "UPSTREAM_UNAVAILABLE" });
  assert.equal(typeof worker.fetch, "function");
});

test("Cloudflare entrypoint uses fetch while ignoring the execution-context argument", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async outgoing => {
      assert.equal(new URL(outgoing.url).origin, env.UPSTREAM_ORIGIN);
      return new Response(null, { status: 204 });
    };
    assert.equal((await worker.fetch(request(), env, { waitUntil() {} })).status, 204);
  } finally {
    globalThis.fetch = original;
  }
});
