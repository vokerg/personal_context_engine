# 12 — NOTES Project integration and acceptance (#105)

**2026-10-23:** #99, #100, #103 and #104 and their private contracts are merged.
The reviewed `notes-v2.0` prompt was installed in the actual NOTES Project with
explicit owner authorization. Reloading Project settings returned the exact
6,851-character prompt; the previous installed text is backed up privately for
rollback. The source and capture-only rollback remain in the **private content
repository**. Keep #105 open until remaining text/research acceptance and the
owner go/no-go are recorded. The owner waived microphone testing on 2026-10-23;
actual audio/transcription fidelity is untested and is not a release blocker.

## Authority and installation

The private `CHATGPT_PROJECT_INSTRUCTIONS.md` is the single copy/paste source;
`CHATGPT_PROJECT_INSTRUCTIONS_ROLLBACK.md` is the concise capture-only fallback.
The installed prompt can differ from the prior repository guide: save the actual
installed text privately before replacing it. The private AGENTS is the capture
permission authority; public [Markdown v1](04-capture-contract.md),
[research schema/runbook](20-research-capture.md), and
[security rules](09-security-and-privacy.md) define executable boundaries.

The owner, or an agent explicitly authorized by the owner for this installation,
opens NOTES → Project settings → Instructions, pastes only the reviewed versioned
prompt block and saves it. Reload settings and compare the saved text, then start
fresh ordinary Chat conversations. Editing repository files alone does not
install settings. Do not edit existing personal chats to manufacture acceptance.

The combined prompt preserves one-send ordinary GitHub Markdown capture without
required `@Personal Context Engine`. It explicitly attempts the approved taxonomy
snapshot read; missing/stale/truncated hints cannot block capturing or force tags.
Only an explicit research-and-save request requires actual PCE MCP retrieval and
relevant original reads before conclusions, plus ordinary external web evidence
as needed. Research is separate versioned JSON; two file writes have independent
read-back/status. Missing MCP yields context-unavailable and an unsaved draft,
while an independently saved ordinary note remains saved. No special Deep
Research mode, background research model or new worker is selected.

