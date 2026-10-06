# P0: Core Invariants, Code Quality & Engineering Integrity (`00-core-invariants.md`)

> **Priority Level: P0 (Supreme System & Engineering Invariant)**  
> This document defines the non-negotiable foundation of the CoAgent engineering standard.  
> Violations strictly block code reviews, Pull Requests, and merges. Zero exceptions permitted.

---

## 1. Strictly No "Hacks" & Root-Cause Engineering
* **Zero Shortcuts**: Never introduce temporary workarounds, monkey-patches, silent exception swallowing (`catch (_) {}` without intentional handling or rationale), mock bypasses in production code, or arbitrary type coercions (`as any`) to artificially bypass checks.
* **Root-Cause Remediation**: Fix defects, race conditions, and edge cases at their architectural source. If an interface or protocol boundary fails, redesign the boundary cleanly rather than applying duct tape around callers.
* **Strict TypeScript Strict Mode**: The codebase operates strictly under TypeScript strict mode (`tsc --noEmit` must pass with 0 compiler errors). Never suppress type errors, abuse `any`, or use arbitrary type coercions to conceal type system mismatches.
* **Runtime Reliability**: The MCP-to-CLI bridge must support bounded headless execution and reliable cancellation. Resource leaks (dangling processes, orphaned file descriptors, uncollected timers, runaway memory buffers) are treated as critical P0 defects. This does not require a general orchestration platform.
* **Defensive Boundary Validation**: Always validate external inputs, CLI outputs, and JSON payloads with strict schemas (`validateToolArguments`, Zod/MCP schema definitions). Never assume third-party CLIs or external callers behave well.

---

## 2. GitHub Integrity & Branch Governance
* **Direct pushes to `main` are strictly forbidden.** Under no circumstances may an agent or contributor commit or push directly to `main` during normal development. The sole permitted exception is an explicit, owner-authorized history recovery procedure using atomic force-with-lease for incident mitigation.
* **Isolated Feature & Release Branches**: All development must occur on dedicated topic branches (`feat/*`, `fix/*`, `chore/*`) created from and targeting the active release branch (`release/vX.Y.Z`, currently `release/v1.0.0`); only final release and hotfix PRs target `main`. See [02-git-workflow](02-git-workflow.md).
* **PR Squash-and-Merge**: Merging into a release branch or `main` is executed exclusively via GitHub Pull Requests with Squash and Merge (`gh pr merge --squash --delete-branch`), with a Conventional Commit title.
* **Green Matrix Requirement**: The `main` branch must strictly remain 100% green across all continuous integration matrix jobs (Linux, macOS, Windows on Node 20 LTS and Node 22 LTS).
* **Protected Review Gates**: No branch protection rules, required status checks, or Author–Reviewer review gates may be disabled or bypassed. Temporary bypass permissions must be revoked immediately after an authorized recovery.

---

## 3. Verifiable Reality & Zero Hallucinated Claims
* **Evidence-Grounded Reporting**: Never claim a milestone, test pass rate, release status, or benchmark unless backed by verifiable, objective execution evidence.
* **No Weakening Tests**: Never delete, weaken, comment out, or doctor test assertions simply to make a failing suite pass. Tests define the public contract.
* **Synchronized Metadata**: Package metadata (`package.json`, `package-lock.json`, `plugin.json`), runtime constants (`BRAND.SERVER_VERSION`), and documentation must strictly reflect the actual state of the codebase.
* **Honest Development Status**: When a package is in development (e.g. `0.9.0-dev`), documentation must honestly reflect that state rather than prematurely proclaiming a production release.

---

## 4. Sovereign Author–Reviewer Verification
* **Mandatory Dual-Role Separation**:
  - **Author** (Antigravity / Gemini) authors code, refactors, and implements features.
  - **Reviewer** (OpenAI Codex `gpt-6.1-sol` / Claude Code) independently audits changes in a read-only sandbox before merging.
* **Zero Unresolved Blockers**: Pull Requests cannot be opened or merged if any P1 (Blocker) or P2 (Important/Robustness) issue is raised by the Reviewer. The state envelope must evaluate to `VERDICT: READY`.
* **Scope-Based Quality Gate**: Before submitting changes, satisfy the applicable checks in [`04-quality-gate.md`](./04-quality-gate.md). Prose-only documentation changes do not require runtime tests, builds, packaging or backend AI calls. Full package and cross-platform validation remain required for releases; existing required remote checks and branch protections must not be bypassed.

