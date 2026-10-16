import { isNoteId } from "@pce/api-client";

/** A deep link is navigation intent, never proof of authorization. */
export function parseNoteDeepLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "pce:" ||
      url.host !== "notes" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1 || !segments[0]) return null;
    // Do not accept percent-encoded separators, dots or alternate paths.
    if (decodeURIComponent(segments[0]) !== segments[0]) return null;
    return isNoteId(segments[0]) ? segments[0] : null;
  } catch {
    return null;
  }
}
