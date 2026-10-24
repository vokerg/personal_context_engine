import { useEffect, useState } from "react";
import { SuggestionPicker } from "./SuggestionPicker.js";
import { getTagRegistry } from "@pce/api-client";

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  attached: string[];
  baseUrl: string;
  token: string | null;
  useSessionCookie: boolean;
  revision: number | undefined;
};

export function NoteTagPicker({
  value,
  onChange,
  disabled,
  attached,
  baseUrl,
  token,
  useSessionCookie,
  revision,
}: Props) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const query = value.trim();
  const options = matches
    .filter((slug) => !attached.includes(slug))
    .slice(0, 6);

  useEffect(() => {
    if (!open || disabled || !token) return;
    const controller = new AbortController();
    setMatches([]);
    setState("loading");
    const timer = setTimeout(() => {
      void getTagRegistry(
        {
          baseUrl,
          getAccessToken: () => token,
          useSessionCookie,
          signal: controller.signal,
          timeoutMs: 12000,
        },
        { limit: 50, ...(query ? { q: query } : {}) },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setMatches(result.approved.map((tag) => tag.slug));
          setState("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) setState("error");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, disabled, token, baseUrl, useSessionCookie, query, revision]);

  return (
    <SuggestionPicker
      id="new-note-tag"
      value={value}
      onChange={onChange}
      options={options.map((value) => ({ value }))}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      suggestionsLabel="Approved tag suggestions"
      placeholder="Find an approved tag"
      describedBy="tag-edit-help"
      maxLength={64}
      state={state}
      loadingMessage="Loading approved tags…"
      errorMessage="Approved tags unavailable. Try reopening."
      emptyMessage="No approved tags to suggest."
    />
  );
}
