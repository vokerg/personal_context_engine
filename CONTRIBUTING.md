# Contributing — issue-first workflow

Personal Context Engine uses GitHub Issues as the source of truth for engineering work; do not maintain a duplicate Markdown task backlog. See [AGENTS.md](AGENTS.md) for architecture, agent scope and privacy constraints.

## Before implementation

1. **Find or create an issue.** Non-trivial code, schema, infrastructure or architectural changes require an open issue. Use the [implementation task template](.github/ISSUE_TEMPLATE/implementation.yml) or [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). Trivial typo/link repairs may omit an issue if explained in the PR.
2. **Make it agent-ready.** The issue must identify the objective and observable outcome, dependency issues/PRs and blocking decisions, in-scope and out-of-scope paths or area ownership, acceptance criteria, a concrete verification plan, and any privacy/security constraints. Small enough to deliver and review in one PR; split broad work first.
3. **Resolve uncertainty explicitly.** Do not silently decide auth, privacy, data-loss behavior or public/private repo boundaries. Put unresolved decisions in the issue and mark it blocked until an authorized owner resolves them.
4. **Check upstream state.** Start from up-to-date `main` once dependencies are merged. For an explicit unmerged dependency, either wait or make a clearly labeled *stacked PR* based on and targeting its branch; do not merge or rewrite someone else's PR to unblock yourself.

## Status progression

| Status | Evidence in GitHub |
| --- | --- |
| Backlog | Issue exists; scope or dependencies may be incomplete. |
| Ready | Issue is agent-ready and unblocked, with acceptance/verification specified. |
| In progress | Contributor takes ownership in the issue conversation (or assignee), creates `type/issue-N-short-description` branch and starts scoped work. |
| PR / review | PR links the issue, describes validation and risks; CI and reviewers examine the diff. |
| Done | Human-approved PR is merged, linked issue closes, and remaining work becomes separate issues. |
| Blocked | Issue/PR comment records blocker, owner and next action; do not misrepresent partial implementation as completed. |

Labels or a GitHub Projects board are optional. Keep status traceable using issues, PRs, assignees and comments without relying on additional services.

## Branch, PR and review

- Use **one issue → one branch → one reviewable PR**. Avoid unrelated refactoring and unrelated file ownership changes.
- Complete the [PR template](.github/pull_request_template.md). Use `Closes #N` when the PR resolves issue N; for partially scoped or stacked work that must not close it yet, use `Refs #N` and state what remains. Keep PR base correct; retarget stacked PRs to `main` once their dependency lands.
- Report commands actually run and outcomes, including failures or unavailable checks; never label unexecuted tests as passed. Add/update tests and docs when behavior changes.
- Self-review correctness, tests, error handling, backwards compatibility, credentials, logging, access control and public/private boundaries. Ask for independent review.
- **Agents may not approve their own PRs or merge without explicit human authorization for that PR.** Before an authorized squash merge, confirm dependencies, correct PR base and required checks; prefer an independent human review. Creating or requesting a PR does not count as approval.
- Keep public CI read-only and synthetic. Never expose private content, tokens or production data in code, templates, logs, PRs or public workflow artifacts.

## Synthetic walkthrough

1. Open an issue titled `[TASK] Validate contributor documentation links` with acceptance criterion “local Markdown links resolve” and verification `node scripts/check-docs.mjs`. Name `README.md` as the owned area and list any dependency.
2. Mark it ready after confirming scope, then create `docs/issue-123-check-links` from `main`. Only use a different base if the issue explicitly depends on an open PR.
3. Commit the scoped changes. Open a PR against the appropriate base with `Closes #123`, actual checker output, risks and a privacy checklist.
4. Review the full diff yourself and record findings. A human explicitly authorizes merging after verification; the owner or explicitly authorized agent squash-merges only when dependencies and checks pass. GitHub closes #123 when the issue-closing PR reaches the default branch.

Example issue and branch names are synthetic; do not create or close #123 just to demonstrate the process.

## Issue/PR dependency discipline

If a blocker appears, record the issue/PR link and consequence, move the work to **blocked**, and avoid unsupported implementation assumptions. A stacked PR is not considered ready to merge until the upstream PR is merged and the target branch is correct. Incomplete or rejected work stays visible in GitHub; it does not get silently marked done.
