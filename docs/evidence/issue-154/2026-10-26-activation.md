# Task activation checkpoint — 2026-10-26

Owner-authorized continuation of [#147](https://github.com/vokerg/personal_context_engine/issues/147),
[#153](https://github.com/vokerg/personal_context_engine/issues/153) and
[#154](https://github.com/vokerg/personal_context_engine/issues/154).
This evidence uses synthetic captures and Task records only. No personal Note
was edited and no Task, reminder, message or calendar action was executed.

## Source and configuration

- Public #155–#161 merged sequentially, rebasing/retargeting each successor.
  Final implementation main `af2609e` matched the previously tested source tree.
  Final-main Documentation, PostgreSQL integration and Workspace checks passed.
- Render API on `af2609e`: Task gate explicitly enabled; database migration
  check and API startup succeeded. Direct/proxied health/readiness returned 200,
  anonymous Notes/Tasks 401 and no-store. No public/default gate changed.
- Vercel production rebuilt with `VITE_PCE_TASKS=true`. Authenticated Tasks
  workspace is actually visible and its writes were read back from PostgreSQL.
- Existing `pce-chatgpt` registration adds only `tasks:read`/`tasks:write` to
  `notes:read`; native `pce-ios` adds those scopes to its existing read/capture/tag
  scopes. Redirects and identities are preserved. Fresh consent and DB grant
  scopes were verified; existing grants were not silently expanded.
- The old ChatGPT connection initially requested only `notes:read`, even after
  reconnect. The operator explicitly requested the approved Task scopes in fresh
  consent, preserving client, redirect, state, audience/resource and S256 PKCE;
  then refreshed tools. A new chat actually invoked Task search/list tools.
- Ignored local configuration enables the separate private-verified GET-only
  Task ingress. The existing trusted local GitHub reader is reused under the
  owner-directed setup. A deterministic DB-jobs loop is running; no new
  embedding/model worker, paid scheduler or hosted worker was launched. This
  importer requires the local Mac/runtime to run; durable GitHub batches wait
  and reconcile after downtime. Restart with `npm run db-jobs:watch` as needed.

## Installed instructions and plugin

Private companion PRs #6/#7 and promotion PR #8 are merged. The working prompt
now contains the exact reviewed notes-v3.0/tasks-v1 block. The actual previously
installed notes-v2.0 text matched its repository block (6,851 characters) and was
backed up privately before replacement. NOTES Project settings were updated,
reloaded and compared exactly: **7,804 characters, notes-v3.0**. A repository
merge alone was not treated as installation evidence.

The owned private personal conversation-capture plugin was guardedly updated
from 0.1.0 to **0.2.0**. Fresh source/release matched the candidate base before
publication. After publication, source/version readback verified the changed
skill and preservation of identity, full presentation/default prompts, metadata
and private audience. Its actual host page shows 0.2.0, and a fresh selected-plugin
conversation performed a real one-Task capture. It remains instructions-only;
the separately consented PCE server and private GitHub tools provide capabilities.

## Actual live results

| Scenario | Observed result |
| --- | --- |
| NOTES clear three-action capture | One faithful Note, one complete batch and three distinct OPEN Tasks persisted through private GitHub → normal Note ingestion → Task ingress → PostgreSQL. Exact source associations/evidence verified. |
| NOTES speculative idea | One Note, one zero-Task batch and zero Tasks persisted. Initial Note create was blocked by ChatGPT safety review; the UI truthfully reported UNSAVED. One explicitly approved create-only recovery reused the same validated Note/batch IDs, checked absence, saved/read back both files and imported successfully. No replacement IDs or repair Note. |
| Conversation plugin commitment | Actual selected 0.2.0 plugin saved/read back one Brief Note and one Task batch; DB import produced exactly one linked Task. No external action or reminder was executed. |
| Replay/original fidelity | Recurring importer reported exact batch replays. Source Task counts stayed 3/0/1, completed state survived replay, and the three-action Note's original text/content hash remained unchanged through web/native completion and reopening. |
| Hosted web | Explicit standalone creation, confirmed completion, Open removal, Completed search, reopen, history, source evidence/timestamps and source-independent Task lifecycle observed using the actual deployed typed HTTP client. |
| Actual ChatGPT retrieval | Fresh Task-scoped connection and tool refresh; a new chat used `search_tasks`/`list_tasks`, status ALL, returned the three synthetic Tasks and reported actual statuses. Notes were not substituted. |
| Actual ChatGPT lifecycle | An explicit synthetic-only request completed and reopened only the filters Task through MCP. Both acknowledgements, distinct command IDs, revision progression and history were verified; the other two source Tasks stayed unchanged. |
| Native build/install | Xcode 26.6 Release simulator compilation succeeded with embedded JS and Tasks enabled. Installed/launched in a fresh iPhone 17 / iOS 26.5 QA simulator; original simulator installation/Keychain preserved. No Metro, paid signing, TestFlight or physical-device release implied. |
| Native behavior | Actual hosted system-browser login, five-scope consent/PKCE callback, five-tab Tasks, explicit creation, unique-marker server search, one-of-three completion, Completed, detail/history, reopen and faithful source Note navigation/back passed. Light/dark and one increased preferred-text-size setting inspected; defaults restored. |
| Native session lifecycle | Process terminate/relaunch restored authenticated Task access without sign-in. Sign-out cleared local credentials and revoked only the QA native Task grant; the ChatGPT Task grant stayed active. Reconnect through the existing Safari session and fresh consent returned to authenticated native Tasks. |

Mechanism regressions were already executed on the identical implementation
tree: **90 files / 456 tests**, focused verifier **17 files / 112 tests**, migration
replay twice and empty schema diff; lint/typecheck/format/docs passed. These are
separate from the actual live observations above. This evidence-only update
does not claim another unexecuted broad test run.

## Limits and rollback

No physical iPhone was connected. Physical-device distribution, cellular/offline
and forced hosted outage/timeout tests, VoiceOver/audio, the largest Dynamic Type
matrix and a live microphone capture remain unverified. Native accessibility
labels/checkbox states were observed through the actual accessibility tree;
that is not a VoiceOver pass. No App v1 capture/reminder/push work is claimed.
#131 and any remaining #154 acceptance gates stay explicit.

Use exact prior installed prompt/plugin versions and disable Task client/API or
ingress gates independently to roll back. Keep originals, batches, command
receipts and lifecycle history. Prior working prompt is recoverable at private
main `6df6cc8`; its exact installed copy is backed up privately. The existing
capture-only rollback file was unchanged. Synthetic test records are labelled;
no personal-content migration or historical backfill was performed.
