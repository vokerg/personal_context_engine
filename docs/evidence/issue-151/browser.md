# #151 synthetic browser verification — 2026-10-25

A dedicated loopback Fastify/Vite fixture used an explicit disposable PostgreSQL
16/pgvector database, a unique synthetic owner and one original Note supporting
three Tasks. No private corpus, hosted service, provider request, real content
migration, prompt change or production setting was used. The isolated Vite
fixture disabled configuration-file/env discovery after an initial fixture had
inherited the configured checkout's Note search flag; that first source-detail
check reached the absent search endpoint and was not counted as passed.

Observed in Chrome after isolation:

- Desktop dark palette: Tasks navigation, three Open checkboxes, dedicated search,
  Completed/All, detail layout, source capture versus Task creation timestamps.
- Complete “Buy filters”: server-confirmed notice, two remaining Open Tasks,
  keyboard focus on the list heading, retained single Completed Task.
- Select Completed Task: description, original evidence and CREATED/COMPLETED
  history visible. Reopen produces OPEN and a REOPENED history event.
- Open source Note: original “Buy filters; email the landlord; check the invoice.”
  remains readable and active. Return to Tasks preserves selection.
- 390 × 844 viewport: stacked columns, visible status/search controls and Task
  checkboxes, no observed horizontal layout overflow. Temporary viewport reset.

The fixture's synthetic records/sessions were removed and its servers stopped.
Typed-client component tests separately verify duplicate taps, search/pagination,
409 reload, 401/403/404, unknown transport outcomes and stable creation/command
retries. Full suite/check outcomes are recorded in the PR.

Not performed: actual system-light browser observation, VoiceOver/assistive
technology, production auth, live hosted user-note writes or cross-surface
ChatGPT/iOS acceptance. Shared palette CSS supplies light/dark styles; the final
release/device/accessibility matrix remains #154.
