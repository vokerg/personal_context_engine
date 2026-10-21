function cooldown(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Separate opt-in process. Cooldown follows completion, so passes never overlap. */
export async function runEmbeddingLoop(
  pass: () => Promise<void>,
  signal: AbortSignal,
  intervalMs = 60_000,
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000)
    throw new Error("Embedding cooldown must be at least one minute");
  while (!signal.aborted) {
    try {
      await pass();
    } catch {
      // Never print adapter exceptions, source text, identifiers or credentials.
      console.error("Embedding cycle unavailable; retrying after cooldown.");
    }
    if (signal.aborted) break;
    await cooldown(intervalMs, signal);
  }
}
