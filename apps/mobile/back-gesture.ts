import type { PanResponderGestureState } from "react-native";

type Swipe = Pick<
  PanResponderGestureState,
  "x0" | "dx" | "dy" | "vx" | "numberActiveTouches"
>;
export function claimsBackSwipe(g: Swipe) {
  return (
    g.numberActiveTouches === 1 &&
    g.x0 <= 36 &&
    g.dx > 12 &&
    g.dx > Math.abs(g.dy) * 2
  );
}
export function completesBackSwipe(g: Swipe) {
  return g.dx > 72 && g.dx > Math.abs(g.dy) * 2 && (g.dx > 120 || g.vx > 0.25);
}
