import { describe, expect, it } from "vitest";
import { describeDetailState, describeListState } from "./screen-state.js";

describe("native standard remote screen states", () => {
  it("does not show fake content before a request completes", () => {
    expect(describeListState("loading", 0, "")).toMatchObject({
      state: "message",
      heading: "Loading notes…",
      canRetry: false,
    });
    expect(describeDetailState("loading", "")).toMatchObject({
      state: "message",
      heading: "Loading note…",
    });
  });
  it("distinguishes empty, error and ready without disguising failures", () => {
    expect(describeListState("ready", 0, "")).toMatchObject({
      heading: "No notes yet",
      canRetry: true,
    });
    expect(describeListState("ready", 2, "")).toEqual({ state: "content" });
    expect(describeListState("error", 0, "Offline")).toMatchObject({
      heading: "Unable to load notes",
      description: "Offline",
      alert: true,
      canRetry: true,
    });
    expect(describeDetailState("error", "Forbidden")).toMatchObject({
      heading: "Note unavailable",
      description: "Forbidden",
      alert: true,
    });
  });
});
