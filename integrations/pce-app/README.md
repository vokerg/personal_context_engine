# Personal Context Engine — App-backed plugin manifest

The installed **Personal Context Engine** is an App-backed plugin whose functionality comes from the PCE server MCP endpoints and contracts (`apps/api/src/mcp.ts`, `apps/api/src/task-mcp.ts`, `docs/18-mcp.md`), not from a separate model instruction prompt.

The tracked `.codex-plugin/plugin.json` and `.app.json` are **identity-preserving snapshots** of the observed current private App-backed plugin release `1.0.0` (2026-10-26). `interface.defaultPrompt` is `null`. The `.app.json` contains a non-secret, account-specific binding identifier; it is **not** a portable app-registration recipe or an OAuth credential.

For replication in a different account/workspace, create/authorize a new App binding and update the bound identifier in a private release package, without reusing the current user's OAuth configuration. Never publish another plugin, change connection scopes or presume settings are deployed merely by committing this manifest. For existing-app verification compare the live manifest against this source and read back the registered tool behavior.
