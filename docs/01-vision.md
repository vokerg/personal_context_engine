# 01 — Product vision and principles

## North star

**Capture freely. Preserve the original. Structure carefully. Surface when relevant. Act deliberately.**

Personal Context Engine (PCE) provides an extensible memory and intelligence layer for a person. Its entry points initially include a ChatGPT Project with voice dictation, but the engine must remain useful without ChatGPT, without GitHub, and without a particular LLM model.

## Intended evolution

1. **Capture / external memory:** accept free-form thoughts, tasks, project ideas, personal memos, decisions, references and reminders.
2. **Context / intelligence:** classify, connect, search and aggregate records into daily, weekly, monthly and per-project ledgers.
3. **Agency / execution:** surface relevant information at the right time and eventually perform bounded, authorized actions with external systems.

Only the first level and the foundation of the second are MVP goals. The third is explicitly deferred.

## Core design invariants

- **Lossless source:** preserve original user text or transcription, even if a generated summary or classification is wrong. A transcript is not the same as retained raw audio.
- **Capture without organization burden:** a user should not need to pick a category, project or tag before speaking.
- **Multiple ideas per utterance:** one capture may produce many distinct notes, tied back to their common origin.
- **Separation of concerns:** content repository, public mechanism, relational projections, LLM processing and application clients have independent lifecycles.
- **Recoverable processing:** no error, rerun, provider outage or partial Git operation should silently lose the original input.
- **Inspectable intelligence:** inferred facts, actions and ledgers retain provenance; uncertain interpretations are marked as such.
- **Human authority:** a model's suggestion is never a blanket authorization to send a message, change external projects, or create consequential actions.
- **Portable sources:** Markdown plus versioned metadata can be exported and reprocessed without a proprietary chat history.
- **Privacy by design:** avoid collecting unnecessary sensitive content, exposing it in public CI, or treating a public repository as private.

## Primary use cases

- "Remember this thought" without requiring a follow-up process.
- Convert an utterance with unrelated ideas into independent, linkable notes.
- Extract a potential task but distinguish **maybe someday** from an explicit reminder.
- Find notes by date, project, type, tags and full text.
- Review "what happened today/this week/this month" with links to underlying notes.
- Receive opt-in reminders and view open loops on mobile.
- Eventually capture new notes through the mobile app and assemble project-specific context for development agents.

## Non-goals for the initial release

- Always-on surveillance or continuous ambient recording.
- A fully autonomous agent that operates on external accounts without approval policy.
- A complete productivity suite with scheduling, delegation and team workflows.
- Automatic interpretation of speculative thoughts as definite commitments.
- Bidirectional GitHub/PostgreSQL editing before conflict-resolution rules are designed.
- Requiring a vector database, microservices, message broker or a proprietary file format.

## Product quality signals

- High percentage of successful one-interaction captures into durable content.
- No lost source records across retries or malformed LLM output.
- Accurate separation of multiple notes from one capture.
- Low false-positive rate for inferred actionable commitments.
- Notes and ledgers remain searchable, attributable and recoverable after changing an LLM provider.
- Notifications are relevant, permissioned and not duplicated.

These are direction-setting measures, not claimed current metrics.

## Approved next-stage intent (2026-10-16)

Do not interrupt the working low-friction ChatGPT -> private GitHub capture workflow. Increase the value of accumulated notes through accessible reading, searchable context, auditable ledgers and interactive agent tools. The near-term product promise is **capture once, preserve originals, organize/search later**. Neither paid LLM services nor semantic indexing are prerequisites for accepting a note.

Plan a second, authenticated capture path that eventually persists into both PostgreSQL and the private content repository with recoverable eventual synchronization. Maintain current GitHub search until a user-approved opt-in switch; build DB text+semantic search in parallel. Focus on a usable web timeline and clickable tags observed in real captures. No mandatory curated taxonomy yet; multi-user isolation and security must be designed before offering new API/MCP write tools. See [intent](../INTENT.md) and [evolution plan](13-evolution-plan.md).
