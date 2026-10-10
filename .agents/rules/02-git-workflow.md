# P0: Git Workflow, Versioning & Release Process (`02-git-workflow.md`)

> **Priority Level: P0 (Critical System Invariant)**
> Direct pushes and force pushes to `develop` or to a release line (`X.Y.x`) are
> strictly forbidden. This rule is the single source for branching, commits, pull
> requests, versioning, releases and issue handling. Other documents reference it.

The process follows widely used conventions:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html),
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/),
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the
`develop` plus release-line model of PrestaShop (owner decision 2026-10-10):
a permanent integration branch, one branch per maintained `X.Y` line, releases as
tags on those branches, and squash-merged pull requests.

Every commit on `develop` and on a line is a squash commit that GitHub created
from one pull request: `<PR title> (#N)`, signed by GitHub and therefore shown as
**Verified**. Nothing reaches these branches any other way. Every change -
features, fixes, releases, backports - travels as its own pushed branch and PR.

## 0. Who does what

| Action | Agent | Owner |
| --- | --- | --- |
| Topic branch, commits, local checks, changelog regeneration | Yes | Yes |
| Push a topic branch, open or update a PR | Only after the owner's explicit go-ahead in the session | Yes |
| Independent review ([03-author-reviewer](03-author-reviewer.md)) | Yes (Reviewer role) | Yes |
| Merge a PR, create a release line, push a tag | Never | Yes |
| Publish a GitHub Release, publish or deprecate on npm, change repository settings | Never | Yes |

An agent prepares release PRs, release notes and evidence (section 5) and
stops. It never states or implies that a push, merge, tag or publication
happened unless it observed it.

---

## 1. Branching Model

| Branch | Purpose | Created from | Merges into | Lifetime |
| --- | --- | --- | --- | --- |
| `develop` | Default branch. Integration of the next version; betas are tagged here | - | - | Permanent |
| `X.Y.x` (for example `1.0.x`) | Release line of version X.Y: release candidates, the final `X.Y.0` and patches `X.Y.Z` | `develop` at feature freeze (the commit that becomes `X.Y.0-rc.1`) | - (receives backports) | Until the line's end of support |
| Topic branch | One change | `develop` (a backport branch: the line) | Its source branch | Until merged |

* There is **no `main` branch** (owner decision 2026-10-10). The repository's
  front page is `develop`; released states are tags and GitHub Releases.
* Release stages are **tags**, never branches:
  `v1.0.0-beta.1` -> `v1.0.0-beta.2` -> `v1.0.0-beta.3` (on `develop`) ->
  `v1.0.0-rc.1` -> `v1.0.0-rc.N` -> `v1.0.0` -> `v1.0.1` (on `1.0.x`).
  A tag freezes the exact state of a stage forever.
* `v1.0.0-beta.1` tags the exact source of the npm name placeholder. It sits on a
  single commit outside `develop`'s history (REPO-002); its GitHub Release shows
  what beta.1 was. The first release for testers is `v1.0.0-beta.2`, the first
  squash commit of the beta.2 work on `develop`.
* **Feature freeze** creates the line: the owner branches `X.Y.x` from `develop`
  at the release commit of `X.Y.0-rc.1`. From then on `develop` carries the next
  version's features and `X.Y.x` takes only release-blocking fixes and, after
  `X.Y.0`, patch fixes.
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
| `release/` | A release PR (section 5): `release/v1.0.0-beta.2` |
| `backport/` | A cherry-pick of a merged `develop` fix into a line (above) |

Keep a topic branch focused on one concern. Rebase it onto its target to pick
up changes (`git rebase origin/develop`). The author may force-push their own
topic branch with `--force-with-lease` before merge; never force-push a branch
someone else is working on.

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
be valid Conventional Commits: the changelog regeneration that runs before every
push (section 6) rejects any other subject. The pull request title and description
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
  changes.
* Open as **draft** while work or verification is incomplete.
* One concern per PR. Prefer under ~400 changed lines excluding generated files
  and lockfiles; split larger work into reviewable steps.
* **Description** (English) with these sections:
  1. **Summary** - what changes and why.
  2. **Links** - `Fixes #...` / `Refs #...`, roadmap item and audit finding IDs.
  3. **Changes** - notable behavior, contract or migration effects, and the
     `pending` changelog entry from the title preview (section 6).
  4. **Verification** - the commands run, platform and Node version, and each
     result as PASS, FAIL or NOT_RUN with a reason, selected per
     [04-quality-gate](04-quality-gate.md). Never report an unexecuted check as PASS.
  5. **Risk and rollback** - what could break and how to revert.
  6. **Checklist** - docs, runtime contract and roadmap status updated where
     behavior changed; `CHANGELOG.md` regenerated, never edited by hand
     (section 6); the title preview passed;
     no secrets, local paths or personal data in the diff.

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
* **Merge method:** Squash and Merge, then delete the topic branch:
  ```bash
  gh pr merge <number> --squash --delete-branch
  ```
  Before confirming, edit the squash message so that it complies with section 2
  (keep footers such as `Fixes #...` and `BREAKING CHANGE:`; remove any AI
  attribution). There is no other merge method: the rulesets allow only squash.

