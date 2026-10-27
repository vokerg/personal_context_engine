// Expo statically inlines only direct EXPO_PUBLIC_* references. No secret here.
export const TASKS_ENABLED = process.env.EXPO_PUBLIC_PCE_TASKS === "true";
export const nativeScopes = (tasks: boolean): string[] => [
  "notes:read",
  "capture:write",
  "tags:write",
  ...(tasks ? ["tasks:read", "tasks:write"] : []),
];
