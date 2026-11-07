# ChatGPT capture surfaces — versioned configuration

This directory is the **reviewable source for the next NOTES Project prompt**, while `integrations/conversation-capture` holds the Conversation Capture plugin source and `integrations/pce-app` records the installed PCE app binding/manifest.

## Source and rollout status (2026-10-26)

| Surface | Tracked candidate/source | Observed installed baseline | Deployment |
| --- | --- | --- | --- |
| NOTES Project | [NOTES_PROJECT_INSTRUCTIONS.md](NOTES_PROJECT_INSTRUCTIONS.md), proposed `notes-v3.1` | Private `CHATGPT_PROJECT_INSTRUCTIONS.md` contains installed `notes-v3.0` | ChatGPT NOTES Project settings (browser) |
| Conversation Capture plugin | `../conversation-capture/skills/conversation-capture/SKILL.md` and tracked manifests, proposed `0.3.0` | Owned private plugin `0.2.0` | Plugin Creator, guarded release update |
| PCE app (search/Tasks) | `../pce-app` manifest; public API/MCP code contracts | Owned private App-backed plugin `1.0.0`, `defaultPrompt: null` | Existing App binding; no separately deployed instruction prompt |

**A PR does not deploy anything.** Until independently installed and verified, the private content repo copy and actual ChatGPT settings remain the baseline. Preserve exact installed text/release identifiers privately for rollback; never mix candidate and observed live state.

## Release workflow

1. Review the public PR for behavior, data boundaries and source manifest consistency. Test Notes and conversation-capture cases (0/1/3 Tasks, opt-out, split Notes, uncertain retry, source attribution, Brief/Full/Specific, explicit research, reminders and missing tools) with **synthetic** content. Confirm the private AGENTS and public contracts still agree.
2. Merge only after review. In a **separately authorized browser/Work or Codex browser session**, open the NOTES Project settings; back up the actual current installed prompt privately, paste **exactly** the raw file `NOTES_PROJECT_INSTRUCTIONS.md`, save, reload and compare full text/length/hash. Do not simply assume project settings consume the repository.
3. Package the reviewed `integrations/conversation-capture` files without changing plugin identity, default prompts, audiences or capability declarations. Compare the live release ID before guarded publication. Re-read the released skill/manifest and compare with the merged revision.
4. The PCE app's `defaultPrompt` is null; there is no PCE prompt to install. Compare the App-backed manifest and binding with `integrations/pce-app` without recreating the app or changing OAuth permissions.
5. Run fresh synthetic one-send NOTES and selected-plugin capture checks, and read actual Note/Task/Research persistence independently. Update the private installed-snapshot/rollback document by a **separate private PR** after deployment, and record confirmed version, release IDs, hashes, results and known limits. Do not write private Note bodies to public evidence.
6. Roll back only the deployed prompt/plugin release on failure; keep persisted Notes, Task history and research artifacts. Never roll back by editing or deleting user content.

For authoritative integration evidence and existing checks see `docs/12-chatgpt-project.md` and `docs/25-task-acceptance.md`. Source changes are **not** permission to modify live ChatGPT settings or plugin publications.
