const snapshotCooldownMs = 60 * 60 * 1000;

/** Slow the optional bridge only; normal DB preparation keeps its own cadence. */
export function scheduleTagSnapshots(
  pass: () => Promise<void>,
  now: () => number = () => performance.now(),
) {
  let nextPassAt = -Infinity;
  return async () => {
    if (now() < nextPassAt) return;
    // Block overlap, including while a slow or failed publication is pending.
    nextPassAt = Infinity;
    try {
      await pass();
    } finally {
      nextPassAt = now() + snapshotCooldownMs;
    }
  };
}
