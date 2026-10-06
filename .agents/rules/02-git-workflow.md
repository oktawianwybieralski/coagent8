# P0: Git Workflow, Versioning & Release Process (`02-git-workflow.md`)

> **Priority Level: P0 (Critical System Invariant)**
> Direct pushes and force pushes to `main` or to a release branch are strictly
> forbidden. This rule is the single source for branching, commits, pull
> requests, versioning, releases and issue handling. Other documents reference it.

The process follows widely used conventions:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html),
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/),
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and a
trunk-plus-release-branch model with squash-merged pull requests.

---

## 1. Branching Model

| Branch | Purpose | Created from | Merges into | Lifetime |
| --- | --- | --- | --- | --- |
| `main` | Accepted final releases only (`vX.Y.Z`) | — | — | Permanent |
| `release/vX.Y.Z` | Integration branch for one upcoming release; carries all of its prereleases | Latest `main` | `main` (final release PR) | Until `vX.Y.Z` is released |
| Topic branch | One change | Active release branch | Active release branch | Until merged |
| `hotfix/vX.Y.Z` | Urgent patch to a released version | Release tag `vX.Y.(Z-1)` on `main` | `main` | Until released |

* The **active release branch** for the 1.0.0 cycle is `release/v1.0.0`.
* Release stages are **tags on the release branch**, not branches:
  `v1.0.0-beta.1` → `v1.0.0-beta.2` → `v1.0.0-rc.1` → `v1.0.0-rc.N` → `v1.0.0`
  (the final tag is on `main`). A tag freezes the exact state of a stage forever.
* Branch names never equal tag names. Release branches use the `release/` prefix;
  tags are bare versions with a `v` prefix.

### Topic branch names

Format: `<type>/<short-kebab-description>`, optionally with the issue number:
`fix/123-windows-teardown-identity`, `feat/session-mode-none`, `docs/release-process`.

| Prefix | Use |
| --- | --- |
| `feat/` | New user-visible capability |
| `fix/` | Bug fix |
| `perf/` | Performance improvement without behavior change |
| `refactor/` | Internal restructuring without behavior change |
| `docs/` | Documentation and contributor rules only |
| `test/` | Tests only |
| `build/`, `ci/` | Build system, packaging or CI workflow |
| `chore/` | Maintenance that fits no other type (dependency bumps, tooling) |

Keep a topic branch focused on one concern. Rebase it onto the active release
branch to pick up changes (`git rebase origin/release/v1.0.0`). The author may
force-push their own topic branch with `--force-with-lease` before merge; never
force-push a branch someone else is working on.

---

## 2. Commit Messages (Conventional Commits)

Every commit that lands on a release branch or `main` — in practice, every
squash-merge commit — must follow Conventional Commits 1.0.0:

```text
<type>(<scope>)!: <subject>

<body>

<footers>
```

* **type** (lowercase): `feat`, `fix`, `perf`, `refactor`, `docs`, `test`,
  `build`, `ci`, `chore`, `revert`. `feat` and `fix` appear in release notes;
  `feat` implies a minor version bump after 1.0.0, `fix` a patch bump.
* **scope** (optional, lowercase): the owning module or area, for example
  `process`, `history`, `sessions`, `redaction`, `routing`, `adapters`, `server`,
  `setup`, `vscode`, `rules`, `release`, `deps`.
* **`!`** before the colon, together with a `BREAKING CHANGE:` footer, marks an
  incompatible change to the MCP tool contract, configuration, stored data or CLI.
* **subject**: imperative mood ("add", not "added"), no trailing period, at most
  72 characters including type and scope, English (see
  [06-language-and-style](06-language-and-style.md)).
* **body** (required unless trivial): wrapped at 72 characters; explain *why* the
  change is needed and what behavior changes, not a file list.
* **footers** (one per line):
  * `Fixes #123` / `Refs #123` — linked GitHub issue;
  * `Refs: AUD-P0-1` — audit finding or roadmap item;
  * `BREAKING CHANGE: <description and migration>`;
* **No AI attribution:** commits, pull requests, changelogs and release notes
  never credit an AI tool as author or co-author: no `Co-Authored-By` trailer
  for an AI and no "Generated with" line. AI tools are tools; the owner is the
  author.

Examples:

```text
fix(process)!: identify Windows descendants by PID and creation time

The CIM sweep matched processes by ParentProcessId alone, so a reused PID
could select unrelated user processes. Tree selection now runs in a pure
function that rejects children created before their parent.

BREAKING CHANGE: terminateProcessTree no longer accepts extraPids.
Fixes #42
Refs: AUD-P0-1
```

