import { useEffect, useMemo, useRef, useState } from "react";
import {
  getGitHubSyncStatus,
  syncFromGitHub,
  describeGitHubSyncError,
  type GitHubSyncStatus,
  type AuthenticatedRequestOptions,
} from "@pce/api-client";

export function GitHubSync({
  baseUrl,
  token,
  useSessionCookie,
}: {
  baseUrl: string;
  token: string;
  useSessionCookie: boolean;
}) {
  const [status, setStatus] = useState<GitHubSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const options: AuthenticatedRequestOptions = useMemo(
    () => ({
      baseUrl,
      getAccessToken: () => token,
      useSessionCookie,
      getCsrfToken: () =>
        decodeURIComponent(
          document.cookie
            .split("; ")
            .find((c) => c.startsWith("pce_csrf="))
            ?.slice(9) ?? "",
        ),
      timeoutMs: 25000,
    }),
    [baseUrl, token, useSessionCookie],
  );
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = () => {
      void getGitHubSyncStatus({ ...options, signal: controller.signal }).then(
        (result) => {
          if (active) setStatus(result);
        },
        () => {
          if (active)
            setMessage(
              "Sync status unavailable. Check your connection and permissions.",
            );
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [options]);
  async function sync() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await syncFromGitHub(options);
      setMessage(
        `${result.staged} staged, ${result.alreadyStaged} already staged, ${result.failed} failed. ${result.hasMore ? "Another batch remains; sync again to continue." : "Scan complete."}`,
      );
      try {
        setStatus(await getGitHubSyncStatus(options));
      } catch {
        setMessage(
          (previous) =>
            previous +
            " Processing status is unavailable; refresh to check it.",
        );
      }
    } catch (error) {
      setMessage(describeGitHubSyncError(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="github-sync">
      <button
        type="button"
        className="secondary"
        disabled={busy || !status?.enabled}
        onClick={() => void sync()}
      >
        {busy ? "Fetching from GitHub…" : "Sync from GitHub"}
      </button>
      <small role="status">
        {status
          ? `${status.enabled ? "" : status.reason + " "}Processing: ${status.pending} pending, ${status.invalid} need inspection. ${status.lastSuccessfulScan ? `Last complete scan: ${new Date(status.lastSuccessfulScan).toLocaleString()}.` : "No complete scan yet."}`
          : "Checking sync availability…"}{" "}
        {message}
      </small>
    </div>
  );
}
