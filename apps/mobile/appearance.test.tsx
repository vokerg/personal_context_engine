// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSavedAppearance, type AppearanceStore } from "./appearance";

let root: ReturnType<typeof createRoot> | undefined;
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => {
  await act(async () => root?.unmount());
});
async function mount(store: AppearanceStore) {
  let result!: ReturnType<typeof useSavedAppearance>;
  function Harness() {
    result = useSavedAppearance(store);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(<Harness />);
  });
  return () => result;
}
it("restores each saved choice on a fresh mount, including system", async () => {
  for (const choice of ["dark", "light", "system"] as const) {
    const store = {
      read: vi.fn(async () => null as string | null),
      write: vi.fn<AppearanceStore["write"]>(async () => undefined),
    };
    const get = await mount(store);
    await act(async () => get().choose(choice));
    expect(store.write).toHaveBeenCalledWith(choice);
    await act(async () => root!.unmount());
    store.read.mockResolvedValue(choice);
    const restored = await mount(store);
    expect(restored().appearance).toBe(choice);
    await act(async () => root!.unmount());
    root = undefined;
  }
});
it("ignores invalid/missing saved values and reports read failure", async () => {
  for (const value of [null, "invalid"]) {
    const get = await mount({
      read: async () => value,
      write: async () => undefined,
    });
    expect(get().appearance).toBe("system");
    await act(async () => root!.unmount());
    root = undefined;
  }
  const get = await mount({
    read: async () => {
      throw Error();
    },
    write: async () => undefined,
  });
  expect(get().error).toContain("Could not restore");
});
it("does not overwrite a new selection with delayed hydration and serializes writes", async () => {
  let restore!: (value: string) => void, finish!: () => void;
  const write = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue(undefined);
  const get = await mount({
    read: () =>
      new Promise((r) => {
        restore = r;
      }),
    write,
  });
  await act(async () => {
    get().choose("dark");
    get().choose("light");
  });
  expect(write.mock.calls.map(([value]) => value)).toEqual(["dark"]);
  await act(async () => {
    restore("system");
    finish();
  });
  expect(get().appearance).toBe("light");
  expect(write.mock.calls.map(([value]) => value)).toEqual(["dark", "light"]);
});
it("keeps the chosen palette on save failure and lets the same choice retry", async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(Error())
    .mockResolvedValue(undefined);
  const get = await mount({ read: async () => null, write });
  await act(async () => get().choose("dark"));
  expect(get().appearance).toBe("dark");
  expect(get().error).toContain("Could not save");
  await act(async () => get().choose("dark"));
  expect(get().error).toBe("");
  expect(write).toHaveBeenCalledTimes(2);
});
