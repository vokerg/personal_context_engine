import { describe, expect, it, vi } from "vitest";
import { getHealth } from "./index.js";

describe("health client", () => {
  it("uses an injected transport and checks its response", async () => {
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    await expect(
      getHealth("http://localhost:3000", transport),
    ).resolves.toEqual({ status: "ok" });
    expect(transport).toHaveBeenCalledWith(
      new URL("http://localhost:3000/health"),
    );
  });
  it("rejects invalid response and failed HTTP status", async () => {
    await expect(
      getHealth("http://localhost:3000", async () => new Response("{}")),
    ).rejects.toThrow();
    await expect(
      getHealth(
        "http://localhost:3000",
        async () => new Response(null, { status: 503 }),
      ),
    ).rejects.toThrow("503");
  });
  it("rejects non-HTTP URLs and embedded credentials before sending", async () => {
    const transport = vi.fn(async () => new Response("{}"));
    await expect(getHealth("file:///tmp/api", transport)).rejects.toThrow(
      "HTTP(S)",
    );
    await expect(
      getHealth("http://alice:secret@localhost:3000", transport),
    ).rejects.toThrow("credentials");
    expect(transport).not.toHaveBeenCalled();
  });
});


import { ApiRequestError, getNote, getNotes } from "./index.js";

describe("typed authenticated notes client", () => {
  const id = "01K00000000000000000000001";
  const record = {
    id, title: "Synthetic", summary: "Synthetic summary",
    capturedAt: "2026-10-16T10:00:00+02:00",
  };

  it("injects a bearer token and validates note responses", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ notes: [record] })));
    const getAccessToken = vi.fn(async () => "synthetic.jwt.token");
    const options = { baseUrl: "https://api.example", getAccessToken, request };
    await expect(getNotes(options)).resolves.toEqual({ notes: [record] });
    expect(request).toHaveBeenCalledWith(
      new URL("https://api.example/api/v1/notes"),
      { method: "GET", headers: { Authorization: "Bearer synthetic.jwt.token" } },
    );
    const detailRequest = vi.fn(async () =>
      new Response(JSON.stringify({ ...record, body: "Synthetic body" })));
    await expect(getNote({ ...options, request: detailRequest }, id))
      .resolves.toEqual({ ...record, body: "Synthetic body" });
  });

  it("refuses to transmit without a token or with injected line breaks", async () => {
    const request = vi.fn(async () => new Response("{}"));
    const options = { baseUrl: "https://api.example", request };
    await expect(getNotes({ ...options, getAccessToken: () => null }))
      .rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    await expect(getNotes({ ...options, getAccessToken: () => "fake\nHeader: stolen" }))
      .rejects.toThrow("Invalid access token");
    await expect(getNote({ ...options, getAccessToken: () => "fake" }, "../other"))
      .rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes 403/404 responses without echoing server details", async () => {
    const options = {
      baseUrl: "https://api.example",
      getAccessToken: () => "fake",
      request: async () => new Response(
        JSON.stringify({ error: { code: "FORBIDDEN", private: "hidden" } }),
        { status: 403 },
      ),
    };
    try {
      await getNotes(options);
      throw new Error("expected 403");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status: 403, code: "FORBIDDEN" });
      expect((error as Error).message).not.toContain("hidden");
    }
  });

  it("passes AbortSignal into transport and validates returned data", async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ notes: [{ ...record, id: "invalid" }] })));
    await expect(getNotes({
      baseUrl: "https://api.example",
      getAccessToken: () => "fake",
      signal: controller.signal,
      request,
    })).rejects.toThrow();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
