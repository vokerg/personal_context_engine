# 14 — OpenAI project and credential groundwork

**Implemented scope (#58):** configuration diagnostics and this provisioning
runbook. **Not implemented:** chunk/vector storage (#46), embedding jobs and
budget enforcement (#47), or hybrid search (#48). GitHub capture, deterministic
ingestion and repository search remain unchanged. Creating an API key does
not activate embeddings or authorize sending private notes to a provider.

## Account and project setup

Use the OpenAI API Platform account, not ChatGPT subscription settings. Inspect
organization Billing overview for available API credit and whether auto-reload
is on. Check credit grants/expiration and usage when planning sustained use;
a historical purchase does not prove credit remains. Report actual balances
privately to the operator, never in public issues, commits or screenshots.
This task does not purchase credits, enable auto-reload, or change billing.

Create a dedicated **Personal Context Engine** development project. Keep other
applications and future production environments separate rather than sharing
one global key. The content repository is data-only and needs no OpenAI key.
Keys and project/account IDs belong in trusted local or deployment secret
storage, not the public code or private Markdown repository.

Prepare a user-owned local-development key named `pce-local-dev`, with an
explicit 30-day expiration. Select Restricted permissions, allow **List models:
Read** and **Model capabilities → Embeddings: Request**, and leave other
endpoint permissions at None. Model reads support the metadata diagnostic;
embedding access is provisioned for later work, not invoked by this setup.
Review the effective permissions in the actual current dashboard. Issuing a
credential requires the operator's confirmation when browser policy requires
it; do not save keys or screenshot one-time secrets before that approval.
For unattended hosting later, provision a separately scoped runtime identity
and credential under an explicitly reviewed deployment plan.

After creation, save the one-time secret directly into the local `.env` without
printing it, putting it in a command argument/shell history, or copying it into
an issue. Restrict the file to mode `0600` and verify `git check-ignore .env`.
If an unexpected existing key is present, preserve it until an explicit rotation
is selected. Dismiss the one-time-secret display after successful storage.

## Local environment

The engine has one ignored root `.env`; the content checkout has none:

```dotenv
PCE_EMBEDDINGS_ENABLED=false
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_PROJECT_ID=proj_your_project_id
OPENAI_API_KEY=replace_with_project_scoped_secret_only_locally
```

`OPENAI_PROJECT_ID` is a routing identifier, not an authentication secret;
`OPENAI_API_KEY` is the secret. Both stay out of examples containing real
account data. Never prefix provider secrets with `VITE_` or `EXPO_PUBLIC_`.
Only a future server-side embedding adapter should receive this key. Existing
clients, MCP arguments and capture agents must never receive it.

The flag and model name currently express the disabled setup boundary. No
embedding worker reads them to process jobs yet. The diagnostic rejects
premature `PCE_EMBEDDINGS_ENABLED=true` rather than implying a working runtime.
Changing a flag alone cannot implement #46/#47 or approve private-text egress.

## Verification without embedding text

From the engine repository:

```bash
npm run openai:check
npm run openai:check -- --live
```

The first command loads local `.env` and checks configuration **offline**. It
does not authenticate or prove key permissions. The explicit `--live` command
makes one authenticated **GET** to the official model metadata endpoint for
`text-embedding-3-small`, using the configured project header and a 15-second
timeout. It disables redirects, never reads note files, and never sends an
embedding, generation, or balance request. Success confirms metadata access,
not embedding-request permissions, available credit or vector output shape.
The diagnostic returns fixed codes, never credentials or provider error bodies.

Common outcomes:

| Code | Operator action |
| --- | --- |
| `LOCAL_CONFIG_READY` | Offline config is present; use explicit live check if needed |
| `API_KEY_REQUIRED` / `PROJECT_ID_REQUIRED` | Fill the local ignored environment |
| `MODEL_METADATA_ACCESS_VERIFIED` | Metadata request succeeded; embeddings remain disabled |
| `AUTHENTICATION_FAILED` | Check expired/revoked/wrong key; do not print it |
| `MODEL_ACCESS_DENIED` | Check the key's List models permission and project access |
| `MODEL_NOT_AVAILABLE` | Check account/project access and the selected model |
| `RATE_OR_QUOTA_LIMIT` | Inspect account limits/usage/billing in the dashboard |
| `NETWORK_OR_PROVIDER_ERROR` | Check connectivity/status; no private data was sent |
| `EMBEDDING_RUNTIME_NOT_IMPLEMENTED` | Keep the flag false; implement and review #46/#47 first |

Tests inject fake HTTP responses and synthetic keys. Public CI never needs
real OpenAI credentials or provider access. Do not add an admin key or a billing
API dependency merely to check the balance; use the authenticated dashboard.

## Costs, limits and future activation gate

As checked on 2026-10-17, the planned model is `text-embedding-3-small`; its
published standard input price is **$0.02 per million tokens**. Recheck official
pricing before budgeting. No embedding request is made by this groundwork.
Organization/project spend alerts and hard spend limits are distinct controls;
inspect the configured dashboard setting rather than treating an alert as a
hard cap. No new monetary limit is silently configured or claimed here.

Before #47 sends any private chunks, review the selected text/retention/region
policy and obtain explicit egress approval; implement bounded token/batch
sizes, per-run/per-owner budgets, retry/concurrency limits and usage accounting.
Capture must remain successful during key, quota, billing or model outages.
A future synthetic embedding smoke test must be separately explicit about the
payload and maximum spend. A funded account is not proof of model readiness.

## Rotation and revocation

Record the key name and expiration in trusted operator records; do not record
its value in the runbook. Before expiry, prepare a replacement with the same
narrow permissions, update the trusted environment, verify metadata access,
then revoke the old key through the dashboard. Recheck actual runtime behavior
before claiming a successful rotation. Revoke immediately if a credential is
exposed, and inspect usage. Stopping embedding work must not stop note capture.

## Official references

- [API authentication and project routing](https://developers.openai.com/api/reference/overview)
- [Production key management and separate projects](https://developers.openai.com/api/docs/guides/production-best-practices)
- [Planned embedding model and pricing](https://developers.openai.com/api/docs/models/text-embedding-3-small)
- [Spend alerts and hard limits](https://developers.openai.com/api/docs/guides/spend-limits)
- [Embedding API guidance](https://developers.openai.com/api/docs/guides/embeddings)
