import { isNoteId } from "@pce/api-client";
import { parseNoteDeepLink } from "./links";
import type { SessionPhase } from "./session";

export type MobileTab = "notes" | "tasks" | "search" | "capture" | "settings";
export const MOBILE_TABS: readonly MobileTab[] = [
  "notes",
  "search",
  "capture",
  "settings",
];

export type NavigationState = {
  phase: SessionPhase;
  tab: MobileTab;
  noteId: string | null;
  noteTrail: string[];
  pendingNoteId: string | null;
};

export type NavigationAction =
  | { type: "session"; phase: SessionPhase }
  | { type: "link"; url: string }
  | { type: "open-note"; id: string }
  | { type: "open-source"; id: string }
  | { type: "tab"; tab: MobileTab }
  | { type: "back" }
  | { type: "reset" };

export const initialNavigation: NavigationState = {
  phase: "restoring",
  tab: "notes",
  noteId: null,
  noteTrail: [],
  pendingNoteId: null,
};

/**
 * One navigation boundary for the native shell. URLs convey intent only:
 * a note must still be fetched through the authenticated API.
 * No note content or session credential is persisted in route state.
 */
export function reduceNavigation(
  state: NavigationState,
  action: NavigationAction,
): NavigationState {
  switch (action.type) {
    case "session":
      if (action.phase === "signed-in") {
        return {
          ...state,
          phase: "signed-in",
          tab: state.pendingNoteId ? "notes" : state.tab,
          noteId: state.pendingNoteId ?? state.noteId,
          noteTrail: state.pendingNoteId ? [] : state.noteTrail,
          pendingNoteId: null,
        };
      }
      // Expiry, revocation and logout discard *all* private navigation.
      if (state.phase === "signed-in") {
        return { ...initialNavigation, phase: action.phase };
      }
      return { ...state, phase: action.phase, noteId: null, noteTrail: [] };
    case "link": {
      const id = parseNoteDeepLink(action.url);
      if (!id) return state;
      if (state.phase !== "signed-in") {
        return { ...state, pendingNoteId: id };
      }
      return {
        ...state,
        tab: "notes",
        noteId: id,
        noteTrail: [],
        pendingNoteId: null,
      };
    }
    case "open-note":
      return state.phase === "signed-in" && isNoteId(action.id)
        ? { ...state, noteId: action.id, noteTrail: [] }
        : state;
    case "open-source":
      return state.phase === "signed-in" &&
        state.noteId &&
        isNoteId(action.id) &&
        action.id !== state.noteId &&
        state.noteTrail.length < 20
        ? {
            ...state,
            noteId: action.id,
            noteTrail: [...state.noteTrail, state.noteId],
          }
        : state;
    case "tab":
      return state.phase === "signed-in"
        ? { ...state, tab: action.tab, noteId: null, noteTrail: [] }
        : state;
    case "back":
      return state.noteId
        ? {
            ...state,
            noteId: state.noteTrail.at(-1) ?? null,
            noteTrail: state.noteTrail.slice(0, -1),
          }
        : state;
    case "reset":
      return { ...initialNavigation, phase: "signed-out" };
  }
}
