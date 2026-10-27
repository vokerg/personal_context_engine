import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  ApiTransportError,
  getTasks,
  getTask,
  getTaskHistory,
  createTask,
  changeTask,
  type Task,
  type TaskCreate,
  type TaskMutation,
  type TaskHistory,
} from "@pce/api-client";

function taskError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401)
      return "Your session expired. Sign in again to use Tasks.";
    if (error.status === 403)
      return "Task access is missing. Reconnect with the required Task permissions.";
    if (error.status === 404)
      return "This Task is unavailable, or Tasks are not enabled.";
    if (error.status === 409)
      return "The Task changed. Reload before trying a new change.";
  }
  if (error instanceof ApiTransportError && error.code === "TIMEOUT")
    return "The request timed out. Retry the same change to confirm its result.";
  return "Could not reach Tasks. Check your connection and try again.";
}
const date = (value: string) => new Date(value).toLocaleString();

export function TasksPanel({
  baseUrl,
  token,
  useSessionCookie,
  onOpenNote,
}: {
  baseUrl: string;
  token: string;
  useSessionCookie: boolean;
  onOpenNote: (id: string) => void;
}) {
  const options = useMemo(
    () => ({
      baseUrl,
      getAccessToken: () => token,
      useSessionCookie,
      getCsrfToken: () =>
        /(?:^|;\s*)pce_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? "",
      timeoutMs: 10000,
    }),
    [baseUrl, token, useSessionCookie],
  );
  const [status, setStatus] = useState<"OPEN" | "COMPLETED" | "ALL">("OPEN");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [after, setAfter] = useState<string | undefined>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [next, setNext] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [detail, setDetail] = useState<Task | null>(null);
  const [detailError, setDetailError] = useState("");
  const [history, setHistory] = useState<TaskHistory>({
    events: [],
    nextRevision: null,
  });
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const command = useRef<{ taskId: string; input: TaskMutation } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const creation = useRef<TaskCreate | null>(null);
  const [creating, setCreating] = useState(false);
  const [creationPending, setCreationPending] = useState(false);
  const [creationError, setCreationError] = useState("");
  const creatingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const firstPage = () => {
    setAfter(undefined);
    setPrevious([]);
    setReload((n) => n + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setTasks([]);
    setNext(null);
    void getTasks(
      { ...options, signal: controller.signal },
      {
        status,
        limit: 30,
        ...(query ? { q: query } : {}),
        ...(after ? { after } : {}),
      },
    )
      .then((page) => {
        if (!controller.signal.aborted) {
          setTasks(page.tasks);
          setNext(page.nextCursor);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(taskError(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [options, status, query, after, reload]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    if (selected)
      void getTask({ ...options, signal: controller.signal }, selected)
        .then((task) => {
          if (!controller.signal.aborted) setDetail(task);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setDetailError(taskError(e));
        });
    return () => controller.abort();
  }, [options, selected, reload]);
  useEffect(() => {
    const controller = new AbortController();
    setHistory({ events: [], nextRevision: null });
    setHistoryError("");
    if (selected) {
      setHistoryBusy(true);
      void getTaskHistory({ ...options, signal: controller.signal }, selected)
        .then((page) => {
          if (!controller.signal.aborted) setHistory(page);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setHistoryError(taskError(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setHistoryBusy(false);
        });
    }
    return () => controller.abort();
  }, [options, selected, reload]);

  async function mutate(task?: Task) {
    if (inFlight.current) return;
    if (!command.current && task) {
      try {
        command.current = {
          taskId: task.taskId,
          input: {
            commandId: crypto.randomUUID(),
            expectedRevision: task.revision,
            status: task.status === "OPEN" ? "COMPLETED" : "OPEN",
          },
        };
      } catch {
        setMutationError(
          "This browser cannot safely generate a Task change ID.",
        );
        return;
      }
    }
    const pending = command.current;
    if (!pending) return;
    inFlight.current = true;
    setBusy(true);
    setPendingId(pending.taskId);
    setMutationError("");
    try {
      const result = await changeTask(options, pending.taskId, pending.input);
      if (!mounted.current) return;
      setNotice(
        result.replayed
          ? "Task change confirmed. Current state loaded."
          : result.task.status === "COMPLETED"
            ? "Task completed. It is available in Completed and All."
            : "Task reopened.",
      );
      command.current = null;
      setPendingId(null);
      if (selected === result.task.taskId) setDetail(result.task);
      document.getElementById("task-list-heading")?.focus();
      firstPage();
    } catch (e) {
      if (!mounted.current) return;
      setMutationError(taskError(e));
      if (e instanceof ApiRequestError && e.status === 409) {
        command.current = null;
        setPendingId(null);
        firstPage();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (creatingRef.current) return;
    if (!creation.current) {
      try {
        creation.current = {
          taskId: crypto.randomUUID(),
          title: title.trim(),
          ...(description ? { description } : {}),
        };
      } catch {
        setCreationError("This browser cannot safely generate a Task ID.");
        return;
      }
    }
    creatingRef.current = true;
    setCreating(true);
    setCreationPending(true);
    setCreationError("");
    try {
      const receipt = await createTask(options, creation.current);
      if (!mounted.current) return;
      creation.current = null;
      setCreationPending(false);
      setTitle("");
      setDescription("");
      setSelected(receipt.task.taskId);
      setNotice("Task saved.");
      firstPage();
    } catch (e) {
      if (mounted.current) setCreationError(taskError(e));
    } finally {
      creatingRef.current = false;
      if (mounted.current) setCreating(false);
    }
  }
  async function moreHistory() {
    if (!selected || historyBusy || history.nextRevision === null) return;
    setHistoryBusy(true);
    setHistoryError("");
    const id = selected;
    try {
      const page = await getTaskHistory(options, id, {
        afterRevision: history.nextRevision,
      });
      if (mounted.current && id === selectedRef.current)
        setHistory((prior) => ({
          events: [...prior.events, ...page.events],
          nextRevision: page.nextRevision,
        }));
    } catch (e) {
      if (mounted.current) setHistoryError(taskError(e));
    } finally {
      if (mounted.current) setHistoryBusy(false);
    }
  }
  function search(event: FormEvent) {
    event.preventDefault();
    setQuery(draftQuery.trim());
    firstPage();
  }
  const controlsDisabled = busy || pendingId !== null;
  return (
    <section aria-label="Tasks workspace" className="tasks-workspace">
      <header className="tasks-heading">
        <div>
          <p className="eyebrow">Your commitments</p>
          <h2>Tasks</h2>
          <p>Complete what is done. Keep the original context.</p>
        </div>
        <button className="secondary" onClick={firstPage}>
          Refresh tasks
        </button>
      </header>
      <div className="panel task-controls">
        <div className="actions" role="group" aria-label="Task status">
          {(
            [
              ["OPEN", "Open"],
              ["COMPLETED", "Completed"],
              ["ALL", "All"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={status === value ? "primary" : "secondary"}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                firstPage();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form onSubmit={search} className="task-search">
          <label htmlFor="task-query">
            Search Tasks
            <input
              id="task-query"
              type="search"
              maxLength={500}
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="Find a Task or its context"
            />
          </label>
          <button className="primary" type="submit">
            Search tasks
          </button>
        </form>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {(error || mutationError) && (
        <div role="alert" className="error">
          <p>{mutationError || error}</p>
          {pendingId ? (
            <button disabled={busy} onClick={() => void mutate()}>
              Retry task change
            </button>
          ) : (
            <button onClick={firstPage}>Retry Tasks</button>
          )}
        </div>
      )}
      {busy && <p role="status">Saving Task change…</p>}
      <div className="task-columns">
        <section
          className="panel task-list-panel"
          aria-label="Task list"
          aria-busy={loading}
        >
          <h3 id="task-list-heading" tabIndex={-1}>
            {status === "OPEN"
              ? "Open Tasks"
              : status === "COMPLETED"
                ? "Completed Tasks"
                : "All Tasks"}
          </h3>
          {loading ? (
            <p role="status">Loading Tasks…</p>
          ) : !error && tasks.length === 0 ? (
            <p>
              {query
                ? "No Tasks match this search."
                : status === "OPEN"
                  ? "No open Tasks. You’re up to date."
                  : "No Tasks in this view yet."}
            </p>
          ) : null}
          <ul className="task-list">
            {tasks.map((task) => (
              <li
                key={task.taskId}
                className={
                  selected === task.taskId ? "task-row selected" : "task-row"
                }
              >
                {task.status === "OPEN" ? (
                  <input
                    type="checkbox"
                    checked={false}
                    disabled={controlsDisabled}
                    aria-label={`Complete ${task.title}`}
                    onChange={() => void mutate(task)}
                  />
                ) : (
                  <span className="task-done" aria-label="Completed">
                    ✓
                  </span>
                )}
                <button
                  className="task-title-button"
                  onClick={() => setSelected(task.taskId)}
                  aria-pressed={selected === task.taskId}
                >
                  <strong>{task.title}</strong>
                  <span>
                    {task.status === "COMPLETED"
                      ? "Completed " + date(task.completedAt!)
                      : "Created " + date(task.createdAt)}
                  </span>
                </button>
                {task.status === "COMPLETED" && (
                  <button
                    className="secondary"
                    disabled={controlsDisabled}
                    onClick={() => void mutate(task)}
                    aria-label={`Reopen ${task.title}`}
                  >
                    Reopen
                  </button>
                )}
              </li>
            ))}
          </ul>
          <nav className="actions" aria-label="Task pages">
            <button
              className="secondary"
              disabled={loading || !previous.length}
              onClick={() => {
                setAfter(previous.at(-1));
                setPrevious((p) => p.slice(0, -1));
              }}
            >
              Previous Tasks
            </button>
            <button
              className="secondary"
              disabled={loading || !next}
              onClick={() => {
                if (next) {
                  setPrevious((p) => [...p, after]);
                  setAfter(next);
                }
              }}
            >
              Next Tasks
            </button>
          </nav>
        </section>
        <section className="panel task-detail-panel" aria-label="Task detail">
          {!selected ? (
            <>
              <h3>Select a Task</h3>
              <p>See its history and original context here.</p>
            </>
          ) : detailError ? (
            <p role="alert">{detailError}</p>
          ) : !detail ? (
            <p role="status">Loading Task…</p>
          ) : (
            <>
              <span className="status-badge">
                {detail.status === "OPEN" ? "Open" : "Completed"}
              </span>
              <h3>{detail.title}</h3>
              {detail.description && (
                <p className="task-description">{detail.description}</p>
              )}
              <p>
                Created {date(detail.createdAt)}
                {detail.completedAt
                  ? " · Completed " + date(detail.completedAt)
                  : ""}
              </p>
              <p>
                {detail.origin === "github"
                  ? "Captured from a private Task batch"
                  : "Saved directly to PCE"}
              </p>
              <button
                className="secondary"
                disabled={controlsDisabled}
                onClick={() => void mutate(detail)}
              >
                {detail.status === "OPEN" ? "Complete Task" : "Reopen Task"}
              </button>
              <h4>Original context</h4>
              {!detail.sources.length && (
                <p>
                  {detail.unavailableSourceCount
                    ? "Source context is unavailable for this session."
                    : "Created independently without a source Note."}
                </p>
              )}
              {detail.sources.map((source) => (
                <div className="task-source" key={source.noteId}>
                  <button
                    className="ghost"
                    onClick={() => onOpenNote(source.noteId)}
                  >
                    Open source Note
                  </button>
                  <p>Captured {date(source.capturedAt)}</p>
                  {source.evidence && (
                    <blockquote>{source.evidence}</blockquote>
                  )}
                </div>
              ))}
              <h4>History</h4>
              {historyError && <p role="alert">{historyError}</p>}
              <ol>
                {history.events.map((event) => (
                  <li key={event.revision}>
                    {event.type === "CREATED"
                      ? "Created"
                      : event.type === "COMPLETED"
                        ? "Completed"
                        : "Reopened"}{" "}
                    · {date(event.at)}
                  </li>
                ))}
              </ol>
              {historyBusy && <p role="status">Loading history…</p>}
              {history.nextRevision !== null && (
                <button
                  className="ghost"
                  disabled={historyBusy}
                  onClick={() => void moreHistory()}
                >
                  More history
                </button>
              )}
            </>
          )}
          <details className="task-create">
            <summary>Create a Task</summary>
            <form onSubmit={(e) => void save(e)}>
              <label htmlFor="task-title">
                Task title
                <input
                  id="task-title"
                  required
                  maxLength={200}
                  value={title}
                  disabled={creationPending}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label htmlFor="task-description">
                Description (optional)
                <textarea
                  id="task-description"
                  maxLength={8000}
                  value={description}
                  disabled={creationPending}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              {creationError && <p role="alert">{creationError}</p>}
              <button
                className="primary"
                disabled={creating || (!creationPending && !title.trim())}
              >
                {creating
                  ? "Saving…"
                  : creationPending
                    ? "Retry Task creation"
                    : "Create Task"}
              </button>
            </form>
          </details>
        </section>
      </div>
    </section>
  );
}
