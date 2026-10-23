import { useEffect, useState } from "react";
import { getResearchForNote, type ResearchRecord } from "@pce/api-client";
import type { AuthenticatedRequestOptions } from "@pce/api-client";

type Props = {
  noteId: string;
  baseUrl: string;
  token: string | null;
  useSessionCookie: boolean;
  initialReportId?: string | undefined;
};
export function ResearchPanel({
  noteId,
  baseUrl,
  token,
  useSessionCookie,
  initialReportId,
}: Props) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof getResearchForNote>
  > | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"research" | "sources">("research");
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(false);
    setSelected(initialReportId ?? null);
    setView("research");
    const options: AuthenticatedRequestOptions = {
      baseUrl,
      getAccessToken: () => token,
      useSessionCookie,
      signal: controller.signal,
      timeoutMs: 12000,
    };
    getResearchForNote(options, noteId)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [noteId, baseUrl, token, useSessionCookie, attempt, initialReportId]);
  const report =
    data?.reports.find((r) => r.reportId === selected) ?? data?.reports[0];
  return (
    <section className="research-panel" aria-label="Saved research">
      <h3>Saved research</h3>
      {error ? (
        <div role="alert">
          <p>Research could not be loaded. The original note is saved.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry research
          </button>
        </div>
      ) : !data ? (
        <p role="status">Loading research…</p>
      ) : (
        <>
          {data.imports
            ?.filter((i) => i.status !== "IMPORTED")
            .map((item, index) => (
              <p role="status" key={index}>
                Note saved; report{" "}
                {item.status === "INVALID"
                  ? "needs a corrected artifact"
                  : "import pending; the worker will retry"}
                . Attempts: {item.attemptCount}.
              </p>
            ))}
          {!report ? (
            <p>
              No saved report is verified for this note. If only the note was
              saved, retry the report with its original ID after checking the
              private inbox.
            </p>
          ) : (
            <>
              <label>
                Report history{" "}
                <select
                  value={report.reportId}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {data.reports.map((r) => (
                    <option key={r.reportId} value={r.reportId}>
                      {r.title} · version {r.revision} · {r.researchedAt}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                AI-generated research · {report.status.toLowerCase()} · version{" "}
                {report.revision}
              </p>
              <p>
                Researched {new Date(report.researchedAt).toLocaleString()} ·
                Search index: {report.indexing.toLowerCase()}
              </p>
              <p>
                PCE context: {report.pceRetrieval.outcome}
                {report.pceRetrieval.mode
                  ? ` (${report.pceRetrieval.mode})`
                  : ""}
                {report.pceRetrieval.degradation
                  ? ` · ${report.pceRetrieval.degradation}`
                  : ""}
              </p>
              {report.pceRetrieval.outcome === "PCE_CONTEXT_UNAVAILABLE" && (
                <p role="status">
                  Context is incomplete. Retry PCE retrieval before using this
                  as a complete report.
                </p>
              )}
              <nav aria-label="Research views">
                <button
                  type="button"
                  aria-pressed={view === "research"}
                  onClick={() => setView("research")}
                >
                  Research
                </button>{" "}
                <button
                  type="button"
                  aria-pressed={view === "sources"}
                  onClick={() => setView("sources")}
                >
                  Sources
                </button>
              </nav>
              {view === "research" ? (
                <>
                  <h4>{report.title}</h4>
                  <p>{report.question}</p>
                  <pre className="detail-body">{report.findings}</pre>
                  {report.claims.map((claim) => (
                    <div key={claim.id}>
                      <p>
                        <strong>
                          {claim.classification.replaceAll("_", " ")}
                        </strong>
                        : {claim.text}
                      </p>
                      {claim.sourceIds.map((id) => (
                        <Source key={id} report={report} id={id} />
                      ))}
                    </div>
                  ))}
                  {report.limitations.length > 0 && (
                    <>
                      <h4>Limitations and unknowns</h4>
                      <ul>
                        {report.limitations.map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <>
                  <h4>Attributed sources</h4>
                  {report.sources.length ? (
                    report.sources.map((s) => (
                      <div key={s.id}>
                        <Source report={report} id={s.id} />
                        {s.kind === "external" ? (
                          <p>
                            Checked {s.checkedAt}. Historical citation; current
                            availability is unverified.
                          </p>
                        ) : (
                          <p>
                            {s.rationale} · Revision:{" "}
                            {s.sourceRevision ?? "not supplied"}
                          </p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p>No sources recorded.</p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
function Source({ report, id }: { report: ResearchRecord; id: string }) {
  const source = report.sources.find((s) => s.id === id);
  if (!source) return null;
  return source.kind === "external" ? (
    <a href={source.url} target="_blank" rel="noreferrer">
      {source.title ?? source.url}
    </a>
  ) : (
    <a href={`?note=${encodeURIComponent(source.noteId)}`}>
      PCE note · {source.noteId}
    </a>
  );
}
