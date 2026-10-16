# PCE — Current product and delivery intent

**Recorded:** 2026-10-16. **Status:** accepted direction, not a statement that the future backend is deployed.
**Implementation epic:** [#42](https://github.com/vokerg/personal_context_engine/issues/42). Details: [docs/13-evolution-plan.md](docs/13-evolution-plan.md).

## What the product is for

Make casual conversation and voice notes into durable personal context that can be **found, inspected, summarized and acted upon deliberately**. ChatGPT is an initial reasoning and capture surface, not the database or sole identity provider. The user should not need to remember which date, tag or exact phrasing was used.

## What must keep working right now

- ChatGPT's existing private-GitHub note capture, and **repository-based search/read**. The current prompt/connector is the user's usable front door. Do not force migration for new features.
- The Markdown v1 original/provenance contract and the GitHub -> worker -> PostgreSQL ingestion path, with strict validation, idempotence and recoverability.
- Safe local owner-aware browsing where explicitly opted in. Do not equate it with production authentication, hosted scheduling or notification delivery.

## What we are building, additively

1. **Reliable ingestion and ownership:** ensure captured Markdown eventually appears in PostgreSQL and is visible to its owner, not other users.
2. **Two-path, two-destination capture:** a future authenticated API/MCP channel can accept the same versioned notes, commit them durably to PostgreSQL, and replicate canonical Markdown to the private GitHub repo through an outbox and retry/reconciliation. The existing repo-origin path remains supported. No fragile two-request client write.
3. **Semantic retrieval infrastructure:** versioned note chunks and pgvector; a separate optional OpenAI `text-embedding-3-small` worker with bounded usage and a replaceable provider contract; lexical + semantic hybrid search restricted by verified owner. Capture works even without embeddings.
4. **Authenticated MCP tools:** user-scoped tokens authorized by the PCE app, no raw DB or provider credentials in clients. ChatGPT can invoke capture, read and later retrieval/ledger tools. **DB search is feature-gated** until proven and intentionally enabled; current ChatGPT searching remains via GitHub.
5. **Useful UI:** readable chronological note browsing, original text, search and filters, clickable *observed* tag catalog/chips and tag usage counts. A standardized tag taxonomy will be considered later, not silently enforced now.
6. **Context/ledgers:** deterministic source-backed evidence packs; ChatGPT initially synthesizes explanations interactively. DeepSeek or unattended LLM-provider choice is **deferred**. Notifications and true mobile push are later independent milestones.

## Non-negotiables

- Preserve originals, timestamps with offsets and stable capture/note identity. Separate capture success from downstream index, export or notification status.
- Two stores cannot share one ACID transaction. Distinguish DB-persisted from GitHub-exported and reconcile failed/duplicate/changed writes. Do not declare all destinations successful until confirmed.
- No leakage across user accounts; derive owner from verified token, not untrusted fields, prompts, tag names or MCP arguments.
- Never put private content or runtime secrets into public code CI. Sending private text to external embeddings is a documented opt-in processing choice.
- Search and model outputs must quote or cite source-note IDs and must not reinterpret speculation as fact. Tags/action hints are advisory, not external execution permissions.
- Make new retrieval and capture routes optional until tested; keep an obvious fallback to GitHub and a reversible migration plan.

## What is *not* agreed

Switching all editing authority to PostgreSQL; turning off the content repo; switching ChatGPT search to the new DB engine by default; launching a dedicated hosted LLM worker or choosing DeepSeek; implementing fixed/default tags; immediate production OAuth/provider deployment.

Follow [the issue order and validation gates](docs/13-evolution-plan.md#delivery-order-and-gates) before changing any of these.
