import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  describeNotesError,
  getNote,
  getNotes,
  isNoteId,
  type NoteDetail,
  type NotePreview,
} from "@pce/api-client";
import {
  PAGE_SIZE,
  filterTimeline,
  groupByLocalDay,
  type TimelineFilters,
} from "./timeline.js";

type LoadState = "loading" | "ready" | "error";
type IngestionStatus = {
  enabled: boolean;
  running: boolean;
  lastRun: string | null;
  error: string | null;
  report: { finalized: number; rejected: number; retried: number } | null;
};

const initialFilters: TimelineFilters = { query: "", from: "", to: "" };

/**
 * Read-only development surface. Bearer tokens and note bodies remain in React
 * memory and are not stored in browser storage or included in URL parameters.
 */
export function App({
  localDevelopment = import.meta.env.VITE_PCE_LOCAL_DEV === "true",
  baseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000",
}: {
  baseUrl?: string;
  localDevelopment?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [ingestion, setIngestion] = useState<IngestionStatus | null>(null);
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState("");
  const [notes, setNotes] = useState<NotePreview[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const id = new URL(window.location.href).searchParams.get("note");
    return id && isNoteId(id) ? id : null;
  });
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [detailError, setDetailError] = useState("");
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [filters, setFilters] = useState<TimelineFilters>(initialFilters);
  const [visiblePages, setVisiblePages] = useState(1);
  const [reloadCount, setReloadCount] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  const filtered = useMemo(() => filterTimeline(notes, filters), [notes, filters]);
  const visible = filtered.slice(0, PAGE_SIZE * visiblePages);
  const grouped = groupByLocalDay(visible);
  const dateRangeInvalid = Boolean(
    filters.from && filters.to && filters.from > filters.to,
  );
  const hasFilters = Boolean(filters.query || filters.from || filters.to);

  function changeFilter(patch: Partial<TimelineFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setVisiblePages(1);
  }

  function navigateToNote(id: string | null) {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("note", id);
      else url.searchParams.delete("note");
      window.history.pushState(null, "", url);
    }
    setSelectedId(id);
  }

  function signOut(message = "") {
    setToken(null);
    setDraft("");
    setNotice(message);
    setNotes([]);
    setSelectedId(null);
    setDetail(null);
    setFilters(initialFilters);
    setVisiblePages(1);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("note");
      window.history.replaceState(null, "", url);
    }
  }

  async function connectLocal() {
    try {
      setNotice("");
      const response = await fetch("/__pce/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Session unavailable");
      const session = (await response.json()) as { token?: unknown };
      if (typeof session.token !== "string") throw new Error("Invalid session");
      setToken(session.token);
    } catch {
      setNotice(
        "Local session unavailable. Start the workspace with npm run dev:local.",
      );
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const restoreSelection = () => {
      const id = new URL(window.location.href).searchParams.get("note");
      setSelectedId(id && isNoteId(id) ? id : null);
    };
    window.addEventListener("popstate", restoreSelection);
    return () => window.removeEventListener("popstate", restoreSelection);
  }, []);

  useEffect(() => {
    if (!localDevelopment) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/__pce/ingestion", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.ok) {
          const status = (await response.json()) as IngestionStatus;
          if (active) setIngestion(status);
        }
      } catch {
        // A status failure never grants, extends, or alters authorization.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [localDevelopment]);

  useEffect(() => {
    if (localDevelopment) void connectLocal();
  }, [localDevelopment]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const controller = new AbortController();
    setListState("loading");
    setListError("");
    getNotes({
      baseUrl,
      getAccessToken: () => token,
      signal: controller.signal,
      timeoutMs: 12000,
    })
      .then((result) => {
        if (!active) return;
        setNotes(result.notes);
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          signOut(describeNotesError(error));
        } else {
          setListState("error");
          setListError(describeNotesError(error));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [baseUrl, token, reloadCount, ingestion?.lastRun]);

  useEffect(() => {
    if (!token || !selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setDetail(null);
    setDetailState("loading");
    setDetailError("");
    getNote(
      {
        baseUrl,
        getAccessToken: () => token,
        signal: controller.signal,
        timeoutMs: 12000,
      },
      selectedId,
    )
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          signOut(describeNotesError(error));
        } else {
          setDetailState("error");
          setDetailError(describeNotesError(error, true));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [baseUrl, token, selectedId, detailAttempt]);

  useEffect(() => {
    if (detailState === "ready") detailHeading.current?.focus();
  }, [detailState, selectedId]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setSelectedId(null);
    setNotes([]);
    setDetail(null);
    setNotice("");
    setToken(value);
    setDraft("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Read-only workspace</p>
          <h1>Personal Context Engine</h1>
          <p className="subtitle">
            {localDevelopment
              ? "Browse the notes in your local workspace. Capture, editing and reminders are separate workflows."
              : "Development preview. Production login, editing and reminders are not available."}
          </p>
        </div>
        {token && (
          <div className="actions">
            <button className="secondary" type="button" onClick={() => setReloadCount((n) => n + 1)}>
              Refresh notes
            </button>
            <button className="ghost" type="button" onClick={() => signOut()}>
              Clear session
            </button>
          </div>
        )}
      </header>

      {!token ? (
        <section className="panel auth-panel" aria-label="Sign-in required">
          <h2>Sign-in required</h2>
          {notice && <p className="error" role="alert">{notice}</p>}
          {localDevelopment ? (
            <button className="primary" type="button" onClick={() => void connectLocal()}>
              Connect local workspace
            </button>
          ) : (
            <>
              <p>
                For synthetic development only, enter a short-lived notes:read JWT from
                a trusted issuer. This token stays in memory, not browser storage.
              </p>
              <form onSubmit={connect}>
                <label htmlFor="access-token">Development access token</label>
                <div className="auth-row">
                  <input
                    id="access-token"
                    type="password"
                    autoComplete="off"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button className="primary" type="submit" disabled={!draft.trim()}>Connect</button>
                </div>
              </form>
            </>
          )}
        </section>
      ) : (
        <div className="workspace">
          <section className="panel timeline-panel" id="timeline" aria-labelledby="timeline-title">
            <div className="panel-header">
              <p className="eyebrow">Library</p>
              <h2 id="timeline-title">Note timeline</h2>
              <p className="subtitle">
                Search and filter the notes returned by the current API. Server search
                and additional facets are not enabled yet.
              </p>
            </div>
            <div className="filters" role="group" aria-label="Timeline filters">
              <div className="filter-field">
                <label htmlFor="note-query">Search loaded titles and summaries</label>
                <input
                  id="note-query"
                  type="search"
                  placeholder="Keyword"
                  value={filters.query}
                  onChange={(event) => changeFilter({ query: event.target.value })}
                />
              </div>
              <div className="filter-field filter-date">
                <label htmlFor="from-date">From (local date)</label>
                <input id="from-date" type="date" value={filters.from}
                  onChange={(event) => changeFilter({ from: event.target.value })} />
              </div>
              <div className="filter-field filter-date">
                <label htmlFor="to-date">To (local date)</label>
                <input id="to-date" type="date" value={filters.to}
                  onChange={(event) => changeFilter({ to: event.target.value })} />
              </div>
              <div className="filter-actions">
                <button className="ghost" type="button" disabled={!hasFilters}
                  onClick={() => { setFilters(initialFilters); setVisiblePages(1); }}>
                  Reset filters
                </button>
              </div>
            </div>

            {dateRangeInvalid && <p className="notice" role="status">The start date is later than the end date.</p>}
            {listState === "loading" && <p className="notice" role="status">Loading notes…</p>}
            {listState === "error" && (
              <div className="notice" role="alert">
                <p>{listError}</p>
                <button className="secondary" type="button" onClick={() => setReloadCount((n) => n + 1)}>
                  Try again
                </button>
              </div>
            )}
            {listState === "ready" && (
              <>
                <p className="list-meta" role="status">
                  {filtered.length} of {notes.length} loaded notes match · showing {visible.length}
                </p>
                {visible.length === 0 ? (
                  <div className="empty">
                    <h3>{hasFilters ? "No matching notes" : "No notes available"}</h3>
                    <p>{hasFilters ? "Change the search or date range to see more." : "No notes are available for this session. Check ingestion or capture another note."}</p>
                  </div>
                ) : (
                  grouped.map((group) => (
                    <section className="day-group" key={group.day} aria-label={group.day}>
                      <h3 className="day-heading">
                        {new Date(group.day + "T12:00:00").toLocaleDateString(undefined, {
                          weekday: "long", year: "numeric", month: "long", day: "numeric",
                        })}
                      </h3>
                      <ul className="note-list">
                        {group.notes.map((note) => (
                          <li key={note.id}>
                            <button
                              className="note-button"
                              type="button"
                              aria-pressed={selectedId === note.id}
                              aria-label={`Open note: ${note.title}`}
                              onClick={() => navigateToNote(note.id)}
                            >
                              <span className="note-title">{note.title}</span>
                              <span className="note-excerpt">{note.summary}</span>
                              <time className="note-time" dateTime={note.capturedAt}>
                                {new Date(note.capturedAt).toLocaleTimeString(undefined, {
                                  hour: "2-digit", minute: "2-digit",
                                })}
                              </time>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
                {visible.length < filtered.length && (
                  <div className="pager">
                    <span>{filtered.length - visible.length} more matching notes</span>
                    <button className="secondary" type="button"
                      onClick={() => setVisiblePages((n) => n + 1)}>
                      Show more
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="panel detail-panel" aria-label="Note detail">
            {!selectedId ? (
              <div className="detail-placeholder">
                <h2>Note details</h2>
                <p>Select a note to read its full original body and summary.</p>
              </div>
            ) : (
              <>
                <button className="ghost" type="button" onClick={() => navigateToNote(null)}>
                  ← Back to timeline
                </button>
                {detailState === "loading" && <p role="status">Loading detail…</p>}
                {detailState === "error" && (
                  <div className="error" role="alert">
                    <p>{detailError}</p>
                    <button className="secondary" type="button" onClick={() => setDetailAttempt((n) => n + 1)}>
                      Try again
                    </button>
                  </div>
                )}
                {detailState === "ready" && detail && (
                  <article>
                    <p className="eyebrow">Captured note</p>
                    <h2 className="detail-title" ref={detailHeading} tabIndex={-1}>
                      {detail.title}
                    </h2>
                    <time dateTime={detail.capturedAt} className="note-time">
                      {new Date(detail.capturedAt).toLocaleString()}
                    </time>
                    <p className="detail-summary">{detail.summary}</p>
                    <h3>Original body</h3>
                    <pre className="detail-body">{detail.body}</pre>
                  </article>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {localDevelopment && (
        <section className="panel status-panel" aria-label="Ingestion worker status">
          <h2>Ingestion worker</h2>
          {!ingestion ? (
            <p>Worker status is unavailable. A local session can still display previously indexed notes.</p>
          ) : (
            <>
              <p>
                {ingestion.enabled
                  ? ingestion.running
                    ? "Processing GitHub inbox…"
                    : "Watching GitHub every 30 seconds."
                  : "GitHub ingestion is disabled; showing a local snapshot."}
              </p>
              {ingestion.lastRun && (
                <p>Last successful check: {new Date(ingestion.lastRun).toLocaleString()}</p>
              )}
              {ingestion.report && (
                <p>
                  Last pass: {ingestion.report.finalized} finalized,{" "}
                  {ingestion.report.rejected} rejected, {ingestion.report.retried} retries.
                </p>
              )}
              {ingestion.error && (
                <p className="error" role="alert">
                  Ingestion needs attention. Check repository access, clean checkout
                  and note ownership. Previous notes remain available.
                </p>
              )}
              <p>Rejected captures remain recoverable in the repository; use capture:validate to diagnose them.</p>
            </>
          )}
        </section>
      )}
    </main>
  );
}
