import { useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  getTaskSuggestionsConfig,
  suggestTasksForNote,
  saveSuggestedTasks,
} from "@pce/api-client";
import type { SaveSuggestedTasks, TaskSuggestions } from "@pce/contracts";

type Props = {
  onSaved?: () => void;
  noteId: string;
  baseUrl: string;
  token: string | null;
  useSessionCookie: boolean;
};
export function NoteTasks(props: Props) {
  // App keys this component by source/auth identity; unmount aborts and ignores late responses.
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const pending = useRef<SaveSuggestedTasks | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<TaskSuggestions | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const options = () => ({
    baseUrl: props.baseUrl,
    getAccessToken: () => props.token,
    useSessionCookie: props.useSessionCookie,
    getCsrfToken: () =>
      /(?:^|;\s*)pce_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? "",
    timeoutMs: 15000,
    signal: controller.current!.signal,
  });
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    getTaskSuggestionsConfig(options())
      .then((c) => {
        if (alive.current) setEnabled(c.enabled);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
    // Component identity includes all transport/auth inputs.
  }, []);
  function message(e: unknown, saving: boolean) {
    if (e instanceof ApiRequestError) {
      if (e.status === 401) return "Session expired. Sign in again.";
      if (e.status === 403)
        return "Task and note permissions are required. Reconnect to continue.";
      if (e.status === 404)
        return "The source note or this feature is unavailable.";
      if (e.status === 409)
        return "These task IDs conflict. Check Tasks before starting again.";
      if (e.status === 429)
        return "Suggestion limit reached. Wait before trying again.";
      if (e.status === 400)
        return saving
          ? "Check the task titles and source evidence."
          : "This note is empty or too long for suggestions (24 KB maximum).";
    }
    return saving
      ? "Save was not confirmed. Retry this exact selection. Before leaving or reloading, check Tasks to avoid duplicates."
      : "Suggestions are unavailable. The note is saved; you can try again.";
  }
  async function suggest() {
    if (busyRef.current || pending.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await suggestTasksForNote(options(), props.noteId);
      if (!alive.current) return;
      setDraft(result);
      setSelected(new Set(result.tasks.map((t) => t.taskId)));
    } catch (e) {
      if (alive.current) setError(message(e, false));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (busyRef.current || !draft) return;
    pending.current ??= {
      captureId: draft.captureId,
      tasks: draft.tasks.filter((t) => selected.has(t.taskId)),
    };
    if (!pending.current.tasks.length) {
      pending.current = null;
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setUncertain(true);
    try {
      const result = await saveSuggestedTasks(
        options(),
        props.noteId,
        pending.current,
      );
      if (!alive.current) return;
      setSaved(result.receipts.length);
      props.onSaved?.();
      pending.current = null;
      setUncertain(false);
    } catch (e) {
      if (alive.current) setError(message(e, true));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!enabled) return null;
  return (
    <section className="note-tasks" aria-label="Tasks from this note">
      <h3>Tasks from this note</h3>
      {saved !== null ? (
        <p role="status">
          {saved} {saved === 1 ? "task saved" : "tasks saved"}. Open Tasks to
          view or complete them.
        </p>
      ) : (
        <>
          {!draft && (
            <>
              <p>
                Suggest tasks sends this note’s original text to DeepSeek.
                Review the suggestions before saving.
              </p>
              <p>Check Tasks first if you have already processed this note.</p>
              <button
                type="button"
                className="secondary"
                onClick={() => void suggest()}
                disabled={busy}
              >
                {busy ? "Suggesting tasks…" : "Suggest tasks"}
              </button>
            </>
          )}
          {draft && (
            <>
              {draft.tasks.length === 0 ? (
                <p role="status">No clear tasks found. {draft.reason}</p>
              ) : (
                <>
                  <p>
                    Select tasks to save. You can edit their titles and
                    descriptions. Each task keeps a link to this note.
                  </p>
                  {draft.tasks.map((task, index) => (
                    <fieldset key={task.taskId} disabled={busy || uncertain}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(task.taskId)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(task.taskId);
                              else next.delete(task.taskId);
                              return next;
                            })
                          }
                        />{" "}
                        Save task {index + 1}
                      </label>
                      <label>
                        Title {index + 1}
                        <input
                          value={task.title}
                          maxLength={200}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              tasks: draft.tasks.map((t) =>
                                t.taskId === task.taskId
                                  ? { ...t, title: e.target.value }
                                  : t,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        Description {index + 1}
                        <textarea
                          value={task.description ?? ""}
                          maxLength={8000}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              tasks: draft.tasks.map((t) =>
                                t.taskId === task.taskId
                                  ? {
                                      ...t,
                                      description: e.target.value || undefined,
                                    }
                                  : t,
                              ),
                            })
                          }
                        />
                      </label>
                      <blockquote>{task.evidence}</blockquote>
                    </fieldset>
                  ))}
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={
                      busy ||
                      !selected.size ||
                      draft.tasks.some(
                        (t) => selected.has(t.taskId) && !t.title.trim(),
                      )
                    }
                  >
                    {busy
                      ? "Saving…"
                      : uncertain
                        ? "Retry saving tasks"
                        : `Save ${selected.size} ${selected.size === 1 ? "task" : "tasks"}`}
                  </button>
                  {uncertain && (
                    <p>
                      Keep this page open to retry the same tasks. Reloading
                      discards the pending request.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
