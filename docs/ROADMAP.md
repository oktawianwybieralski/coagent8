# CoAgent roadmap to v1.0.0

**Next release:** `1.0.0-beta.1`. **Current package version:** `1.0.0-beta.1`.
**Direction updated:** 2026-10-05. **Beta 1 readiness:** Blocked by the
[independent audit at `c265cdf`](PROJECT_REVIEW_2026-10-05.md#independent-audit-at-c265cdf)
(3 P0 and 11 P1 findings).

This is the single active implementation and acceptance plan for the 1.0.0
release train. The current version label is development metadata. It does not
establish that a beta or release candidate has been accepted. Each stage requires
the milestones, compatibility decisions and evidence defined for it below.

The current priority is a simple, client-independent MCP-to-CLI bridge that does
not interrupt desktop work. After the audit, the first obligation is that it cannot
harm the desktop or the user's data. Process identity, output integrity and storage
availability come before new features. This direction supersedes the
installation-first sequence in the earlier review and handoff.

## Release sequence

1.0.0 ships through two betas and up to two release candidates. Betas go to
invited testers, who report problems as GitHub issues (the `issue` tool prepares
a sanitized, prefilled report). Release candidates follow only when beta feedback
contains no open P0/P1 defects.

| Stage | Version | Audience | Entry gate |
| --- | --- | --- | --- |
| Beta 1 | `1.0.0-beta.1` | Invited testers | Execution order 1 complete (all audit blockers); `BETA-001` checklist |
| Beta 2 | `1.0.0-beta.2` | Invited testers, wider circle | Execution order 2 complete; no open P0/P1 issue from beta 1 |
| RC 1 | `1.0.0-rc.1` | Release candidate | Execution orders 3–4 complete or explicitly deferred; scope frozen; `RC-001` checklist |
| RC 2 | `1.0.0-rc.2` | Only if needed | Release-readiness corrections to RC 1 only |
| Final | `1.0.0` | Public | Accepted RC; final release PR to `main` per [Git governance](../.agents/rules/02-git-workflow.md) |

All 1.0.0 work lands on the release branch `release/v1.0.0` through
squash-merged pull requests from topic branches. Each prerelease stage is an
annotated tag on that branch (`v1.0.0-beta.1`, `v1.0.0-beta.2`, `v1.0.0-rc.1`);
the final release is a PR from `release/v1.0.0` to `main`, tagged `v1.0.0`.
Branching, commit, pull request, versioning, changelog and release procedures
are defined in [Git governance](../.agents/rules/02-git-workflow.md).

Every stage publishes the exact artifact that passed its gate:
- prerelease versions are published as GitHub prereleases and, optionally, under
  the npm dist-tag `next`, never `latest`;
- a content change after a gate passes produces the next version number, not a
  replacement artifact under the same version.

## 1.0.0 scope

1.0.0 delivers:
- audit remediation (`AUDIT-001` blockers);
- generic MCP discovery and execution;
- plain consultation;
- quiet, bounded and identity-safe process supervision;
- fewer backend probes;
- optional archival history;
- clear tool contracts;
- non-blocking startup;
- the bounded refactoring in `SURFACE-001`, `EXEC-001`, `ROUTING-MIGRATE-001`,
  `SESSION-001`, `HISTORY-002` and `SIMPLIFY-001`.

Supporting verification, documentation and correctness work accompanies the
affected milestones. Each change requires its stated acceptance. An unchecked item
or a historical test result is not completion evidence.

Existing integrations and stored data must remain compatible or carry an explicit
migration. Integration isolation is in scope; adding hosts and completing every
optional host's UI acceptance are not prerequisites for the core release. Verify
any integration changed or advertised as supported, and document remaining limits.
Conditional investigations require a demonstrated need rather than becoming
automatic release blockers. The audit recorded that need for Windows Job Objects
(AUD-P0-1). Deferred work remains outside 1.0.0 unless this plan is explicitly
updated before the RC scope freeze.

## Product boundary

CoAgent lets an agent in a compatible MCP host ask a selected local coding CLI
for help and receive its public answer, with bounded execution, read-only access,
redaction and reliable cancellation. A host is the calling application; a backend
is the CLI executing the request. The same brand can fill either role.

### Why MCP over direct CLI commands?
While a human in a terminal can run `codex`, `agy`, or `claude` directly, CoAgent
serves autonomous AI agents (in Cursor, Claude Desktop, Antigravity, VS Code, Zed):

1. **Agent-to-agent delegation.** Host models lack arbitrary shell execution
   privileges and knowledge of each CLI's invocation syntax; MCP standardizes
   peer invocation.
2. **Mandatory read-only sandboxing (P0).** CLI execution is locked down:
   `--sandbox read-only` on Codex, native `--sandbox` on agy, read-only tools on
   Claude. Auditing models cannot mutate repositories.
3. **Protocol normalization.** Codex JSONL, agy NDJSON stream-json and Claude text
   become standard MCP tool responses with sanitized diagnostic errors and token
   metrics.
4. **Owned process supervision.** Owned child trees (`codex.exe`, `conhost.exe`)
   are torn down with bounded I/O. Teardown must target only processes whose
   identity, PID plus creation time, proves ownership (`WINDOWS-001`).
5. **Routing and failover (`smart_quota`).** Work is redirected away from a
   provider with an observed rate-limit cooldown, for example from rate-limited
   Codex to Gemini agy.

Generic stdio configuration is the primary integration contract. A client does
not need a CoAgent-specific installer adapter to discover tools. Setup commands,
VSIX/plugin packaging and branding are optional conveniences. Preserve existing
registrations and their rollback safeguards while separating those integrations.

The runtime enforces the State Envelope for `review` only; `consult` returns a
plain answer with `verdict: "NOT_APPLICABLE"`. Every execution currently persists
conversation history. The canonical profile advertises six core tools plus three
deprecated aliases (`analyze`, `debug`, `implement`); the compact profile
advertises four. No new runtime option is implied by this plan unless an item
says so.

## Architecture principle: conventional layout and bounded responsibilities

MCP stdio defines communication over standard streams, not a source-directory
convention. The official TypeScript tutorial puts server construction, tool
registration and transport connection in src/index.ts; it is a minimal example,
not a required layout. See the [transport specification](https://modelcontextprotocol.io/specification/latest/basic/transports)
and [server tutorial](https://modelcontextprotocol.io/docs/develop/build-server).

Use a conventional TypeScript/MCP layout as the default: source under src/, a
recognizable entrypoint, server composition, tool handlers and clearly named
product modules. Reference implementations vary in their exact layout; this is
an organizational convention, not a protocol requirement.

The name of a directory, module, class or function defines its responsibility.
Its behavior and side effects must stay within that named scope. If work belongs
elsewhere, delegate it to the appropriate owner. Delegation does not transfer
ownership or justify duplicating the other owner's implementation.

Evaluate structure by product needs, dependency direction and maintenance cost.
Simplification means reducing mandatory mechanisms between a question and its
answer while making every owner's scope clear.

- Keep index.ts for startup/shutdown and server.ts/tools/ for MCP registration,
  schemas, request handling and responses. CLI execution and provider policies
  belong to product logic behind that boundary.
- Keep current folder names when they accurately describe the complete scope.
  backends/ can own provider adapters, selection and availability; adapters/ owns
  translation to and from CLI interfaces. An adapter must not also own host
  installation, session storage or global routing.
- Resolve a name/scope mismatch by moving the misplaced behavior, splitting a
  mixed owner, or choosing a precise name for a coherent responsibility. Do not
  broaden a name to legitimize unrelated work. Renaming alone is not acceptance.
- A justified folder does not justify every feature inside it. sessions/ does
  not make durable archival history necessary for every consultation; backends/
  does not make repeated probes or additional routing strategies necessary.
- Extract resources/ or prompts/ only when implemented behavior needs a separate
  owner. Their presence in the protocol does not require empty directories or
  additional abstraction layers.

Apply this principle through `AUDIT-001`, `SURFACE-001`, `EXEC-001`,
`ROUTING-MIGRATE-001`, `SESSION-001`, `HISTORY-002` and `SIMPLIFY-001`. Measure
progress by clear ownership and fewer required operations, with safety and
compatibility preserved. Review module names, exports and side effects together:
tools own MCP handling, adapters own CLI translation, execution owns task/process
lifecycle, sessions own continuation/ownership, and integrations own host
registration. Each refactored module must have a named scope that covers all of
its behavior without absorbing another owner's responsibility.

## Documentation ownership

| Document | Owns |
| --- | --- |
| [README](../README.md) | Product introduction, ordinary MCP setup and entry points |
| [Architecture](ARCHITECTURE.md) | Current component boundaries and dependency flow |
| [Runtime contract](RUNTIME_CONTRACT.md) | Implemented tools, execution, errors, sessions, limits and known deviations |
| This roadmap | Priorities, proposed changes, acceptance and remaining work |
| [Project review](PROJECT_REVIEW_2026-10-05.md) | Audit findings (`AUD-*`), evidence and proposed fixes, bound to snapshots |
| [Integration guide](VSCODE_INTEGRATION.md) | Optional setup, VSIX/plugin lifecycle and host-specific limits |
| [Quality gate](../.agents/rules/04-quality-gate.md) | Scope-based local verification and full release validation |

Archived plans, the archived earlier review and the deferred interactive CLI RFC
do not define current policy. A completion mark (`[x]`) requires a reference to
evidence that measures the claim; source inspection alone is not runtime evidence.

## Audit remediation index

Every P0/P1 finding from the
[independent audit](PROJECT_REVIEW_2026-10-05.md#independent-audit-at-c265cdf) has
exactly one owning milestone below. P2 findings are owned as listed; P3 nits are
folded into `SIMPLIFY-001`.

| Finding | Severity | Summary | Owning milestone | Order |
| --- | --- | --- | --- | --- |
| AUD-P0-1 | P0 | Teardown identifies descendants by parent PID only | `WINDOWS-001` | 1 |
| AUD-P0-2 | P0 | Redaction rewrites code in public answers | `REDACTION-002` | 1 |
| AUD-P0-3 | P0 | Quadratic history growth; archive failures fail turns and block all executions | `HISTORY-002` | 1 |
| AUD-P1-1 | P1 | Cooldown recorded twice; parsed reset lost | `ROUTING-MIGRATE-001` | 1 |
| AUD-P1-2 | P1 | Unknown errors reported as `INPUT_LIMIT` | `ERRORS-001` | 1 |
| AUD-P1-3 | P1 | Metadata failure discards a successful answer | `HISTORY-002` | 1 |
| AUD-P1-10 | P1 | Stale committed `dist/` excluded from review | `PACKAGE-001` | 1 |
| AUD-P1-4 | P1 | Probe and supervision churn | `EXEC-001` (probes), `WINDOWS-001` (supervision) | 2 |
| AUD-P1-5 | P1 | Gemini parser rejects unknown event types | `CLI-INTERACT-001` | 2 |
| AUD-P1-6 | P1 | `model` reaches argv unvalidated | `EXEC-001` | 2 |
| AUD-P1-7 | P1 | Consent is an agent-set flag | `EXEC-001` | 2 |
| AUD-P1-8 | P1 | Resources bypass workspace isolation | `SESSION-001` | 2 |
| AUD-P1-9 | P1 | Lease integrity | `LOCKS-001` | 2 |
| AUD-P1-11 | P1 | Codex configuration parsed with a regex | `EXEC-001` | 2 |
| AUD-P2-1, AUD-P2-2 | P2 | Heuristic classification; fabricated data | `ROUTING-MIGRATE-001`, `DIAGNOSTICS-001` | 3 |
| AUD-P2-7 | P2 | Empty catches | `ERRORS-001` | 3 |
| AUD-P2-9, AUD-P2-11 | P2 | No MCP roots; malformed config hides tools | `MCP-001` | 3 |
| AUD-P2-10 | P2 | Installer bundled into the core server | `INSTALL-001` | 4 |
| AUD-P2-12 | P2 | Global history lock | `HISTORY-002` | 3 |
| AUD-P2-13 | P2 | Redaction format gaps | `REDACTION-002` | 3 |
| AUD-P2-14 | P2 | Orphans after a server crash | `WINDOWS-001` | 3 |
| AUD-P2-15 | P2 | CI duplication; documentation weight | `VERIFY-SCOPE-001` | 3 |
| AUD-P2-3 … AUD-P2-6, AUD-P2-8, P3 | P2/P3 | Test hooks, duplication, double timeout, dead code, contract fiction, nits | `SIMPLIFY-001` | 3 |

## Execution order

| Order | Work | Acceptance |
| --- | --- | --- |
| Done | `WINDOWS-001` (window suppression), `VERIFY-SCOPE-001` (runner selection), `STARTUP-001`, `SURFACE-001`, `CONSULT-001` | Recorded below; window suppression is in source but not in the committed bundle until `PACKAGE-001` |
| 1 (gates beta 1) | `AUDIT-001` blockers: `WINDOWS-001` process identity, `REDACTION-002`, `HISTORY-002` archive isolation, `ROUTING-MIGRATE-001` cooldown fix, `ERRORS-001` typed errors, `PACKAGE-001` | No teardown without verified identity; answers unaltered except credential formats; archive failures never fail or block a turn; parsed resets survive; no unknown error reported as `INPUT_LIMIT`; no build output in Git. Each with a regression test derived from the audit reproduction |
| 2 (gates beta 2), owner may reorder | `CLAUDE-BACKEND-001`: Claude Code in restricted read-only mode with streaming and resume | Subscription authentication; per-run read-only check; typed failures from stream-json; adapter tests green in CI |
| 2 (gates beta 2) | Remaining audit P1: `EXEC-001` probes, argv and consent; `CLI-INTERACT-001` forward compatibility; `SESSION-001` resource isolation; `LOCKS-001`; `WINDOWS-001` supervision cost | One cached probe per backend and no probe in `execute`; validated model identifiers; consent not assertable by the caller; unknown agy events tolerated; resources honor workspace ownership; no permanent lease |
| 3 (gates RC 1) | `SESSION-001`, `CLI-INTERACT-001`, `HISTORY-002` remainder, `SIMPLIFY-001`, audit P2 items | Safe auto-resume; activity liveness; deletions and deduplication with behavior preserved |
| 4 (gates RC 1) | `INSTALL-001`, optional integrations | Setup/repair isolated from core and bundled separately; VSIX and host presentation verified only where supported |
| 5 (RC and final) | Remaining correctness, documentation and `RC-001`: candidate acceptance | Concrete milestone evidence; frozen scope; exact package passes full CI matrix and independent Reviewer approval |

Small fixes should land independently. Choose incremental refactoring or a
rewrite by the resulting simplicity, correctness and maintenance cost. Rewrite
modules or subsystems when that produces a better result, with explicit scope,
contract migration and reviewable validation. Renaming folders alone does not
reduce responsibilities.

## 1. Audit blockers and quiet, identity-safe Windows operation

### `AUDIT-001` — release blockers from the independent audit

**Status:** Open. This umbrella closes when every order-1 row of the
[remediation index](#audit-remediation-index) is complete in its owning milestone.
It adds no separate work.

- [ ] Turn each audit reproduction into a regression test before or with the fix.
  The reproductions cover: the redaction inputs, the controller cooldown sequence,
  streamed-history byte growth, the full-archive first flush, the commented Codex
  `model` line and the synthetic stale-PPID process snapshot.
- [ ] Re-run the audit probes against the candidate and record the results in the
  project review before requesting Reviewer approval.

### `WINDOWS-001` — process windows, supervision and process identity

**Status:** Reopened by AUD-P0-1 (blocker) and AUD-P1-4.
- Window suppression is implemented in source. It is absent from the committed
  bundle until `PACKAGE-001` lands.
- The previous "zero orphan leaks" deferral rationale for Job Objects is withdrawn.

Completed:
- [x] Hide every test-created descendant, including nested PowerShell
  `Start-Process` calls (`-WindowStyle Hidden`) and synchronous shell probes (`windowsHide: true`).
  Parent `windowsHide` alone does not control windows created by descendants.
- [x] Preserve assertions for cancellation, EOF, parent/intermediate exit and
  orphan cleanup. Test helpers clean up even when an assertion fails via resilient `t.after` hooks.
- [x] Measure helper launches and ownership across the test runner, MCP harness
  and CLI runner. Replaced overlapping per-process CIM polling with serialized supervisor-wide
  CIM queries (`CimMutex`) in `src/execution/process.ts`.
- [x] Record a Windows desktop check for no visible windows/focus changes and
  process evidence for no owned survivors (`node.exe` / `powershell.exe` orphan sweep verified clean).
  Validate POSIX teardown separately. This evidence concerns owned survivors; it
  does not cover unowned processes matched by a stale parent PID (AUD-P0-1).

Process identity (AUD-P0-1, order 1):
- [ ] Treat process identity as (PID, creation time).
  - PowerShell emits only a snapshot (`ProcessId`, `ParentProcessId`,
    `CreationDate`).
  - A pure TypeScript function selects owned descendants, rejecting any child
    created before its parent.
  - The root identity is captured while the root is alive.
- [ ] Never start a sweep after a clean exit when no descendant was observed.
  Kill each verified identity individually, re-checking its creation time; never
  rely on `/T` across unverified PIDs.
- [ ] Remove the process-name denylist. It is not a safety mechanism.
- [ ] Apply the same supervisor to the test runner and MCP test harness.
- [ ] Acceptance: unit tests over synthetic snapshots, including stale PPID,
  reused root PID and live-root cases. No validation by sweeping a live desktop.

Supervision cost (AUD-P1-4, order 2):
- [ ] Do not track descendants for short-lived commands (`--version`, `git`).
  Poll only long-running tasks.
- [ ] Measure helper launches per consult/review on Windows before and after.
  Record the counts and latency.

Crash orphans and Job Objects (AUD-P2-14, order 3):
- [ ] Prototype a Job Object with `KILL_ON_JOB_CLOSE`. It removes polling and
  crash orphans. Evaluate compatibility with backend sandboxes and nested jobs,
  and the distribution cost of a helper.
- [ ] Add a POSIX parent-death strategy for detached groups.

### `REDACTION-002` — output integrity versus diagnostic redaction

**Status:** Open (AUD-P0-2 blocker, AUD-P2-13).

- [ ] Split redaction.
  - Public answers and stored assistant messages are filtered for high-confidence
    credential formats only: `sk-…`, `ghp_…`, `github_pat_…`, AWS key IDs,
    PEM private keys, `Bearer …`.
  - Keyword=value rules (`token=`, `password:`, `auth=`) and home-path redaction
    apply to diagnostics, stderr, errors, doctor output and issue reports.
- [ ] Regression: the four audit inputs round-trip unchanged; a real key inside an
  answer is still replaced.
- [ ] Add missing formats: `gho_`, `ghu_`, `ghs_`, `glpat-`, `ya29.`, bare JWT,
  `sk_live_`, `npm_`, `hf_`.
- [ ] Update the redaction rule in [01-security-and-sandboxes](../.agents/rules/01-security-and-sandboxes.md)
  if the final scope differs from its current text.

### `PACKAGE-001` — built output is not source

**Status:** Open (AUD-P1-10 blocker).

- [ ] Remove `dist/` from Git and build it in `prepack` and CI.
- [ ] Produce plugin/VSIX artifacts from the built tarball, not from a committed
  bundle.
- [ ] Keep `index.js`, `mcp.json` and `bin` entries valid for installed packages.
- [ ] Acceptance: a fresh clone cannot run a stale bundle. The consumer smoke test
  verifies the packed bundle matches a build of the packed source.

### `VERIFY-SCOPE-001` — useful verification without repeated full runs

- [x] Consolidate local policy in the quality-gate rule: prose-only edits do not
  trigger runtime tests, builds, packaging or backend invocations. Synchronize
  AGENTS, workflow skill and handoff references. This is a documentation change.
- [x] Add explicit file/suite selection to `tests/run.cjs`. No-argument discovery
  still finds the full inventory; selected files do not append other tests.
  Preserves portable arguments, bounded concurrency (`--test-concurrency=2` default with CLI override),
  and awaited cleanup. Tested via `tests/discovery.test.js` and `node tests/run.cjs tests/v1_phase1.test.js`.
- [ ] Group tests by behavior/cost rather than historical phase numbers. Retain
  meaningful behavioral coverage; use an explicit migration when a contract changes.
- [ ] Run coverage once per applicable CI matrix job instead of separately
  repeating the same full suite (AUD-P2-15). Scope documentation and VSIX jobs to
  relevant changes while preserving required status checks and the full release matrix.
- [ ] Keep complete failure logs. Rerun only to investigate a failure or validate
  a new change; do not treat an unexplained passing retry as a fix (`VERIFY-001`).
- [ ] Replace tests that cement defects. Example: the "O(1) appends" history test
  that never measures size. Each replacement asserts the measured property.

### `HANDOFF-001` — portable agent instructions and handoff templates

**Status:** Planned; supporting documentation work, without changing the product
execution order.

- [ ] Define one versioned Markdown handoff standard and short Author, Reviewer
  and advisory examples for Antigravity, Codex, Claude Code and Cursor. Separate
  task role from provider identity while preserving independent CoAgent Review
  assignments and review policy. Keep provider launch details outside
  the shared template; document permissions as explicit capabilities.
- [ ] Specify a header with task ID, role, mode, topic branch, target branch,
  accepted base SHA and candidate SHA. Distinguish the PR target from the reviewed
  candidate. Identify dirty-worktree reviews with a captured diff digest and
  untracked-file inventory; a HEAD SHA alone does not identify uncommitted work.
  Release approval additionally binds the tree SHA and package artifact SHA-256.
- [ ] Require a concrete objective, allowed scope, exclusions, acceptance criteria
  and a short applicable-invariants checklist referencing the authoritative
  [rules](../.agents/rules/00-core-invariants.md). Distinguish rule priority
  (P0/P1/P2) from finding severity (P1/P2/P3, or the audit's P0–P3 scale).
  Preserve read-only review, consent, redaction, branch protection and unrelated work.
- [ ] Select verification by the [quality gate](../.agents/rules/04-quality-gate.md).
  Record commands, scope/platform, exit results and evidence references; distinguish
  PASS, FAIL and NOT_RUN and explain inapplicable checks. Define a clean diff as
  passing diff validation, not discarding existing edits. Require owned-process
  cleanup evidence for lifecycle changes; never infer zero leaks from an assertion.
- [ ] Specify Author output as changes, evidence and remaining work; strict Reviewer
  output retains the [State Envelope](../.agents/rules/03-author-reviewer.md), including
  REVIEW, SNAPSHOT, COVERAGE, VERDICT, findings, CHECKS and END_REVIEW. READY requires
  complete declared coverage, applicable verified checks and zero unresolved P1/P2
  findings; missing evidence, snapshot mismatch or truncation blocks readiness.
  Separate task readiness from release approval. Advisory handoffs request concise
  recommendations; ordinary consult formatting changes remain tracked in CONSULT-001.
- [ ] Keep the shared core short through task-specific context and repository-relative
  references rather than copied rulebooks, transcripts or full logs. Include essential
  constraints inline and supply bounded excerpts when the recipient cannot access
  referenced files. Make unresolved decisions and the next action explicit.
- [ ] Forbid completion claims in a handoff that the roadmap does not back with
  evidence. The audit found two such claims in the previous handoff.
- [ ] Review examples as fresh handoffs with no prior chat context, checking snapshot
  identity, accessible references, role separation and honest unexecuted checks.
  Update HANDOFF.md to use the standard and point to this roadmap.
  Acceptance for this documentation task is content/link review and git diff --check;
  it requires no runtime tests or backend AI invocation solely to validate prose.

## 2. Generic MCP, plain consultation and streamlined surface

### `MCP-001` — interoperability independent of installer support

- [x] Document host/backend separation, generic stdio setup and the distinction
  between automatic registration support and MCP compatibility.
- [x] Add focused acceptance for a client with an arbitrary name and no optional
  capabilities: initialization and tools/list must not invoke a backend, require
  a recognized host or mutate host registrations. A missing backend must not hide
  tools; its invocation returns an actionable error. Verified in `tests/generic_mcp.test.js`.
- [x] Confirm a fixture-backed call through the generic MCP boundary, then record
  a real Continue Agent-mode connection separately when that host is available.
  Verified generic stdio call boundary in `tests/generic_mcp.test.js` and `tests/mcp.test.js`.
- [x] Keep startup independent of optional archive maintenance failures, without
  concealing errors that affect execution safety or active session ownership.
- [ ] A malformed `config.json` must not hide tools. Fall back to defaults and
  report the configuration error in `doctor` and on execution (AUD-P2-11).
- [ ] Resolve the workspace from MCP roots when `workspace_path` is absent, or
  require it. Never default silently to the server's working directory
  (AUD-P2-9).

### `STARTUP-001` — non-blocking MCP server initialization

**Status:** Implemented; asynchronous background session maintenance unblocked server connect.

- [x] Eliminate synchronous session pruning from the MCP connection critical path:
  `pruneExpiredSessions` runs as a background task after `server.connect(transport)`.
- [x] Handle and record background pruning failures safely as redacted warnings.
- [x] Signal handlers (`SIGINT`, `SIGTERM`) and standard input EOF await the
  background pruning task during graceful shutdown.
- [x] Prevent MCP client connection timeouts on Windows caused by blocking directory
  sweeps and file lock contention during host startup, without deleting active sessions.

### `SURFACE-001` — tool surface consolidation and clear profile contracts

**Status:** Implemented; canonical six-tool surface defined and legacy actions aliased to consult.

- [x] Define the canonical six-tool public interface: `consult` (with optional
  `task_type` "architecture", "debug", "implementation" and context files),
  `review`, `doctor`, `session`, `cancel`, `issue`.
- [x] Retain the compact profile via the `run` gateway with legacy action
  compatibility (`analyze`, `debug`, `implement` mapped to `consult` with
  deprecation warnings).
- [x] Deprecate and alias the separately advertised `analyze`, `debug` and
  `implement` tools to `consult` handlers with argument mapping. Removed the
  phantom `context_files` field from `debug`. The six-tool baseline excludes the
  temporarily advertised aliases.
- [ ] Remove remaining phantom contract fields and deduplicate prompt tokens:
  - Remove `doctor.repair` and `doctor.workspace_path` from `doctor.tool.ts` inputSchema (both are currently ignored; removing them saves context tokens for MCP clients, AUD-P2-8; tracked in `SIMPLIFY-001`).
  - Eliminate prompt token redundancy in `review` caller instructions: caller handoffs must not duplicate State Envelope rules (`VERDICT`, `[P1/P2/P3]`), because `review.tool.ts` automatically formats the required envelope protocol in the task prompt.

### `CONSULT-001` — separate advice from release approval and structured verdict output

**Status:** Implemented; consult decoupled from State Envelope and structured verdict exposed.

- [x] Ordinary-advice mode for consult: no State Envelope instructions or gate;
  `verdict: "NOT_APPLICABLE"`.
- [x] Audit status in `structuredContent` (`verdict`, `reason`, `sessionHandle`)
  validated by `outputSchema`; tool errors (`isError`) are distinct from audit
  conclusions.
- [x] Keep review's diff preparation with an explicit strict-audit default.
- [x] Preserve structured execution status, typed errors, cancellation and privacy.
  A textual READY or PASS is not proof that a command ran or a release is approved.
- [x] Verify plain answers, opt-in audit formatting, partial/truncated output and
  legacy calls.

## 3. Smaller execution path, robust sessions and honest routing

### `EXEC-001` — pure backend resolution, bounded probes and enforceable policy

- [x] Make backend resolution (`src/backends/routing.ts:resolveBackend`) strictly
  read-only: no `setDefaultBackend` mutation during `auto` resolution. Verified in
  `tests/routing.test.js`.
- [ ] Prefer an explicit backend or configured default. Preserve the onboarding error
  when auto-selection is ambiguous, reported with its own error code (see `ERRORS-001`).
- [ ] Bounded probe caching (AUD-P1-4):
  - one cached probe per backend, bound to the resolved executable path, mtime,
    version output, relevant environment variables and configuration digests;
  - bounded TTL, with forced refresh in `doctor`;
  - adapters do not re-probe inside `execute` (Gemini `--version`; Claude no
    longer does, see `CLAUDE-BACKEND-001`);
  - the agy `/usage` call runs only in `doctor`, never on the request path;
  - fail-closed sandbox checks and fresh consent evaluation on every turn.
- [x] Keep doctor as an explicit diagnostic operation; `inspectQuotas()` is
  integrated into `runDoctor()` and backends under active cooldown are excluded
  from `ready_backends`. Authentication evidence honesty is reopened under
  `DIAGNOSTICS-001`.
- [ ] Validate `model` identifiers in the schema and in each adapter before they
  reach argv (AUD-P1-6).
- [ ] Parse Codex configuration with `smol-toml` (top-level `model` only), or
  omit `-m` when no model was requested and govern the model the CLI reports
  (AUD-P1-11).
- [ ] Consent the caller cannot assert (AUD-P1-7):
  - when the client supports MCP elicitation, ask the user before a governed model
    runs;
  - otherwise fail with `POLICY_DENIED` and instructions;
  - govern the effective default model of every backend, including agy's;
  - never replace consent with an agent-generated assertion.

### `CLAUDE-BACKEND-001` — Claude Code in restricted read-only mode

**Status:** Implemented on `feat/claude-restricted-backend`; focused tests and a
live MCP check passed locally on Windows; acceptance open until CI is green. Order: it does not precede the order-1 audit blockers unless the owner
decides otherwise. It applies the target shape of `EXEC-001` (probe, model
validation), `CLI-INTERACT-001` (unknown events, typed failures) and
`REDACTION-002` (no answer redaction in the adapter) to Claude only.

Why: the Reviewer role runs through `review`/`consult` with `backend: "claude"`.
`--bare` accepts only `ANTHROPIC_API_KEY`/`apiKeyHelper`, so subscription users
could not use Claude, and the adapter had no streaming or resume.

Live evidence (Claude Code 2.1.289, haiku, 2026-10-05; redacted recordings in
`tests/fixtures/claude-cli/recordings/`):
`--restricted` authenticates with the claude.ai subscription
(`apiKeySource: "none"`); `system/init` reports only `Glob, Grep, Read` and no
MCP servers; a request to create a file and run a shell command was refused
and no file was created; project `.claude/settings.json` hooks and project
`CLAUDE.md` were not loaded; `--session-id` then `--resume` continued the same
session; authentication, unknown model and unknown session failures are
structured (`assistant.error`, `result.is_error`, `api_error_status`,
`result.errors`); `claude auth status` reports login state as JSON (exit 0/1)
without a model call.

- [x] `--restricted` replaces `--bare`; flags: `-p --restricted --tools Read,Glob,Grep
  --permission-mode dontAsk --permission-prompts none --settings
  {"disableAllHooks":true} --strict-mcp-config --mcp-config {"mcpServers":{}}
  --output-format stream-json --verbose --include-partial-messages`.
- [x] Fail closed per run: `SANDBOX_UNAVAILABLE` unless `system/init` reports only
  the read-only tools, no MCP server and `dontAsk`.
- [x] `claude.collector.ts`: deltas, final messages, tool start/finish, status,
  usage and terminal result; unknown event types and `system` subtypes produce one
  warning each.
- [x] `claude-errors.ts`: table-driven mapping of CLI error categories, HTTP status
  and anchored `result.errors` prefixes to error codes; no stderr regex.
- [x] Fresh `--session-id <uuid>` per new session, `--resume <uuid>` for
  continuation; malformed IDs rejected before spawn.
- [x] `--effort` for `low|medium|high|xhigh|max`; model identifiers validated
  before argv (AUD-P1-6 pattern), including environment alias overrides;
  top-tier governance unchanged.
- [x] Probe: `--version` (minimum 2.1.259) and `claude auth status`; no probe in
  `execute`; no model call.
- [x] Focused Claude and routing suites pass through `tests/run.cjs` (33/33,
  Windows, 2026-10-05; 7 in `claude.adapter`, 12 in `claude.collector`, 4 in
  `claude.usage`, 6 in `quota_and_gemini`, 4 in config/doctor/routing). The local
  run coincided with an unrelated Chrome application being closed, consistent
  with AUD-P0-1.
- [x] Live check through the built server (`consult`, `backend: "claude"`,
  haiku, 2026-10-05): `doctor` lists Claude in `ready_backends`; turn 1 received
  the prompt on stdin, used only `Read` and `Glob`, refused file creation and a
  shell command, and created no file; turn 2 resumed the session and recalled
  the file content.
- [x] Native quota before backend selection: optional `CliAdapter.inspectQuota()`,
  implemented for Claude through `claude -p /usage` on verified CLI versions (>= 2.1.289;
  versions older than 2.1.289 skip inspection to prevent prompt leakage to models; zero cost and
  no turn verified live and on every read) and called by `inspectQuotas` for
  `doctor` and `smart_quota`. Window summarizing is shared with Gemini
  (`src/backends/quota.ts`). Gemini still reads `/usage` inside its probe;
  moving it to `inspectQuota` belongs to `EXEC-001`. Ranking by measured
  headroom (not only exhaustion) is a separate routing decision.
- [ ] `inspectQuota` latency and timeout optimization (Opus audit note): when the
  60 s quota cache expires, `smart_quota` routing can block for up to 5 s on `--version`
  plus 15 s on `/usage` without an abort signal before selecting a backend.
  Mitigations: shorten the `/usage` timeout (e.g. 3–5 s), pass through `AbortSignal`,
  or restrict synchronous native reads to `doctor` while routing relies strictly on
  cached or asynchronously refreshed measurements.
- [ ] Skills for audits: decide how workspace skills reach the Reviewer. The
  profile exposes no `Skill` tool, and `--restricted` ignores project settings;
  extend `CLAUDE_READ_ONLY_TOOLS` only with live evidence that the profile stays
  read-only.
- [ ] Open: user-level hooks and plugins could not be observed (none installed);
  their exclusion rests on the `--restricted` help text and the project-settings
  evidence. Built-in CLI plugins (`agents-md`, telemetry) still run.

### `ROUTING-MIGRATE-001` / `QUOTA-001` — honest circuit breaker and native quota introspection

**Status:** Partially implemented; parsed reset cooldowns are broken in
production (AUD-P1-1).

- [x] Gemini (`agy`) native quota: `agy --output-format json -p "/usage"` is parsed
  into measured `remaining_fraction`, `headroomPercent` and `resetsAt`. Moving this
  probe off the request path is tracked in `EXEC-001`.
- [x] Codex classification: `usage limit`, `hit your usage limit` and `spend cap`
  map to `RATE_LIMITED`.
- [ ] Record exactly one cooldown per rate-limited turn, using the parsed provider
  reset when present and the tiered backoff otherwise. Remove the second write in
  the controller. Acceptance: a regression through the controller sequence, not
  only `checkAndRecordRateLimit` (AUD-P1-1, order 1).
- [ ] Classify from structured payloads first and anchored provider phrases
  second. Stop matching bare `429`, `quota` or `auth` substrings. Parse `ms`
  before `m` and decimal durations (AUD-P2-1).
- [ ] Remove remaining synthetic telemetry: a missing `remaining_fraction` is
  unmeasured, not 100% headroom (AUD-P2-2).
- [ ] Claude Code status: distinguish unauthenticated or logged-out states from
  runtime process errors without stderr substring guesses. Not implemented;
  `authStatus` is always `unknown`.
- [ ] Rebrand and document the circuit breaker: clearly distinguish observed
  cooldown states from native quota meters. `smart_quota` selects the first
  permitted backend without an observed cooldown; it does not score headroom.

### `SESSION-001` — safe auto-resume and first-class handle exposure

- [ ] Expose `sessionHandle` as a first-class machine-readable field in `structuredContent`
  (when continuation is available) so calling orchestrator models do not need to scrape Markdown blockquotes.
- [ ] Session continuation controls:
  - Introduce `session_mode: "new" | "auto" | "none"` in execution schemas. The
    audit recommends `"none"` as the default for `consult`, so ordinary advice
    creates no session or history files; record the compatibility decision.
  - Explicit handle precedence: if `session_handle` is explicitly supplied, use it
    directly; fail closed if it is invalid or busy.
  - Opt-in `"auto"` mode: reuse the most recent active idle session strictly matching the canonical
    `workspace` AND `backend` within a strict 15-minute inactivity TTL.
  - Collision safety: if the candidate session is currently busy, implicit `"auto"` mode safely spawns
    a fresh isolated session rather than failing with `SESSION_BUSY`.
  - Ephemeral `"none"` mode: execute without creating on-disk session records or durable history files.
  - Fail-open continuation fallback: allow exactly one fresh-session fallback ONLY for positively
    identified remote native continuation expiration before task execution begins (with an explicit `warnings` notice).
    The fallback turn must strictly share the original request's remaining absolute time budget and caller
    cancellation signal without restarting or extending deadlines. Never retry policy denials, sandbox failures,
    cancellations, or partial-execution errors.
- [ ] Enforce workspace ownership consistently (AUD-P1-8, order 2): MCP resources
  must not list or return other workspaces' sessions and histories, unless they
  are explicitly documented as an owner-wide view. The `session list` action
  follows the same rule.

### `LOCKS-001` — lease integrity

**Status:** Open (AUD-P1-9).

- [ ] Create lease files atomically (write a temporary file, then link or rename),
  so no lease is ever observable empty.
- [ ] Reclaim an empty or unparsable lease older than a bounded age. Add a maximum
  age based on `createdAt` so a reused PID cannot keep a dead owner's lease alive.
- [ ] Remove lease deletion from `sweepExpiredSessions`; reclamation belongs to
  `withFileLock` and its token protocol.
- [ ] Acceptance: crash-between-open-and-write, reused-PID and concurrent-sweep
  regressions.

### `CLI-INTERACT-001` — stream activity liveness and backend failure modes

- [ ] Specify an activity-aware inactivity policy for subprocess supervision in `src/execution/process.ts`:
  track stdout/stderr data events and tool progress (`lastDataAt = Date.now()`) while explicitly accommodating provider-appropriate
  silent reasoning intervals; classify idle expiration as an inactivity timeout (not a proven freeze).
- [ ] Enforce configurable idle thresholds, an absolute maximum wall-clock ceiling, and leak-free process
  tree teardown on idle expiration, absolute timeout, and caller cancellation. Stream activity must never
  extend the caller's absolute budget.
- [ ] Add focused acceptance tests: continuous output, silent reasoning intervals, absolute timeout cutoffs,
  caller cancellation, and process tree teardown without survivors.
- [ ] Tolerate unknown native event types from agy and other CLIs with a warning;
  fail only on invalid known events (AUD-P1-5, order 2).
- [ ] Map CLI failure modes (authentication expiration, rate limits, context length
  overflow, crashes, unexpected exit signals) to typed errors through the
  `ERRORS-001` error type.
- [ ] Investigate and fix MCP server icon display across hosts (Antigravity/Gemini/VS Code):
  ensure icon references conform to host expectations (base64 data-URI vs static assets/file URIs vs plugin manifest metadata).
- [ ] Evaluate prompt token efficiency: reject binary prompt/vector encoding schemes across the
  standard CLI/LLM text interface on simplicity and architectural grounds (text BPE tokenizers
  do not benefit from raw binary byte packing); focus token savings on lean system instructions,
  concise diffs, and eliminating redundant State Envelope formatting from ordinary consult calls.

### `HISTORY-002` — continuation versus archival storage

**Status:** Blocker (AUD-P0-3, AUD-P1-3).

- [ ] Persist streamed answers as append-only deltas. A final `assistant_message`
  replaces the deltas on load, and the `.json` snapshot is materialized once, on
  `turn_finished`. Acceptance: persisted bytes stay within a small constant factor
  of the answer size (the audit measured 54–112×).
- [ ] Uncouple archive failures from execution:
  - initial, periodic and final flush errors become redacted warnings with
    `historyAvailable: false`;
  - the initial flush must never prevent a CLI launch;
  - capacity limits evict the oldest sessions (LRU) instead of refusing new turns.
- [ ] Move post-execution bookkeeping (session metadata, archive, cooldown) out of
  the execution `try`. A bookkeeping failure never discards a successful answer;
  it becomes a warning with continuation disabled (AUD-P1-3).
- [ ] Preserve fail-closed session ownership and safety: keep turn acquisition,
  lease releases (`releaseSessionTurn`), turn mutual exclusion, and workspace binding
  strictly fail-closed. A lease-release failure is a session error, not `HISTORY_ERROR`.
- [ ] With archival history disabled, a one-shot call must not require history files.
- [ ] Replace the global `history/store` lock and per-flush `.capacity.meta`
  rewrite with per-session locking and lazily computed capacity (AUD-P2-12).
- [ ] Retain simple file-based `.jsonl` / `.json` sessions or ephemeral turns;
  SQLite is deferred.
- [ ] Define retention, default mode, resource/tool behavior and migration before
  altering storage. Preserve existing histories, recovery and pagination
  consistency. Do not delete user data outside the documented retention.

### `INSTALL-001` / `MIGRATION-001` — optional setup and presentation

Shared setup exists; its native-host acceptance remains partial as recorded below.
Do not expand the supported-host list as a prerequisite for core MCP compatibility.

- [ ] Isolate setup/repair, native-host probes and VSIX/plugin presentation from
  core startup and backend execution. Ship setup as a separate entrypoint and
  bundle, so the core server no longer carries the TOML/JSONC parsers. Unknown
  arguments must not terminate a server started by a host (AUD-P2-10).
- [ ] Retain selected-client consent, idempotence, stable owned runtime paths,
  conflict detection, preservation of unrelated settings and private backups.
- [ ] Never remove a working registration to test a replacement. Use isolated
  profiles, verify the replacement in that host, and retain/restore the original
  on failure. Do not rely on uninstall callbacks for external settings.
- [ ] Complete native host/update/repair and plugin/VSIX lifecycle acceptance only
  for integrations being changed or claimed as supported. Keep UI/icon evidence
  separate from protocol compatibility and backend readiness.

Host evidence recorded on 2026-10-05 (historical; not fresh validation):

| Host | Evidence | Remaining acceptance |
| --- | --- | --- |
| Codex 0.160.0 | App-server discovery of nine tools and `doctor` in the existing manual profile; fresh isolated install, managed update and idempotent repair passed actual host calls. | Native plugin loading, composer/name/icon and existing-chat refresh/UI. |
| Claude Code | Existing registration preserved; direct runtime initialize/list/doctor passed; bundled executable resolution follows installed extension updates. | Native-host call/connection acceptance for fresh setup, update and repair; backend authenticated execution. |
| agy 1.2.16 | Existing registration preserved; direct runtime initialize/list/doctor passed. | Native plugin inventory/loading and real chat discovery/call/presentation; managed updates deferred without native-host acceptance. |
| VS Code | Native provider retained; manual active-profile/workspace registration takes precedence; setup/remote/multi-root paths exercised by source tests; VSIX packages. | Real install/update/uninstall lifecycle, fresh/existing chat, icons and alternate-profile UI. |
| Insiders | Historical repaired profile preserved. | Executable/application installation and all native UI acceptance remain unverified. |

The CLI provides `setup`, `repair` and read-only `status`. VSIX first-run
onboarding and `CoAgent: Setup or Repair Chat Clients` reuse that implementation.
Selected local-default clients are remembered. Immutable runtime bundles are
published under `~/.coagent8/runtime/<sha256>/index.cjs`. The repaired manual
`~/.coagent8/runtime/index.cjs` registrations are preserved. No user host
configuration was removed or replaced during the real acceptance checks.

### `SIMPLIFY-001` — deletions and deduplication

**Status:** Open (AUD-P2-3 to AUD-P2-6, AUD-P2-8 and P3 nits). Behavior must be
preserved or explicitly migrated; deletion is not a contract change unless stated.

- [ ] Remove production test hooks `coagent8_MAINTENANCE_GATE` and
  `coagent8_MAINTENANCE_DELAY_MS`; inject the maintenance dependency in tests
  (AUD-P2-3).
- [ ] Replace the three deprecated `*.tool.ts` files and the duplicated `run`
  mapping with one alias table. Merge the Codex and Gemini structured-error
  extractors. Validate arguments once at the server boundary (AUD-P2-4).
- [ ] Drop the Gemini adapter's second timeout (AUD-P2-5).
- [ ] Delete dead code (AUD-P2-6):
  - the unused half of `StreamReducer`;
  - `killProcessSafely`, `getProgressStage`, `getToolProfile`, `CONFIG_FILE`,
    `DEFAULT_CONFIG_DIR`, `resolveCodexCommand`, `SessionLockData`;
  - the unreachable truncation-string check in `git.ts`.
- [ ] Remove or implement phantom contract fields: `doctor.repair`,
  `doctor.workspace_path`, `resources.listChanged`, and the hardcoded doctor
  `security_policy` claims (AUD-P2-8).
- [ ] Stop banner stripping for JSON-backed adapters. Redact progress messages
  once. Correct stale model names in tool descriptions. Make `cancel` report
  whether anything was cancelled. Redact home paths in `session list` (P3).

## Existing completed work and remaining correctness

These statuses summarize prior implementation; they are not fresh test results.

- [x] `GEMINI-001`: production denial-stream handling and regressions for both
  orders preserve typed sandbox denial and reject genuine duplicate terminals.
- [x] `REDACTION-001`: escaped/structured home paths and synthetic secret bounds.
  Output integrity is a separate open item (`REDACTION-002`).
- [x] `ARCH-001/002`: identity primitives break the session/history cycle;
  cancellation is composed explicitly; cooldown writes moved out of rendering.
- [x] `PARSER-001`: live Codex collector coverage replaces the unused parser path.
- [x] `ROUTING-001`: smart_quota uses observed availability/cooldowns, not invented
  account headroom. Preserve or explicitly migrate that external contract.
- [x] `TYPES-001`: narrowed untrusted boundaries; three explicit `any` remain in
  `parseGeminiUsage`.
- [ ] `DIAGNOSTICS-001`: authentication evidence must be explicitly unverified for
  every backend. Reopened: Codex reports `authenticated` from file presence or
  environment variables (AUD-P2-2). Claude reports the CLI's own `claude auth status`
  login state and states that token validity is proven only by an execution.
- [ ] `ERRORS-001`: one typed error protocol (AUD-P1-2, order 1):
  - a `ToolError` class carries an `ErrorCode`;
  - no `CODE:` string prefixes and no prefix parsing in `server.ts`;
  - an unknown failure maps to `PROCESS_ERROR`, never `INPUT_LIMIT`;
  - `ONBOARDING_REQUIRED` gets a defined code.

  Also review the 37 empty `catch {}` blocks individually and distinguish
  expected absence from actionable I/O errors, including `ensureConfigDir`
  (AUD-P2-7).
- [ ] `DOCS-001`: expand compressed logic and document meaningful exported contracts.
- [ ] `VERIFY-001`: record repeatable validation without retroactively assigning
  the historical unexplained 133/134 failure to a later discovered race. Retained
  logs under ignored `tests/artifacts/verification/` record two reproduced
  failures (a 10 ms lock-queue assumption and fixture startup starvation) and
  their fixes; production deadlines were unchanged.

### `TESTS-001` — consolidated test structure

The structural migration is implemented; final release validation remains pending.

- [x] Test files, fixtures, helpers, runner, consumer smoke and generated test
  evidence live under tests/. Production, documentation and VSIX tooling remain
  outside that directory. Temporary consumer installs are isolated and cleaned up.
- [x] One recursive portable discovery helper excludes fixtures/helpers/artifacts,
  preserves the inventory, supports nested tests and rejects empty discovery.
- [x] MCP requests are bounded; teardown awaits owned processes before deleting
  temporary directories, including failure paths. Assertions remain meaningful.
- [x] Package checks reject test/development artifacts while preserving required
  runtime assets, bundled loading and supplied-tarball consumer verification.
- [x] Imports/configuration follow the migration and the unused Node 20 polyfill
  was removed. Test evidence and API/VSIX artifacts have separate locations.
- [ ] Verify the exact package, coverage thresholds and supported OS/Node matrix
  at release acceptance; complete independent review of the resulting snapshot.

## Release acceptance and deferred work

### `BETA-001` — publish 1.0.0-beta.1 and 1.0.0-beta.2 to invited testers

**Status:** Blocked by `AUDIT-001`. Testers run CoAgent on their own desktops,
so no beta ships while a P0 finding is open.

Beta 1 gate:
- [ ] Execution order 1 is complete: every audit blocker is closed in its owning
  milestone with a regression test, and the audit reproductions pass against the
  candidate.
- [ ] Run the full local gate below on a clean checkout. All six CI jobs pass for
  the candidate commit.
- [ ] Verify on a real Windows desktop that a consult and a review open no visible
  windows. Record the helper launch count.
- [ ] Prepare the feedback channel:
  - a GitHub bug-report issue template that asks for the `issue` tool output,
    `doctor` output, OS, Node version and backend CLI versions;
  - a short tester guide in the README (install, register in a host, report a bug).
- [x] Create `CHANGELOG.md` (Keep a Changelog) with an Unreleased section.
- [ ] Create the GitHub triage labels defined in
  [Git governance](../.agents/rules/02-git-workflow.md#7-issues-and-tester-feedback)
  and apply the branch and tag protection in its section 8.
- [ ] Release with the prerelease procedure in
  [Git governance](../.agents/rules/02-git-workflow.md#prerelease-beta-or-release-candidate):
  - release PR;
  - annotated tag `v1.0.0-beta.1` on `release/v1.0.0`;
  - artifacts built from the tag, with SHA-256 digests;
  - GitHub pre-release;
  - optional npm `next`.

Beta 2 gate:
- [ ] Execution order 2 is complete.
- [ ] Every beta 1 issue is triaged. No open P0/P1 issue remains; deferred issues
  have a recorded decision.
- [ ] Same verification and publication steps as beta 1.

An independent review by the Reviewer is required for each beta's changes before merge,
as for any PR. The hash-bound release approval applies from RC 1.

### `RC-001` — freeze, validate and accept 1.0.0-rc.1 (and rc.2 if needed)

**Status:** Blocked by `BETA-001`; the existing version label is not acceptance.

- [ ] Close every audit P0/P1 finding in its owning milestone with a regression
  test. Re-run the audit reproductions against the candidate.
- [ ] Close the included core milestones (`SURFACE-001`, `EXEC-001`, `ROUTING-MIGRATE-001`,
  `SESSION-001`, `CLI-INTERACT-001`, `HISTORY-002`, `LOCKS-001`, `REDACTION-002`,
  `PACKAGE-001`, `SIMPLIFY-001`) and applicable correctness, verification and
  documentation work with evidence references. Record optional integration limits
  and conditional/deferred items explicitly.
- [ ] No open P0/P1 issue from either beta.
- [ ] Freeze the 1.0.0 scope and record included PRs, the accepted base and committed
  candidate. Reconcile README, architecture, runtime contract, contributor rules
  and handoff with implemented behavior; synchronize version metadata and assets.
- [ ] Validate a clean checkout and the exact package artifact with the full
  release gate below, all six supported CI jobs and applicable integration checks.
- [ ] Record soak evidence for concurrency, cancellation/EOF and owned-process
  cleanup, locks, restart recovery, history modes and bounded memory/cache behavior.
- [ ] Obtain independent Reviewer approval bound to base SHA, candidate SHA, tree
  SHA and artifact SHA-256, with complete coverage and no unresolved P1/P2 findings.
- [ ] Record RC acceptance against that snapshot and artifact. A correction after
  RC 1 ships as `1.0.0-rc.2` with renewed validation and approval. The accepted RC
  becomes `1.0.0` through the final release PR, verified main snapshot and
  publication defined by Git governance.

Use the [quality gate](../.agents/rules/04-quality-gate.md) for each change. Full
release validation still requires typecheck, build, all tests, package integrity,
exact-tarball consumer checks, applicable coverage/documentation checks, the six
supported CI jobs, soak evidence and an independent review by the Reviewer bound to base,
candidate, tree and artifact hashes. No unresolved P1/P2 findings may be released.
An optional integration's unverified UI must not be advertised as supported.

A prerelease content change invalidates its exact-artifact approval; this
is not a requirement to rerun all runtime tests after every documentation edit.
Work on topic branches. This plan does not authorize push, merge or publication.

Interactive auto-confirm, SQLite, generated diff UI and multi-backend consensus
remain deferred. Activity-based inactivity supervision is scheduled under
`CLI-INTERACT-001`; structured consult output is implemented (`CONSULT-001`).
The interactive CLI RFC (not in the repository) is historical discussion,
not an instruction to implement or weaken consent.

The simplification is complete only when:
- generic MCP use works without setup;
- ordinary consultation returns an ordinary, unaltered answer;
- missing backends or a malformed configuration do not hide tools;
- cancellation leaves no owned survivors and never touches an unowned process;
- a full archive never blocks execution;
- Windows tests do not interrupt the desktop;
- prose edits do not invoke runtime verification.

Planned changes to history and tool contracts must carry explicit migrations and
focused evidence.
