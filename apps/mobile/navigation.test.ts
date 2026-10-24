import { describe, expect, it } from "vitest";
import { initialNavigation, reduceNavigation } from "./navigation.js";

const id = "01K00000000000000000000001";
const link = "pce://notes/" + id;
const step = reduceNavigation;

describe("native navigator authorization boundary", () => {
  it("holds a canonical link until signed in and then opens only its ID", () => {
    const pending = step(initialNavigation, { type: "link", url: link });
    expect(pending).toMatchObject({ noteId: null, pendingNoteId: id });
    const ready = step(pending, { type: "session", phase: "signed-in" });
    expect(ready).toMatchObject({
      tab: "notes",
      noteId: id,
      pendingNoteId: null,
    });
    expect(step(ready, { type: "back" }).noteId).toBeNull();
  });

  it("rejects injected links and never opens private detail before login", () => {
    const signedOut = step(initialNavigation, {
      type: "session",
      phase: "signed-out",
    });
    expect(step(signedOut, { type: "open-note", id })).toEqual(signedOut);
    for (const url of [
      link + "?access_token=secret",
      link + "#private",
      "pce://oauth/callback?code=secret",
      "pce://notes/not-an-id",
    ]) {
      expect(step(signedOut, { type: "link", url })).toEqual(signedOut);
    }
  });

  it("clears detail and pending links after explicit logout and expiry", () => {
    const ready = step(initialNavigation, {
      type: "session",
      phase: "signed-in",
    });
    const detail = step(ready, { type: "open-note", id });
    expect(step(detail, { type: "session", phase: "signed-out" })).toEqual({
      ...initialNavigation,
      phase: "signed-out",
    });
    expect(step(detail, { type: "reset" }).noteId).toBeNull();
    const recovered = step(
      step(detail, { type: "session", phase: "restoring" }),
      { type: "session", phase: "signed-in" },
    );
    expect(recovered.noteId).toBeNull();
  });

  it("supports typed tabs, back navigation and fresh external link intent", () => {
    const ready = step(initialNavigation, {
      type: "session",
      phase: "signed-in",
    });
    const search = step(ready, { type: "tab", tab: "search" });
    expect(search.tab).toBe("search");
    const detail = step(search, { type: "link", url: link });
    expect(detail).toMatchObject({ tab: "notes", noteId: id });
    const out = step(detail, { type: "session", phase: "signed-out" });
    const pending = step(out, { type: "link", url: link });
    expect(step(pending, { type: "session", phase: "signed-in" }).noteId).toBe(
      id,
    );
  });
});
