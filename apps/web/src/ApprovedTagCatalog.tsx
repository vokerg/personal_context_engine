import { useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  getTagRegistry,
  type TagRegistryResponse,
} from "@pce/api-client";

type Props = {
  baseUrl: string;
  token: string | null;
  useSessionCookie: boolean;
  registry: TagRegistryResponse;
  busy: boolean;
  selectTag: (slug: string) => void;
  unapprove: (slug: string) => void;
};
export function ApprovedTagCatalog({
  baseUrl,
  token,
  useSessionCookie,
  registry,
  busy,
  selectTag,
  unapprove,
}: Props) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [after, setAfter] = useState<string | undefined>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [page, setPage] = useState<TagRegistryResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const revision = useRef<number | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), 250);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    setAfter(undefined);
    setPrevious([]);
    revision.current = undefined;
  }, [registry.revision, query]);
  useEffect(() => {
    if (after && revision.current === undefined) {
      setAfter(undefined);
      setPrevious([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    getTagRegistry(
      {
        baseUrl,
        getAccessToken: () => token,
        useSessionCookie,
        signal: controller.signal,
        timeoutMs: 12000,
      },
      {
        limit: 50,
        ...(query ? { q: query } : {}),
        ...(after ? { after, revision: revision.current } : {}),
      },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setPage(result);
          revision.current = result.revision;
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiRequestError && reason.status === 409) {
          setAfter(undefined);
          setPrevious([]);
          revision.current = undefined;
          setAttempt((n) => n + 1);
          setNotice("The approved catalog changed. Showing its first page.");
        } else {
          setError(true);
          setLoading(false);
          setPage(null);
        }
      });
    return () => controller.abort();
  }, [
    baseUrl,
    token,
    useSessionCookie,
    query,
    after,
    registry.revision,
    attempt,
  ]);
  return (
    <div className="approved-catalog">
      <h5 ref={heading} tabIndex={-1}>
        Browse approved tags
      </h5>
      <label htmlFor="catalog-query">Find approved tags</label>
      <input
        id="catalog-query"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setAfter(undefined);
          setPrevious([]);
        }}
        maxLength={100}
        placeholder="Search the full approved vocabulary"
      />
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Loading approved tags…</p>
      ) : error ? (
        <div role="alert">
          <p>Approved tags could not be loaded.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry catalog
          </button>
        </div>
      ) : (
        <>
          <p className="subtitle">
            Page {previous.length + 1} · {page?.approved.length ?? 0} approved
            tags
          </p>
          <div className="tag-chips" role="group" aria-label="Approved tags">
            {page?.approved.map((tag) => (
              <span className="tag-pair" key={tag.slug}>
                <button
                  className="tag-chip"
                  type="button"
                  aria-label={`Filter by approved tag ${tag.slug}, ${tag.noteCount} notes`}
                  onClick={() => selectTag(tag.slug)}
                >
                  {tag.displayName || tag.slug}{" "}
                  <span aria-hidden="true">{tag.noteCount}</span>
                </button>
                <span className="tag-status tag-status-approved">approved</span>
                <button
                  type="button"
                  className="ghost tag-action"
                  disabled={busy}
                  aria-label={`Unapprove tag ${tag.slug}`}
                  onClick={() => unapprove(tag.slug)}
                >
                  Unapprove
                </button>
              </span>
            ))}
          </div>
          {!page?.approved.length && (
            <p>
              {query
                ? "No approved tags match this search."
                : "No approved tags yet. Approve an observed tag to build your vocabulary."}
            </p>
          )}
          {(previous.length > 0 || page?.nextCursor) && (
            <nav className="pager" aria-label="Approved tag pages">
              <button
                type="button"
                className="secondary"
                disabled={!previous.length}
                onClick={() => {
                  setAfter(previous.at(-1));
                  setPrevious(previous.slice(0, -1));
                  heading.current?.focus();
                }}
              >
                Previous tags
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!page?.nextCursor}
                onClick={() => {
                  setPrevious([...previous, after]);
                  setAfter(page?.nextCursor ?? undefined);
                  heading.current?.focus();
                }}
              >
                Next tags
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
