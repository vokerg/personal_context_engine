import { expect, it } from "vitest";
import { claimsBackSwipe, completesBackSwipe } from "./back-gesture";
const swipe = { x0: 15, dx: 95, dy: 5, vx: 0.6, numberActiveTouches: 1 };
it("claims only a rightward single-finger edge swipe, leaving scroll and text gestures alone", () => {
  expect(claimsBackSwipe(swipe)).toBe(true);
  for (const change of [
    { x0: 100 },
    { dx: -95 },
    { dy: 100 },
    { numberActiveTouches: 2 },
    { dx: 5 },
  ]) {
    expect(claimsBackSwipe({ ...swipe, ...change })).toBe(false);
  }
});
it("requires a deliberate distance and speed, or a longer slow swipe, before going back", () => {
  expect(completesBackSwipe(swipe)).toBe(true);
  expect(completesBackSwipe({ ...swipe, dx: 140, vx: 0.01 })).toBe(true);
  expect(completesBackSwipe({ ...swipe, dx: 30 })).toBe(false);
  expect(completesBackSwipe({ ...swipe, vx: 0.01 })).toBe(false);
  expect(completesBackSwipe({ ...swipe, dy: 100 })).toBe(false);
});
