---
title: Git workflow
---

# P0: Git Workflow, Versioning & Release Process (`02-git-workflow.md`)

> **Priority Level: P0 (Critical System Invariant)**
> Direct pushes and force pushes to `develop` or to a release line (`X.Y.x`) are
> strictly forbidden. This rule is the single source for branching, commits, pull
> requests, versioning, releases and issue handling. Other documents reference it.

The process follows widely used conventions:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html),
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) and a
`develop` plus release-line branch model (owner decision 2026-10-10):
a permanent integration branch, one branch per maintained `X.Y` line, releases as
tags on those branches, and squash-merged pull requests.

Every commit on `develop` and on a line is a squash commit that GitHub created
from one pull request: `<PR title> (#N)`, signed by GitHub and therefore shown as
**Verified**. Nothing reaches these branches any other way. Each coherent
result - feature, fix, release or backport - travels as one topic branch and PR.
Implementation subtasks are not automatically separate pull requests.

## 0. Who does what

Agents implement changes and prepare the review evidence. The owner focuses on
architecture and code review; the Author must not leave routine PR preparation,
check selection or evidence collection for the owner. Independent verification
does not imply the owner's approval or replace their architectural decisions.
The owner's code review normally happens before opening the PR (owner
clarification, 2026-10-12). Agents prepare the local candidate, relevant diff,
check evidence and open questions for that review, address the feedback, then
open the PR within the owner's authorization. Opening a PR does not require
the owner to repeat a completed review of the same snapshot. Later changes
must be disclosed with their effect on the earlier review.

| Action | Agent | Owner |
| --- | --- | --- |
| Topic branch, commits, local checks, changelog check | Yes | Yes |
| Push a topic branch, open or update a PR | Only after the owner's explicit go-ahead in the session | Yes |
| Independent review ([03-author-reviewer](03-author-reviewer.md)) | Yes (Reviewer role) | Yes |
| Merge a PR | Only on the owner's explicit instruction for that PR | Yes |
| Create a release line, push a tag | Never | Yes |
| Verify a draft release, edit its notes | Yes | Yes |
| Publish a GitHub Release, approve a staged npm version, promote it to `latest`, publish or deprecate on npm, publish on the VS Code Marketplace, change repository settings | Never | Yes |

An agent prepares release PRs, release notes and evidence (section 5) and
stops. It never states or implies that a push, merge, tag or publication
happened unless it observed it.

---

## 1. Branching Model

| Branch | Purpose | Created from | Merges into | Lifetime |
| --- | --- | --- | --- | --- |
| `develop` | Default branch. Integration of the next version; betas are tagged here | - | - | Permanent |
| `X.Y.x` (for example `1.0.x`) | Release line of version X.Y: its release candidates (for 1.0 the previews after feature freeze, such as `0.8.0` and `0.9.0`), the final `X.Y.0` and patches `X.Y.Z` | `develop` at feature freeze (the release commit of the first release candidate) | - (receives backports) | Until the line's end of support |
| Topic branch | One change | `develop` (a backport branch: the line) | Its source branch | Until merged |

* There is **no `main` branch** (owner decision 2026-10-10). The repository's
  front page is `develop`; released states are tags and GitHub Releases.
* Release stages are **tags**, never branches, named `vX.Y.Z` after the version
  (section 4): betas `v0.6.0` -> `v0.7.0` (on `develop`) -> release candidates
  `v0.8.0` -> `v0.9.0` -> `v1.0.0` -> `v1.0.1` (on `1.0.x`). How many betas and
  release candidates there are follows the roadmap's release acceptance; each
  preview takes the next minor. A tag freezes the exact state of a stage forever.
* The first release is `v0.6.0` (prepared as 1.0.0-beta.2), the first squash
  commit of that work on `develop`. The npm name placeholder `1.0.0-beta.1` holds
  the place of `0.5.0`: the owner withdraws it from npm, and it has no tag, GitHub
  Release or changelog entry (owner decision 2026-10-11, REPO-003).
