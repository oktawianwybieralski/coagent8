# CoAgent8 - Agent & Contributor Guidelines (`AGENTS.md`)

This repository defines strict engineering practices, Git branching workflows, quality gates, and architectural conventions for all AI coding agents (Antigravity, Cursor, Codex, Claude Code) and human contributors.

All rules are organized hierarchically by strict priority from **P0 (Critical System Invariants)** to **P2 (Code Standards & Conventions)** in [`.agents/rules/`](./.agents/rules/):

Use [docs/ROADMAP.md](./docs/ROADMAP.md) as the single active plan,
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for contracts and design, and
[docs/HANDOFF.md](./docs/HANDOFF.md) for current work and evidence. These are the
three active project documents; optional ignored local notes are not instructions.
[docs/delivered/](./docs/delivered/README.md) is the permanent record of what each
version delivered, per card, with its evidence (owner decision 2026-10-20): history,
not instructions. The PR that delivers a card's subtasks adds or extends its record.
The product is a client-independent system for delegating complete tasks to
cooperating agents (owner decision, 2026-10-08). Roles and model/provider choices are independent;
client skill installation is planned. The current runtime remains a read-only
MCP-to-CLI bridge until verified task execution profiles land. Follow the
roadmap's full coagent direction while preserving audit gates and quiet desktop
operation. Historical plans and RFCs do not override this direction.

---

## Prioritized Rule Index (`.agents/rules/`)

### P0 - Critical System & Security Invariants
*Must never be bypassed under any circumstances.*

