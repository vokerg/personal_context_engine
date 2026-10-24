export type ThemePreference = "system" | "light" | "dark";

const storageKey = "pce-appearance";

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    // The system theme remains usable if browser storage is disabled.
    return "system";
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  try {
    if (preference === "system") window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, preference);
  } catch {
    // Theme switching does not require browser storage.
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document !== "undefined")
    document.documentElement.dataset.theme = preference;
}
