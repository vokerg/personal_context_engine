import { useEffect, useId, useState } from "react";
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
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [matches, setMatches] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const query = value.trim();
  const options = matches
    .filter((slug) => !attached.includes(slug))
    .slice(0, 6);

  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId, open]);

  useEffect(() => {
    if (!open || disabled || !token) return;
    const controller = new AbortController();
    setMatches([]);
    setActive(-1);
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

  function select(slug: string) {
    onChange(slug);
    setOpen(false);
    setActive(-1);
  }

  return (
    <div
      className="note-tag-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="note-tag-input">
        <input
          id="new-note-tag"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && !disabled}
          aria-controls={listId}
          aria-activedescendant={
            open && options[active] ? `${listId}-${active}` : undefined
          }
          aria-describedby="tag-edit-help"
          autoComplete="off"
          value={value}
          maxLength={64}
          placeholder="Find an approved tag"
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              setActive(-1);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              if (options.length)
                setActive((index) =>
                  event.key === "ArrowDown"
                    ? Math.min(index + 1, options.length - 1)
                    : index < 0
                      ? options.length - 1
                      : Math.max(0, index - 1),
                );
            }
            if (event.key === "Enter" && open && options[active]) {
              event.preventDefault();
              select(options[active]);
            }
          }}
        />
        <button
          type="button"
          className="tag-picker-toggle"
          tabIndex={-1}
          aria-label="Toggle approved tag suggestions"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {open && !disabled && (
        <div className="tag-picker-menu">
          <div
            role="listbox"
            id={listId}
            aria-label="Approved tag suggestions"
            aria-busy={state === "loading"}
          >
            {options.map((slug, index) => (
              <button
                key={slug}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={active === index}
                tabIndex={-1}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(slug)}
              >
                {slug}
              </button>
            ))}
          </div>
          {state === "loading" && <p role="status">Loading approved tags…</p>}
          {state === "error" && (
            <p role="status">Approved tags unavailable. Try reopening.</p>
          )}
          {state === "ready" && !options.length && (
            <p role="status">No approved tags to suggest.</p>
          )}
          {state === "ready" && options.length === 6 && (
            <p className="tag-picker-hint">Type to narrow the matches.</p>
          )}
        </div>
      )}
    </div>
  );
}