0. **[P0: Core Invariants, Code Quality & Engineering Integrity (`00-core-invariants.md`)](./.agents/rules/00-core-invariants.md)**:
   - **Strictly no "hacks"**: Zero shortcuts, no monkey-patching, no silent exception swallowing, root-cause fixes only.
   - **GitHub & branch protection**: Direct pushes to `develop` or a release line strictly forbidden, green CI matrix, clean PR squash-and-merge; integration and publication are owner actions.
   - **Verifiable reality**: Zero hallucinated claims, honest evidence, no weakened tests, synchronized metadata.
   - **Production reliability**: Strict TypeScript strict mode, leak-free process management, defensive schema validation.
   - **Dependency boundaries (P0)**: One owner per capability; dependencies follow the architecture direction. No new runtime/type cycles, reverse dependencies or transport coupling in the engine. Existing violations require explicit migration, not copied patterns; see [core boundary rules](./.agents/rules/00-core-invariants.md#dependency-and-responsibility-boundaries).

1. **[P0: Security & Execution Profiles (`01-security-and-sandboxes.md`)](./.agents/rules/01-security-and-sandboxes.md)**:
   - Current mandatory read-only profiles: Codex app-server verifies readOnly/never and
     every inherited MCP server disabled per thread;
     Claude restricted mode verifies Read/Glob/Grep, dontAsk and empty MCP config;
     agy receives native --sandbox; its inherited MCP servers and plugins are a
     documented limitation (owner decision 2026-10-08), with recursion refused.
   - Planned full coagents use task-scoped capabilities under user policy;
     writing and bounded delegation require the roadmap's profile migration.
   - Models priced as expensive (at least 2x the backend default, or 20 USD per
     million output tokens), unknown or approximately priced require explicit user
     approval (`approve: true`) through server MCP elicitation; a calling agent
     cannot grant it.
   - Automated secret redaction for API keys, tokens, credentials, and user home directory paths, without rewriting ordinary content of public answers.

2. **[P0: Git Workflow, Release Governance & Branch Protection (`02-git-workflow.md`)](./.agents/rules/02-git-workflow.md)**:
   - **Branch model (owner decision 2026-10-10):** `develop` is the default and only integration branch; each maintained version has a release line `X.Y.x` (`1.0.x` from the first release candidate). There is no `main`. Direct pushes to `develop` or a line are strictly forbidden.
   - All development takes place on topic branches (`feat/*`, `fix/*`, `perf/*`, `docs/*`, `chore/*`, ...) created from and targeting `develop` (a backport: its line). npm, the VSIX and the Git tag share one numeric version without pre-release suffixes (owner decision 2026-10-11); every version below 1.0.0 is a preview and each preview raises the minor. Betas are annotated tags on `develop` (`v0.6.0`, `v0.7.0`); release candidates (`v0.8.0`, `v0.9.0`), `v1.0.0` and patches are tags on `1.0.x`; fixes land on `develop` first and are backported to the line by squash PRs. Every commit on `develop` and a line is a GitHub squash commit `<PR title> (#N)` shown as Verified; no merge commits. The first release for testers was `v0.6.0`, published as a preview (then a GitHub pre-release, VS Code pre-release and npm `next`; GitHub Releases and the Marketplace use normal channels since 2026-10-13 and npm publishes every release directly to `next`); the npm name placeholder `1.0.0-beta.1` held the place of 0.5.0 and is withdrawn, with no tag, GitHub Release or changelog entry.
   - Merge exclusively via **Pull Requests with Squash and Merge** (`gh pr merge --squash`; the repository deletes the merged branch); commits and PR titles follow Conventional Commits; versions follow SemVer; `CHANGELOG.md` is generated from the history, never edited by hand.
   - **PR scope:** one coherent result per PR, with its tests and related documentation; roadmap subtasks may share a branch and PR. Split by independent value, risk, rollback or decision, not automatically by task ID or line count. See [rule 02 section 3](./.agents/rules/02-git-workflow.md#3-pull-requests).
   - **Releases** follow [rule 02 section 5](./.agents/rules/02-git-workflow.md#5-release-process): every coherent result is one PR into the branch that carries the tag (`develop` for betas and their patches, `X.Y.x` from the first release candidate); a release PR only sets the version and the changelog, and its CI-built VSIX and tarball pass native acceptance before the owner merges and tags; the tag-triggered workflow builds a verified draft; publishing it starts direct npm publication (to `next`); for 0.7.0 the owner uploads the verified VSIX manually to Marketplace (later owner decision 2026-10-19), then runs Verify published and later promotes a stable version to `latest`. A defect found after the tag ships in the next patch. Agents never push, merge, tag or publish without the owner's explicit go-ahead.
   - **Changelog only at release (owner decision 2026-10-14)**: `CHANGELOG.md` is regenerated only in a release PR (`npm run changelog -- --tag vX.Y.Z`); topic branches never regenerate or commit it. Before every push run `npm run changelog:check`, and before opening a PR or changing its title `npm run changelog:check -- --with-commit "<PR title>"`. A failure blocks the push or PR.
   - `develop` and every release line must strictly remain 100% green across all 6 CI matrix jobs (three OSes, Node 24 and 26).
   - A force push of one's own topic branch names the expected remote commit: `--force-with-lease=<branch>:<sha> --force-if-includes`, never a bare lease (owner decision 2026-10-18).
   - History recovery is strictly an emergency owner procedure with atomic force-with-lease.
   - **No AI attribution (forbidden)**: never add a `Co-Authored-By` trailer for an AI tool, a "Generated with" line or similar to commits, PRs, changelogs or release notes. The owner is the sole author.

---

### P1 - Verification & Engineering Gates
*Mandatory quality bars that must be satisfied before PR merge.*

3. **[P1: CoAgent8 Review & Independent Audit (`03-author-reviewer.md`)](./.agents/rules/03-author-reviewer.md)**:
   - Strict Author/Reviewer separation: roles are independent of model/provider;
     the implementation author cannot supply their own independent approval.
   - Independent verification via `review` in read-only sandbox before merging.
   - The review request carries the requirements: card acceptance text, dated
     decisions and the proposed PR title and body, with the checks listed in
     [review input](./.agents/rules/03-author-reviewer.md#review-input).
   - Release approval strictly binds to Base SHA, Candidate SHA, Tree SHA, and Artifact SHA-256.
   - Zero P1 (critical) or P2 (robustness) issues allowed. State Envelope must
     evaluate to `VERDICT: READY` with independently verified scope/checks; the
     current text gate alone does not establish complete input or release approval.

4. **[P1: Local Quality Verification Gate (`04-quality-gate.md`)](./.agents/rules/04-quality-gate.md)**:
   - Choose local checks by change scope using the linked rule; do not repeat a full gate after every edit.
   - Prose-only README, plan and rule edits require content/link review and `git diff --check`, without runtime tests, builds, packaging or backend AI calls.
   - Runtime, process, packaging and integration changes require appropriate behavioral checks.
   - Releases retain the full local package gate, supported CI matrix and independent review. Existing required remote checks must not be bypassed.
   - `.artifacts/` holds only output of project scripts; agents keep their scripts, logs and drafts in their scratch directory.

---

### P2 - Compatibility & Code Standards
*Operational standards ensuring cross-platform stability and clean communication.*

5. **[P2: Cross-Platform & CI Matrix Guardrails (`05-cross-platform.md`)](./.agents/rules/05-cross-platform.md)**:
   - Explicit recursive `tests/*.test.js` discovery through `tests/run.cjs` (no shell glob assumptions for Windows `cmd.exe`).
   - Teardown terminates only owned handles and owned process groups, after a protocol interrupt where the backend supports one; never select a process by PID, parent PID or name. POSIX uses process group `process.kill(-proc.pid)`.
   - Strict buffer bounding (`maxBufferBytes: 512KB`, `maxInputBytes: 4MB`).

6. **[P2: Language & Code Style Standards (`06-language-and-style.md`)](./.agents/rules/06-language-and-style.md)**:
   - Universal English standard for all source code, identifiers, comments, TSDoc annotations, commit messages, and documentation.

