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
