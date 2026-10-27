import { resumeAuthorization } from "./authorization-continuation";
import { TasksPanel } from "./TasksPanel.js";
import { SuggestionPicker } from "./SuggestionPicker.js";
import { NoteTagPicker } from "./NoteTagPicker.js";
import { ResearchPanel } from "./ResearchPanel.js";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  describeNotesError,
  getNote,
  getNotes,
  getTags,
  getTagRegistry,
  approveTag,
  unapproveTag,
  changeNoteTag,
  removeNote,
  setNoteArchived,
  type TagRegistryResponse,
  getBrowsePage,
  getBrowseFacets,
  searchContext,
  getSearchNote,
  type BrowseFacets,
  type SearchRequest,
  type TagFacetsResponse,
  isNoteId,
  type NoteDetail,
  type NotePreview,
} from "@pce/api-client";
import { PAGE_SIZE, filterTimeline, groupByLocalDay } from "./timeline.js";

import {
  emptyFilters,
  filterParameters,
  noteKinds,
  readBrowseUrl,
  serverFilters,
  pagedFilters,
  writeBrowseUrl,
  type BrowseFilters,
} from "./browse.js";

type LoadState = "loading" | "ready" | "error";
type IngestionStatus = {
  enabled: boolean;
  running: boolean;
  lastRun: string | null;
  error: string | null;
  report: { finalized: number; rejected: number; retried: number } | null;
  checkpoint?: {
    lastScanAt: string | null;
    reconciledAt: string | null;
    revisionPending: boolean;
  } | null;
  reconciliation?: {
    conflicts: number;
    missing: number;
    invalid: number;
  } | null;
};

const initialFilters = emptyFilters;

/**
 * Read-only development surface. Bearer tokens and note bodies remain in React
 * memory and are not stored in browser storage or included in URL parameters.
 */
