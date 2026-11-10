# Main-commit release versions

PCE uses a **single repository release version for each commit on the first-parent
history of `main`**. Web, API, and workers still deploy independently. A version
identifies a *source revision*, not proof that a particular service is running it.

## Version format and lifecycle

- Format: `rNNNNNN`, for example `r000251`. The number is the ordinal of that
  commit in `git rev-list --first-parent --reverse main`, zero-padded to six digits
  (the padding grows naturally if the count exceeds six digits).
- Source of truth: a **lightweight Git tag** `refs/tags/rNNNNNN` pointing at the
  full 40-character commit SHA. There is no mutable version counter or
  `package.json` bump. These are not semantic versions or GitHub Releases.
- Start: the first commit to `main` introducing
  `.github/workflows/main-version.yml` (normally this feature's squash merge).
  Earlier commits are **not** retroactively tagged, though they contribute to
  the ordinal. The first published version therefore need not be `r000001`.
- A squash merge gets one tag for its squash commit. A standard merge gets one
  tag for the merge commit, not for commits on the side branch. If multiple
  commits are individually applied to `main` (e.g. a rebase merge), each
  first-parent commit gets a tag. Direct pushes also get tags, but direct pushes
  are discouraged and **do not** trigger the GCP worker deployment workflow.
- Tags are immutable by policy: never delete, move, or reuse a `rNNNNNN` tag.
  The tagger fails on a collision rather than overwriting a tag.

## Automatic creation

[Version every main commit](../.github/workflows/main-version.yml) runs on
every push to `main` and can be launched manually via **Actions → Version every
main commit → Run workflow → main**.

The workflow checks out current `main` with complete history, runs the
[Git-fixture tests](../.github/release/main-version.test.mjs) and executes
[the tagger](../.github/release/main-version.mjs). The tagger:

1. Finds the original first-parent commit adding the workflow.
2. Enumerates all main first-parent revisions since that commit.
3. Verifies that existing release tags match their expected commit SHA.
4. Atomically publishes only missing tags, using the workflow's scoped
   `contents: write` token. A repeat run is safe and creates nothing if
   all tags are present.

The complete scan means a later run repairs gaps if a workflow was skipped,
cancelled before publication, or superseded in GitHub's concurrency queue.
If a failed run has not been followed by another main push, launch it manually.
Tagging uses **no cloud credentials, database, migrations, container rebuilds or
new deployment**. New tags alone do not trigger the selective production
deployments (Vercel, Render or the GCP worker).

**Repository prerequisite:** GitHub Actions must be allowed to use
`GITHUB_TOKEN` for `contents: write` on tags. If tag rulesets are enabled,
allow this workflow to create `r*` tags without permitting arbitrary users to
move or delete them. Protect `main` by requiring PRs and CI; the repository's
separate GCP worker deployment path assumes merged PRs.

## Finding versions and deployment state

Refresh the tags and inspect a release:

```sh
git fetch origin --tags
git rev-parse 'r000251^{commit}'           # example: complete source commit
git show --no-patch r000251               # commit metadata
git tag --points-at <full-main-commit-sha> # release(s) on an exact commit
```

Browse the [repository tags](https://github.com/vokerg/personal_context_engine/tags) or use the
GitHub Actions run summary for the latest version, SHA and number of new tags.

**A tag is not a deployment record.** To find which version runs where, first
read the deployed SHA from the hosting platform, then match it to its tag:

| Component | Current source-of-truth for the *deployed* SHA |
|---|---|
| Web / Vercel | Production deployment → Git commit SHA in Vercel |
| API / Render | Live deployment → Git commit SHA in Render |
| Worker / GCP systemd | `/opt/pce/current/REVISION` (or the active release name with SHA prefix) |
| Reserve API/static frontend / GCP | `/opt/pce-api/current/REVISION` and the separately installed static web release; see [reserve API operations](29-gcp-api.md) |
| Reserve Cloudflare gateway | Reviewed deployed module revision recorded in protected operator evidence; independently updated from API |
| Neon schemas | Applied `_prisma_migrations` history on each database — **independent of Git release numbering** |

These versions are expected to differ when changes target only some services.
The reserve API, static frontend and edge gateway retain their existing manual
update paths; this workflow does not deploy them. A CI/workflow change may still
match the existing conservative backend filters when its PR merges. Creating
source tags adds no new deployment trigger or runtime credential.

The existing [deployment scopes](26-worker-deployment.md)
continue to decide which artifacts deploy. A tag must **not** be shown as "live"
until the relevant deployment has succeeded. Automatic central deployment
status reporting and an in-app deployed-version view are **not** part of this
initial tagging implementation.

A deployed SHA from before versioning started will have **no** `rNNNNNN` tag;
show the full SHA rather than guessing a version. After versioning starts,
if a deployed SHA lacks its expected tag, inspect the release workflow and run
its recovery path; do not use the tag of a newer commit as a substitute.

## Troubleshooting and rollback

- **No tag after a merge:** check
  [the version workflow](https://github.com/vokerg/personal_context_engine/actions/workflows/main-version.yml),
  then manually rerun it on `main`. It will fill all missing main tags.
- **Tag collision:** the workflow intentionally fails. Check for rewritten
  history or a manually created `rNNNNNN` tag; do not force-push tags or
  automatically repair the collision.
- **Publishing denied:** verify the workflow's `contents: write` permission
  and repository/organization tag rulesets.
- **Rollback:** deploy the selected compatible *commit SHA* (and immutable image
  digest where applicable), using the existing platform-specific rollback
  process. Rolling back a service does not modify a Git tag or undo a Prisma
  migration; check schema and queued-job compatibility first.

The automation itself is introduced via a PR; tagging starts **only once that PR
is merged into `main`**. No existing production instance changes merely
because the release workflow is added.