```text
docs(rules): define release branches, tags and PR process
```

Commits on topic branches may be informal work-in-progress; they disappear in the
squash. The pull request title and description become the final commit, so they
must meet this section.

---

## 3. Pull Requests

### Opening

* Target the active release branch (`release/v1.0.0`). Target `main` only for a
  final release PR or a hotfix.
* **Title**: a valid Conventional Commit header (section 2). It becomes the
  squash-merge subject.
* Open as **draft** while work or verification is incomplete.
* One concern per PR. Prefer under ~400 changed lines excluding generated files
  and lockfiles; split larger work into reviewable steps.
* **Description** (English) with these sections:
  1. **Summary** — what changes and why.
  2. **Links** — `Fixes #…` / `Refs #…`, roadmap item and audit finding IDs.
  3. **Changes** — notable behavior, contract or migration effects.
  4. **Verification** — the commands run, platform and Node version, and each
     result as PASS, FAIL or NOT_RUN with a reason, selected per
     [04-quality-gate](04-quality-gate.md). Never report an unexecuted check as PASS.
  5. **Risk and rollback** — what could break and how to revert.
  6. **Checklist** — docs, runtime contract and roadmap status updated where
     behavior changed; `CHANGELOG.md` "Unreleased" entry added for user-visible
     changes; no secrets, local paths or personal data in the diff.

### Review and merge

* **Required before merge:**
  * all required CI checks green on the PR's latest commit;
  * an independent review by the Reviewer per
    [03-author-reviewer](03-author-reviewer.md), on the latest commit, with no
    unresolved P1/P2 finding;
  * all review conversations resolved;
  * the branch up to date with its target.
* The Author never approves their own PR. When GitHub approvals require a second
  account that does not exist, record the Reviewer's verdict in the PR instead.
* Address findings with new commits; do not rewrite history during review unless
  the Reviewer agrees.
* **Merge method:** Squash and Merge only, then delete the topic branch:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
  Before confirming, edit the squash message so that it complies with section 2
  (keep footers such as `Fixes #…` and `BREAKING CHANGE:`).

---

## 4. Versioning

* Versions follow SemVer 2.0.0. Prerelease identifiers are `beta.N` and `rc.N`;
  SemVer ordering is `1.0.0-beta.1 < 1.0.0-beta.2 < 1.0.0-rc.1 < 1.0.0`.
* **Beta**: feature-incomplete or not fully hardened; distributed to invited
  testers. **Release candidate**: scope frozen; only release-blocking fixes.
  The roadmap's [release sequence](../../docs/ROADMAP.md#release-sequence) defines
  each stage's entry gate.
* The version is changed only in a release commit (section 5), consistently in
  `package.json`, `package-lock.json`, `plugin.json`, `extensions/vscode/package.json`
  and `CHANGELOG.md`. Runtime constants read it from `package.json`.
* A build from an untagged commit is a development build and is never distributed,
  even though it carries the last version string.
* Published versions are immutable. A correction is always a new version number;
  a tag is never moved or reused.

---

## 5. Release Process

### Prerelease (beta or release candidate)

1. **Gate:** the stage's entry gate in the roadmap is satisfied on the release
   branch, with green CI.
2. **Release PR** into the release branch, titled
   `chore(release): v1.0.0-beta.N`, which only:
   * sets the version (section 4);
   * moves `CHANGELOG.md` "Unreleased" entries under the new version heading with
     the release date.
3. After merge, verify CI on the resulting release-branch commit.
4. **Tag** that exact commit with an annotated tag:
   ```bash
   git tag -a v1.0.0-beta.N <release-branch-sha> -m "CoAgent v1.0.0-beta.N"
   git push origin v1.0.0-beta.N
   ```
5. **Build** the artifacts (npm tarball, VSIX) from a clean checkout of the tag;
   record their SHA-256 digests.
6. **Publish** a GitHub Release marked as *pre-release*, with the changelog
   section, known issues, artifacts and digests. Optionally publish to npm with
   `npm publish --tag next`. Never publish a prerelease to the npm `latest` tag.
7. Continue work on the same release branch toward the next stage.

### Final release

