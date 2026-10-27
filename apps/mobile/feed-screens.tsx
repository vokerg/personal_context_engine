import { DateFilter } from "./date-filter";
import { datePresets, presetDates } from "@pce/api-client";
import { useLiveRefresh } from "./live-refresh";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ApiRequestError,
  describeNotesError,
  getBrowseFacets,
  getBrowsePage,
  getTagRegistry,
  searchContext,
  type BrowseFacets,
  type BrowseQuery,
  type SearchRequest,
  type SearchResponse,
} from "@pce/api-client";
import type { NotePreview } from "@pce/api-client";
import {
  browseQuery,
  emptyFilters,
  localDayKey,
  localDateBounds,
  PagedFeed,
  searchQuality,
  searchQuery,
  type FeedState,
  type Filters,
} from "./feed-model";
import type { MobileSession } from "./session";
import type { Palette } from "./theme";
import { ActionButton, SectionTitle, StatusMessage } from "./ui";

type SearchHit = SearchResponse["results"][number];
type Approved = { slug: string; displayName: string | null };
type FacetState = {
  loading: boolean;
  error: string;
  values: BrowseFacets | null;
  approved: Approved[];
  revision: number;
  cursor: string | null;
  loadingMore: boolean;
  truncated: boolean;
};
const initialFacets: FacetState = {
  loading: true,
  error: "",
  values: null,
  approved: [],
  revision: 0,
  cursor: null,
  loadingMore: false,
  truncated: false,
};
const initialFeed = <T,>(): FeedState<T> => ({
  items: [],
  nextCursor: null,
  loading: true,
  loadingMore: false,
  refreshing: false,
  error: null,
});

