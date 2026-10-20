# Documentation index

This documentation is the **architecture baseline and project bible** for Personal Context Engine. It distinguishes decisions from implementation. It describes the system intended to be built; do not interpret a described flow as proof that it is running.

## Reading order

| Document | Scope |
| --- | --- |
| [01 — Vision](01-vision.md) | Product promise, principles, success measures, boundaries |
| [02 — Architecture](02-architecture.md) | Components, trust boundaries, data flows, replaceable adapters |
| [03 — Repositories and operations](03-repositories-and-operations.md) | Public/private split, workspaces, local dev, CI/CD |
| [04 — Capture contract](04-capture-contract.md) | Voice transcription, splitting, frontmatter v1, examples |
| [05 — Ingestion](05-ingestion.md) | Worker, states, idempotency, retry, reconciliation |
| [06 — Domain and taxonomy](06-domain-and-taxonomy.md) | Capture/Note/Task/Reminder, controlled vocabularies |
| [07 — Ledgers](07-ledgers.md) | Daily/weekly/monthly/project summaries, provenance, recalculation |
| [08 — Clients and notifications](08-clients-and-notifications.md) | React web, Expo mobile, push workflow |
| [09 — Security and privacy](09-security-and-privacy.md) | Data minimization, private repo, auditability, credentials |
| [10 — Roadmap](10-roadmap.md) | Vertical slices, acceptance gates and deferred features |
| [11 — Decisions](11-decisions.md) | Accepted, proposed, deferred, open questions |
| [12 — ChatGPT Project](12-chatgpt-project.md) | Current repo-based capture/search, future MCP boundary |
| [13 — Evolution plan](13-evolution-plan.md) | Progressive dual-store capture, embeddings, token MCP, gated DB search, UX rollout |
| [14 — OpenAI setup](14-openai-setup.md) | Project/key provisioning, disabled configuration and safe metadata diagnostics |
| [15 — Database recovery](15-database-recovery.md) | Optional synthetic restore drill and deferred backup policy (D-020) |
| [Project intent](../INTENT.md) | Concise direction and explicit constraints for future contributors |

## Authority and change management

1. Running code and tests (when they exist) describe current runtime behavior.
2. Versioned wire schemas and validators (when implemented) describe executable contracts.
3. These specifications express intended constraints and design.
4. The [decision register](11-decisions.md) records which choices are settled; later changes require an explicit update.
5. Prompt templates and examples never override authorization, privacy or data-loss safeguards.

Where a contract remains proposed, implement a test-backed specification before declaring it stable. If docs disagree with running behavior, report the discrepancy and update both rather than quietly choosing one.

## Documentation conventions

- All maintained project documentation and metadata keys are in English. User-entered content stays in its original language unless explicitly requested otherwise.
- Examples use **synthetic** names, IDs and data only.
- Distinguish `captured_at` from `occurred_at` and `due_at`. Timestamps should include UTC offsets; projections normalize to UTC while retaining the user's IANA timezone.
- Use RFC 2119-style MUST/SHOULD language for guarantees and write down exceptions.
- Prefer small adapter contracts and domain invariants to speculative infrastructure.

- [16 — Embedding storage and deterministic chunking](16-embedding-storage.md) — #46 migration, isolation, limits and rollback.

- [17 — Gated DB search](17-search.md) — local search, owner isolation, fallback, budgets and rollback.

- [18 — Optional MCP and same-login OAuth](18-mcp.md) — gated local protocol, consent and deployment verification boundaries.

- [19 — Vercel web and Render API](19-hosted-deployment.md) — main-only hosted setup, same-origin proxy, secrets and verification.
