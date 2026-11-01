import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  getGitHubSyncStatus,
  syncFromGitHub,
  describeGitHubSyncError,
  type GitHubSyncStatus,
} from "@pce/api-client";
import type { MobileSession } from "./session";
import type { Palette } from "./theme";
import { ActionButton } from "./ui";

export function GitHubSync({
  session,
  palette,
}: {
  session: MobileSession;
  palette: Palette;
}) {
  const [status, setStatus] = useState<GitHubSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const options = useMemo(
    () => ({
      baseUrl: session.config.apiOrigin,
      getAccessToken: () => session.getAccessToken(),
      timeoutMs: 25000,
    }),
    [session],
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
    <View style={{ gap: 10 }}>
      <ActionButton
        label={busy ? "Fetching from GitHub…" : "Sync from GitHub"}
        disabled={busy || !status?.enabled}
        palette={palette}
        onPress={() => void sync()}
        secondary
      />
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: palette.secondary }}
      >
        {status
          ? `${status.enabled ? "" : status.reason + " "}Processing: ${status.pending} pending, ${status.invalid} need inspection.`
          : "Checking sync availability…"}{" "}
        {message}
      </Text>
    </View>
  );
}
