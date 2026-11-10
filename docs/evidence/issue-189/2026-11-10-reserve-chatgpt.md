# Reserve MCP ChatGPT acceptance — 2026-11-10

Refs #189, #49 and #50. This records a bounded owner-authorized synthetic
browser test, not default capture/retrieval cutover or general availability.
Live identifiers, private chat links, service URLs and corpus diagnostics are
intentionally excluded from this public evidence.

## Four-chat test

Four separate ordinary ChatGPT chats exercised a fictional project: an original
Note, supplied synthetic research text, three independent Tasks, and a question
requiring cross-chat retrieval. The corrected requests explicitly selected
**PCE GCP Reserve MCP**. This was not a clean NOTES 2 or dictation test.

| Surface | Observed result |
| --- | --- |
| Original Note | `capture_note` returned `DB_PERSISTED`; `get_note` returned the supplied original, title and tags |
| Research-text Note | Initial reserve calls returned `UNAVAILABLE` twice and read-back returned `NOT_FOUND`; explicitly supplied valid Markdown v1 with the same IDs/key then returned `DB_PERSISTED` and successful read-back |
| Independent Tasks | Duplicate search found no existing matches; three records were created and individually read back as `OPEN`, revision 1, without dates/reminders or source links |
| Final retrieval | After research capture recovery, the fourth chat found both Notes through both search interfaces using project name and codeword, read originals, and verified all three Tasks; the answer reproduced the fictional comparison values with source IDs |

The reviewing agent checked the chats oldest to newest, independently read both
Notes and searched the three Tasks through reserve MCP, and confirmed both Notes
in lexical search. These are authenticated application-level readbacks, not a
new direct SQL inspection of receipts/jobs. `PENDING` indexing in capture receipts
did not prevent subsequent lexical retrieval. No semantic-index completion is
claimed. The successful capture responses reported `replayed: false`; this run
does not independently establish successful replay after an ambiguous timeout.

All five records were persisted directly through the authenticated API/MCP into
PostgreSQL. No GitHub content write, export, acquisition or importer participated
in these test captures or retrievals. No background process was started locally.
Synthetic records were retained; no cleanup or external Task execution occurred.

## Failures and recovery boundaries

The first requests mistakenly selected the older **Personal Context Engine**
read/Task integration. Its catalog omitted `capture_note`, and its Task/retrieval
requests stopped at an expired-connection prompt. Selecting the reserve plugin
resolved that mismatch. The owner subsequently explicitly requested removal of
the obsolete read/Task plugin; Plugin Management reported it uninstalled.
This was not removal of **PCE Conversation Capture**, deletion of records, or a
change to the existing NOTES Project/GitHub fallback.

Source inspection shows the MCP capture handler maps all repository exceptions
to `UNAVAILABLE`, including potential validation/conflict failures. Valid
Markdown resolved the observed research-text failure, but the exact initial
rejected-payload cause was not isolated. Do not interpret `UNAVAILABLE` alone as
proof of an outage. Track content-free actionable errors and discoverable
Markdown guidance in [#195](https://github.com/vokerg/personal_context_engine/issues/195).

The research fixture was supplied invented text stored as an ordinary
`kind: reference` Note. No actual research synthesis or separate versioned
`ResearchReport` creation was tested. The MCP catalog exposes report retrieval,
not report creation; Note capture must not be reported as report persistence.

## NOTES 2 setup

After these tests, the owner requested a new NOTES 2 Project with only a concise
recommendation to use available MCP tools. The empty Project was created with
no imported chats or added source files. Saved settings were reopened and the
following instruction was verified:

> Prefer available PCE MCP tools to save and retrieve my notes. Confirm a save only after a successful tool result; otherwise say UNSAVED. Keep replies brief.

The instruction contains no repository reference or GitHub workflow. The memory
selector reported global memory off at creation; saved Project settings show
the default memory mode and Library access enabled. No claim of enforced
Project-only isolation or disabled account Library access is made. No test
message was sent during setup; subsequent baseline testing is recorded below.

## Remaining acceptance

Keep #189 open: unified plugin instructions, NOTES 2 one-send capture
without mandatory mentions/tool selection, normal dictation, successive-message
behavior, refresh/revocation and failure recovery remain separate checks.
Existing official-client/server-side acceptance in the GCP runbook must not be
conflated with this browser run. No authorization for default cutover follows
from these results. Existing NOTES and optional private GitHub capture remain
available independently.


## Subsequent NOTES 2 baseline — capture failed

With the short saved instruction unchanged, three automatic capture attempts
(plain English, a successive message in the same chat, and a Russian explicit
save request in a fresh chat) reported `UNSAVED`/service unavailable. Independent
reserve MCP lexical searches for the synthetic project and each marker found
no matching Notes. A diagnostic follow-up in the Russian chat reported two
identical `capture_note` calls whose `notes` array contained plain prose, not
Markdown v1; the reported tool error was `UNAVAILABLE`. This is model-reported
call detail, not direct inspection of server logs.

A separate fresh-chat question automatically used saved-note retrieval and
returned the earlier synthetic design Note's correct values and source ID,
while reporting no saved records for the new fixture. No mention or manual
tool selection was used. Automatic selection/retrieval therefore worked;
ordinary capture preparation failed. Dictation was not tested. #195 now owns
a self-described plain-text MCP input with server-owned formatting and
actionable errors; the baseline must not be relabeled a capture pass.
