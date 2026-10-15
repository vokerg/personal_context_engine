# 10 — Delivery roadmap and acceptance gates

**Delivery principle:** implement thin end-to-end slices. Validate the risk in ChatGPT-to-private-GitHub capture before investing in a full UI and automated intelligence stack. Stages describe intent, **not completed milestones**.

## Phase 0 — Foundation and privacy

- [ ] Make content repository **Private** and verify permissions.
- [ ] Publish the architecture baseline, agent instructions, contracts and public docs-only CI.
- [ ] Add synthetic capture examples and enforce a versioned validator.
- [ ] Agree on content repo `AGENTS.md` and ChatGPT Project instructions.
- [ ] Define and test a safe way to obtain truly unique note IDs.

**Gate:** no personal data exists in any public repo, fixture or CI artifact; schemas are understandable enough to implement independently.

## Phase 1 — Proof of capture

- [ ] Connect a ChatGPT Project to the private content repository.
- [ ] Validate that the selected ChatGPT surface can **write**, not merely search/read.
- [ ] Speak several single-note and multi-idea messages; verify each resulting file.
- [ ] Check faithful original transcript, no invented deadlines, controlled tags and stable IDs.
- [ ] Detect failures explicitly; no false claims that a write succeeded.

**Gate:** routine captures can be saved with acceptable user friction, no dropped ideas and no misleading save confirmations.

## Phase 2 — Deterministic ingestion

- [ ] Implement schema v1 parser and test fixtures in shared packages.
- [ ] Add PostgreSQL/Prisma schema with note, capture, source revision and processing attempt fields.
- [ ] Implement GitHub content storage adapter and worker ingestion from `inbox/`.
- [ ] Implement idempotency, crash recovery, reconciliation, rejection and finalization into `notes/YYYY/MM/`.
- [ ] Add synthetic failure-injection integration tests.

**Gate:** repeated runs and interrupted imports preserve data and never create duplicate notes or action candidates.

## Phase 3 — First usable intelligence

- [ ] Implement authenticated read API and basic search/query projections.
- [ ] Produce deterministic daily ledger with source-note links.
- [ ] Try manual ChatGPT summaries using bounded, relevant evidence.
- [ ] Add weekly/monthly ledger generation and explicit stale/regeneration behavior.

**Gate:** a user can browse records and inspect an auditable ledger without consulting raw Git manually.

## Phase 4 — Web and mobile

- [ ] Add React/Vite web timeline, search, project/type filters and note details.
- [ ] Add React Native/Expo login, timeline and note details.
- [ ] Add explicit reminder creation/acceptance semantics and server scheduler.
- [ ] Implement device registration, push delivery attempts, deep links and user control.

**Gate:** actual-device mobile push works best-effort for authorized reminders; retries do not spam.

## Phase 5 — Expansion (later)

- Mobile voice/text capture through API.
- Per-project ledgers, semantic link discovery and user-review workflows.
- Automated LLM provider adapters and scheduled summaries with budgets.
- Rich editing, bidirectional storage sync, offline experiences and context packages for other agents.
- Additional execution integrations under deliberate approval policies.

## Validation principles

- Unit-test domain transitions; contract-test API and validators.
- Integration-test worker with synthetic Git/DB fixtures and fault injection.
- Test private content permission behavior in a separate trusted environment, not public CI.
- Verify dates, timezones, DST, concurrency, crash recovery and duplicated side effects.
- Require user approval for merging; keep design documentation aligned with each implemented phase.

## Definition of done for any phase

Features have validated contracts, tests or documented manual evidence, operational failure behavior, security review, readable docs and clear "implemented vs proposed" status. Explicitly report what remains open. Do not fake completeness with a diagram or README.
