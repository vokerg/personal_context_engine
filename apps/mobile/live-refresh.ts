import { useEffect, useRef } from "react";
import { AppState } from "react-native";

/** Only the visible screen polls; no private data is persisted. */
export function useLiveRefresh(visible: boolean, refresh: () => void) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!visible) return;
    let active = AppState.currentState === "active";
    // Returning from detail or another tab also revalidates server state.
    if (active) latest.current();
    const subscription = AppState.addEventListener("change", (state) => {
      const next = state === "active";
      if (next && !active) latest.current();
      active = next;
    });
    const timer = setInterval(() => {
      if (active) latest.current();
    }, 30000);
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [visible]);
}
