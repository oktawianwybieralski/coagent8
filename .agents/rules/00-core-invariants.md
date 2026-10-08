# P0: Core Invariants, Code Quality & Engineering Integrity (`00-core-invariants.md`)

> **Priority Level: P0 (Supreme System & Engineering Invariant)**  
> This document defines the non-negotiable foundation of the CoAgent8 engineering standard.  
> Violations strictly block code reviews, Pull Requests, and merges. Zero exceptions permitted.

---

## 1. Strictly No "Hacks" & Root-Cause Engineering
* **Zero Shortcuts**: Never introduce temporary workarounds, monkey-patches, silent exception swallowing (`catch (_) {}` without intentional handling or rationale), mock bypasses in production code, or arbitrary type coercions (`as any`) to artificially bypass checks.
* **Root-Cause Remediation**: Fix defects, race conditions, and edge cases at their architectural source. If an interface or protocol boundary fails, redesign the boundary cleanly rather than applying duct tape around callers.
* **Strict TypeScript Strict Mode**: The codebase operates strictly under TypeScript strict mode (`tsc --noEmit` must pass with 0 compiler errors). Never suppress type errors, abuse `any`, or use arbitrary type coercions to conceal type system mismatches.
* **Runtime Reliability**: CoAgent8 must support bounded headless task execution and reliable cancellation. Resource leaks (dangling processes, orphaned file descriptors, uncollected timers, runaway memory buffers) are treated as critical P0 defects. The planned full coagent direction extends these guarantees to delegated task trees; the roadmap defines the implementation stages.
* **Defensive Boundary Validation**: Always validate external inputs, CLI outputs, and JSON payloads with strict schemas (`validateToolArguments`, Zod/MCP schema definitions). Never assume third-party CLIs or external callers behave well.
* **Strict ASCII Punctuation & Character Encoding**: Never use non-ASCII typography (Unicode em dashes U+2014, en dashes U+2013, curly/smart quotes U+201C/U+201D/U+2018/U+2019, non-breaking spaces U+00A0). All source code, configuration manifests, test suites, and documentation must strictly use standard ASCII hyphens (`-`, U+002D), ASCII straight quotes (`"`, `'`), and standard ASCII whitespace. See [06-language-and-style.md](06-language-and-style.md).

---

## Dependency and responsibility boundaries

These are P0 engineering invariants, not directory naming preferences. The
[architecture ownership map](../../docs/ARCHITECTURE.md#dependency-boundaries)
defines the dependency direction; the
[migration plan](../../docs/ROADMAP.md#simplify-001---module-boundary-migration)
records existing violations and their removal. A directory move alone does not
establish compliance.

* **One owner per responsibility**: A module owns one coherent capability and
  its side effects. Consumers call that owner; they do not copy its policy,
  persistence, validation or lifecycle logic. New files belong to a named
  capability, never to a generic `utils`, `common` or `shared` dumping ground.
  File count and line count are signals for review, not arbitrary limits.
* **Dependencies follow ownership**: Transport/UI layers call application
  operations. Application operations compose domain services and provider
  adapters. Domain policy and reusable mechanisms must not import their callers,
  client transports, presentation code or installation/UI modules. Provider
  adapters translate provider protocols; they do not own application routing or
  user approval policy. Review all cross-boundary dependencies, including types.
* **No new cycles or hidden reverse dependencies**: Do not introduce runtime or
  type-only import cycles. Dynamic imports, re-exports, barrel files, global
  registries and service locators cannot hide a forbidden dependency. Use a
  narrow contract owned by the consumer or a genuinely shared contract, and
  supply its implementation at the composition boundary. Do not move all types
  into a common file merely to silence a dependency check.
* **Contracts are independent**: Shared request/result/event contracts do not
  load implementation modules or depend on MCP/editor/provider SDK types.
  Execution returns transport-independent results and evidence. Transport
  formatting must not own or weaken policy, redaction or review acceptance.
* **Mechanisms do not acquire policy**: File locks, atomic writes, bounded I/O
  and process primitives may implement their named effects, but must not load
  user configuration, choose models, start sessions or register clients as an
  incidental import/use effect. Optional integration code stays outside the
  normal server startup dependency graph.
* **Existing violations are migration debt, not precedents**: Inventory exact
  edges and their removal stage before refactoring. Do not add edges to, expand
  or conceal a legacy cycle. Untouched debt does not require an unrelated
  rewrite. Each migration slice removes its declared violations and preserves
  behavior, public contracts and stored data; update the ownership map and
  verify the affected dependency graph. A new violation blocks acceptance.

---

## 2. GitHub Integrity & Branch Governance
* **Direct pushes to `main` are strictly forbidden.** Under no circumstances may an agent or contributor commit or push directly to `main` during normal development. The sole permitted exception is an explicit, owner-authorized history recovery procedure using atomic force-with-lease for incident mitigation.
* **Isolated Feature & Release Branches**: All development must occur on dedicated topic branches (prefixes defined in `02-git-workflow.md`, including `docs/*`) created from and targeting the active release branch (`release/vX.Y.Z`, currently `release/v1.0.0`); only final release and hotfix PRs target `main`. See [02-git-workflow](02-git-workflow.md).
* **PR Squash-and-Merge**: Merging into a release branch or `main` is executed exclusively via GitHub Pull Requests with Squash and Merge (`gh pr merge --squash --delete-branch`), with a Conventional Commit title.
* **Green Matrix Requirement**: The `main` branch must strictly remain 100% green across all continuous integration matrix jobs (Linux, macOS, Windows on Node 24 LTS and Node 26).
* **Protected Review Gates**: No branch protection rules, required status checks, or Author-Reviewer review gates may be disabled or bypassed. Temporary bypass permissions must be revoked immediately after an authorized recovery.

---

## 3. Verifiable Reality & Zero Hallucinated Claims
* **Evidence-Grounded Reporting**: Never claim a milestone, test pass rate, release status, or benchmark unless backed by verifiable, objective execution evidence.
* **No Weakening Tests**: Never delete, weaken, comment out, or doctor test assertions simply to make a failing suite pass. Tests define the public contract.
* **Synchronized Metadata**: Package metadata (`package.json`, `package-lock.json`, `plugin.json`), runtime constants (`BRAND.SERVER_VERSION`), and documentation must strictly reflect the actual state of the codebase.
* **Honest Development Status**: When a package is in development (e.g. `0.9.0-dev`), documentation must honestly reflect that state rather than prematurely proclaiming a production release.

---

## 4. Sovereign Author-Reviewer Verification
* **Mandatory Dual-Role Separation**:
  - **Author** authors code, refactors, and implements features. The role is independent of model/provider.
  - **Reviewer** independently audits changes in a separate read-only execution before merging. The author cannot provide their own independent approval; provider/model identity alone does not establish independence.
* **Zero Unresolved Blockers**: Pull Requests cannot be opened or merged if any P1 (Blocker) or P2 (Important/Robustness) issue is raised by the Reviewer. The state envelope must evaluate to `VERDICT: READY`.
* **Scope-Based Quality Gate**: Before submitting changes, satisfy the applicable checks in [`04-quality-gate.md`](./04-quality-gate.md). Prose-only documentation changes do not require runtime tests, builds, packaging or backend AI calls. Full package and cross-platform validation remain required for releases; existing required remote checks and branch protections must not be bypassed.

