import { useEffect, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  describeNotesError,
  getNote,
  getNotes,
  type NoteDetail,
  type NotePreview,
} from "@pce/api-client";

type LoadState = "loading" | "ready" | "error";

/**
 * Development token entry is not an identity provider or a production login.
 * Tokens and note bodies stay in component memory (no browser storage).
 */
export function App({
  baseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3000",
}: {
  baseUrl?: string;
}) {
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [listState, setListState] = useState<LoadState>("loading");
  const [listError, setListError] = useState("");
  const [notes, setNotes] = useState<NotePreview[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("loading");
  const [detailError, setDetailError] = useState("");
  const [detail, setDetail] = useState<NoteDetail | null>(null);

  function signOut(message = "") {
    setToken(null);
    setDraft("");
    setNotice(message);
    setNotes([]);
    setSelectedId(null);
    setDetail(null);
  }

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
  }, [baseUrl, token]);

  useEffect(() => {
    if (!token || !selectedId) return;
    let active = true;
    const controller = new AbortController();
    setDetail(null);
    setDetailState("loading");
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
  }, [baseUrl, token, selectedId]);

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
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 760,
        padding: 24,
        margin: "0 auto",
        lineHeight: 1.5,
      }}
    >
      <h1>Personal Context Engine</h1>
      <p>Read-only client preview. No login, token issuance, editing or reminders yet.</p>
      {!token ? (
        <section aria-label="Sign-in required">
          <h2>Sign-in required</h2>
          {notice && <p role="alert">{notice}</p>}
          <p>
            For synthetic development only, enter a short-lived notes:read JWT from
            a trusted issuer. The token is never persisted in browser storage.
          </p>
          <form onSubmit={connect}>
            <label htmlFor="access-token">Development access token</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <input
                id="access-token"
                aria-label="Development access token"
                type="password"
                autoComplete="off"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                style={{ flex: "1 1 260px", padding: 8 }}
              />
              <button type="submit" disabled={!draft.trim()}>
                Connect
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section>
          <button onClick={() => signOut()}>Clear session</button>
          <h2>Notes</h2>
          {listState === "loading" && <p role="status">Loading notes…</p>}
          {listState === "error" && <p role="alert">{listError}</p>}
          {listState === "ready" && notes.length === 0 && (
            <p>No notes available for this session.</p>
          )}
          {listState === "ready" && notes.length > 0 && (
            <ul>
              {notes.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(note.id)}
                    aria-pressed={selectedId === note.id}
                  >
                    {note.title}
                  </button>
                  <p>{note.summary}</p>
                </li>
              ))}
            </ul>
          )}
          {selectedId && (
            <section aria-label="Note detail">
              <h2>Note detail</h2>
              {detailState === "loading" && <p role="status">Loading detail…</p>}
              {detailState === "error" && <p role="alert">{detailError}</p>}
              {detailState === "ready" && detail && (
                <article>
                  <h3>{detail.title}</h3>
                  <p>{detail.summary}</p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{detail.body}</p>
                </article>
              )}
            </section>
          )}
        </section>
      )}
    </main>
  );
}
