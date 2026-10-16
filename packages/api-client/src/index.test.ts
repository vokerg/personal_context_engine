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
    id,
    title: "Synthetic",
    summary: "Synthetic summary",
    capturedAt: "2026-10-16T10:00:00+02:00",
  };

  it("injects a bearer token and validates note responses", async () => {
    const request = vi.fn(
      async () => new Response(JSON.stringify({ notes: [record] })),
    );
    const getAccessToken = vi.fn(async () => "synthetic.jwt.token");
    const options = { baseUrl: "https://api.example", getAccessToken, request };
    await expect(getNotes(options)).resolves.toEqual({ notes: [record] });
    expect(request).toHaveBeenCalledWith(
      new URL("https://api.example/api/v1/notes"),
      {
        method: "GET",
        headers: { Authorization: "Bearer synthetic.jwt.token" },
      },
    );
    const detailRequest = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...record, body: "Synthetic body" })),
    );
    await expect(
      getNote({ ...options, request: detailRequest }, id),
    ).resolves.toEqual({ ...record, body: "Synthetic body" });
  });

  it("refuses to transmit without a token or with injected line breaks", async () => {
    const request = vi.fn(async () => new Response("{}"));
    const options = { baseUrl: "https://api.example", request };
    await expect(
      getNotes({ ...options, getAccessToken: () => null }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    await expect(
      getNotes({ ...options, getAccessToken: () => "fake\nHeader: stolen" }),
    ).rejects.toThrow("Invalid access token");
    await expect(
      getNote({ ...options, getAccessToken: () => "fake" }, "../other"),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("never sends bearer credentials over non-loopback HTTP", async () => {
    const request = vi.fn(async () => new Response("{}"));
    const getAccessToken = vi.fn(() => "synthetic.jwt.token");
    for (const baseUrl of [
      "http://api.example:3000",
      "http://192.168.1.2:3000",
      "http://localhost.evil.example:3000",
    ]) {
      await expect(
        getNotes({ baseUrl, getAccessToken, request }),
      ).rejects.toThrow("HTTPS");
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    for (const baseUrl of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      await expect(
        getNotes({
          baseUrl,
          getAccessToken,
          request: async () => new Response(JSON.stringify({ notes: [] })),
        }),
      ).resolves.toEqual({ notes: [] });
    }
  });

  it("normalizes 403/404 responses without echoing server details", async () => {
    const options = {
      baseUrl: "https://api.example",
      getAccessToken: () => "fake",
      request: async () =>
        new Response(
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
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args).toHaveLength(2);
      return new Response(
        JSON.stringify({ notes: [{ ...record, id: "invalid" }] }),
      );
    });
    await expect(
      getNotes({
        baseUrl: "https://api.example",
        getAccessToken: () => "fake",
        signal: controller.signal,
        request,
      }),
    ).rejects.toThrow();
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
  });
});

import { ApiTransportError, describeNotesError } from "./index.js";

describe("transport and privacy safe UI errors", () => {
  it("turns bad success payloads into stable, non-disclosing errors", async () => {
    await expect(
      getNotes({
        baseUrl: "https://api.example",
        getAccessToken: () => "fake",
        request: async () =>
          new Response(JSON.stringify({ notes: [{ secret: "private" }] })),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not echo rejected transport exception details", async () => {
    try {
      await getNotes({
        baseUrl: "https://api.example",
        getAccessToken: () => "fake",
        request: async () => {
          throw new Error("token=sensitive-value");
        },
      });
      throw new Error("expected transport failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiTransportError);
      expect((error as Error).message).not.toContain("sensitive-value");
      expect(describeNotesError(error)).toContain("Could not reach");
    }
  });

  it("does not fetch after an abort, including async token resolution", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => new Response("{}"));
    const getAccessToken = vi.fn(async () => {
      controller.abort();
      return "fake";
    });
    await expect(
      getNotes({
        baseUrl: "https://api.example",
        getAccessToken,
        signal: controller.signal,
        request,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("validates the timeout before requesting credentials", async () => {
    const getAccessToken = vi.fn(() => "fake");
    await expect(
      getNotes({ baseUrl: "https://api.example", getAccessToken, timeoutMs: -1 }),
    ).rejects.toThrow("timeout");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("times out a hung transport and removes its credentials from errors", async () => {
    vi.useFakeTimers();
    try {
      const pending = getNotes({
        baseUrl: "https://api.example",
        getAccessToken: () => "fake",
        timeoutMs: 100,
        request: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            (init?.signal as AbortSignal).addEventListener("abort", () =>
              reject(new Error("hidden bearer")),
            );
          }),
      });
      await vi.advanceTimersByTimeAsync(101);
      await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats auth and disabled routes without leaking server details", () => {
    expect(describeNotesError(new ApiRequestError(401, "UNAUTHORIZED"))).toContain("Session");
    expect(describeNotesError(new ApiRequestError(403, "FORBIDDEN"))).toContain("notes:read");
    expect(describeNotesError(new ApiRequestError(404, "NOT_FOUND"))).toContain("not enabled");
    expect(describeNotesError(new ApiRequestError(404, "NOT_FOUND"), true)).toContain("unavailable");
  });
});
