export type RemoteState = "loading" | "ready" | "error";
export type ListPresentation =
  | { state: "content" }
  | { state: "message"; heading: string; description?: string; alert: boolean; canRetry: boolean };

export function describeListState(
  state: RemoteState,
  count: number,
  error: string,
): ListPresentation {
  if (state === "loading")
    return { state: "message", heading: "Loading notes…", alert: false, canRetry: false };
  if (state === "error")
    return {
      state: "message",
      heading: "Unable to load notes",
      description: error,
      alert: true,
      canRetry: true,
    };
  if (count === 0)
    return {
      state: "message",
      heading: "No notes yet",
      description: "Nothing is available for this account.",
      alert: false,
      canRetry: true,
    };
  return { state: "content" };
}

export function describeDetailState(
  state: RemoteState,
  error: string,
): ListPresentation {
  if (state === "loading")
    return { state: "message", heading: "Loading note…", alert: false, canRetry: false };
  if (state === "error")
    return {
      state: "message",
      heading: "Note unavailable",
      description: error,
      alert: true,
      canRetry: true,
    };
  return { state: "content" };
}
