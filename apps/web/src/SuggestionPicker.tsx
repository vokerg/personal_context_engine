import { useEffect, useId, useState } from "react";

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label?: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  suggestionsLabel: string;
  placeholder: string;
  disabled?: boolean;
  describedBy?: string;
  maxLength?: number;
  state?: "loading" | "ready" | "error";
  loadingMessage?: string;
  errorMessage?: string;
  emptyMessage: string;
};

/** Shared bounded popup for editable project and tag suggestions. */
export function SuggestionPicker({
  id,
  value,
  onChange,
  options,
  open,
  onOpenChange,
  suggestionsLabel,
  placeholder,
  disabled = false,
  describedBy,
  maxLength,
  state = "ready",
  loadingMessage,
  errorMessage,
  emptyMessage,
}: Props) {
  const listId = useId();
  const [active, setActive] = useState(-1);
  const visible = options.slice(0, 6);
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId, open]);
  function select(value: string) {
    onChange(value);
    onOpenChange(false);
    setActive(-1);
  }
  return (
    <div
      className="suggestion-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          onOpenChange(false);
      }}
    >
      <div className="suggestion-input">
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && !disabled}
          aria-controls={listId}
          aria-activedescendant={
            open && visible[active] ? `${listId}-${active}` : undefined
          }
          aria-describedby={describedBy}
          autoComplete="off"
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => onOpenChange(true)}
          onClick={() => onOpenChange(true)}
          onChange={(event) => {
            onChange(event.target.value);
            onOpenChange(true);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onOpenChange(false);
              setActive(-1);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              onOpenChange(true);
              if (visible.length)
                setActive((index) =>
                  event.key === "ArrowDown"
                    ? Math.min(index + 1, visible.length - 1)
                    : index < 0
                      ? visible.length - 1
                      : Math.max(0, index - 1),
                );
            }
            if (event.key === "Enter" && open && visible[active]) {
              event.preventDefault();
              select(visible[active].value);
            }
          }}
        />
        <button
          type="button"
          className="suggestion-toggle"
          tabIndex={-1}
          aria-label={`Toggle ${suggestionsLabel.toLowerCase()}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onOpenChange(!open)}
        >
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {open && !disabled && (
        <div className="suggestion-menu">
          <div
            role="listbox"
            id={listId}
            aria-label={suggestionsLabel}
            aria-busy={state === "loading"}
          >
            {visible.map((option, index) => (
              <button
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={active === index}
                tabIndex={-1}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option.value)}
              >
                {option.label ?? option.value}
              </button>
            ))}
          </div>
          {state === "loading" && <p role="status">{loadingMessage}</p>}
          {state === "error" && <p role="status">{errorMessage}</p>}
          {state === "ready" && !visible.length && (
            <p role="status">{emptyMessage}</p>
          )}
          {state === "ready" && visible.length === 6 && (
            <p className="suggestion-hint">Type to narrow the matches.</p>
          )}
        </div>
      )}
    </div>
  );
}