* **Feature freeze** creates the line: the owner branches `X.Y.x` from `develop`
  at the release commit of its first release candidate (for 1.0: the first
  preview tagged on `1.0.x`). From then on `develop` carries the next version's
  features and `X.Y.x` takes only release-blocking fixes and, after `X.Y.0`,
  patch fixes.
* **Fixes for a line** land on `develop` first. A fix that a maintained line
  also needs is then **backported**: a branch `backport/<N>-<desc>` from the line
  with `git cherry-pick -x <develop-sha>`, and a PR into the line titled like the
  original with the suffix `(backport #N)`, squash-merged. Only a fix that does
  not apply to `develop` (code already gone there) targets the line directly.
* **No merge commits.** `develop` and the lines have linear history of squash
  commits only. A line is never merged into `develop`; the changelog of each
  branch is generated on that branch (section 6).
* Branch names never equal tag names: lines are `X.Y.x`, tags are `vX.Y.Z...`.

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
| `release/` | A release PR (section 5): `release/v0.7.0` |
| `backport/` | A cherry-pick of a merged `develop` fix into a line (above) |

Keep a topic branch focused on one concern. Rebase it onto its target to pick
up changes (`git rebase origin/develop`). The author may force-push their own
topic branch before merge, only with an explicit lease on the commit they last
saw on the remote and `--force-if-includes`:

```bash
git push --force-with-lease=<branch>:<sha> --force-if-includes origin <branch>
```

A bare `--force-with-lease` compares against the local remote-tracking ref,
which a background `git fetch` (editor autofetch, another agent) can move, so
it may overwrite commits the author never saw (owner decision 2026-10-18,
`PROPOSALS-001k`). Never force-push a branch someone else is working on.

---

## 2. Commit Messages (Conventional Commits)

Every commit that lands on `develop` or a line - in practice, every
squash-merge commit - must follow Conventional Commits 1.0.0:

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
  * `Fixes #123` / `Refs #123` - linked GitHub issue;
  * `Refs: AUD-P0-1` - audit finding or roadmap item;
  * `BREAKING CHANGE: <description and migration>`;
