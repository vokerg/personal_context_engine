/** Explicitly idle until the ContentStore and projection worker issues land. */
export function workerStatus() {
  return { state: "idle" as const, imported: 0 };
}
