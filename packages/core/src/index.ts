/** Exhaustiveness helper for future pure domain state machines. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected domain variant: ${String(value)}`);
}