export function App({
  localDevelopment = import.meta.env.DEV &&
    import.meta.env.VITE_PCE_LOCAL_DEV === "true",
  baseUrl: configuredBaseUrl = import.meta.env.VITE_API_BASE_URL ??
    (import.meta.env.PROD && typeof window !== "undefined"
      ? window.location.origin
      : "http://127.0.0.1:3000"),
  browseEnabled = import.meta.env.VITE_PCE_LOCAL_BROWSE === "true",
  searchEnabled = import.meta.env.VITE_PCE_DB_SEARCH === "true",
  researchEnabled = import.meta.env.VITE_PCE_RESEARCH_REPORTS === "true",
  tasksEnabled = import.meta.env.VITE_PCE_TASKS === "true",
}: {
  baseUrl?: string;
  localDevelopment?: boolean;
  browseEnabled?: boolean;
  searchEnabled?: boolean;
  researchEnabled?: boolean;
  tasksEnabled?: boolean;
}) {
  const baseUrl = useMemo(() => {
    if (!localDevelopment || typeof window === "undefined")
      return configuredBaseUrl;
    try {
      const api = new URL(configuredBaseUrl);
      const browserHost = window.location.hostname;
      if (
        ["localhost", "127.0.0.1"].includes(browserHost) &&
        ["localhost", "127.0.0.1"].includes(api.hostname)
      )
        api.hostname = browserHost;
      return api.origin;
    } catch {
      return configuredBaseUrl;
    }
  }, [configuredBaseUrl, localDevelopment]);
  const sessionAuthentication =
    import.meta.env.PROD || import.meta.env.VITE_PCE_SESSION_AUTH === "true";
  const [workspaceView, setWorkspaceView] = useState<"notes" | "tasks">(
    "notes",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const researchTargets = useRef(new Map<string, string>());
  const [searchStatus, setSearchStatus] = useState("");
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
  const [filters, setFilters] = useState<BrowseFilters>(() =>
    typeof window === "undefined"
      ? initialFilters
      : readBrowseUrl(new URL(window.location.href)),
  );
  const [sharedFilters, setSharedFilters] = useState(
    () =>
      typeof window !== "undefined" &&
      filterParameters.some((key) =>
        new URL(window.location.href).searchParams.has(key),
      ),
  );
  const [tags, setTags] = useState<TagFacetsResponse>({
    tags: [],
    truncated: false,
  });
  const [tagsState, setTagsState] = useState<LoadState>("loading");
  const [tagsError, setTagsError] = useState("");
  const [tagAttempt, setTagAttempt] = useState(0);
  const [metadataRefresh, setMetadataRefresh] = useState(0);
  const [registry, setRegistry] = useState<TagRegistryResponse | null>(null);
  const [registryError, setRegistryError] = useState("");
  const [registryAttempt, setRegistryAttempt] = useState(0);
  const [registryBusy, setRegistryBusy] = useState<string | null>(null);
  const approvalEpoch = useRef(0);
  const editEpoch = useRef(0);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagEditBusy, setTagEditBusy] = useState(false);
  const [tagEditError, setTagEditError] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const registrySlugs = useMemo(
    () => new Set(registry?.approved.map((tag) => tag.slug) ?? []),
    [registry],
  );
  const observedStatuses = useMemo(
    () =>
      new Map(registry?.observedStatuses?.map((s) => [s.slug, s.status]) ?? []),
    [registry],
  );
  const statusOf = (slug: string) =>
    observedStatuses.get(slug) ??
    (registrySlugs.has(slug)
      ? "approved"
      : registry?.truncated
        ? "unverified"
        : "candidate");
  const approvedObservedTags = useMemo(
    () =>
      registry
        ? tags.tags.filter((tag) => statusOf(tag.slug) === "approved")
        : [],
    [registry, registrySlugs, observedStatuses, tags.tags],
  );
  const [browseCursor, setBrowseCursor] = useState<string | undefined>();
  const [previousCursors, setPreviousCursors] = useState<
    Array<string | undefined>
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<BrowseFacets>({
    projects: [],
    kinds: [],
    truncated: false,
  });
  const [facetsError, setFacetsError] = useState("");
  const [facetsState, setFacetsState] = useState<LoadState>("loading");
  const [facetAttempt, setFacetAttempt] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filters.query), 250);
    return () => clearTimeout(timer);
  }, [filters.query]);
  const navigation = useRef(
    new Map<
      number,
      {
        filters: BrowseFilters;
        shared: boolean;
        pages: number;
        cursor?: string | undefined;
        previous?: Array<string | undefined>;
      }
    >(),
  );
  const navigationId = useRef(0);
  const apiFilters = useMemo(
    () =>
      browseEnabled
        ? pagedFilters({ ...filters, query: debouncedQuery })
        : serverFilters(filters),
    [
      browseEnabled,
      browseEnabled ? debouncedQuery : "",
      filters.tag,
      filters.project,
      filters.kind,
      filters.status,
      browseEnabled ? filters.from : "",
      browseEnabled ? filters.to : "",
    ],
  );
  const [visiblePages, setVisiblePages] = useState(1);
  const [reloadCount, setReloadCount] = useState(0);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const timelinePanel = useRef<HTMLElement>(null);
  const returnToTimeline = useRef(false);

  const filtered = useMemo(
    () => (browseEnabled ? notes : filterTimeline(notes, filters)),
    [browseEnabled, notes, filters],
  );
  const visible = browseEnabled
    ? filtered
    : filtered.slice(0, PAGE_SIZE * visiblePages);
  const grouped = groupByLocalDay(visible);
  const dateRangeInvalid = Boolean(
    filters.from && filters.to && filters.from > filters.to,
  );
  const hasFilters = Object.entries(filters).some(
    ([key, value]) =>
      Boolean(value) && (key !== "status" || value !== "active"),
  );

  function navigate(
    next: BrowseFilters,
    id: string | null,
    shared = sharedFilters,
    replace = false,
  ) {
    if (typeof window !== "undefined") {
      const url = writeBrowseUrl(new URL(window.location.href), next, shared);
      url.searchParams.delete("report");
      const reportId = id ? researchTargets.current.get(id) : null;
      if (reportId) url.searchParams.set("report", reportId);
      if (id) url.searchParams.set("note", id);
      else url.searchParams.delete("note");
      const currentKey = window.history.state?.pce as number;
      navigation.current.set(currentKey, {
        filters,
        shared: sharedFilters,
        pages: visiblePages,
        cursor: browseCursor,
        previous: previousCursors,
      });
      const key = ++navigationId.current;
      navigation.current.set(key, {
        filters: next,
        shared,
        pages: next === filters ? visiblePages : 1,
        cursor: next === filters ? browseCursor : undefined,
        previous: next === filters ? previousCursors : [],
      });
      window.history[replace ? "replaceState" : "pushState"](
        { pce: key },
        "",
        url,
      );
    }
    setFilters(next);
    setSharedFilters(shared);
    if (selectedId && !id) returnToTimeline.current = true;
    setSelectedId(id);
    if (next !== filters) {
      setVisiblePages(1);
      setBrowseCursor(undefined);
      setPreviousCursors([]);
    }
  }

  function changeFilter(patch: Partial<BrowseFilters>) {
    navigate({ ...filters, ...patch }, selectedId, sharedFilters, true);
  }

  function navigateToNote(id: string | null) {
    navigate(filters, id);
  }

  function selectTag(tag: string) {
    navigate({ ...filters, tag }, null);
  }

  async function signOut(message = "") {
    if (signingOut) return;
    setSigningOut(true);
    approvalEpoch.current += 1;
    editEpoch.current += 1;
    setTagEditBusy(false);
    setTagEditError("");
    setTagDraft("");
    setRemoveConfirm(false);
    setRemoveBusy(false);
    setRemoveError("");
    setArchiveBusy(false);
    setArchiveError("");
    if (sessionAuthentication) {
      const csrf =
        document.cookie
          .split("; ")
          .find((x) => x.startsWith("pce_csrf="))
          ?.slice(9) ?? "";
      try {
        const response = await fetch(new URL("/auth/logout", baseUrl), {
          signal: AbortSignal.timeout(12000),
          method: "POST",
          credentials: "include",
          headers: { "X-PCE-CSRF": csrf },
        });
        if (!response.ok && response.status !== 401)
          throw new Error("Logout unavailable");
      } catch {
        setNotice(
          "Sign-out failed. Your session may still be active. Try again.",
        );
        setSigningOut(false);
        return;
      }
    }
    setToken(null);
    setSigningOut(false);
    setDraft("");
    setNotice(message);
    setNotes([]);
    setTags({ tags: [], truncated: false });
    setTagsState("loading");
    setTagsError("");
    setFacetsState("loading");
    setFacetsError("");
    setRegistry(null);
    setRegistryError("");
    setRegistryBusy(null);
    setFacets({ projects: [], kinds: [], truncated: false });
    setBrowseCursor(undefined);
    setPreviousCursors([]);
    setNextCursor(null);
    setSharedFilters(false);
    navigation.current.clear();
    setSelectedId(null);
    setDetail(null);
    setFilters(initialFilters);
    setDebouncedQuery("");
    setVisiblePages(1);
    if (typeof window !== "undefined") {
      const url = writeBrowseUrl(
        new URL(window.location.href),
        initialFilters,
        false,
      );
      url.searchParams.delete("note");
      window.history.replaceState(null, "", url);
    }
  }

  useEffect(() => {
    if (!token || !sessionAuthentication) return;
    resumeAuthorization(baseUrl);
  }, [token, sessionAuthentication, baseUrl]);

  async function passwordLogin(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    try {
      const response = await fetch(new URL("/auth/password", baseUrl), {
        signal: AbortSignal.timeout(12000),
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error("Sign-in failed");
      setToken("session-cookie");
    } catch {
      setNotice("Sign-in failed. Check your username and password.");
    } finally {
      setPassword("");
    }
  }
  async function connectLocal() {
    if (!import.meta.env.DEV) return;
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

  async function connectDevelopmentSession() {
    if (!import.meta.env.DEV) return;
    try {
      setNotice("");
      const response = await fetch(new URL("/auth/dev-session", baseUrl), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("Session unavailable");
      setToken("session-cookie");
    } catch {
      setNotice("Local development session unavailable.");
      setAuthFailed(true);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    navigation.current.set(0, {
      filters,
      shared: sharedFilters,
      pages: 1,
      previous: [],
    });
    window.history.replaceState({ pce: 0 }, "", window.location.href);
    const restoreSelection = () => {
      const url = new URL(window.location.href);
      const id = url.searchParams.get("note");
      const saved = navigation.current.get(window.history.state?.pce as number);
      if (!id) returnToTimeline.current = true;
      setSelectedId(id && isNoteId(id) ? id : null);
      setFilters(saved?.filters ?? readBrowseUrl(url));
      setSharedFilters(
        saved?.shared ??
          filterParameters.some((key) => url.searchParams.has(key)),
      );
      setVisiblePages(saved?.pages ?? 1);
      setBrowseCursor(saved?.cursor);
      setPreviousCursors(saved?.previous ?? []);
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
    if (typeof window === "undefined") return;
    let active = true;
    const establishSession = async () => {
      if (!sessionAuthentication) {
        if (localDevelopment) await connectLocal();
        return;
      }
      setAuthMode(null);
      setAuthFailed(false);
      try {
        const configResponse = await fetch(new URL("/auth/config", baseUrl), {
          signal: AbortSignal.timeout(12000),
          credentials: "include",
        });
        if (!configResponse.ok) throw new Error("Auth unavailable");
        const config = (await configResponse.json()) as { mode?: unknown };
        if (
          config.mode !== "single-user" &&
          !(import.meta.env.DEV && config.mode === "dev-single-user")
        )
          throw new Error("Invalid authentication mode");
        if (!active) return;
        setAuthMode(config.mode);
        const current = await fetch(new URL("/auth/session", baseUrl), {
          signal: AbortSignal.timeout(12000),
          credentials: "include",
        });
        if (current.ok) {
          if (active) setToken("session-cookie");
          return;
        }
        if (current.status !== 401) throw new Error("Session unavailable");
        if (!active) return;
        if (
          import.meta.env.DEV &&
          !localDevelopment &&
          config.mode === "dev-single-user"
        )
          await connectDevelopmentSession();
        else if (localDevelopment) await connectLocal();
      } catch {
        if (active) {
          setAuthFailed(true);
          setNotice("Sign-in service unavailable.");
        }
      }
    };
    void establishSession();
    return () => {
      active = false;
    };
  }, [baseUrl, localDevelopment, sessionAuthentication, authAttempt]);

  useEffect(() => {
    if (!token) return;
    if (!apiFilters) {
      setNotes([]);
      setListState("error");
      setListError(
        browseEnabled
          ? "Check the date range, project slug and search length (up to 256 characters)."
          : "Use a lowercase project slug, with hyphens between words.",
      );
      return;
    }
    let active = true;
    const controller = new AbortController();
    setListState("loading");
    setListError("");
    setSearchStatus("");
    const requestOptions = {
      baseUrl,
      getAccessToken: () => token,
      useSessionCookie: sessionAuthentication,
      getCsrfToken: () =>
        document.cookie
          .split("; ")
          .find((v) => v.startsWith("pce_csrf="))
          ?.slice(9) ?? "",
      signal: controller.signal,
      timeoutMs: 12000,
    };
    const query = (apiFilters as { q?: string }).q;
    const request =
      searchEnabled && query
        ? searchContext(requestOptions, {
            query,
            limit: 24,
            ...(filters.tag ? { tags: [filters.tag] } : {}),
            ...(filters.project ? { project: filters.project } : {}),
            ...(filters.kind
              ? { kind: filters.kind as SearchRequest["kind"] }
              : {}),
            status: filters.status,
            ...((apiFilters as { start?: string }).start
              ? { start: (apiFilters as { start: string }).start }
              : {}),
            ...((apiFilters as { end?: string }).end
              ? { end: (apiFilters as { end: string }).end }
              : {}),
            ...(browseCursor ? { cursor: browseCursor } : {}),
          }).then((result) => {
            if (active)
              setSearchStatus(
                result.mode === "hybrid"
                  ? "Semantic and keyword matches"
                  : "Keyword matches — semantic search is currently unavailable.",
              );
            if (active) {
              researchTargets.current.clear();
              for (const hit of result.results)
                if (
                  hit.parentNoteId &&
                  !researchTargets.current.has(hit.parentNoteId)
                )
                  researchTargets.current.set(hit.parentNoteId, hit.id);
            }
            return {
              notes: result.results
                .map((r) => ({
                  id: r.parentNoteId ?? r.id,
                  title:
                    r.contentType === "research"
                      ? "Research: " + r.title
                      : r.title,
                  summary: r.snippet || r.title,
                  tags: r.tags,
                  capturedAt: r.capturedAt,
                  status: r.status,
                }))
                .filter(
                  (n, index, all) =>
                    all.findIndex((other) => other.id === n.id) === index,
                ),
              nextCursor: result.nextCursor,
            };
          })
        : browseEnabled
          ? getBrowsePage(requestOptions, {
              ...apiFilters,
              ...(browseCursor ? { cursor: browseCursor } : {}),
            })
          : getNotes(
              requestOptions,
              apiFilters as Parameters<typeof getNotes>[1],
            );
    request
      .then((result) => {
        if (!active) return;
        setNotes(result.notes);
        setNextCursor(
          "nextCursor" in result && typeof result.nextCursor === "string"
            ? result.nextCursor
            : null,
        );
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          signOut(describeNotesError(error));
        } else if (
          browseEnabled &&
          browseCursor &&
          error instanceof ApiRequestError &&
          error.status === 400
        ) {
          setBrowseCursor(undefined);
          setPreviousCursors([]);
          setNotice("The note snapshot changed. Showing the first page again.");
        } else {
          setListState("error");
          setListError(describeNotesError(error));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    baseUrl,
    token,
    reloadCount,
    apiFilters,
    browseCursor,
    browseEnabled,
    browseEnabled ? null : ingestion?.lastRun,
  ]);

  // Facets are slow-changing metadata, independent of ingestion status polling.
  useEffect(() => {
    if (!token) return;
    const timer = setInterval(
      () => setMetadataRefresh((n) => n + 1),
      60 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (!browseEnabled || !token) return;
    let active = true;
    const controller = new AbortController();
    setFacetsError("");
    setFacetsState((current) => (current === "ready" ? "ready" : "loading"));
    getBrowseFacets(
      {
        baseUrl,
        getAccessToken: () => token,
        useSessionCookie: sessionAuthentication,
        getCsrfToken: () =>
          document.cookie
            .split("; ")
            .find((v) => v.startsWith("pce_csrf="))
            ?.slice(9) ?? "",
        signal: controller.signal,
        timeoutMs: 12000,
      },
      filters.status,
    )
      .then((result) => {
        if (active) {
          setFacets(result);
          setFacetsState("ready");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401)
          signOut(describeNotesError(error));
        else {
          setFacetsError(describeNotesError(error));
          setFacetsState((current) =>
            current === "ready" ? "ready" : "error",
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    baseUrl,
    token,
    browseEnabled,
    reloadCount,
    facetAttempt,
    metadataRefresh,
    filters.status,
  ]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const controller = new AbortController();
    setTagsState((current) => (current === "ready" ? "ready" : "loading"));
    setTagsError("");
    getTags(
      {
        baseUrl,
        getAccessToken: () => token,
        useSessionCookie: sessionAuthentication,
        getCsrfToken: () =>
          document.cookie
            .split("; ")
            .find((v) => v.startsWith("pce_csrf="))
            ?.slice(9) ?? "",
        signal: controller.signal,
        timeoutMs: 12000,
      },
      filters.status,
    )
      .then((result) => {
        if (!active) return;
        setTags(result);
        setTagsState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401)
          signOut(describeNotesError(error));
        else {
          setTagsState((current) => (current === "ready" ? "ready" : "error"));
          setTagsError(describeNotesError(error));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    baseUrl,
    token,
    tagAttempt,
    reloadCount,
    metadataRefresh,
    filters.status,
  ]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const controller = new AbortController();
    getTagRegistry({
      baseUrl,
      getAccessToken: () => token,
      useSessionCookie: sessionAuthentication,
      signal: controller.signal,
      timeoutMs: 12000,
    })
      .then((result) => {
        if (active) {
          setRegistry(result);
          setRegistryError("");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          signOut(describeNotesError(error));
        } else if (error instanceof ApiRequestError && error.status === 404) {
          setRegistry(null);
          setRegistryError("");
        } else {
          setRegistryError(describeNotesError(error));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [baseUrl, token, registryAttempt, reloadCount, metadataRefresh]);

  async function changeApproval(slug: string, approved: boolean) {
    if (!token || registryBusy) return;
    const epoch = approvalEpoch.current;
    setRegistryBusy(slug);
    setRegistryError("");
    const options = {
      baseUrl,
      getAccessToken: () => token,
      useSessionCookie: sessionAuthentication,
      getCsrfToken: () =>
        document.cookie
          .split("; ")
          .find((v) => v.startsWith("pce_csrf="))
          ?.slice(9) ?? "",
      timeoutMs: 12000,
    };
    try {
      if (approved) await approveTag(options, slug);
      else await unapproveTag(options, slug);
      // A successful write may outlive signout. Never restore another session's
      // owner-scoped registry or status after credentials have been cleared.
      if (epoch !== approvalEpoch.current) return;
      const refreshed = await getTagRegistry(options);
      if (epoch !== approvalEpoch.current) return;
      setRegistry(refreshed);
      setNotice(
        approved
          ? "Tag approved for future use."
          : "Tag unapproved; existing note tags preserved.",
      );
    } catch (error) {
      if (epoch === approvalEpoch.current)
        setRegistryError(describeNotesError(error));
    } finally {
      if (epoch === approvalEpoch.current) setRegistryBusy(null);
    }
  }

  function toggleActivityApproval(slug: string) {
    if (!registry) {
      // Keep tag navigation usable while an older server has no registry
      // endpoint. Once the registry is available, activity chips are the
      // single approval control.
      selectTag(slug);
      return;
    }
    void changeApproval(slug, statusOf(slug) !== "approved");
  }

  useEffect(() => {
    editEpoch.current += 1;
    setTagDraft("");
    setTagEditError("");
    setTagEditBusy(false);
    setRemoveConfirm(false);
    setRemoveBusy(false);
    setRemoveError("");
    setArchiveBusy(false);
    setArchiveError("");
  }, [selectedId]);

  async function editNoteTag(operation: "add" | "remove", slug: string) {
    if (!token || !detail?.tagEditing || tagEditBusy) return;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
      setTagEditError(
        "Use lowercase letters, digits and single hyphens (up to 64 characters).",
      );
      return;
    }
    const epoch = editEpoch.current;
    const id = detail.id;
    setTagEditBusy(true);
    setTagEditError("");
    try {
      const result = await changeNoteTag(
        {
          baseUrl,
          getAccessToken: () => token,
          useSessionCookie: sessionAuthentication,
          getCsrfToken: () =>
            document.cookie
              .split("; ")
              .find((v) => v.startsWith("pce_csrf="))
              ?.slice(9) ?? "",
          timeoutMs: 12000,
        },
        id,
        { operation, slug, expectedRevision: detail.tagEditing.revision },
      );
      if (epoch !== editEpoch.current) return;
      setDetail((current) =>
        current?.id === id ? { ...current, ...result } : current,
      );
      setTagDraft("");
      setReloadCount((n) => n + 1);
      setNotice(
        result.changed
          ? "Note tag changes saved to your database."
          : "Note tags already up to date.",
      );
    } catch (error) {
      if (epoch !== editEpoch.current) return;
      if (error instanceof ApiRequestError && error.status === 409) {
        setTagEditError(
          "Tags changed in another tab. Reloaded current tags; retry your action.",
        );
        setDetailAttempt((n) => n + 1);
      } else if (error instanceof ApiRequestError && error.status === 401) {
        signOut(describeNotesError(error));
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setTagEditError("This session is missing tags:write access.");
      } else {
        setTagEditError(describeNotesError(error));
      }
    } finally {
      if (epoch === editEpoch.current) setTagEditBusy(false);
    }
  }

  async function removeSelectedNote() {
    if (!token || !detail || removeBusy) return;
    const epoch = editEpoch.current;
    const id = detail.id;
    setRemoveBusy(true);
    setRemoveError("");
    try {
      await removeNote(
        {
          baseUrl,
          getAccessToken: () => token,
          useSessionCookie: sessionAuthentication,
          getCsrfToken: () =>
            document.cookie
              .split("; ")
              .find((v) => v.startsWith("pce_csrf="))
              ?.slice(9) ?? "",
          timeoutMs: 12000,
        },
        id,
      );
      if (epoch !== editEpoch.current) return;
      setNotes((current) => current.filter((note) => note.id !== id));
      setDetail(null);
      setRemoveConfirm(false);
      setReloadCount((n) => n + 1);
      navigateToNote(null);
      setNotice("Note removed from this workspace.");
    } catch (error) {
      if (epoch !== editEpoch.current) return;
      if (error instanceof ApiRequestError && error.status === 401) {
        signOut(describeNotesError(error));
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setRemoveError("This session is missing notes:write access.");
      } else if (error instanceof ApiRequestError && error.status === 404) {
        setRemoveError("This note is unavailable.");
      } else {
        setRemoveError(describeNotesError(error, true));
      }
    } finally {
      if (epoch === editEpoch.current) setRemoveBusy(false);
    }
  }

  async function setSelectedNoteArchived(archived: boolean) {
    if (!token || !detail || archiveBusy) return;
    const epoch = editEpoch.current;
    const id = detail.id;
    setArchiveBusy(true);
    setArchiveError("");
    try {
      const result = await setNoteArchived(
        {
          baseUrl,
          getAccessToken: () => token,
          useSessionCookie: sessionAuthentication,
          getCsrfToken: () =>
            document.cookie
              .split("; ")
              .find((v) => v.startsWith("pce_csrf="))
              ?.slice(9) ?? "",
          timeoutMs: 12000,
        },
        id,
        archived,
      );
      if (epoch !== editEpoch.current) return;
      setDetail((current) =>
        current?.id === id ? { ...current, status: result.status } : current,
      );
      setNotes((current) =>
        current.map((note) =>
          note.id === id ? { ...note, status: result.status } : note,
        ),
      );
      setReloadCount((n) => n + 1);
      setNotice(archived ? "Note archived." : "Note restored to active notes.");
      if (archived && filters.status === "active") navigateToNote(null);
    } catch (error) {
      if (epoch !== editEpoch.current) return;
      if (error instanceof ApiRequestError && error.status === 401) {
        signOut(describeNotesError(error));
      } else if (error instanceof ApiRequestError && error.status === 403) {
        setArchiveError("This session is missing notes:write access.");
      } else if (error instanceof ApiRequestError && error.status === 404) {
        setArchiveError("This note is unavailable.");
      } else {
        setArchiveError(describeNotesError(error, true));
      }
    } finally {
      if (epoch === editEpoch.current) setArchiveBusy(false);
    }
  }

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
    (searchEnabled ? getSearchNote : getNote)(
      {
        baseUrl,
        getAccessToken: () => token,
        useSessionCookie: sessionAuthentication,
        getCsrfToken: () =>
          document.cookie
            .split("; ")
            .find((v) => v.startsWith("pce_csrf="))
            ?.slice(9) ?? "",
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
    if (selectedId && detailState === "ready") detailHeading.current?.focus();
    if (!selectedId && returnToTimeline.current) {
      returnToTimeline.current = false;
      timelinePanel.current?.focus();
    }
  }, [detailState, selectedId]);

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    // Preserve a validated deep link during initial manual sign-in.
    // Switching users requires Clear session, which removes the URL note ID.
    setNotes([]);
    setDetail(null);
    setNotice("");
    setToken(value);
    setDraft("");
  }

  return (
    <main className="app-shell">
      {token &&
        sessionAuthentication &&
        (() => {
          const parameters = new URL(window.location.href).searchParams.get(
            "authorize",
          );
          if (!parameters || parameters.length > 4096) return null;
          const target = new URL("/oauth/authorize", baseUrl);
          target.search = parameters;
          return (
            <aside role="status">
              <p>
                A client is requesting access to PCE. Review its permissions
                before allowing access.
              </p>
              <a href={target.toString()}>Review client access</a>
            </aside>
          );
        })()}
      <header className="topbar">
        <div>
          <p className="eyebrow">Personal workspace</p>
          <h1>Personal Context Engine</h1>
          <p className="subtitle">
            {token && tasksEnabled
              ? "Keep your notes and commitments together."
              : localDevelopment
                ? "Browse the notes in your local workspace. Capture, editing and reminders are separate workflows."
                : sessionAuthentication
                  ? "Sign in to browse your workspace. Editing and reminders are separate workflows."
                  : "Development preview. Production login, editing and reminders are not available."}
          </p>
        </div>
        <div className="actions header-actions">
          {token && (
            <div className="actions">
              {(!tasksEnabled || workspaceView === "notes") && (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setBrowseCursor(undefined);
                    setPreviousCursors([]);
                    setReloadCount((n) => n + 1);
                  }}
                >
                  Refresh notes
                </button>
              )}
              <button
                className="ghost"
                type="button"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {signingOut ? "Signing out…" : "Clear session"}
              </button>
            </div>
          )}
        </div>
      </header>

      {token && searchStatus && <p role="status">{searchStatus}</p>}
      {token && notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {token && tasksEnabled && (
        <nav
          className="actions workspace-navigation"
          aria-label="Workspace views"
        >
          <button
            type="button"
            className={workspaceView === "notes" ? "primary" : "secondary"}
            aria-pressed={workspaceView === "notes"}
            onClick={() => setWorkspaceView("notes")}
          >
            Notes
          </button>
          <button
            type="button"
            className={workspaceView === "tasks" ? "primary" : "secondary"}
            aria-pressed={workspaceView === "tasks"}
            onClick={() => setWorkspaceView("tasks")}
          >
            Tasks
          </button>
        </nav>
      )}
      {token && tasksEnabled && (
        <div hidden={workspaceView !== "tasks"}>
          <TasksPanel
            baseUrl={baseUrl}
            token={token}
            useSessionCookie={sessionAuthentication}
            onOpenNote={(id) => {
              navigateToNote(id);
              setWorkspaceView("notes");
            }}
          />
        </div>
      )}
      {!token ? (
        <section className="panel auth-panel" aria-label="Sign-in required">
          <h2>Sign-in required</h2>
          {notice && (
            <p className="error" role="alert">
              {notice}
            </p>
          )}
          {sessionAuthentication && (authFailed || authMode === null) ? (
            authFailed ? (
              <button
                type="button"
                onClick={() => {
                  setNotice("");
                  setAuthAttempt((n) => n + 1);
                }}
              >
                Retry sign-in service
              </button>
            ) : (
              <p role="status">Checking sign-in service…</p>
            )
          ) : sessionAuthentication && authMode === "single-user" ? (
            <form onSubmit={passwordLogin}>
              <label>
                Username
                <input
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button type="submit">Sign in</button>
            </form>
          ) : import.meta.env.DEV && localDevelopment ? (
            <button
              className="primary"
              type="button"
              onClick={() => void connectLocal()}
            >
              Connect local workspace
            </button>
          ) : import.meta.env.DEV && !sessionAuthentication ? (
            <>
              <p>
                For synthetic development only, enter a short-lived notes:read
                JWT from a trusted issuer. This token stays in memory, not
                browser storage.
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
                  <button
                    className="primary"
                    type="submit"
                    disabled={!draft.trim()}
                  >
                    Connect
                  </button>
                </div>
              </form>
            </>
          ) : (
            <p role="status">Connecting local development session…</p>
          )}
        </section>
      ) : (
        <div
          hidden={tasksEnabled && workspaceView !== "notes"}
          className={`workspace${selectedId ? " has-selection" : ""}`}
        >
          <section
            className="panel controls-panel"
            aria-label="Browse controls"
          >
            <div className="filters" role="group" aria-label="Timeline filters">
              <div className="filter-field">
                <label htmlFor="note-query">
                  {browseEnabled
                    ? "Search all note text"
                    : "Search loaded titles and summaries"}
                </label>
                <input
                  id="note-query"
                  type="search"
                  maxLength={browseEnabled ? 256 : undefined}
                  placeholder={
                    searchEnabled ? "Ask or search your notes" : "Keyword"
                  }
                  value={filters.query}
                  onChange={(event) =>
                    changeFilter({ query: event.target.value })
                  }
                />
              </div>
              <div className="filter-field filter-date">
                <label htmlFor="from-date">From (local date)</label>
                <input
                  id="from-date"
                  type="date"
                  value={filters.from}
                  onChange={(event) =>
                    changeFilter({ from: event.target.value })
                  }
                />
              </div>
              <div className="filter-field filter-date">
                <label htmlFor="to-date">To (local date)</label>
                <input
                  id="to-date"
                  type="date"
                  value={filters.to}
                  onChange={(event) => changeFilter({ to: event.target.value })}
                />
              </div>
              <div className="filter-field">
                <label htmlFor="project-filter">
                  {browseEnabled ? "Project" : "Project slug"}
                </label>
                <SuggestionPicker
                  id="project-filter"
                  placeholder="All projects"
                  suggestionsLabel="Project suggestions"
                  value={filters.project}
                  onChange={(project) => changeFilter({ project })}
                  open={projectPickerOpen}
                  onOpenChange={setProjectPickerOpen}
                  options={
                    browseEnabled
                      ? [
                          { value: "", label: "All projects" },
                          ...facets.projects
                            .filter((project) =>
                              project.slug
                                .toLowerCase()
                                .includes(filters.project.trim().toLowerCase()),
                            )
                            .map((project) => ({
                              value: project.slug,
                              label: `${project.slug} (${project.count})`,
                            })),
                        ]
                      : []
                  }
                  emptyMessage={
                    browseEnabled
                      ? "No matching projects. You can type a project slug."
                      : "Type a project slug to filter."
                  }
                />
              </div>
              <div className="filter-field filter-date">
                <label htmlFor="kind-filter">Kind</label>
                <select
                  id="kind-filter"
                  value={filters.kind}
                  onChange={(event) =>
                    changeFilter({
                      kind: event.target.value as BrowseFilters["kind"],
                    })
                  }
                >
                  <option value="">All kinds</option>
                  {(browseEnabled
                    ? facets.kinds.map((k) => k.slug)
                    : noteKinds
                  ).map((kind) => (
                    <option value={kind} key={kind}>
                      {kind}
                      {browseEnabled
                        ? ` (${facets.kinds.find((k) => k.slug === kind)?.count ?? 0})`
                        : ""}
                    </option>
                  ))}
                  {browseEnabled &&
                    filters.kind &&
                    !facets.kinds.some((k) => k.slug === filters.kind) && (
                      <option value={filters.kind}>{filters.kind} (0)</option>
                    )}
                </select>
              </div>
              <div className="filter-field filter-date">
                <label htmlFor="status-filter">Notes</label>
                <select
                  id="status-filter"
                  value={filters.status}
                  onChange={(event) =>
                    changeFilter({
                      status: event.target.value as BrowseFilters["status"],
                    })
                  }
                >
                  <option value="active">Active notes</option>
                  <option value="archived">Archived notes</option>
                  <option value="all">Active and archived</option>
                </select>
              </div>
              <div className="filter-actions">
                <button
                  className="ghost"
                  type="button"
                  disabled={!hasFilters}
                  onClick={() => {
                    navigate(initialFilters, null, false);
                  }}
                >
                  Reset filters
                </button>
              </div>
            </div>

            {browseEnabled && facetsState === "loading" && (
              <p className="notice" role="status">
                Loading project and kind filters…
              </p>
            )}
            {browseEnabled && facetsError && (
              <div className="notice" role="alert">
                <p>Project/kind filters: {facetsError}</p>
                <button
                  className="secondary"
                  onClick={() => setFacetAttempt((n) => n + 1)}
                >
                  Retry filters
                </button>
              </div>
            )}
            {browseEnabled && facets.truncated && (
              <p className="notice">
                Showing 200 project suggestions. Enter another observed project
                slug to filter.
              </p>
            )}
            <section className="tag-browser" aria-labelledby="tags-title">
              <h3 id="tags-title">Your tags</h3>
              <p className="subtitle">
                Counts cover all notes available to this session.
              </p>
              {tagsState === "loading" && <p role="status">Loading tags…</p>}
              {tagsError && (
                <div role="alert">
                  <p>{tagsError}</p>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setTagAttempt((n) => n + 1)}
                  >
                    Retry tags
                  </button>
                </div>
              )}
              {tagsState === "ready" && (
                <>
                  {tags.tags.length === 0 && <p>No tags yet.</p>}
                  {tags.tags.length > 0 &&
                    approvedObservedTags.length === 0 && (
                      <p>
                        No approved tags yet. Pick one from a note activity to
                        add it here.
                      </p>
                    )}
                  <div
                    className="tag-chips"
                    role="group"
                    aria-label="Approved tags"
                  >
                    {approvedObservedTags.map((tag) => (
                      <span key={tag.slug} className="tag-pair">
                        <button
                          className="tag-chip tag-chip-picked"
                          type="button"
                          aria-pressed={filters.tag === tag.slug}
                          aria-label={`Filter by approved tag ${tag.slug}, ${tag.count} notes`}
                          title="Approved tag"
                          onClick={() =>
                            selectTag(filters.tag === tag.slug ? "" : tag.slug)
                          }
                        >
                          <span aria-hidden="true" className="tag-check">
                            ✓
                          </span>
                          {tag.slug} <span aria-hidden="true">{tag.count}</span>
                        </button>
                      </span>
                    ))}
                  </div>
                  {registryError && (
                    <div role="alert">
                      <p>Tag approval unavailable: {registryError}</p>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => setRegistryAttempt((n) => n + 1)}
                      >
                        Retry approvals
                      </button>
                    </div>
                  )}
                  {tags.truncated && (
                    <p role="status">
                      Showing the first 200 observed tags. Candidate tags stay
                      on note activities until picked.
                    </p>
                  )}
                </>
              )}
              {filters.tag && (
                <p className="active-tag">
                  Selected tag: <strong>{filters.tag}</strong>{" "}
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => selectTag("")}
                  >
                    Clear tag
                  </button>
                </p>
              )}
              <button
                className="ghost"
                type="button"
                disabled={!apiFilters || dateRangeInvalid}
                onClick={() =>
                  navigate(filters, selectedId, !sharedFilters, true)
                }
              >
                {sharedFilters
                  ? "Remove filters from link"
                  : "Share filtered view"}
              </button>
              <p className="share-hint">
                {sharedFilters
                  ? "Tag, project, kind, status and dates are in the address. Copy it to share; access still requires a session."
                  : "Sharing adds tag, project, kind, status and dates to the address. Search text stays in memory."}
              </p>
            </section>

            {dateRangeInvalid && (
              <p className="notice" role="status">
                The start date is later than the end date.
              </p>
            )}
          </section>
          <section
            className="panel timeline-panel"
            id="timeline"
            aria-label="Notes"
            ref={timelinePanel}
            tabIndex={-1}
          >
            {listState === "loading" && (
              <p className="notice" role="status">
                Loading notes…
              </p>
            )}
            {listState === "error" && (
              <div className="notice" role="alert">
                <p>{listError}</p>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setReloadCount((n) => n + 1)}
                >
                  Try again
                </button>
              </div>
            )}
            {listState === "ready" && (
              <>
                <p className="sr-only" role="status">
                  {browseEnabled
                    ? `Showing ${visible.length} ${visible.length === 1 ? "note" : "notes"} · Page ${previousCursors.length + 1}`
                    : `${filtered.length} of ${notes.length} loaded notes match · showing ${visible.length}`}
                </p>
                {visible.length === 0 ? (
                  <div className="empty">
                    <h3>
                      {hasFilters ? "No matching notes" : "No notes available"}
                    </h3>
                    <p>
                      {hasFilters
                        ? "Change or reset the filters to see more."
                        : "No notes are available for this session. Check ingestion or capture another note."}
                    </p>
                  </div>
                ) : (
                  grouped.map((group) => (
                    <section
                      className="day-group"
                      key={group.day}
                      aria-label={group.day}
                    >
                      <h3 className="day-heading">
                        {new Date(group.day + "T12:00:00").toLocaleDateString(
                          undefined,
                          {
                            weekday: "long",
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          },
                        )}
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
                              <span className="note-title">
                                {note.title}
                                {note.status === "archived" && (
                                  <span className="status-badge status-archived note-status">
                                    Archived
                                  </span>
                                )}
                              </span>
                              <span className="note-excerpt">
                                {note.summary}
                              </span>
                              <time
                                className="note-time"
                                dateTime={note.capturedAt}
                              >
                                {new Date(note.capturedAt).toLocaleTimeString(
                                  undefined,
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  },
                                )}
                              </time>
                            </button>
                            {note.tags && note.tags.length > 0 && (
                              <div
                                className="tag-chips note-tags"
                                aria-label={`Tags on ${note.title}`}
                              >
                                {note.tags.map((tag) => (
                                  <button
                                    className={`tag-chip tag-chip-activity${registry && statusOf(tag) === "approved" ? " tag-chip-picked" : ""}`}
                                    type="button"
                                    key={tag}
                                    aria-pressed={
                                      registry
                                        ? statusOf(tag) === "approved"
                                        : filters.tag === tag
                                    }
                                    aria-label={
                                      registry
                                        ? statusOf(tag) === "approved"
                                          ? `Unpick approved tag ${tag}`
                                          : `Pick tag ${tag} to approve`
                                        : `Filter by tag ${tag}`
                                    }
                                    title={
                                      registry
                                        ? `Tag status: ${statusOf(tag)}`
                                        : undefined
                                    }
                                    disabled={
                                      registry ? registryBusy !== null : false
                                    }
                                    onClick={() =>
                                      registry
                                        ? toggleActivityApproval(tag)
                                        : selectTag(tag)
                                    }
                                  >
                                    {registry &&
                                      statusOf(tag) === "approved" && (
                                        <span
                                          aria-hidden="true"
                                          className="tag-check"
                                        >
                                          ✓
                                        </span>
                                      )}
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
                {browseEnabled &&
                  (nextCursor || previousCursors.length > 0) && (
                    <nav className="pager" aria-label="Note pages">
                      <button
                        className="secondary"
                        disabled={!previousCursors.length}
                        onClick={() => {
                          setBrowseCursor(previousCursors.at(-1));
                          setPreviousCursors(previousCursors.slice(0, -1));
                          timelinePanel.current?.focus();
                        }}
                      >
                        Previous page
                      </button>
                      <button
                        className="secondary"
                        disabled={!nextCursor}
                        onClick={() => {
                          setPreviousCursors([
                            ...previousCursors,
                            browseCursor,
                          ]);
                          setBrowseCursor(nextCursor ?? undefined);
                          timelinePanel.current?.focus();
                        }}
                      >
                        Next page
                      </button>
                    </nav>
                  )}
                {!browseEnabled && visible.length < filtered.length && (
                  <div className="pager">
                    <span>
                      {filtered.length - visible.length} more matching notes
                    </span>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setVisiblePages((n) => n + 1)}
                    >
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
                <button
                  className="ghost detail-back"
                  type="button"
                  onClick={() => navigateToNote(null)}
                >
                  ← Back to timeline
                </button>
                {(detailState === "loading" ||
                  (detailState === "ready" && detail?.id !== selectedId)) && (
                  <p role="status">Loading detail…</p>
                )}
                {detailState === "error" && (
                  <div className="error" role="alert">
                    <p>{detailError}</p>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setDetailAttempt((n) => n + 1)}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {detailState === "ready" && detail?.id === selectedId && (
                  <div className="detail-actions">
                    <span
                      className={`status-badge status-${detail.status}`}
                      aria-label={`Note status: ${detail.status}`}
                    >
                      {detail.status === "archived" ? "Archived" : "Active"}
                    </span>
                    <button
                      className="ghost"
                      type="button"
                      onClick={() =>
                        void setSelectedNoteArchived(
                          detail.status !== "archived",
                        )
                      }
                      disabled={archiveBusy || removeBusy || removeConfirm}
                    >
                      {archiveBusy
                        ? detail.status === "archived"
                          ? "Restoring…"
                          : "Archiving…"
                        : detail.status === "archived"
                          ? "Unarchive note"
                          : "Archive note"}
                    </button>
                    {!removeConfirm ? (
                      <button
                        className="danger"
                        type="button"
                        aria-label="Remove note"
                        onClick={() => {
                          setRemoveError("");
                          setRemoveConfirm(true);
                        }}
                        disabled={removeBusy || archiveBusy}
                      >
                        Remove note
                      </button>
                    ) : (
                      <div
                        className="remove-confirm"
                        role="group"
                        aria-label="Confirm note removal"
                      >
                        <p>
                          Remove this note from the workspace? Its original
                          source and provenance will be preserved.
                        </p>
                        <div className="actions">
                          <button
                            className="ghost"
                            type="button"
                            onClick={() => {
                              setRemoveConfirm(false);
                              setRemoveError("");
                            }}
                            disabled={removeBusy}
                          >
                            Cancel
                          </button>
                          <button
                            className="danger"
                            type="button"
                            aria-label="Confirm remove note"
                            onClick={() => void removeSelectedNote()}
                            disabled={removeBusy}
                          >
                            {removeBusy ? "Removing…" : "Remove note"}
                          </button>
                        </div>
                        {removeError && (
                          <p className="error" role="alert">
                            {removeError}
                          </p>
                        )}
                      </div>
                    )}
                    {archiveError && (
                      <p className="error" role="alert">
                        {archiveError}
                      </p>
                    )}
                  </div>
                )}
                {detailState === "ready" && detail?.id === selectedId && (
                  <article>
                    <p className="eyebrow">
                      Captured note
                      {detail.status === "archived" ? " · archived" : ""}
                    </p>
                    <h2
                      className="detail-title"
                      ref={detailHeading}
                      tabIndex={-1}
                    >
                      {detail.title}
                    </h2>
                    <time dateTime={detail.capturedAt} className="note-time">
                      {new Date(detail.capturedAt).toLocaleString()}
                    </time>
                    <p className="detail-summary">{detail.summary}</p>
                    {detail.tags && detail.tags.length > 0 && (
                      <div className="tag-chips" aria-label="Note tags">
                        {detail.tags.map((tag) => (
                          <span className="tag-pair" key={tag}>
                            <button
                              className={`tag-chip tag-chip-activity${registry && statusOf(tag) === "approved" ? " tag-chip-picked" : ""}`}
                              type="button"
                              title={
                                registry
                                  ? `Tag status: ${statusOf(tag)}`
                                  : undefined
                              }
                              aria-pressed={
                                registry
                                  ? statusOf(tag) === "approved"
                                  : filters.tag === tag
                              }
                              aria-label={
                                registry
                                  ? statusOf(tag) === "approved"
                                    ? `Unpick approved tag ${tag}`
                                    : `Pick tag ${tag} to approve`
                                  : `Filter by tag ${tag}`
                              }
                              disabled={
                                registry ? registryBusy !== null : false
                              }
                              onClick={() =>
                                registry
                                  ? toggleActivityApproval(tag)
                                  : selectTag(tag)
                              }
                            >
                              {registry && statusOf(tag) === "approved" && (
                                <span aria-hidden="true" className="tag-check">
                                  ✓
                                </span>
                              )}
                              {tag}
                            </button>
                            {detail.tagEditing && (
                              <button
                                className="ghost tag-action tag-remove"
                                type="button"
                                aria-label={`Remove tag ${tag} from this note`}
                                title={`Remove tag ${tag} from this note`}
                                disabled={tagEditBusy}
                                onClick={() => void editNoteTag("remove", tag)}
                              >
                                <span aria-hidden="true">−</span>
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {detail.tagEditing && (
                      <div className="note-tag-editor">
                        <label htmlFor="new-note-tag">
                          Add a tag to this note
                        </label>
                        <div className="note-tag-add-row">
                          <NoteTagPicker
                            value={tagDraft}
                            onChange={setTagDraft}
                            disabled={tagEditBusy}
                            attached={detail.tags ?? []}
                            baseUrl={baseUrl}
                            token={token}
                            useSessionCookie={sessionAuthentication}
                            revision={registry?.revision}
                          />
                          <button
                            type="button"
                            className="secondary"
                            disabled={tagEditBusy || !tagDraft.trim()}
                            onClick={() =>
                              void editNoteTag("add", tagDraft.trim())
                            }
                          >
                            {tagEditBusy ? "Saving…" : "Add tag"}
                          </button>
                        </div>
                        <p className="subtitle" id="tag-edit-help">
                          Choose an approved tag or type a new one. New tags
                          stay candidates until approved.
                        </p>
                        {tagEditError && (
                          <p className="error" role="alert">
                            {tagEditError}
                          </p>
                        )}
                      </div>
                    )}
                    {detail.metadata && (
                      <dl className="note-metadata">
                        <dt>Kind</dt>
                        <dd>{detail.metadata.kind}</dd>
                        <dt>Source</dt>
                        <dd>{detail.metadata.source}</dd>
                        <dt>Captured</dt>
                        <dd>{detail.metadata.capturedAtRaw}</dd>
                        {detail.metadata.timezone && (
                          <>
                            <dt>Timezone</dt>
                            <dd>{detail.metadata.timezone}</dd>
                          </>
                        )}
                        <dt>Projects</dt>
                        <dd>{detail.metadata.projects.join(", ") || "None"}</dd>
                        <dt>Domains</dt>
                        <dd>{detail.metadata.domains.join(", ") || "None"}</dd>
                        <dt>Action hint</dt>
                        <dd>{detail.metadata.actionHint} (advisory)</dd>
                        <dt>Review</dt>
                        <dd>
                          {detail.metadata.reviewRequired
                            ? "Required"
                            : "Not requested"}
                        </dd>
                        {detail.metadata.occurredAt && (
                          <>
                            <dt>Occurred</dt>
                            <dd>{detail.metadata.occurredAt}</dd>
                          </>
                        )}
                        {detail.metadata.dueAt && (
                          <>
                            <dt>Due</dt>
                            <dd>
                              {detail.metadata.dueAt} · No notification
                              scheduled
                            </dd>
                          </>
                        )}
                      </dl>
                    )}
                    {researchEnabled && (
                      <ResearchPanel
                        key={detail.id}
                        noteId={detail.id}
                        initialReportId={
                          researchTargets.current.get(detail.id) ??
                          new URL(window.location.href).searchParams.get(
                            "report",
                          ) ??
                          undefined
                        }
                        baseUrl={baseUrl}
                        token={token}
                        useSessionCookie={sessionAuthentication}
                      />
                    )}
                    {detail.originalInput !== undefined ? (
                      <>
                        <h3>Original input</h3>
                        <pre
                          className="detail-body"
                          tabIndex={0}
                          role="region"
                          aria-label="Original input"
                        >
                          {detail.originalInput}
                        </pre>
                        <details>
                          <summary>Full captured Markdown</summary>
                          <pre
                            className="detail-body"
                            tabIndex={0}
                            role="region"
                            aria-label="Full captured Markdown"
                          >
                            {detail.body}
                          </pre>
                        </details>
                      </>
                    ) : (
                      <>
                        <h3>Original body</h3>
                        <pre className="detail-body">{detail.body}</pre>
                      </>
                    )}
                  </article>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {localDevelopment && (
        <section
          className="panel status-panel"
          aria-label="Ingestion worker status"
        >
          <h2>Ingestion worker</h2>
          {!ingestion ? (
            <p>
              Worker status is unavailable. A local session can still display
              previously indexed notes.
            </p>
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
                <p>
                  Last successful check:{" "}
                  {new Date(ingestion.lastRun).toLocaleString()}
                </p>
              )}
              {ingestion.report && (
                <p>
                  Last pass: {ingestion.report.finalized} finalized,{" "}
                  {ingestion.report.rejected} rejected,{" "}
                  {ingestion.report.retried} retries.
                </p>
              )}
              {ingestion.checkpoint && (
                <p>
                  {ingestion.checkpoint.revisionPending
                    ? "Source revision awaits reconciliation."
                    : "Observed source revision reconciled."}
                  {ingestion.checkpoint.reconciledAt && (
                    <>
                      {" "}
                      Last reconciliation:{" "}
                      {new Date(
                        ingestion.checkpoint.reconciledAt,
                      ).toLocaleString()}
                      .
                    </>
                  )}
                </p>
              )}
              {ingestion.reconciliation && (
                <p
                  role={
                    ingestion.reconciliation.conflicts ||
                    ingestion.reconciliation.missing ||
                    ingestion.reconciliation.invalid
                      ? "status"
                      : undefined
                  }
                >
                  Source checks: {ingestion.reconciliation.conflicts} conflicts,{" "}
                  {ingestion.reconciliation.missing} missing sources,{" "}
                  {ingestion.reconciliation.invalid} invalid files. Stored
                  originals are retained.
                </p>
              )}
              {ingestion.error && (
                <p className="error" role="alert">
                  Ingestion needs attention. Check repository access, clean
                  checkout and note ownership. Previous notes remain available.
                </p>
              )}
              <p>
                Rejected captures remain recoverable in the repository; use
                capture:validate to diagnose them.
              </p>
            </>
          )}
        </section>
      )}
    </main>
  );
}