* **No AI attribution (forbidden):** commits, pull requests, changelogs and
  release notes never credit an AI tool as author or co-author. Do not add a
  `Co-Authored-By` trailer for an AI (Claude, Codex, Gemini, Antigravity or any
  other), a "Generated with" line or a similar note. AI tools are tools paid for
  by the owner, who is the sole author and copyright holder. The Reviewer
  rejects a commit or PR that contains AI attribution.

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
docs(rules): define release lines, tags and PR process
```

Commits on topic branches disappear in the squash, but their headers must still
be valid Conventional Commits: the changelog check that runs before every push
(section 6) rejects any other subject. The pull request title and description
become the final commit, so they must meet this section.

---

## 3. Pull Requests

### Opening

* Target `develop`; a backport targets its line (section 1). A release PR
  targets the branch that will carry the tag (section 5). Push the branch only
  after the owner's go-ahead (section 0); GitHub needs it to open the PR.
* **Title**: a valid Conventional Commit header (section 2). It becomes the
  squash-merge subject and the changelog entry. Preview that entry with the
  changelog check (section 6) before opening the PR and whenever the title
  changes. Never put the PR number in the title: GitHub appends ` (#N)` on
  squash, so a title ending in `(#N)` lands as `(#N) (#N)`.
* Open as **draft** while work or verification is incomplete.
* One coherent result per PR. Keep its implementation, regression tests and
  related documentation together; use commits and a checklist for subtasks.
  Several roadmap rows may share a PR when they implement the same result.
* Split when a part has independent value, risk or rollback, needs a separate
  owner decision, or the combined scope cannot be reviewed effectively. Do not
  split by line count, file, client, task ID or test count, and do not batch
  unrelated fixes just to reduce the number of PRs. Never separate a fix from
  its tests or leave an incomplete migration. Release PRs and backports stay
  separate.
* Changes to rules, AGENTS.md or the workflow are their own result and travel
  in their own PR, so the history and the changelog show them.
* For a grouped PR, record all included task IDs and acceptance checks. Internal
  dependencies are completed in order on the same branch; external dependencies
  must be satisfied before starting. Review and required CI cover the combined
  current head, using the union of affected verification scopes (rule 04).
* **Description** (English) follows the
  [PR template](../../.github/pull_request_template.md) and has these sections.
  Scale detail to the change's risk; a small prose PR can use a sentence per
  section. The template is a writing aid, not another source of requirements.
  1. **Summary** - the concrete problem and resulting behavior, suitable for
     the squash commit body. Keep verification and process notes below.
  2. **Links** - `Fixes #...` / `Refs #...`, roadmap item and audit finding IDs.
     Link referenced documents and headings; write `None` if none apply.
  3. **Changes** - notable behavior, contract or migration effects, and the
     `pending` changelog entry from the title preview (section 6), or explain
     why the generator omits it. Highlight architectural decisions the owner
     should assess. Do not narrate commit organization or repeat the file list.
     Screenshots and before/after examples are useful only when they help
     evaluate the affected behavior.
  4. **Verification** - the commands run, platform and Node version, and each
     result as PASS, FAIL or NOT_RUN with a reason, selected per
     [04-quality-gate](04-quality-gate.md). Never report an unexecuted check as PASS.
     Identify the checked snapshot (commit SHA, or explicitly a local dirty
     diff). Separately record independent review per
     [03-author-reviewer](03-author-reviewer.md#recording-pr-evidence), including
     pending review honestly. GitHub Checks is the record of remote CI on the
     current head; do not duplicate its status in a checkbox or paste its logs.
     Link a relevant run or failure when it helps assess the change.
  5. **Risk and rollback** - what could break and how to revert.
     Documentation can establish policy, so assess its accuracy and impact
     rather than assuming prose has no risk.
  6. **Checklist** - docs, runtime contract and roadmap status updated where
     behavior changed; `CHANGELOG.md` unchanged outside a release PR
     (section 6); the title preview passed;
     no secrets, local paths or personal data in the diff.
     Include only Author-controlled preparation items. Mark inapplicable items
     `N/A` with a reason; do not check them as completed. CI and review readiness
     remain the merge gates below, not duplicated checklist items.
* The Author maintains the body and checklist as work, findings and evidence
  change, within the owner's authorization in section 0. Before requesting
  owner review, provide a current description and clearly name unresolved
  findings, missing checks and decisions needing the owner's judgment. Never
  imply owner approval or mark independent review complete from a `consult`.

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
  the Reviewer agrees. Rebasing a branch whose review is complete (READY, no
  open finding or conversation) onto its target is an update, not a rewrite
  during review; it supersedes the review evidence, and the rebased head needs
  a new independent review ([03-author-reviewer](03-author-reviewer.md#recording-pr-evidence)).
* **Merge method:** Squash and Merge, then delete the topic branch:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
  Before confirming, edit the squash message so that it complies with section 2
  (keep footers such as `Fixes #...` and `BREAKING CHANGE:`; remove any AI
  attribution). There is no other merge method: the rulesets allow only squash.
  An agent merging PRs that the owner listed follows the
  [pr-merge skill](../skills/pr-merge/SKILL.md) step by step.

---

## 4. Versioning

* Versions follow SemVer 2.0.0 **without pre-release identifiers** (owner
  decision 2026-10-11, REPO-003). The npm package, the VS Code extension and the
  Git tag carry the same numeric `X.Y.Z`, with no mapping between them. VS Code
  accepts only a numeric extension version and offers Restart Extensions after an
  update only when that number changes; the Marketplace refuses a repeated
  version. `scripts/build-vscode.cjs` refuses any other version.
* **A preview is every version below 1.0.0.** Each preview, beta or release
  candidate, raises the minor: `0.5.0` is skipped (the withdrawn npm name
  placeholder `1.0.0-beta.1` held it), then `0.6.0` (the first release,
  prepared as 1.0.0-beta.2), `0.7.0`, `0.8.0`, `0.9.0`; further previews would
  continue with `0.10.0`. A release of a preview that only fixes it raises the
  patch instead (owner decision 2026-10-11): `0.6.1`, `0.6.2`; it ships as a
  preview like its minor. The final release is `1.0.0`. A preview ships in the
  normal channels: a normal GitHub Release and a Marketplace release without the
  pre-release flag (owner decision 2026-10-13, RELEASE-001c); npm channels follow
  the table below. How a version after 1.0.0 is previewed is an owner decision
  before the first such preview.
* **Beta**: feature-incomplete or not fully hardened; distributed to invited
  testers as a preview. **Release candidate**: scope frozen on the line; only
  release-blocking fixes. The roadmap's
  [release acceptance](../../docs/ROADMAP.md#release-acceptance) defines each
  stage's entry gate.
* The version is changed only in a release PR (section 5), consistently in
  `package.json`, `package-lock.json`, `plugin.json`, `extensions/vscode/package.json`,
  `server.json` (its `version` and `packages[0].version`) and `CHANGELOG.md`. Runtime constants read it from `package.json`.
* A build from an untagged commit is a development build and is never distributed,
  even though it carries the last version string.
* Published versions are immutable. A correction is always a new version number;
  a tag is never moved, deleted or reused (the tag rulesets enforce it).

### npm distribution channels

| npm dist-tag | Holds | Install |
| --- | --- | --- |
| `next` | Every new release, as soon as it is published; fixes may still follow | `npm install coagent8@next` |
| `latest` | The release the owner promoted as stable | `npm install coagent8` |

* Every release is staged to `next` by `npm-publish.yml` (`npm stage publish`, owner
  decision 2026-10-19); the owner approves it on npmjs.com with 2FA. A staged
  version's dist-tag cannot change, so `latest` is a separate owner step once the
  version proved stable: `npm dist-tag add coagent8@X.Y.Z latest`. npm's package
  page shows the version `latest` points at. The README install instructions use
  `@next`, which existing registrations also use.
* The `beta` dist-tag is retired (removed with 0.6.0).

---

## 5. Release Process

A release is a tag on a commit that already passed every check. Nothing is
built, fixed or edited after the tag; a defect found later ships in the next
version (section 4: a fix-only release raises the patch, `0.6.1`). The owner
performs every step marked (owner); an agent prepares the rest and stops there.

The **target** is the branch that carries the tag (section 1): `develop` for
betas and their patches; `X.Y.x` for release candidates, `X.Y.0` and later
patches. Before the first release candidate the owner creates `X.Y.x` from
`develop`. Every step below uses that target; `<repo>` is
`oktawianwybieralski/coagent8` unless a step names another.

### Between releases: every coherent result is one pull request

1. Branch from the target (`git switch -c fix/<topic> origin/<target>`), one
   concern per branch (section 1); a fix a line also needs lands on `develop`
   first and is backported.
2. Before pushing: the local checks of the change's scope
   ([04-quality-gate](04-quality-gate.md)), `npm run changelog:check` (section 6) and,
   for code, an independent CoAgent8 review of the branch with `VERDICT: READY`
   ([03-author-reviewer](03-author-reviewer.md)).
3. Open the PR into the target (section 3). It merges when the six CI jobs are
   green on its head and no P1/P2 finding is open; squash and delete the branch.
4. After each merge CI runs again on the target. When a job there fails, only
   the PR that fixes it may merge next: find the cause and fix it with a test
   that reproduces it. A job is re-run only when its cause is known and its fix
   is in a PR; a green re-run alone is not evidence.
5. A PR that completes a planned card ticks it in the roadmap.

### Phase A - prepare and accept the release candidate (agent may prepare)

6. **Scope.** The roadmap names the cards of the version. Preparation starts
   when all of them are merged, CI is green on the target's head, no P0/P1 issue
   is open, and README, extension README and known limitations describe the
   merged behavior.
7. **Release branch.** `git switch -c release/vX.Y.Z origin/<target>` with one
   commit `chore(release): vX.Y.Z` that only:
   * sets the version with `npm version X.Y.Z --no-git-tag-version` (it updates
     `package.json` and `package-lock.json`) and in `plugin.json`,
     `extensions/vscode/package.json` and both versions in `server.json`; `git grep -n "<previous version>"` then
     finds no other manifest still carrying the old number;
   * regenerates `CHANGELOG.md` with `npm run changelog -- --tag vX.Y.Z`;
   * adds the tester header `docs/releases/vX.Y.Z.md` (step 9).

   Every later regeneration on this branch also passes `--tag vX.Y.Z`; plain
   `npm run changelog` would turn the version heading back into Unreleased.
8. **Local checks on that commit:** the full local gate
   ([04-quality-gate](04-quality-gate.md#full-release-gate)) with platform, Node,
   commit, tree and tarball digest recorded.
9. **Release notes header** in English for testers, written to
   `docs/releases/vX.Y.Z.md` and reviewed with the release PR: what CoAgent8 is,
   install, what changed in plain words, known limitations, upgrade notes. No
   internal card IDs or process notes. `npm run release-notes -- --tag vX.Y.Z`
   previews the generated part; `release.yml` puts the header above it and fails
   without the file (`RELEASE-001e`).
10. Run `npm run changelog -- --tag vX.Y.Z` once more (it must leave the file
    unchanged), push the branch and open the PR `chore(release): vX.Y.Z` into
    the target, with the evidence. Its six CI jobs must be green; they
    build the release candidate's VSIX and tarball with the new version.
11. **Native acceptance of the candidate.** Download the VSIX and the tarball
    from the PR head's CI run (`gh run download <run> --repo <repo>
    -n evidence-<os>-node-24.x -D <empty folder>`) and run the stage's native
    acceptance (roadmap) with them: an isolated VS Code instance
    (`--user-data-dir`, `--extensions-dir`) and a clean npm folder, at least
    `doctor` with `scope: "health"`, `consult` and `review` on each backend. A
    finding is fixed by its own PR into the target (step 1); then rebase the
    release branch, regenerate the changelog and repeat from step 8.
12. **Rehearsal when release tooling changed.** If any PR since the previous
    tag changed `.github/workflows/`, `package.json` or `package-lock.json`,
    `scripts/`, `tooling/` or `cliff*.toml`, rehearse with the release PR's
    head in a throwaway public repository `<repo>-release-test`:
    * push the head as `develop` and make `develop` its default branch (the
      workflow accepts tags only on `develop` or a line);
    * push the release tags that exist in `<repo>` (each tag listed by
      `git ls-remote --tags --refs origin 'v*'`, as
      `git push <throwaway> refs/tags/<tag>:refs/tags/<tag>`; never local-only
      tags), so the notes start at the previous version as they will in `<repo>`;
    * push an annotated `vX.Y.Z` on the head and verify the draft as in Phase D
      with `<repo>` set to the throwaway repository;
    * when `docs.yml` changed, enable Pages there and publish the draft: the
      documentation must deploy;
    * delete the repository afterwards.

    `npm-publish.yml` only stages: nothing is public before the owner approves, and
    a wrong staged version is rejected on npmjs.com (`npm stage reject`). A re-run
    uses the workflow at the tag, so when a changed workflow fails, stage the
    verified file by hand (step 22). CI runs its command with `--dry-run` on every
    PR. The real tag cannot be retried.
13. **Independent review** of `<previous tag>...release/vX.Y.Z`, bound to the
    base, candidate, tree and tarball hashes ([03-author-reviewer](03-author-reviewer.md)).

### Phase B - merge and tag (owner)

14. Squash-merge the release PR. Replace the default squash body (the whole PR
    description) with two or three lines on what the version brings; the title
    stays `chore(release): vX.Y.Z (#N)`. An agent may merge only on the owner's
    explicit instruction for that PR.
15. Verify before tagging: `origin/<target>` is the squash commit, its tree
    equals the release PR head's tree (`git rev-parse <sha>^{tree}`), GitHub
    shows it Verified, and CI on the target is green on it.
16. Tag that exact commit and push only the tag (owner; the tag is immutable):
    ```bash
    git fetch origin
    git tag -a vX.Y.Z <verified-sha> -m "CoAgent8 vX.Y.Z"
    git push origin vX.Y.Z
    ```

### Phase C - build (release workflow)

17. The tag starts `.github/workflows/release.yml`: it checks that the tag is a
    numeric annotated `vX.Y.Z` on `develop` or an `X.Y.x` line matching
    `package.json`, runs the full gate on Ubuntu with Node 24, packs and
    smoke-tests the exact tarball, packages the VSIX, writes `SHA256SUMS`, signs
    build provenance for both, composes the notes (`scripts/release-notes.cjs`:
    the step 9 header, the git-cliff changelog with `--current` and root commits
    skipped, the artifacts) and creates a **draft** normal release. It never
    publishes anything. A failure here is fixed by a new patch version; the tag
    stays.

### Phase D - verify the draft (agent may run, owner decides)

18. Download and verify in one empty folder:
    ```bash
    gh release download vX.Y.Z --repo <repo> -D <empty folder>
    cd <empty folder>
    sha256sum --check --ignore-missing SHA256SUMS
    gh attestation verify coagent8-X.Y.Z.tgz --repo <repo>
    gh attestation verify coagent8-mcp-X.Y.Z.vsix --repo <repo>
    ```
    Check the version inside both files and that the VSIX carries no pre-release
    flag.
19. Install the downloaded VSIX in an isolated VS Code instance and the
    downloaded tarball in a clean npm folder, confirm the installed extension
    files equal the VSIX (VS Code adds only `__metadata` to `package.json`), and
    repeat `doctor` with `scope: "health"` and one `consult` through each.
20. Read the draft's notes: the reviewed header from step 9, then the generated
    Full Changelog, Contributors, Compare and Artifacts sections. Nothing is
    replaced by hand; a wrong header is fixed in the next version.

### Phase E - publish (owner, in this order, from the Phase D folder)

21. Publish the draft release as a normal release. This deploys the
    documentation site (`docs.yml`) and starts `npm-publish.yml` and
    `marketplace-publish.yml`.
22. npm: `npm-publish.yml` verifies the release tarball's checksum and provenance and
    stages that exact file to `next` (section 4). Approve it on npmjs.com with 2FA
    (Packages, coagent8, staged versions); the version is then live on `next`.
    Promote it to `latest` once it proved stable, never in the same breath:
    ```bash
    npm dist-tag add coagent8@X.Y.Z latest
    npm dist-tag ls coagent8                       # check the tags
    ```
    Without trusted publishing (section 8) stage the verified file by hand:
    `npm stage publish ./coagent8-X.Y.Z.tgz --tag next`. npm never accepts the
    same version twice.
23. Marketplace: publishing the release also starts `marketplace-publish.yml`,
    which verifies the release VSIX's checksum, provenance, version and normal
    channel and publishes that exact file under `okidev` (`RELEASE-001d`). Without
    it (section 8), publish the verified file by hand:
    `npx @vscode/vsce@4.0.0 publish --packagePath ./coagent8-mcp-X.Y.Z.vsix`.
24. Announce the release to testers with the GitHub Release link.

### After the release

25. Confirm on the target: CI green and `git diff --exit-code vX.Y.Z --
    CHANGELOG.md` reports no change (read-only; never regenerate the file
    here). Record the release evidence in HANDOFF, mark the
    version done in the roadmap and close the issues it fixed.

Any change to the release branch after step 13 repeats steps 8 to 13 for the new
head. A pushed tag is never moved, deleted or reused.

### Final release and end of support

* The final `X.Y.0` follows the same phases on `X.Y.x`, with the additional
  readiness gate: the roadmap's RC stage accepted with no open P0/P1 issue; six CI
  jobs and the full local gate on a clean checkout; soak verification of the
  exact artifact (concurrent sessions, process cancellation, EOF teardown, lock
  contention, restart recovery, history pagination, bounded cache/memory); and
  an independent review of the complete release diff against the previous
  release tag, bound to base, candidate, tree and artifact hashes, with
  `COVERAGE: COMPLETE`, `VERDICT: READY` and no unresolved P1/P2 finding.
* A line is supported until the owner announces its end; its branch then stays
  read-only (no deletion; the ruleset forbids it).

---

## 6. Changelog

* `CHANGELOG.md` at the repository root is generated from the Conventional
  Commits history by git-cliff (`cliff.toml`, `npm run changelog`), with one
  section per released version (`## vX.Y.Z - (YYYY-MM-DD)`), newest first.
  The layout below is an owner decision of 2026-10-13.
* Nobody edits it by hand; the Reviewer rejects a manual edit. It is
  regenerated only in a release PR, with `--tag` (section 5, owner decision
  2026-10-14). Between releases it lists the released versions only; topic
  branches never run `npm run changelog` and never commit `CHANGELOG.md`.
* Each section is a nested list: area (commit scope; "General" without one),
  then type, then entries, newest first. Each entry is
  `#PR: description (by @author)`, linked to the PR and the author's GitHub
  account. The PR number comes from the `(#N)` suffix of the squash subject and
  the account from GitHub's no-reply author address; another address gives no
  author.
* Why only at release: generated on a topic branch, the file lists that
  branch's commits, which the squash removes, and cannot list the PR itself,
  whose `(#N)` squash commit does not exist yet. On the release branch every
  change since the previous tag is a squash commit, so each entry is a PR.
* Each branch generates its own file: on `develop` the versions tagged on
  `develop` (betas), on a line the versions tagged on that line. Before the
  first line exists (the first release candidate), the owner decides how
  `develop` lists the line's releases; until then every release is tagged on
  `develop`.
* The detailed entries of 0.6.0 (prepared as 1.0.0-beta.2) come from the
  commits of PR #3, squash-merged as one commit (REPO-002); GitHub keeps them as
  `refs/pull/3/head`. They are generated from those commits, never written by
  hand, named by their commit, and kept as a fixed section, the oldest entry at
  the end of the file (`cliff.toml` footer, which names the command); generation
  after it starts at tag `v0.6.0`.
* Types, in this order: Breaking change (`!` or `BREAKING CHANGE`), New feature
  (`feat`), Improvement (`perf`), Bug fix (`fix`), Refactoring (`refactor`),
  Removal (`revert`). `docs`, `chore`, `test`, `ci`, `build` and `style` are
  omitted unless breaking. A breaking commit is listed under Breaking change of
  its area only, not again under its type.
* A subject that is not a Conventional Commit (for example GitHub's default
  `Revert "..."` title) fails the generation (`require_conventional`) instead of
  silently losing its entry.
* GitHub release notes are generated by `npm run release-notes`
  (`cliff.release-notes.toml`).
  - Under a "Full Changelog" heading, a collapsed list has the layout of a
    `CHANGELOG.md` section: area, then type (Breaking change first), then
    `#PR: description (by @author)`. GitHub links `#N` and `@user` there.
  - Contributors and a Compare link to the previous tag follow the list.
  - Known issues, security notes and artifact digests are added by hand; they do
    not derive from commits.
* Give each PR a title describing its coherent result so that its entry is
  precise; implementation subtasks belong in the body and checklist.

### Checks before every push and pull request

The agent does this itself, without being asked.

1. **Before every `git push` of a topic branch**, run `npm run changelog:check`.
   It writes no file and fails when any commit since `v0.6.0` is not a
   Conventional Commit. A failure blocks the push: reword the offending commit;
   never push past it. Do not run `npm run changelog` and do not commit
   `CHANGELOG.md` on a topic branch.
2. **Before `gh pr create` and before every PR title change**, run
   `npm run changelog:check -- --with-commit "<PR title>"`. It writes no file.
   * The title appears as a `pending` entry. It must sit in the right group and
     describe the change for users.
   * A non-zero exit means the title is not a Conventional Commit. (git-cliff
     2.14.2 reports this case with a panic, exit code 101.)
   * A breaking change needs `!` in the title or a `BREAKING CHANGE:` footer in
     the squash message. A `!` on a branch commit alone is lost in the squash.
   * Copy the `pending` entry into the PR description (section 3).
3. **On a release branch** (section 5), regenerate with
   `npm run changelog -- --tag vX.Y.Z` before every push and keep the file in
   the release commit. A merge conflict in `CHANGELOG.md` there is never
   resolved by hand: take either side and regenerate.
4. Report the results in the PR **Verification** section as PASS or FAIL.

---

## 7. Issues and Tester Feedback

* Bugs are reported as GitHub issues. Testers should include the output of the
  `issue` tool (a sanitized report to paste into the form) and of `doctor`, the OS, Node
  version, CoAgent8 version and backend CLI versions.
* Triage labels:
  * type: `bug`, `enhancement`, `question`, `docs`;
  * severity for bugs: `P0` (safety, data loss, tool unusable), `P1`
    (incorrect result or contract violation), `P2` (robustness or degraded
    behavior), `P3` (cosmetic);
  * `found-in:v0.6.0` (the version where the bug was observed);
  * status: `needs-repro`, `confirmed`, `wontfix`, `duplicate`.
* P0 and P1 issues block the next stage tag. Every closed bug references the PR
  that fixed it (`Fixes #...` in the PR).
* Never paste credentials, configuration files or private code into issues;
  maintainers redact any that appear.

---

## 8. Repository Settings (GitHub rulesets)

The owner maintains three branch and tag rulesets with no bypass actors except
the tag-creation rule:

| Ruleset | Targets | Rules |
| --- | --- | --- |
| `develop` | `refs/heads/develop` | PR required; squash only; linear history; required checks below, up to date; conversation resolution; signed commits; no deletion; no force push |
| `release lines` | `refs/heads/*.*.x` | PR required; squash only; linear history; required checks below, up to date; conversation resolution; signed commits; no deletion; no force push |
| `release tags` | `refs/tags/v*` | No update, deletion or force push (immutable); creation restricted to maintainers |

* **Required checks** are the six CI jobs, exactly as `ci.yml` names them:
  `Test on {ubuntu-latest, macos-latest, windows-latest} (Node {24.x, 26.x})`.
  When the CI matrix changes, the ruleset changes in the same PR's follow-up;
  a required check that no job reports blocks every merge.
* `develop` is the default branch. GitHub signs every squash commit it creates
  (the "Verified" badge), which satisfies the signed-commit rule; a locally made,
  unsigned commit can never reach a protected branch.
* **GitHub Pages:** source "GitHub Actions"; the `github-pages` environment allows
  deployments from tags `v*` (a release event runs on the tag) and from
  `develop` (manual runs). Site: https://oktawianwybieralski.github.io/coagent8/.
* **npm trusted publishing** (RELEASE-001b): on npmjs.com the package `coagent8`
  trusts publisher repository `oktawianwybieralski/coagent8`, workflow
  `npm-publish.yml`, no environment, allowed action `npm stage publish` only;
  the approval is the owner's 2FA on the staged version, not a GitHub
  environment (whose rules blocked the job). The repository variable
  `NPM_TRUSTED_PUBLISHING` is `true` and the package disallows token
  publishing. Without the variable the staging job is skipped.
* **Marketplace publishing** (RELEASE-001d): the repository secret `VSCE_PAT` holds
  a Marketplace personal access token of the `okidev` publisher (scope Marketplace:
  Manage), and the repository variable `MARKETPLACE_PUBLISHING` is `true`; without
  the variable `marketplace-publish.yml` is skipped. Publishing the GitHub Release
  is the approval.
* No protection, required check or review gate may be disabled or bypassed
  outside the recovery procedure below.

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
  git push --atomic --force-with-lease=refs/heads/<branch>:<old_sha> --force-with-lease=refs/tags/<tag>:<old_tag_obj> origin <new_sha>:refs/heads/<branch> refs/tags/<tag>:refs/tags/<tag>
  ```
* Immediately verify that discarded commit SHAs are absent from the branch lineage (`git merge-base --is-ancestor <bad_sha> origin/<branch>` returns exit code 1).
* Restore branch protections and revoke temporary bypass permissions immediately following recovery.
