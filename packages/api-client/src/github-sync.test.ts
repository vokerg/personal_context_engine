import { expect, it, vi } from "vitest";
import { getGitHubSyncStatus, syncFromGitHub } from "./index.js";
it("uses one authenticated server-side operation with no repository/token configuration in the payload", async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer native-access",
    });
    if (init?.method === "POST") {
      expect(String(url)).toBe("https://api.example/api/v1/github-sync");
      expect(init.body).toBe("{}");
      return new Response(
        JSON.stringify({
          examined: 10,
          staged: 2,
          alreadyStaged: 8,
          failed: 0,
          hasMore: true,
        }),
      );
    }
    expect(String(url)).toBe("https://api.example/api/v1/github-sync/status");
    return new Response(
      JSON.stringify({
        enabled: false,
        reason: "Disabled",
        lastSuccessfulScan: null,
        hasMore: false,
        pending: 2,
        processed: 0,
        invalid: 0,
      }),
    );
  });
  const options = {
    baseUrl: "https://api.example",
    getAccessToken: () => "native-access",
    request,
  };
  expect(await getGitHubSyncStatus(options)).toMatchObject({
    enabled: false,
    pending: 2,
  });
  expect(await syncFromGitHub(options)).toMatchObject({
    staged: 2,
    hasMore: true,
  });
});
it("rejects malformed status responses and reports sanitized transport errors", async () => {
  await expect(
    getGitHubSyncStatus({
      baseUrl: "https://api.example",
      getAccessToken: () => "fake",
      request: async () =>
        new Response(JSON.stringify({ private: "never echo" })),
    }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