1. **Release readiness gate** — all of:
   * the roadmap's RC stage is accepted, with no open P0/P1 issue;
   * all six CI jobs and the full local gate
     (`npm run typecheck`, `npm run build`, `npm test`, `npm pack --dry-run`,
     `npm run test:consumer`) pass on a clean checkout;
   * soak verification of the exact artifact: concurrent sessions, process
     cancellation, EOF teardown, lock contention, restart recovery, history
     pagination and bounded cache/memory behavior;
   * an independent review by the Reviewer of the complete release diff
     against the previous `main`, bound to base, candidate, tree and artifact
     hashes, with `COVERAGE: COMPLETE`, `VERDICT: READY` and no unresolved
     P1/P2 finding.

   Any content change after the gate restarts it.
2. Release commit on the release branch: `chore(release): v1.0.0` (version and
   changelog, as for prereleases).
3. Open the final release PR `release/v1.0.0` → `main` titled
   `chore(release): v1.0.0`. Merge with Squash and Merge.
4. Verify that the `main` commit's tree equals the approved candidate tree and that
   CI passes on it.
5. Tag the verified `main` commit:
   ```bash
   git tag -a v1.0.0 <verified-main-sha> -m "CoAgent v1.0.0"
   git push origin v1.0.0
   ```
6. Build from the tag, publish the GitHub Release (not pre-release) and npm
   `latest`, with digests.
7. Delete the merged release branch. Create the next release branch
   (`release/v1.1.0`) from `main` when work on it starts.

### Hotfix (after a final release)

1. Branch `hotfix/v1.0.1` from tag `v1.0.0`.
2. Apply fix commits via PRs into the hotfix branch (or a single PR to `main`
   for a one-commit fix). Bump the patch version and the changelog.
3. Merge the hotfix PR into `main`, tag `v1.0.1`, publish as a final release.
4. Port the fix to the active release branch through a normal PR
   (`fix(...)`, `Refs: v1.0.1`).

---

## 6. Changelog

* `CHANGELOG.md` at the repository root follows Keep a Changelog 1.1.0 with an
  `## [Unreleased]` section and one section per released version, newest first.
* Groups: Added, Changed, Deprecated, Removed, Fixed, Security.
* Every PR with a user-visible effect adds an entry under Unreleased in the same
  PR. Internal refactors, tests and CI changes do not need entries.
* Release notes on GitHub are the changelog section of that version, plus known
  issues and artifact digests.

---

## 7. Issues and Tester Feedback

* Bugs are reported as GitHub issues. Testers should include the output of the
  `issue` tool (a sanitized, prefilled report) and of `doctor`, the OS, Node
  version, CoAgent version and backend CLI versions.
* Triage labels:
  * type: `bug`, `enhancement`, `question`, `docs`;
  * severity for bugs: `P0` (safety, data loss, tool unusable), `P1`
    (incorrect result or contract violation), `P2` (robustness or degraded
    behavior), `P3` (cosmetic);
  * `found-in:v1.0.0-beta.1` (the version where the bug was observed);
  * status: `needs-repro`, `confirmed`, `wontfix`, `duplicate`.
* P0 and P1 issues block the next stage tag. Every closed bug references the PR
  that fixed it (`Fixes #…` in the PR).
* Never paste credentials, configuration files or private code into issues;
  maintainers redact any that appear.

---

## 8. Branch Protection (GitHub settings)

Apply to `main` and `release/*`:

* require a pull request before merging; squash merging only; linear history;
* require status checks to pass (all six CI matrix jobs) and branches to be up
  to date before merging;
* require conversation resolution;
* block force pushes and deletions;
* restrict tag creation for `v*` to maintainers (tag protection rule).

No protection, required check or review gate may be disabled or bypassed outside
the recovery procedure below.

---

## 9. History Recovery Protocol (Emergency Incident Exception)

* History rewrites are strictly an emergency incident recovery mechanism, never routine cleanup.
* An owner-authorized recovery must identify:
  - The exact affected refs and expected old object IDs.
  - The consolidated replacement tree SHA.
  - Complete local validation evidence.
  - An offline backup bundle (`git bundle create coagent8-backup.bundle --all`).
* The recovery must use explicit atomic force-with-lease:
  ```bash
  git push --atomic --force-with-lease=refs/heads/main:<old_sha> --force-with-lease=refs/tags/<tag>:<old_tag_obj> origin <new_sha>:refs/heads/main refs/tags/<tag>:refs/tags/<tag>
  ```
* Immediately verify that discarded commit SHAs are absent from `origin/main` lineage (`git merge-base --is-ancestor <bad_sha> origin/main` returns exit code 1).
* Restore branch protections and revoke temporary bypass permissions immediately following recovery.