/** Refresh on a single 401 only. A 403 must never trigger a login/refresh loop. */
async function authorized<T>(
  session: MobileSession,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      error.status !== 401 ||
      signal.aborted
    )
      throw error;
    const token = await session.forceRefresh();
    if (!token || signal.aborted) throw error;
    return fn();
  }
}
function requestOptions(session: MobileSession, signal: AbortSignal) {
  return {
    baseUrl: session.config.apiOrigin,
    getAccessToken: () => session.getAccessToken(),
    signal,
    timeoutMs: 12000,
  };
}
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "Session expired. Sign in again.";
    if (error.status === 403)
      return "This session lacks permission to read these notes.";
    if (error.status === 404)
      return "This endpoint is not available on the connected API.";
    if (error.status === 409)
      return "The list changed. Refresh to restart from the first page.";
    if (error.status === 429) return "Too many requests. Try again shortly.";
  }
  if (error instanceof Error && error.message === "Repeated pagination cursor")
    return "The server repeated a page cursor. Refresh to try again.";
  return describeNotesError(error);
}
function useFacets(session: MobileSession) {
  const [state, setState] = useState<FacetState>(initialFacets);
  const [reload, setReload] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState(initialFacets);
    const opts = requestOptions(session, controller.signal);
    void Promise.all([
      authorized(session, controller.signal, () => getBrowseFacets(opts)),
      authorized(session, controller.signal, () =>
        getTagRegistry(opts, { limit: 100 }),
      ),
    ]).then(
      ([values, registry]) => {
        if (controller.signal.aborted) return;
        setState({
          loading: false,
          error: "",
          values,
          approved: registry.approved.map(({ slug, displayName }) => ({
            slug,
            displayName,
          })),
          revision: registry.revision,
          cursor: registry.nextCursor ?? null,
          loadingMore: false,
          truncated: registry.truncated || values.truncated,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ ...initialFacets, loading: false, error: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [session, reload]);

  const more = () => {
    const { cursor, revision, loadingMore } = state;
    if (
      !cursor ||
      loadingMore ||
      !abortRef.current ||
      abortRef.current.signal.aborted
    )
      return;
    const signal = abortRef.current.signal;
    setState((prior) => ({ ...prior, loadingMore: true }));
    void authorized(session, signal, () =>
      getTagRegistry(requestOptions(session, signal), {
        after: cursor,
        revision,
        limit: 100,
      }),
    ).then(
      (page) => {
        if (signal.aborted) return;
        setState((prior) => ({
          ...prior,
          approved: [
            ...prior.approved,
            ...page.approved.map(({ slug, displayName }) => ({
              slug,
              displayName,
            })),
          ].filter(
            (value, index, array) =>
              array.findIndex((other) => other.slug === value.slug) === index,
          ),
          cursor: page.nextCursor ?? null,
          truncated: prior.truncated || page.truncated,
          loadingMore: false,
        }));
      },
      (error: unknown) => {
        if (signal.aborted) return;
        setState((prior) => ({
          ...prior,
          loadingMore: false,
          error: errorText(error),
        }));
      },
    );
  };
  return { state, more, reload: () => setReload((v) => v + 1) };
}

function Chip({
  label,
  selected,
  onPress,
  palette,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  palette: Palette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: selected ? palette.primary : palette.surface,
        paddingVertical: 10,
        paddingHorizontal: 13,
        opacity: pressed ? 0.7 : 1,
        justifyContent: "center",
      })}
    >
      <Text
        style={{
          color: selected ? palette.onPrimary : palette.text,
          fontSize: 14,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function FilterControls({
  filters,
  update,
  palette,
  facets,
}: {
  filters: Filters;
  update: (next: Filters) => void;
  palette: Palette;
  facets: ReturnType<typeof useFacets>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [allTags, setAllTags] = useState(false);
  const [allProjects, setAllProjects] = useState(false);
  const active = Object.values(filters).filter(Boolean).length;
  const { state } = facets;
  const set = (key: keyof Filters, value: string) =>
    update({ ...filters, [key]: filters[key] === value ? "" : value });
  const dates = useMemo(() => {
    try {
      localDateBounds(filters.from, filters.to);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid date range";
    }
  }, [filters.from, filters.to]);
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Chip
          label={
            expanded
              ? "Hide filters"
              : "Filters" + (active ? " (" + active + ")" : "")
          }
          selected={expanded}
          onPress={() => setExpanded((v) => !v)}
          palette={palette}
        />
        {active > 0 ? (
          <Chip
            label="Clear all filters"
            selected={false}
            onPress={() => update(emptyFilters)}
            palette={palette}
          />
        ) : null}
      </View>
      {expanded ? (
        <ScrollView
          style={{ maxHeight: 350, borderRadius: 14 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            backgroundColor: palette.surface,
            borderColor: palette.border,
            borderWidth: 1,
            borderRadius: 14,
            padding: 12,
            gap: 12,
          }}
        >
          {state.loading ? (
            <Text style={{ color: palette.secondary }}>
              Loading server filter options…
            </Text>
          ) : null}
          {state.error ? (
            <StatusMessage
              palette={palette}
              heading="Could not load filter options"
              description={state.error}
              alert
              retry={facets.reload}
            />
          ) : null}
          <Text
            accessibilityRole="header"
            style={{ color: palette.text, fontWeight: "700" }}
          >
            Projects
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {state.values?.projects.length ? (
              state.values.projects
                .filter(
                  (project, index) =>
                    allProjects ||
                    index < 12 ||
                    project.slug === filters.project,
                )
                .map(({ slug, count }) => (
                  <Chip
                    key={slug}
                    label={slug + " (" + count + ")"}
                    selected={filters.project === slug}
                    onPress={() => set("project", slug)}
                    palette={palette}
                  />
                ))
            ) : (
              <Text style={{ color: palette.secondary }}>
                No project facets available
              </Text>
            )}
          </View>
          {(state.values?.projects.length ?? 0) > 12 ? (
            <Chip
              label={
                allProjects ? "Show fewer projects" : "Show all project facets"
              }
              selected={false}
              onPress={() => setAllProjects((v) => !v)}
              palette={palette}
            />
          ) : null}
          <Text
            accessibilityRole="header"
            style={{ color: palette.text, fontWeight: "700" }}
          >
            Kinds
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {state.values?.kinds.map(({ slug, count }) => (
              <Chip
                key={slug}
                label={slug + " (" + count + ")"}
                selected={filters.kind === slug}
                onPress={() => set("kind", slug)}
                palette={palette}
              />
            ))}
          </View>
          <Text
            accessibilityRole="header"
            style={{ color: palette.text, fontWeight: "700" }}
          >
            Approved tags only
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
            {state.approved
              .filter(
                (tag, index) =>
                  allTags || index < 16 || tag.slug === filters.tag,
              )
              .map(({ slug, displayName }) => (
                <Chip
                  key={slug}
                  label={displayName || slug}
                  selected={filters.tag === slug}
                  onPress={() => set("tag", slug)}
                  palette={palette}
                />
              ))}
          </View>
          {state.approved.length > 16 ? (
            <Chip
              label={allTags ? "Show fewer tags" : "Show all loaded tags"}
              selected={false}
              onPress={() => setAllTags((v) => !v)}
              palette={palette}
            />
          ) : null}
          {state.cursor ? (
            <ActionButton
              label={
                state.loadingMore
                  ? "Loading approved tags…"
                  : "Load more approved tags"
              }
              palette={palette}
              secondary
              disabled={state.loadingMore}
              onPress={facets.more}
            />
          ) : null}
          {state.truncated ? (
            <Text style={{ color: palette.secondary, fontSize: 13 }}>
              Some facet lists may be incomplete; only approved registry tags
              appear here.
            </Text>
          ) : null}
          <Text
            accessibilityRole="header"
            style={{ color: palette.text, fontWeight: "700" }}
          >
            Captured on local dates (inclusive)
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {datePresets.map((preset) => {
              const range = presetDates(preset.id);
              return (
                <Chip
                  key={preset.id}
                  label={preset.label}
                  selected={
                    filters.from === range.from && filters.to === range.to
                  }
                  onPress={() =>
                    update({ ...filters, ...presetDates(preset.id) })
                  }
                  palette={palette}
                />
              );
            })}
          </View>
          <View style={{ gap: 8 }}>
            {(["from", "to"] as const).map((key) => (
              <DateFilter
                key={key}
                label={key === "from" ? "From date" : "Through date"}
                value={filters[key]}
                onChange={(value) => update({ ...filters, [key]: value })}
                palette={palette}
              />
            ))}
          </View>
          {dates ? (
            <Text accessibilityRole="alert" style={{ color: palette.danger }}>
              {dates}
            </Text>
          ) : null}
          <Text style={{ color: palette.secondary, fontSize: 13 }}>
            Project, kind, approved tag and dates are combined on the server.
            Dates follow this device's timezone, including daylight-saving
            changes.
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function useFeed<T extends { id: string }>(
  enabled: boolean,
  key: string,
  fetcher: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    state: FeedState<T>;
  }>(() => ({ key, state: initialFeed<T>() }));
  const current = useRef<PagedFeed<T> | null>(null);
  useEffect(() => {
    current.current?.cancel();
    if (!enabled) {
      current.current = null;
      setSnapshot({ key, state: { ...initialFeed<T>(), loading: false } });
      return;
    }
    const feed = new PagedFeed(fetcher, (state) => setSnapshot({ key, state }));
    current.current = feed;
    feed.restart();
    return () => {
      feed.cancel();
      if (current.current === feed) current.current = null;
    };
    // 'key' represents the immutable, validated query and invalidates earlier network work.
  }, [enabled, key]);
  // Never display an earlier query's private results while a new request is pending.
  const state =
    snapshot.key === key
      ? snapshot.state
      : { ...initialFeed<T>(), loading: enabled };
  return {
    state,
    refresh: () => current.current?.restart(true),
    loadMore: () => current.current?.loadMore(),
    retry: () => current.current?.restart(),
  };
}

function FeedStatus({
  state,
  title,
  retry,
  palette,
}: {
  state: FeedState<unknown>;
  title: string;
  retry: () => void;
  palette: Palette;
}) {
  if (state.loading)
    return (
      <StatusMessage
        palette={palette}
        heading={"Loading " + title.toLowerCase() + "…"}
      />
    );
  if (state.error)
    return (
      <StatusMessage
        palette={palette}
        heading={"Could not load " + title.toLowerCase()}
        description={errorText(state.error)}
        retry={retry}
        alert
      />
    );
  if (!state.items.length)
    return (
      <StatusMessage
        palette={palette}
        heading={"No " + title.toLowerCase() + " found"}
        description="Try clearing a filter or changing the query."
      />
    );
  return null;
}
function NoteTile({
  note,
  palette,
  open,
}: {
  note: NotePreview;
  palette: Palette;
  open: (id: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={"Open note: " + note.title}
      onPress={() => open(note.id)}
      style={({ pressed }) => ({
        padding: 15,
        borderWidth: 1,
        borderRadius: 14,
        gap: 6,
        borderColor: palette.border,
        backgroundColor: palette.surface,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: palette.text, fontSize: 17, fontWeight: "600" }}>
        {note.title}
      </Text>
      <Text
        numberOfLines={3}
        style={{ color: palette.secondary, fontSize: 15 }}
      >
        {note.summary}
      </Text>
    </Pressable>
  );
}
type TimelineRow =
  | { type: "heading"; key: string; label: string }
  | { type: "note"; key: string; note: NotePreview };
function grouped(notes: NotePreview[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previous = "";
  for (const note of notes) {
    const day = localDayKey(note.capturedAt);
    if (day !== previous) {
      rows.push({
        type: "heading",
        key: "day-" + note.id,
        label: new Date(note.capturedAt).toLocaleDateString(undefined, {
          month: "long",
          day: "numeric",
          year: "numeric",
        }),
      });
      previous = day;
    }
    rows.push({ type: "note", key: note.id, note });
  }
  return rows;
}

export function TimelineScreen({
  session,
  palette,
  onOpenNote,
  bottomInset = 24,
  hidden,
}: {
  session: MobileSession;
  palette: Palette;
  onOpenNote: (id: string) => void;
  bottomInset?: number;
  hidden?: boolean;
}) {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const facets = useFacets(session);
  const prepared = useMemo(() => {
    try {
      return { query: browseQuery(filters), error: "" };
    } catch (error) {
      return {
        query: null,
        error: error instanceof Error ? error.message : "Invalid filters",
      };
    }
  }, [filters]);
  const key = JSON.stringify(prepared.query);
  const feed = useFeed<NotePreview>(
    prepared.query !== null,
    key,
    async (cursor, signal) => {
      const opts = requestOptions(session, signal);
      const result = await authorized(session, signal, () =>
        getBrowsePage(opts, {
          ...(prepared.query as BrowseQuery),
          ...(cursor ? { cursor } : {}),
        }),
      );
      return { items: result.notes, nextCursor: result.nextCursor };
    },
  );
  const refresh = () => {
    feed.refresh();
    facets.reload();
  };
  useLiveRefresh(!hidden, () => {
    if (
      !feed.state.loading &&
      !feed.state.refreshing &&
      !feed.state.loadingMore
    )
      refresh();
  });
  const rows = useMemo(() => grouped(feed.state.items), [feed.state.items]);
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        display: hidden ? "none" : "flex",
        gap: 12,
      }}
    >
      <View style={{ paddingHorizontal: 20, paddingTop: 15, gap: 9 }}>
        <SectionTitle palette={palette}>Notes</SectionTitle>
        <FilterControls
          filters={filters}
          update={setFilters}
          palette={palette}
          facets={facets}
        />
      </View>
      {prepared.error ? (
        <StatusMessage
          palette={palette}
          heading="Invalid date filter"
          description={prepared.error}
          alert
        />
      ) : null}
      <FlatList
        alwaysBounceVertical
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="never"
        style={{ flex: 1 }}
        data={prepared.query ? rows : []}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) =>
          item.type === "heading" ? (
            <Text
              accessibilityRole="header"
              style={{
                color: palette.secondary,
                fontSize: 15,
                fontWeight: "700",
                marginTop: 12,
              }}
            >
              {item.label}
            </Text>
          ) : (
            <NoteTile note={item.note} palette={palette} open={onOpenNote} />
          )
        }
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: bottomInset,
          gap: 9,
          flexGrow: 1,
        }}
        onEndReached={() => {
          if (!hidden) feed.loadMore();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={feed.state.refreshing}
            onRefresh={refresh}
          />
        }
        ListEmptyComponent={
          prepared.query ? (
            <FeedStatus
              title="Notes"
              state={feed.state}
              retry={feed.retry}
              palette={palette}
            />
          ) : null
        }
        ListFooterComponent={
          feed.state.items.length ? (
            <View style={{ gap: 8 }}>
              {feed.state.error ? (
                <FeedStatus
                  title="Notes"
                  state={feed.state}
                  retry={feed.retry}
                  palette={palette}
                />
              ) : null}
              {feed.state.loadingMore ? (
                <Text style={{ color: palette.secondary }}>
                  Loading next page…
                </Text>
              ) : null}
              {feed.state.nextCursor && !feed.state.error ? (
                <ActionButton
                  label="Load more notes"
                  palette={palette}
                  secondary
                  onPress={feed.loadMore}
                  disabled={feed.state.loadingMore}
                />
              ) : null}
            </View>
          ) : null
        }
      />
    </View>
  );
}

export function SearchScreen({
  session,
  palette,
  onOpenNote,
  bottomInset = 24,
  hidden,
}: {
  session: MobileSession;
  palette: Palette;
  onOpenNote: (id: string) => void;
  bottomInset?: number;
  hidden?: boolean;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [meta, setMeta] = useState<{
    key: string;
    mode: "hybrid" | "lexical";
    degradation: string | null;
    truncated: boolean;
  } | null>(null);
  const facets = useFacets(session);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 350);
    return () => clearTimeout(timer);
  }, [input]);
  const prepared = useMemo(() => {
    if (!query) return { valid: null, error: "" };
    try {
      return { valid: searchQuery(filters, query), error: "" };
    } catch (error) {
      return {
        valid: null,
        error: error instanceof Error ? error.message : "Invalid search",
      };
    }
  }, [filters, query]);
  const key = JSON.stringify(prepared.valid);
  const queryIsCurrent = input.trim() === query;
  useEffect(() => setMeta(null), [key]);
  const feed = useFeed<SearchHit>(
    prepared.valid !== null,
    key,
    async (cursor, signal) => {
      const inputQuery = {
        ...(prepared.valid as SearchRequest),
        ...(cursor ? { cursor } : {}),
      };
      const opts = requestOptions(session, signal);
      const result = await authorized(session, signal, () =>
        searchContext(opts, inputQuery),
      );
      if (!signal.aborted)
        setMeta((previous) =>
          previous?.key === key &&
          (previous.mode === "lexical" || previous.degradation)
            ? { ...previous, truncated: previous.truncated || result.truncated }
            : {
                key,
                mode: result.mode,
                degradation: result.degradation,
                truncated: result.truncated,
              },
        );
      return { items: result.results, nextCursor: result.nextCursor };
    },
  );
  const refreshSearch = () => {
    setMeta(null);
    feed.refresh();
    facets.reload();
  };
  useLiveRefresh(!hidden, () => {
    if (
      queryIsCurrent &&
      !feed.state.loading &&
      !feed.state.refreshing &&
      !feed.state.loadingMore
    )
      refreshSearch();
  });
  const retrySearch = () => {
    setMeta(null);
    feed.retry();
  };
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        display: hidden ? "none" : "flex",
        gap: 12,
      }}
    >
      <View style={{ paddingHorizontal: 20, paddingTop: 15, gap: 10 }}>
        <SectionTitle palette={palette}>Search</SectionTitle>
        <TextInput
          accessibilityLabel="Search your notes"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => {
            setQuery(input.trim());
            Keyboard.dismiss();
          }}
          autoCorrect={false}
          returnKeyType="search"
          maxLength={500}
          placeholder="Search notes and research…"
          placeholderTextColor={palette.secondary}
          style={{
            color: palette.text,
            backgroundColor: palette.surface,
            borderColor: palette.border,
            borderWidth: 1,
            borderRadius: 12,
            minHeight: 48,
            paddingHorizontal: 14,
            fontSize: 16,
          }}
        />
        <FilterControls
          filters={filters}
          update={setFilters}
          palette={palette}
          facets={facets}
        />
        {queryIsCurrent &&
        !feed.state.error &&
        meta?.key === key &&
        prepared.valid ? (
          <Text
            accessibilityRole="text"
            style={{ color: palette.secondary, fontSize: 14 }}
          >
            {searchQuality(meta.mode, meta.degradation)}
          </Text>
        ) : null}
      </View>
      {prepared.error ? (
        <StatusMessage
          palette={palette}
          heading="Invalid search filters"
          description={prepared.error}
          alert
        />
      ) : null}
      <FlatList
        alwaysBounceVertical
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="never"
        style={{ flex: 1 }}
        data={prepared.valid && queryIsCurrent ? feed.state.items : []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              "Open " +
              (item.contentType === "research"
                ? "parent note for research: "
                : "search result: ") +
              item.title
            }
            onPress={() =>
              onOpenNote(
                item.contentType === "research"
                  ? (item.parentNoteId ?? item.id)
                  : item.id,
              )
            }
            style={({ pressed }) => ({
              backgroundColor: palette.surface,
              borderColor: palette.border,
              borderWidth: 1,
              borderRadius: 14,
              padding: 15,
              gap: 7,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text
              style={{ color: palette.text, fontSize: 17, fontWeight: "600" }}
            >
              {item.title}
            </Text>
            <Text style={{ color: palette.secondary, fontSize: 15 }}>
              {item.snippet}
            </Text>
            <Text style={{ color: palette.secondary, fontSize: 12 }}>
              {item.contentType === "research" ? "Research" : "Note"} ·{" "}
              {item.channel} · source revision {item.sourceRevision} ·{" "}
              {item.capturedAt.slice(0, 10)}
            </Text>
            <Text selectable style={{ color: palette.secondary, fontSize: 12 }}>
              Source ID: {item.id}
            </Text>
            <Text style={{ color: palette.secondary, fontSize: 12 }}>
              Match: {item.lexical ? "lexical" : ""}
              {item.lexical && item.semantic ? " + " : ""}
              {item.semantic ? "semantic" : ""}
            </Text>
          </Pressable>
        )}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: bottomInset,
          gap: 9,
          flexGrow: 1,
        }}
        onEndReached={() => {
          if (!hidden && queryIsCurrent) feed.loadMore();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={feed.state.refreshing}
            onRefresh={refreshSearch}
          />
        }
        ListEmptyComponent={
          !queryIsCurrent ? (
            <StatusMessage palette={palette} heading="Updating search…" />
          ) : !query ? (
            <StatusMessage
              palette={palette}
              heading="Enter a search"
              description="Search uses the server's lexical or hybrid index. Results and mode come from the API."
            />
          ) : prepared.valid ? (
            <FeedStatus
              title="Results"
              state={feed.state}
              retry={retrySearch}
              palette={palette}
            />
          ) : null
        }
        ListFooterComponent={
          queryIsCurrent && feed.state.items.length ? (
            <View style={{ gap: 8 }}>
              {feed.state.error ? (
                <FeedStatus
                  title="Results"
                  state={feed.state}
                  retry={retrySearch}
                  palette={palette}
                />
              ) : null}
              {feed.state.loadingMore ? (
                <Text style={{ color: palette.secondary }}>
                  Loading more matches…
                </Text>
              ) : null}
              {feed.state.nextCursor && !feed.state.error ? (
                <ActionButton
                  label="Load more results"
                  palette={palette}
                  secondary
                  onPress={feed.loadMore}
                  disabled={feed.state.loadingMore}
                />
              ) : null}
              {meta?.key === key && meta.truncated && !feed.state.nextCursor ? (
                <Text style={{ color: palette.secondary }}>
                  The server reports additional matches beyond its returned
                  window.
                </Text>
              ) : null}
            </View>
          ) : null
        }
      />
    </View>
  );
}
