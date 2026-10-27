# Conversation-capture Task integration (#153)

## Activated checkpoint (2026-10-26)

The owner approved final activation after the implementation stack deployed.
The existing private plugin is now **0.2.0**, with guarded publication and exact
source/version/preservation readback. The live NOTES Project has the reviewed
**notes-v3.0** block installed and verified after reload. Actual NOTES captures
persisted 0 and 3 Tasks; a fresh selected-plugin Brief capture persisted 1 Task.
The hosted Task API/web and trusted local Task importer are enabled. Fresh
ChatGPT/native Task scopes and actual Task retrieval were verified. See the
[live evidence and remaining device limits](../../docs/evidence/issue-154/2026-10-26-activation.md).
The sections below describe the earlier preparation checkpoint, not current
installation status. The plugin remains instructions-only and retains its
identity, private audience, default prompts and GitHub fallback.

This directory owns the review source for the existing conversation-capture
plugin's changed skill. It does not install a plugin, change Project settings,
connect a server, grant scopes or capture this engineering conversation.

## Inspected current surface (2026-10-25)

The owned private personal plugin is version 0.1.0 with one conversation-capture
skill and portable/compatibility manifests. Its source inventory contains no
MCP server or App connection. It uses separately connected GitHub tools. In the
inspected chat, the PCE connection exposed `search_context` / `get_note` reads;
no Task write tool was attached. A skills-only plugin cannot add a backend tool
or infer access to other chats. The scoped Task tools in #150 are independently
gated server code, not proof of hosted attachment or consent.

The candidate skill preserves Brief/Full/Specific, supplied-text coverage,
private visibility, faithful Markdown, canonical-path readback and current
research/tag rules. After separately verified owner activation it uses the
single public [tasks-v1 policy](../../docs/24-task-extraction-policy.md) for
0..N clear user commitments, with no per-task approval and no external execution.
It falls back to the reviewed private create-only Task batch path when direct
Task tools are absent. Missing Task prerequisites must not block a valid Note.

## Prepared release and activation

The local 0.2.0 candidate archive contains the changed skill plus the inspected
root/compatibility manifests with version bumped in both. Identity, full
presentation/default prompts, metadata, scope/audience and existing declarations
are preserved; no private author/account metadata is committed to this public
repository. Archive inventory/content and exact preservation checks were run.
The actual plugin remains at 0.1.0; its cache was not edited.

Plugin Creator's available update operation publishes a new current release;
it has no draft-only save in this session. The archive is prepared privately for
review, not uploaded. Before an explicitly approved publication, freshly read
current source and compare its release ID to the recorded candidate base. If it
changed, reconcile and rebuild; never bypass the expected-release guard. After
an approved update, read back source/version and test actual host capture.

The private repository has a separate inactive notes-v3.0 candidate, 7,804
characters, while its working notes-v2.0 and rollback remain unchanged. Review
public/private PRs, deploy/verify Task write/import readiness, obtain fresh
scope consent where needed and explicit owner activation before promoting or
installing. No production prompt mutation is performed by source preparation.

## Verification limits

[Expected-output fixtures](../../test/fixtures/task-policy-v1.json) cover English,
Russian, mixed language, 0/1/3 Tasks, speculative/conditional/reported content,
assistant suggestions, quoted injection, explicit no-Task opt-out and unclear
requested intent. PostgreSQL tests preserve one original and the exact supplied
Task identities through API/GitHub replay and completion. These fixtures encode
human-authored expected model decisions; **no LLM was run**. Live classification,
one-send tool selection, voice, actual prompt installation/plugin publication
and device acceptance remain the #153/#154 release gate.
