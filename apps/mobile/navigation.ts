import { isNoteId } from "@pce/api-client";
import { parseNoteDeepLink } from "./links";
import type { SessionPhase } from "./session";

export type MobileTab = "notes" | "search" | "capture" | "settings";
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
  pendingNoteId: string | null;
};

export type NavigationAction =
  | { type: "session"; phase: SessionPhase }
  | { type: "link"; url: string }
  | { type: "open-note"; id: string }
  | { type: "tab"; tab: MobileTab }
  | { type: "back" }
  | { type: "reset" };

export const initialNavigation: NavigationState = {
  phase: "restoring",
  tab: "notes",
  noteId: null,
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
          pendingNoteId: null,
        };
      }
      // Expiry, revocation and logout discard *all* private navigation.
      if (state.phase === "signed-in") {
        return { ...initialNavigation, phase: action.phase };
      }
      return { ...state, phase: action.phase, noteId: null };
    case "link": {
      const id = parseNoteDeepLink(action.url);
      if (!id) return state;
      if (state.phase !== "signed-in") {
        return { ...state, pendingNoteId: id };
      }
      return { ...state, tab: "notes", noteId: id, pendingNoteId: null };
    }
    case "open-note":
      return state.phase === "signed-in" && isNoteId(action.id)
        ? { ...state, noteId: action.id }
        : state;
    case "tab":
      return state.phase === "signed-in"
        ? { ...state, tab: action.tab, noteId: null }
        : state;
    case "back":
      return state.noteId ? { ...state, noteId: null } : state;
    case "reset":
      return { ...initialNavigation, phase: "signed-out" };
  }
}
