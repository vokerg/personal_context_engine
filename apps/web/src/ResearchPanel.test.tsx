// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ResearchPanel } from "./ResearchPanel.js";
const id = "11111111-1111-4111-8111-111111111111";
let root: Root, container: HTMLDivElement;
const report = {
  schemaVersion: 1,
  reportId: "22222222-2222-4222-8222-222222222222",
  seriesId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  supersedesReportId: null,
  parentNoteId: id,
  captureId: "33333333-3333-4333-8333-333333333333",
  title: "Synthetic report",
  question: "What was verified?",
  findings: "<script>untrusted source</script>",
  limitations: ["Synthetic only"],
  researchedAt: "2026-10-23T09:00:00Z",
  status: "DRAFT",
  provenance: { agent: "chatgpt", modelId: null },
  pceRetrieval: {
    outcome: "PCE_CONTEXT_UNAVAILABLE",
    queries: ["sample"],
    checkedAt: null,
    mode: null,
    degradation: null,
  },
  sources: [
    {
      kind: "external",
      id: "source",
      url: "https://example.org/evidence",
      title: "Actual citation URL",
      checkedAt: "2026-10-23T08:00:00Z",
    },
  ],
  claims: [
    {
      id: "claim",
      text: "Synthetic analysis",
      classification: "analysis",
      sourceIds: ["source"],
    },
  ],
  contentHash: "a".repeat(64),
  origin: "github",
  savedAt: "2026-10-23T09:05:00Z",
  indexing: "PENDING",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    root.render(
      <ResearchPanel
        noteId={id}
        baseUrl="https://api.example.test"
        token="synthetic"
        useSessionCookie={false}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
it("separates generated findings, history, source links and incomplete context, rendering text literally", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ reports: [report], imports: [] })),
    ),
  );
  await render();
  expect(container.textContent).toContain("AI-generated research");
  expect(container.textContent).toContain("Context is incomplete");
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>untrusted source</script>");
  expect(container.querySelector("select")?.options[0]?.textContent).toContain(
    "version 1",
  );
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((b) => b.textContent === "Sources")!
      .click();
  });
  expect(container.querySelector("a")?.href).toBe(
    "https://example.org/evidence",
  );
  expect(container.textContent).toContain("current availability is unverified");
});
it("shows note-only recovery and durable retry status without claiming a report exists", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            reports: [],
            imports: [
              {
                status: "RETRY",
                attemptCount: 2,
                lastErrorCode: "DEPENDENCY_OR_SOURCE_UNAVAILABLE",
                updatedAt: "2026-10-23T09:00:00Z",
              },
            ],
          }),
        ),
    ),
  );
  await render();
  expect(container.textContent).toContain("Note saved; report import pending");
  expect(container.textContent).toContain("No saved report is verified");
});
it("recovers from a read failure on explicit retry", async () => {
  let failed = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(failed ? {} : { reports: [], imports: [] }),
          { status: failed ? 500 : 200 },
        ),
    ),
  );
  await render();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  failed = false;
  await act(async () => {
    container.querySelector("button")!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(container.textContent).toContain("No saved report is verified");
});
