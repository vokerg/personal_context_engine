import { useEffect, useRef, useState } from "react";
import type { Appearance } from "./theme";
export type AppearanceStore = {
  read: () => Promise<string | null>;
  write: (value: Appearance) => Promise<void>;
};
export function useSavedAppearance(store: AppearanceStore) {
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [error, setError] = useState("");
  const version = useRef(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    const started = version.current;
    void store.read().then(
      (value) => {
        if (
          active &&
          version.current === started &&
          (value === "system" || value === "light" || value === "dark")
        )
          setAppearance(value);
      },
      () => {
        if (active && version.current === started)
          setError("Could not restore appearance. Choose it again to save.");
      },
    );
    return () => {
      active = false;
    };
  }, [store]);
  const choose = (value: Appearance) => {
    const chosen = ++version.current;
    setAppearance(value);
    setError("");
    writes.current = writes.current
      .then(() => store.write(value))
      .then(
        () => {
          if (version.current === chosen) setError("");
        },
        () => {
          if (version.current === chosen)
            setError("Could not save appearance. Select it again to retry.");
        },
      );
  };
  return { appearance, choose, error };
}
