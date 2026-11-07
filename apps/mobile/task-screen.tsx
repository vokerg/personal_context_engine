import { claimsBackSwipe, completesBackSwipe } from "./back-gesture";
import { useLiveRefresh } from "./live-refresh";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  PanResponder,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { randomUUID } from "expo-crypto";
import {
  ApiRequestError,
  getTasks,
  getTask,
  getTaskHistory,
  type Task,
  type TaskHistory,
} from "@pce/api-client";
import type { MobileSession } from "./session";
import type { Palette } from "./theme";
import { ActionButton, Panel, SectionTitle, StatusMessage } from "./ui";
import { TaskRequests, taskFailure } from "./task-requests";

const timestamp = (value: string) => new Date(value).toLocaleString();
export function TasksScreen({
  session,
  palette,
  hidden = false,
  bottomInset = 112,
  onOpenNote,
}: {
  session: MobileSession;
  palette: Palette;
  hidden?: boolean;
  bottomInset?: number;
  onOpenNote: (id: string) => void;
}) {
  const options = useMemo(
    () => ({
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      timeoutMs: 12000,
    }),
    [session],
  );
  const requests = useMemo(
    () => new TaskRequests(options, randomUUID),
    [options],
  );
  const live = useRef(true);
  const epoch = useRef(0);
  const [status, setStatus] = useState<"OPEN" | "COMPLETED" | "ALL">("OPEN");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const loadingMore = useRef(false);
  const [error, setError] = useState("");
  const [changeError, setChangeError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryChange, setRetryChange] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const backGesture = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          claimsBackSwipe(gesture),
        onPanResponderRelease: (_event, gesture) => {
          if (completesBackSwipe(gesture)) setSelected(null);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  const queryIdentity = useRef("");
  const [detail, setDetail] = useState<Task | null>(null);
  const [history, setHistory] = useState<TaskHistory>({
    events: [],
    nextRevision: null,
  });
  const [detailError, setDetailError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [creating, setCreating] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState("");
  useLiveRefresh(!hidden && !selected && !createOpen, () => {
    if (!loading && !more && !busy && !creating && !selected && !createOpen)
      setReload((v) => v + 1);
  });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, [session]);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++epoch.current;
    setLoading(true);
    const identity = JSON.stringify([status, query]);
    if (queryIdentity.current !== identity) setTasks([]);
    queryIdentity.current = identity;
    setNext(null);
    setError("");
    loadingMore.current = false;
    setMore(false);
    void getTasks(
      { ...options, signal: controller.signal },
      { status, ...(query ? { q: query } : {}), limit: 30 },
    )
      .then((page) => {
        if (!controller.signal.aborted && version === epoch.current) {
          setTasks(page.tasks);
          setNext(page.nextCursor);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(taskFailure(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [options, query, status, reload]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    setHistoryError("");
    setHistory({ events: [], nextRevision: null });
    if (selected) {
      void getTask({ ...options, signal: controller.signal }, selected)
        .then((task) => {
          if (!controller.signal.aborted) setDetail(task);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setDetailError(taskFailure(e));
        });
      setHistoryBusy(true);
      void getTaskHistory({ ...options, signal: controller.signal }, selected)
        .then((events) => {
          if (!controller.signal.aborted) setHistory(events);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setHistoryError(taskFailure(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setHistoryBusy(false);
        });
    }
    return () => controller.abort();
  }, [options, selected, reload]);
  async function loadMore() {
    if (!next || loading || loadingMore.current) return;
    loadingMore.current = true;
    setMore(true);
    setError("");
    const version = epoch.current,
      cursor = next;
    try {
      const page = await getTasks(options, {
        status,
        ...(query ? { q: query } : {}),
        after: cursor,
        limit: 30,
      });
      if (!live.current || version !== epoch.current) return;
      if (page.nextCursor === cursor) throw new Error("Repeated task page");
      setTasks((prior) => [
        ...new Map(
          [...prior, ...page.tasks].map((t) => [t.taskId, t]),
        ).values(),
      ]);
      setNext(page.nextCursor);
    } catch (e) {
      if (live.current && version === epoch.current) setError(taskFailure(e));
    } finally {
      if (version === epoch.current) {
        loadingMore.current = false;
        if (live.current) setMore(false);
      }
    }
  }
  async function change(task?: Task) {
    if (requests.changing || (requests.pendingTaskId && task)) return;
    setBusy(true);
    setChangeError("");
    setNotice("");
    try {
      const result = await requests.change(task);
      if (!live.current || !result) return;
      setRetryChange(false);
      setNotice(
        result.replayed
          ? "Task change confirmed. Current state loaded."
          : result.task.status === "COMPLETED"
            ? "Task completed. Find it in Completed or All."
            : "Task reopened.",
      );
      try {
        AccessibilityInfo.announceForAccessibility(
          result.replayed
            ? "Task change confirmed"
            : result.task.status === "COMPLETED"
              ? "Task completed"
              : "Task reopened",
        );
      } catch {
        /* Accessibility feedback cannot invalidate a committed change. */
      }
      setReload((n) => n + 1);
    } catch (e) {
      if (live.current) {
        setChangeError(taskFailure(e));
        setRetryChange(requests.pendingTaskId !== null);
        if (e instanceof ApiRequestError && e.status === 409)
          setReload((n) => n + 1);
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function save() {
    if (requests.creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const receipt = await requests.create({
        title: title.trim(),
        ...(description ? { description } : {}),
      });
      if (!live.current || !receipt) return;
      setTitle("");
      setDescription("");
      setCreateOpen(false);
      setSelected(receipt.task.taskId);
      setNotice("Task saved.");
      setReload((n) => n + 1);
    } catch (e) {
      if (live.current) setCreateError(taskFailure(e));
    } finally {
      if (live.current) {
        setCreating(false);
        setCreatePending(requests.pendingCreation);
      }
    }
  }
  async function moreHistory() {
    if (!selected || historyBusy || history.nextRevision === null) return;
    const id = selected;
    setHistoryBusy(true);
    try {
      const page = await getTaskHistory(options, id, {
        afterRevision: history.nextRevision,
      });
      if (live.current && selectedRef.current === id)
        setHistory((p) => ({
          events: [
            ...new Map(
              [...p.events, ...page.events].map((e) => [e.revision, e]),
            ).values(),
          ],
          nextRevision: page.nextRevision,
        }));
    } catch (e) {
      if (live.current && selectedRef.current === id)
        setHistoryError(taskFailure(e));
    } finally {
      if (live.current) setHistoryBusy(false);
    }
  }
  const inputStyle = {
    color: palette.text,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    minHeight: 48,
    fontSize: 17,
  };
  const disabled = busy || retryChange;
  const mutations = (
    <>
      {notice ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: palette.secondary }}
        >
          {notice}
        </Text>
      ) : null}
      {changeError ? (
        <StatusMessage
          palette={palette}
          heading="Task change needs attention"
          description={changeError}
          alert
        />
      ) : null}
      {retryChange ? (
        <ActionButton
          label="Retry Task change"
          palette={palette}
          disabled={busy}
          onPress={() => void change()}
        />
      ) : null}
      {busy ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: palette.secondary }}
        >
          Saving Task change…
        </Text>
      ) : null}
    </>
  );
  return (
    <View
      style={{ flex: 1, display: hidden ? "none" : "flex" }}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
    >
      <View
        style={{ flex: 1, display: selected ? "none" : "flex" }}
        accessibilityElementsHidden={Boolean(selected)}
      >
        <FlatList
          alwaysBounceVertical
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="never"
          refreshing={loading}
          onRefresh={() => setReload((v) => v + 1)}
          data={tasks}
          keyExtractor={(t) => t.taskId}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: 20,
            paddingBottom: bottomInset + 16,
            gap: 12,
          }}
          ListHeaderComponent={
            <View style={{ gap: 14 }}>
              <SectionTitle palette={palette}>Tasks</SectionTitle>
              <Text style={{ color: palette.secondary }}>
                Your commitments, separate from Notes and reminders.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {(
                  [
                    ["OPEN", "Open"],
                    ["COMPLETED", "Completed"],
                    ["ALL", "All"],
                  ] as const
                ).map(([value, label]) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityLabel={label + " Tasks"}
                    accessibilityState={{ selected: status === value }}
                    onPress={() => setStatus(value)}
                    style={{
                      padding: 12,
                      minHeight: 46,
                      borderRadius: 12,
                      backgroundColor:
                        status === value ? palette.primary : palette.subtle,
                    }}
                  >
                    <Text
                      style={{
                        color:
                          status === value ? palette.onPrimary : palette.text,
                      }}
                    >
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                accessibilityLabel="Search Tasks"
                placeholder="Find a Task or its context"
                placeholderTextColor={palette.secondary}
                style={inputStyle}
                value={draftQuery}
                maxLength={500}
                onChangeText={setDraftQuery}
                returnKeyType="search"
                onSubmitEditing={() => {
                  setQuery(draftQuery.trim());
                  setReload((n) => n + 1);
                }}
              />
              <ActionButton
                label="Search Tasks"
                palette={palette}
                onPress={() => {
                  setQuery(draftQuery.trim());
                  setReload((n) => n + 1);
                }}
              />
              <ActionButton
                label="Refresh Tasks"
                palette={palette}
                secondary
                disabled={loading}
                onPress={() => setReload((n) => n + 1)}
              />
              {mutations}
              <ActionButton
                label={createOpen ? "Hide Task creation" : "Create a Task"}
                palette={palette}
                secondary
                onPress={() => setCreateOpen((v) => !v)}
              />
              {createOpen ? (
                <Panel palette={palette}>
                  <Text style={{ color: palette.secondary }}>
                    Create a Task explicitly. Dictation supplies text; no model
                    interprets it.
                  </Text>
                  <TextInput
                    accessibilityLabel="Task title"
                    placeholder="Task title"
                    placeholderTextColor={palette.secondary}
                    style={inputStyle}
                    value={title}
                    maxLength={200}
                    editable={!creating && !createPending}
                    onChangeText={setTitle}
                  />
                  <TextInput
                    accessibilityLabel="Task description"
                    placeholder="Description (optional)"
                    placeholderTextColor={palette.secondary}
                    style={inputStyle}
                    value={description}
                    maxLength={8000}
                    multiline
                    editable={!creating && !createPending}
                    onChangeText={setDescription}
                  />
                  {createError ? (
                    <Text
                      accessibilityRole="alert"
                      style={{ color: palette.danger }}
                    >
                      {createError}
                    </Text>
                  ) : null}
                  <ActionButton
                    label={
                      creating
                        ? "Saving Task…"
                        : createPending
                          ? "Retry Task creation"
                          : "Save Task"
                    }
                    palette={palette}
                    disabled={creating || (!createPending && !title.trim())}
                    onPress={() => void save()}
                  />
                </Panel>
              ) : null}
              {error ? (
                <StatusMessage
                  palette={palette}
                  heading="Could not load Tasks"
                  description={error}
                  alert
                  retry={() => setReload((n) => n + 1)}
                />
              ) : null}
            </View>
          }
          ListEmptyComponent={
            error ? null : (
              <StatusMessage
                palette={palette}
                heading={
                  loading
                    ? "Loading Tasks…"
                    : query
                      ? "No matching Tasks"
                      : status === "OPEN"
                        ? "No open Tasks"
                        : "No Tasks in this view"
                }
              />
            )
          }
          ListFooterComponent={
            next ? (
              <ActionButton
                label={more ? "Loading more Tasks…" : "More Tasks"}
                palette={palette}
                disabled={more}
                onPress={() => void loadMore()}
              />
            ) : null
          }
          renderItem={({ item }) => (
            <View
              style={{
                flexDirection: "row",
                gap: 12,
                padding: 14,
                alignItems: "center",
                borderRadius: 14,
                backgroundColor: palette.surface,
                borderWidth: 1,
                borderColor: palette.border,
              }}
            >
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={
                  (item.status === "OPEN" ? "Complete " : "Reopen ") +
                  item.title
                }
                accessibilityState={{
                  checked: item.status === "COMPLETED",
                  disabled,
                }}
                disabled={disabled}
                onPress={() => void change(item)}
                style={{
                  minWidth: 46,
                  minHeight: 46,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: palette.primary, fontSize: 28 }}>
                  {item.status === "COMPLETED" ? "☑" : "☐"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={"Open Task: " + item.title}
                onPress={() => setSelected(item.taskId)}
                style={{
                  flex: 1,
                  minHeight: 46,
                  justifyContent: "center",
                  gap: 5,
                }}
              >
                <Text
                  style={{
                    color: palette.text,
                    fontSize: 18,
                    fontWeight: "600",
                  }}
                >
                  {item.title}
                </Text>
                <Text style={{ color: palette.secondary }}>
                  {item.status === "COMPLETED"
                    ? "Completed " + timestamp(item.completedAt!)
                    : "Created " + timestamp(item.createdAt)}
                </Text>
              </Pressable>
            </View>
          )}
        />
      </View>
      {selected ? (
        <ScrollView
          {...backGesture.panHandlers}
          alwaysBounceVertical
          automaticallyAdjustKeyboardInsets
          contentInsetAdjustmentBehavior="never"
          refreshControl={
            <RefreshControl
              refreshing={!detail && !detailError}
              onRefresh={() => setReload((v) => v + 1)}
            />
          }
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: 20,
            paddingBottom: bottomInset + 16,
            gap: 14,
          }}
        >
          <ActionButton
            label="Back to Tasks"
            palette={palette}
            secondary
            onPress={() => setSelected(null)}
          />
          {mutations}
          {detailError ? (
            <StatusMessage
              palette={palette}
              heading="Task unavailable"
              description={detailError}
              alert
              retry={() => setReload((n) => n + 1)}
            />
          ) : !detail ? (
            <StatusMessage palette={palette} heading="Loading Task…" />
          ) : (
            <Panel palette={palette}>
              <SectionTitle palette={palette}>{detail.title}</SectionTitle>
              <Text style={{ color: palette.secondary }}>
                {detail.status === "OPEN" ? "Open" : "Completed"}
              </Text>
              {detail.description ? (
                <Text selectable style={{ color: palette.text, fontSize: 17 }}>
                  {detail.description}
                </Text>
              ) : null}
              <Text style={{ color: palette.secondary }}>
                Created {timestamp(detail.createdAt)}
                {detail.completedAt
                  ? " · Completed " + timestamp(detail.completedAt)
                  : ""}
              </Text>
              <Text style={{ color: palette.secondary }}>
                {detail.origin === "github"
                  ? "Private Task batch"
                  : "Saved directly to PCE"}
              </Text>
              <ActionButton
                label={
                  detail.status === "OPEN" ? "Complete Task" : "Reopen Task"
                }
                palette={palette}
                disabled={disabled}
                onPress={() => void change(detail)}
              />
              <Text
                accessibilityRole="header"
                style={{ color: palette.text, fontSize: 20, fontWeight: "600" }}
              >
                Original context
              </Text>
              {!detail.sources.length ? (
                <Text style={{ color: palette.secondary }}>
                  {detail.unavailableSourceCount
                    ? "Source context is unavailable for this session."
                    : "Created independently without a source Note."}
                </Text>
              ) : null}
              {detail.sources.map((source) => (
                <View key={source.noteId} style={{ gap: 8 }}>
                  <ActionButton
                    label="Open source Note"
                    palette={palette}
                    secondary
                    onPress={() => onOpenNote(source.noteId)}
                  />
                  <Text style={{ color: palette.secondary }}>
                    Captured {timestamp(source.capturedAt)}
                  </Text>
                  {source.evidence ? (
                    <Text selectable style={{ color: palette.text }}>
                      {source.evidence}
                    </Text>
                  ) : null}
                </View>
              ))}
              <Text
                accessibilityRole="header"
                style={{ color: palette.text, fontSize: 20, fontWeight: "600" }}
              >
                History
              </Text>
              {historyBusy ? (
                <Text style={{ color: palette.secondary }}>
                  Loading history…
                </Text>
              ) : null}
              {historyError ? (
                <Text
                  accessibilityRole="alert"
                  style={{ color: palette.danger }}
                >
                  {historyError}
                </Text>
              ) : null}
              {history.events.map((event) => (
                <Text key={event.revision} style={{ color: palette.secondary }}>
                  {event.type === "CREATED"
                    ? "Created"
                    : event.type === "COMPLETED"
                      ? "Completed"
                      : "Reopened"}{" "}
                  · {timestamp(event.at)}
                </Text>
              ))}
              {history.nextRevision !== null ? (
                <ActionButton
                  label="More Task history"
                  palette={palette}
                  secondary
                  disabled={historyBusy}
                  onPress={() => void moreHistory()}
                />
              ) : null}
            </Panel>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}