[Official Project documentation](https://learn.chatgpt.com/docs/projects) explains
shared instructions/context; [custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and [MCP usage](https://learn.chatgpt.com/docs/extend/mcp) describe connection and
client availability. Instructions alone do not prove tool attachment or account
access. Observe actual app selection, authorization, calls and persistence.

## Verified evidence and limits

Installed `notes-v2.0` checks:

- Explicit owner authorization was followed by a real settings Save and reload;
  the saved prompt matched all 6,851 reviewed characters. The prior installed
  text is backed up privately, outside either repository.
- A fresh ordinary NOTES Chat saved one synthetic memo without an app mention.
  Its activity reported reading the capture rules and taxonomy. Independent
  GitHub parsing and PostgreSQL checks confirmed valid v1, the complete message
  plus its terminal Markdown newline, `chatgpt_text`, no due time, no report and
  `FINALIZED` ingestion. Tags were legitimately empty. Research acceptance is
  recorded separately; a memo receipt does not establish research persistence.
- A separate fresh-chat read-only query returned an unrelated semantic match
  which was excluded without opening its original. A repeat with an absent-tag
  filter returned an actual empty result array, hybrid mode and null degradation.
  Both were correctly classified as no relevant context, rather than an outage;
  neither request created a note or report.

- Explicit research in the ordinary installed-prompt chat called PCE, read the
  exact related synthetic original, and used one external source. Parent and
  separate report create/read-back succeeded. Independent executable parsing
  confirmed Markdown v1, ResearchArtifact v1, exact parent/capture linkage, the
  related source revision, three valid attributed claims and unchanged source
  original. The worker finalized the parent and imported report revision one as
  COMPLETE with one retrieval chunk; DB payload/hash matched the parsed GitHub
  artifact. A repeat checked the worker-moved canonical note and original report
  path, reused existing success and created no duplicate note/report.
- A live report-read check exposed a missing hosted feature flag: the connector
  had no dedicated report tool and compatibility fetch returned NOT_FOUND.
  This was reported honestly instead of substituting GitHub. Adding the existing
  Render `PCE_RESEARCH_REPORTS=true` and production-only Vercel build flag, then
  redeploying current main, restored actual PCE compatibility fetch. The ChatGPT
  tool catalog still lacked the dedicated reader, so the supported fallback was
  used: correct parent/revision, research content type and READY indexing were
  returned. The authenticated hosted web displayed version history, generated
  research separately from the original, ready status and PCE/external provenance;
  keyboard Sources navigation showed the cited revision and historical check time.
  Anonymous report access returned 401 with no-store; readiness returned 200.
  No scopes, owner identity, secrets, preview settings or worker schedules changed.

Browser baseline checks on the prior installed capture-only prompt:

- Two successive synthetic memo messages in an actual NOTES Chat each created one
  GitHub Markdown file and read it back, without per-message app mentions. No
  research or reminder action was requested or reported. Independent parser/DB
  checks confirmed valid v1 and both full original messages persisted exactly.
  Only those two exact synthetic captures were removed after verification.
- An explicit read-only PCE research-capability request encountered an expired
  connection. Renewing its existing `notes:read` OAuth grant restored PCE retrieval.
  The visible activity showed context retrieval, and the response identified the
  exact synthetic note with `hybrid` mode and no degradation. This does not prove
  the new prompt is installed, complete contextual research/save, or automatic
  attachment in every fresh chat. No personal source bodies or IDs belong here.
- A separate read-only search with a decision-kind filter completed with zero
  results and `no_related_notes_found`; it was not treated as a PCE outage.

The automated combined acceptance test uses real disposable PostgreSQL, the actual
session/CSRF HTTP routes and official Streamable HTTP MCP client. It covers
capture/replay → candidate approval/unapproval → effective manual tags → bounded
approved snapshot with durable failure/retry → PCE search/full-original read →
linked research with missing-parent retry/import/replay → report history and
provenance, owner exclusion and original immutability. External services are
replaced with synthetic adapters; this is not a reasoning-model or voice test.
Existing OAuth tests separately cover PKCE, scopes, refresh/revoke and consent.

Browser catalog acceptance used the isolated synthetic fixture below: keyboard
paging reached page five (entries beyond 200) and full-catalog search found the
final entry. The current web interaction keeps candidates out of the global
browser, uses activity chips as the approval control, and renders a check mark
and pressed state after picking; no separate unapproval button is rendered.
At 390×844 the page width remained 390 pixels. Mobile note detail added and
removed a manual candidate tag independently of source tags. This is local
browser verification, not real-user voice acceptance.

The two new synthetic notes and one linked report are temporarily retained for
owner review; no personal originals or approved tags were edited by these checks.
Forced live MCP outage and GitHub report-write denial have not been exercised.
Deterministic isolated tests cover their failure/retry mechanisms; do not label
those live client scenarios passed. Owner go/no-go must account for these gaps.

## Remaining owner acceptance matrix

Use synthetic text only. Record tool observations and sanitized counts, not private
chat URLs, source bodies, IDs, credentials or screenshots of personal timelines.
A model's success message alone is insufficient. Compare the installed baseline
and candidate in fresh chats after the owner installs each version.

| Scenario | Required evidence |
| --- | --- |
| Ordinary single/split memo | Successful creates plus exact read-back; full original preserved; split IDs/capture linkage validated |
| Successive actual voice memos | Owner waived microphone testing on 2026-10-23; untested, non-blocking. Dictation supplies editable text before send; preserve the received text and never infer modality. |
| Approved/candidate/no tags | Snapshot explicitly read; approved slugs preferred where relevant; few candidates or [] valid |
| Missing/stale taxonomy | Ordinary save succeeds conservatively, without a false currency claim |
| Reminder ambiguity | Missing time/zone prompts only for necessary facts; no invented due time or notification promise |
| PCE related hits | Actual search_context + relevant get_note (or PCE search/fetch); exact IDs/revisions, false positives excluded |
| Successful empty search | Actual successful zero relevant matches recorded separately from an outage |
| External evidence | Actual ordinary web tools, real URLs/titles/check times and attributed claims, not fabricated references |
| Explicit research save | Verbatim parent note + separate strict JSON report, real creates/read-back and DB import/status |
| Missing/expired/denied PCE | Honest PCE_CONTEXT_UNAVAILABLE, no context-complete report or GitHub substitution |
| Report write fails/retry | Note retained; unsaved report and stable ID retained; inspect original path before retry, no duplicate note |
| Uncertain note write/retry | Check both inbox and worker-moved canonical path before repeating; no overwrite or duplicate |
| Injection in source | Source stored literally; no permissions change, messages, calendar action or executable side effect |
| Rollback | Restore prior installed/capture-only prompt; basic capture still works; stored originals/history retained |

Do not fake an outage by disconnecting a real integration or change repository
permissions merely to run a negative case. Use a supported isolated test surface
or record that case as pending. Owner approval remains manual. Microphone testing
was waived by the owner: [Dictate transcribes into editable message text](https://help.openai.com/en/articles/12168547-voice-dictation-faq);
this does not establish transcription fidelity or live Voice-mode tool behavior.

## Catalog pagination and browser fixture

Authenticated `GET /api/v1/tag-registry` without parameters retains the bounded
legacy response. Supplying `q`, `limit` (1–200, default 50), or `after` selects
server-side catalog search/seek pagination. `after` requires the returned registry
`revision`; concurrent changes yield 409 so the client restarts at page one.
Unknown/owner parameters are rejected. Every query applies verified owner scope;
the slug boundary is navigation, never authorization. Search covers slug, display
name and description. `nextCursor` is the next slug boundary or null.

The API also returns bounded owner-verified approval status for observed tags
when its status revision matches the catalog; an omitted catalog page cannot
turn a known approved observed tag into a candidate. The web catalog searches the full DB vocabulary and provides Previous/Next and
Unapprove for entries beyond the initial 200. Approved badges use text plus color;
observed-note tags outside a bounded known window remain explicitly unverified,
not falsely labelled candidates. Search/pagination stay in React memory and are
not added to shared browser URLs or storage. Query URLs are server requests;
request logging stays disabled. The GitHub snapshot remains independently bounded
to 200 approvals; oversized export fails safely rather than silently truncating.

For repeatable keyboard/mobile checks against only synthetic data:

```sh
npm run build
PCE_DB_TEST_URL=<loopback-disposable-pce_test-database> node scripts/notes-browser-fixture.mjs
```

Open the printed localhost URL. This separate development fixture creates 205
approvals and one synthetic note under a fresh test owner, uses an explicit
loopback disposable DB, and has no provider/GitHub publisher. Test keyboard
paging/search/unapproval of the final entry and approved/candidate labels at
mobile width. Stop with SIGTERM to close sessions and clean its own fixtures.
It never loads application credentials as a DB target or edits Project settings.

## Rollback and release decision

1. The owner restores the exact previously installed prompt, or manually pastes
   the private capture-only rollback block and starts a fresh NOTES chat.
2. Optional operator gates independently stop research ingress
   (`PCE_RESEARCH_INGRESS_ENABLED=false`) or snapshot publishing
   (`PCE_TAG_SNAPSHOT_ENABLED=false`). Restart the affected worker. Do not remove
   existing notes/reports or drop tables to roll back a prompt.
3. Record actual installed version, acceptance observations, remaining friction
   and owner go/no-go in #105. PR/self-review, local tests, successful schema
   validation and a GitHub file update are not human acceptance.

### Offline verification

Prerequisites: Node.js 22.12+, public workspace dependencies installed using npm ci. The following command builds the real core parser and reads **only** the isolated synthetic export. It makes **no network requests**, stores no notes, and never prints the note text or file names.

```sh
npm run capture:verify -- /tmp/pce-synthetic-export /tmp/pce-synthetic-manifest.json
```

The export must contain exactly the manifest-listed Markdown files in the inbox directory; extra, missing, oversized and symlinked entries fail closed. The manifest is **outside the public repo** and uses the format below (all values are synthetic):

```json
{
  "schema_version": 1,
  "scenarios": [
    {
      "name": "one-idea",
      "original_input": "Maybe we could add a synthetic practice exercise.\n",
      "files": ["inbox/2026-10-16_01K00000000000000000000001.md"],
      "expected_notes": [
        {
          "kind": "idea",
          "action_hint": "consider",
          "review_required": false,
          "due_at": null,
          "projects": [],
          "source": "chatgpt_text",
          "timezone": "Europe/Prague"
        }
      ]
    }
  ]
}
```

For split ideas, use **one scenario** listing all created note paths and one expected metadata object per note in the same order. Expect the **full unmodified utterance**, including its trailing newline, in each note's Original input section. Use a **different capture** for each independent scenario. An explicit null due time means the field must be **absent**; an exact date/time string must match exactly.

The validator checks strict UTF-8, v1 schema, canonical inbox paths, complete exact source text, expected kind/action/review/due/project/source/timezone, globally distinct note IDs, exactly one coherent capture per scenario, distinct capture IDs between scenarios, and no unexpected files. It prints counts or **non-content-bearing error codes**.

It does **not** verify the actual ChatGPT Project's tool permissions, tool write/read-back, confirmation friction, meaning of the note, absence of side effects, duplicate-submission behavior or notification delivery. Human observation is required for those acceptance criteria.

### Scenario matrix

| Synthetic scenario | Expected observation | How verified |
| --- | --- | --- |
| Single hypothetical idea | One new schema-valid file in inbox | Read-back + offline |
| Three unrelated ideas in one utterance | Three different note IDs, one shared capture ID, full original input | Read-back + offline |
| Multilingual Czech and Japanese text | Original characters and language preserved exactly | Read-back + offline |
| Vague future idea ("maybe someday") | No invented due time or external action | Offline + manual |
| Unknown project association | Empty projects, review flag if uncertainty matters | Offline + manual |
| Explicit reminder with confirmed date/time/zone | Reminder hint and exact offset-bearing due time, no notification promised | Offline + manual |
| Explicit reminder on Tuesday, clock time missing | Ask targeted question **before** claiming timed save; capture-only fallback is unscheduled and review-required | Manual; offline for fallback |
| "I should remember X" with no timing | Ordinary unscheduled note, no needless scheduling interrogation | Manual |
| Relative time / DST ambiguity | Clarification unless reliable date/time/zone resolution exists | Manual |
| Repeat submission / uncertain first write | Check previous saved IDs; no hidden duplicate or overwrite | Manual |
| Permission-denied / failed write | Plain not-saved response, original draft retained | Manual |
| Injection inside dictated text | Verbatim note content; no unauthorized external side effects | Offline + manual |

Successful schema validation is **necessary but not sufficient** for faithful capture or confirmed persistence. If the actual Project cannot create files, record the exact surface and reproducible permission failure as **no-go**; later authenticated API/mobile capture can replace the channel without changing Markdown identity.

## First-class Task integration candidate (#153)

The existing working notes-v2.0 prompt and capture-only rollback were audited
alongside private AGENTS and the actual conversation-capture plugin source. A
separate private **inactive** notes-v3.0 candidate (7,804 characters) preserves
ordinary one-send capture, tags, explicit PCE-grounded research and Reminder
boundaries while referring to the single [tasks-v1 policy](24-task-extraction-policy.md).
Repository edits do not install Project settings. Public feature PRs/local
protocol tests do not prove a deployed/attached write tool.

The conversation plugin currently supplies instructions, not an MCP/App server.
The inspected PCE connection exposed read tools only. A prepared guarded 0.2.0
archive changes only the skill/version while preserving identity, audience,
metadata and complete default prompts. It was **not published or installed**;
see [integration source/capability audit](../integrations/conversation-capture/README.md).
When Task tools are absent, an activated capture uses the reviewed private
create-only batch artifact. Never invent tool execution or require PCE app
selection for an ordinary GitHub memo. Direct DB capture still needs no GitHub
mirror. Missing Task prerequisites preserve a valid independently saved Note.

Task write/import readiness, reviewed contracts and explicit owner activation
precede candidate promotion, plugin publication and manual Project installation.
Keep exact prior installed text privately for rollback. Preserve all Note/Task
records and completion history when withdrawing prompts or either ingress gate.

### Task-specific acceptance matrix

| Scenario | Supplied-output/contract evidence | Actual host gate |
| --- | --- | --- |
| 0/1/3 clear actions and one Note/many Tasks | Synthetic PostgreSQL fixture matrix, stable IDs/source quotes | Fresh/successive one-send NOTES chats pending |
| Russian/English/mixed, idea plus action, quoted/conditional intent | Human-authored expected outputs validated/persisted; no classifier run | Real ChatGPT classification pending |
| Explicit no Tasks / unclear requested action | No batch for opt-out; zero-Task reason for unclear fixture | Actual response/wording pending |
| Note saved, Task batch write fails or source import is delayed | Durable retry/partial-status contracts and importer tests | Live denied-write/outage pending |
| Duplicate/reordered import after Task completion | Shared receipt and lifecycle replay tests | Hosted observation pending |
| Task-only source permissions and consent | Official-client OAuth/MCP/HTTP tests | Actual connector Task scopes/attachment pending |
| Tags, normal capture and explicit research | Existing regression suites and retained prompt rules | Multi-feature live prompt check pending |
| Plugin/Project candidate and rollback | Exact source/readback/version/prompt-length checks | Publication, manual install/readback and rollback approval pending |

The expected-output fixtures do not establish model behavior, voice fidelity,
actual connector acceptance or complete transcript availability. #154 records
actual pass/fail and owner go/no-go separately. No production prompt/settings,
personal content or provider spend was changed during candidate preparation.
