# CoAgent — Agent & Contributor Guidelines (`AGENTS.md`)

This repository defines strict engineering practices, Git branching workflows, quality gates, and architectural conventions for all AI coding agents (Antigravity, Cursor, Codex, Claude Code) and human contributors.

All rules are organized hierarchically by strict priority from **P0 (Critical System Invariants)** to **P2 (Code Standards & Conventions)** in [`.agents/rules/`](./.agents/rules/):

Use [docs/ROADMAP.md](./docs/ROADMAP.md) as the single active plan. The product is
a client-independent MCP-to-CLI bridge; host setup and editor integrations are
optional. Current priorities are quiet Windows operation and simpler ordinary
MCP use. Historical plans and RFCs do not override this direction.

---

## 🧭 Prioritized Rule Index (`.agents/rules/`)

### 🔴 P0 – Critical System & Security Invariants
*Must never be bypassed under any circumstances.*

0. **[P0: Core Invariants, Code Quality & Engineering Integrity (`00-core-invariants.md`)](./.agents/rules/00-core-invariants.md)**:
   - **Strictly no "hacks"**: Zero shortcuts, no monkey-patching, no silent exception swallowing, root-cause fixes only.
   - **GitHub & branch protection**: Direct pushes to `main` strictly forbidden, green CI matrix, clean PR squash-and-merge.
   - **Verifiable reality**: Zero hallucinated claims, honest evidence, no weakened tests, synchronized metadata.
   - **Production reliability**: Strict TypeScript strict mode, leak-free process management, defensive schema validation.

1. **[P0: Security & Read-Only Sandboxes (`01-security-and-sandboxes.md`)](./.agents/rules/01-security-and-sandboxes.md)**:
   - Mandatory read-only sandboxes (`--sandbox read-only` on Codex, `--permission-mode dontAsk --tools Read,Glob,Grep` on Claude, native `--sandbox` on agy).
   - Top-tier model confirmation (`astra`, `opus`) strictly requires explicit interactive user consent (`ask_question`). Never pass `user_confirmed: true` without explicit user selection.
   - Automated secret redaction for API keys, tokens, credentials, and user home directory paths, without rewriting ordinary content of public answers.

2. **[P0: Git Workflow, Release Governance & Branch Protection (`02-git-workflow.md`)](./.agents/rules/02-git-workflow.md)**:
   - **Direct pushes to `main` are strictly forbidden.**
   - All development takes place on dedicated topic branches (`feat/*`, `fix/*`, `perf/*`, `chore/*`) created from and targeting the active release branch `release/v1.0.0`. Betas and release candidates are annotated tags on that branch (`v1.0.0-beta.1`, `v1.0.0-beta.2`, `v1.0.0-rc.1`); the final `v1.0.0` tag is on `main`.
   - Merge exclusively via **Pull Requests with Squash and Merge** (`gh pr merge --squash --delete-branch`); commits and PR titles follow Conventional Commits; versions follow SemVer; changes are recorded in `CHANGELOG.md`.
   - `main` receives only finalized, audited release snapshots; must strictly remain 100% green across all 6 CI matrix jobs.
   - History recovery is strictly an emergency owner procedure with atomic force-with-lease.

---

### 🟡 P1 – Verification & Engineering Gates
*Mandatory quality bars that must be satisfied before PR merge.*

3. **[P1: CoAgent Review & Independent Audit (`03-author-reviewer.md`)](./.agents/rules/03-author-reviewer.md)**:
   - Strict Author/Reviewer separation: Antigravity acts as Author (writes the change); Codex Sol (`gpt-6.1-sol`) / Claude Code acts as Reviewer (independent review via CoAgent Review).
   - Independent verification via `review` in read-only sandbox before merging.
   - Release approval strictly binds to Base SHA, Candidate SHA, Tree SHA, and Artifact SHA-256.
   - Zero P1 (critical) or P2 (robustness) issues allowed. State Envelope gate must evaluate to `VERDICT: READY`.

4. **[P1: Local Quality Verification Gate (`04-quality-gate.md`)](./.agents/rules/04-quality-gate.md)**:
   - Choose local checks by change scope using the linked rule; do not repeat a full gate after every edit.
   - Prose-only README, plan and rule edits require content/link review and `git diff --check`, without runtime tests, builds, packaging or backend AI calls.
   - Runtime, process, packaging and integration changes require appropriate behavioral checks.
   - Releases retain the full local package gate, supported CI matrix and independent review. Existing required remote checks must not be bypassed.

---

### 🟢 P2 – Compatibility & Code Standards
*Operational standards ensuring cross-platform stability and clean communication.*

5. **[P2: Cross-Platform & CI Matrix Guardrails (`05-cross-platform.md`)](./.agents/rules/05-cross-platform.md)**:
   - Explicit recursive `tests/*.test.js` discovery through `tests/run.cjs` (no shell glob assumptions for Windows `cmd.exe`).
   - Process tree teardown terminates only owned processes; process identity is PID plus creation time, never PID or parent PID alone, and name lists are not a safety mechanism. POSIX uses process group `process.kill(-proc.pid)`.
   - Strict buffer bounding (`maxBufferBytes: 512KB`, `maxInputBytes: 4MB`).

6. **[P2: Language & Code Style Standards (`06-language-and-style.md`)](./.agents/rules/06-language-and-style.md)**:
   - Universal English standard for all source code, identifiers, comments, TSDoc annotations, commit messages, and documentation.