---

## 4. Versioning

* Versions follow SemVer 2.0.0. Prerelease identifiers are `beta.N` and `rc.N`;
  SemVer ordering is `1.0.0-beta.1 < 1.0.0-beta.2 < 1.0.0-beta.3 < 1.0.0-rc.1 < 1.0.0`.
* **Beta**: feature-incomplete or not fully hardened; distributed to invited
  testers as a preview. **Release candidate**: scope frozen on the line; only
  release-blocking fixes. The roadmap's
  [release acceptance](../../docs/ROADMAP.md#release-acceptance) defines each
  stage's entry gate.
* The version is changed only in a release PR (section 5), consistently in
  `package.json`, `package-lock.json`, `plugin.json`, `extensions/vscode/package.json`
  and `CHANGELOG.md`. Runtime constants read it from `package.json`.
* A build from an untagged commit is a development build and is never distributed,
  even though it carries the last version string.
* Published versions are immutable. A correction is always a new version number;
  a tag is never moved, deleted or reused (the tag rulesets enforce it).

### npm distribution channels

| npm dist-tag | Holds | Install |
| --- | --- | --- |
| `next` | The newest beta or release candidate (preview) | `npm install coagent8@next` |
| `latest` | The newest final release | `npm install coagent8` |

* A prerelease is never published to `latest`. Until `1.0.0`, `latest` still
  points at the deprecated `1.0.0-beta.1` name placeholder (npm always keeps a
  `latest` tag); its deprecation message directs users to `coagent8@next`.
  The README install instructions use `@next` until 1.0.0.
* The `beta` dist-tag is retired; the owner removes it when publishing beta.2
  (`npm dist-tag rm coagent8 beta`).

---

## 5. Release Process

Every release follows the same five phases. The owner performs every action
marked (owner); an agent may prepare everything else.

### Phase A - release PR (agent may prepare)

1. **Gate:** the stage's entry gate in the roadmap is satisfied on the target
   branch with green CI. Betas target `develop`; `rc.N`, `X.Y.0` and patches
   target `X.Y.x` (for `rc.1`, the owner creates `X.Y.x` from `develop` first).
2. Branch `release/vX.Y.Z-<pre>` from the target. One commit
   `chore(release): vX.Y.Z-<pre>` that only:
   * sets the version (section 4) where it differs;
   * regenerates `CHANGELOG.md` with `npm run changelog -- --tag vX.Y.Z-<pre>`,
     which writes the commits since the previous tag under the new version
     heading with the release date (section 6).
3. Run the full local gate ([04-quality-gate](04-quality-gate.md#full-release-gate))
   on that commit and record platform, Node, commit, tree and artifact digests.
4. Open the PR titled `chore(release): vX.Y.Z-<pre>`; attach the local gate
   evidence and the release notes preview (`npm run release-notes -- --tag vX.Y.Z-<pre>`).
   The independent review binds to that commit ([03-author-reviewer](03-author-reviewer.md)).

### Phase B - merge and tag (owner)

5. Squash-merge the release PR after green CI and review. Verify CI on the
   resulting commit of the target branch.
6. Tag that exact commit with an annotated tag and push only the tag:
   ```bash
   git fetch origin
   git tag -a vX.Y.Z-<pre> <verified-sha> -m "CoAgent8 vX.Y.Z-<pre>"
   git push origin vX.Y.Z-<pre>
   ```

### Phase C - build (release workflow)

7. The tag push starts `.github/workflows/release.yml`. It checks that the tag is
   annotated, that `package.json` carries the same version and that the tagged
   commit is on `develop` or an `X.Y.x` line; runs the full gate on Ubuntu with
   Node 24; packs and smoke-tests the exact npm tarball, packages the VSIX,
   writes `SHA256SUMS`, generates the release notes with git-cliff and creates a
   **draft** GitHub Release (marked pre-release for a `-beta`/`-rc` tag) with
   these assets. It never publishes to npm and never publishes the draft.

### Phase D - verify the published artifacts (owner, agent may assist locally)

8. Download the assets from the draft release (`gh release download vX.Y.Z-<pre>`),
   verify them against `SHA256SUMS` and the CI digests, install the tarball and
   the VSIX in clean profiles, and run the stage's native acceptance (roadmap).
   Add known issues, security notes and digests to the draft notes.

### Phase E - publish (owner)

9. Publish the draft GitHub Release (keep "pre-release" for betas and RCs).
10. Publish the verified tarball, not a rebuild:
    ```bash
    npm publish ./coagent8-X.Y.Z-<pre>.tgz --tag next      # beta or rc
    npm publish ./coagent8-X.Y.Z.tgz                        # final: latest
    ```
11. Announce the release to testers with the GitHub Release link.

Any content change after Phase A's gate restarts it with a new commit; a pushed
tag is never moved. A failed release workflow is fixed by a new release number
when the tag was already pushed.

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
  Commits history by git-cliff (`cliff.toml`, `npm run changelog`). It follows
  Keep a Changelog 1.1.0 with one section per released version, newest first.
* Nobody edits it by hand; the Reviewer rejects a manual edit. It is regenerated
  before every push (below) and, with `--tag`, in each release PR (section 5).
* Each entry starts with its commit, linked to GitHub; the `(#N)` suffix of a
  squash subject becomes a link to the PR. On a topic branch the entries are the
  branch commits. After the squash merge they are replaced by the PR title (one
  entry per PR) at the next regeneration on the target branch.
* Each branch generates its own file: on `develop` the versions tagged on
  `develop` (betas), on a line the versions tagged on that line. Before the
  first line exists (`1.0.0-rc.1`), the owner decides how `develop` lists the
  line's releases; until then every release is tagged on `develop`.
* The detailed entries of 1.0.0-beta.2 come from the 293 local commits that were
  squash-merged as one PR (REPO-002). They are generated on that PR branch
  before the merge and kept as a curated section, like 1.0.0-beta.1; generation
  after it starts at tag `v1.0.0-beta.2`.
* Groups: Breaking (`!` or `BREAKING CHANGE`), Added (`feat`), Changed (`perf`,
  `refactor`), Removed (`revert`), Fixed (`fix`). `docs`, `chore`, `test`, `ci`,
  `build` and `style` are omitted. A breaking commit is listed under Breaking
  only, not again under its type.
* A subject that is not a Conventional Commit (for example GitHub's default
  `Revert "..."` title) fails the generation (`require_conventional`) instead of
  silently losing its entry.
* The 1.0.0-beta.1 release (tag `v1.0.0-beta.1`, outside `develop`'s history)
  keeps its curated description as the oldest entry at the end of the
  file (`cliff.toml` footer).
* GitHub release notes are generated by `npm run release-notes`
  (`cliff.release-notes.toml`) in the layout of the PrestaShop release pages.
  - Entries are grouped by area (commit scope; "General" without one), then by
    type.
  - Each entry is `#PR: description (by @author)`.
  - Breaking changes come first and are not repeated under their area.
    Contributors and a "Full Changelog" compare link follow the entries.
  - Known issues, security notes and artifact digests are added by hand; they do
    not derive from commits.
* Keep each PR to one user-visible change so that its entry is precise.

### Regeneration before every push and pull request

The agent does this itself, without being asked.

1. **Before every `git push`** (any branch), after the last change is
   committed:
   * Run `npm run changelog`. It fails when any commit since `v1.0.0-beta.1` is
     not a Conventional Commit. A failure blocks the push: reword the offending
     commit; never push past it.
   * If `CHANGELOG.md` changed, commit it alone as `chore(changelog): regenerate`.
     `chore` is omitted from the changelog, so this commit does not make the file
     stale. Do not amend it into an earlier commit: that changes the SHA that
     the file links.
   * Confirm that no entry is duplicated, misgrouped or missing, then push.
   * A file generated before the last commit is stale. A generated file cannot
     list the commit that contains it, which is why the file gets its own commit.
2. **Before `gh pr create` and before every PR title change**, run
   `npm run changelog:check -- --with-commit "<PR title>"`. It writes no file.
   * The title appears as a `pending` entry. It must sit in the right group and
     describe the change for users.
   * A non-zero exit means the title is not a Conventional Commit. (git-cliff
     2.14.2 reports this case with a panic, exit code 101.)
   * A breaking change needs `!` in the title or a `BREAKING CHANGE:` footer in
     the squash message. A `!` on a branch commit alone is lost in the squash.
   * Copy the `pending` entry into the PR description (section 3).
3. **Merge conflict in `CHANGELOG.md`** (for example after rebasing on
   `develop`): never resolve it by hand. Take either side, run
   `npm run changelog` and commit the result as in step 1.
4. Report the results in the PR **Verification** section as PASS or FAIL.

---

## 7. Issues and Tester Feedback

* Bugs are reported as GitHub issues. Testers should include the output of the
  `issue` tool (a sanitized, prefilled report) and of `doctor`, the OS, Node
  version, CoAgent8 version and backend CLI versions.
* Triage labels:
  * type: `bug`, `enhancement`, `question`, `docs`;
  * severity for bugs: `P0` (safety, data loss, tool unusable), `P1`
    (incorrect result or contract violation), `P2` (robustness or degraded
    behavior), `P3` (cosmetic);
  * `found-in:v1.0.0-beta.2` (the version where the bug was observed);
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
