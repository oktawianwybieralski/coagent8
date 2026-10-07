# CoAgent8 roadmap to v1.0.0

**Next release:** `1.0.0-beta.2`, the first release for testers. **Current package
version:** `1.0.0-beta.2`, an unaccepted development candidate. `1.0.0-beta.1`
remains the npm name placeholder (`REPO-001`).
**Direction and status reconciled:** 2026-10-07, implementation snapshot
`24052e3`. **Beta 2 readiness:** BLOCKED. Earlier audit fixes are implemented
on the local stack, but newer approval/sandbox findings remain open and the
integrated candidate has no completed six-job CI/release approval.

This is the single active implementation and acceptance plan for the 1.0.0
release train. The current version label is development metadata. It does not
establish that a beta or release candidate has been accepted. Each stage requires
the milestones, compatibility decisions and evidence defined for it below.

The current priority is a simple, client-independent MCP-to-CLI bridge that does
not interrupt desktop work. After the audit, the first obligation is that it cannot
harm the desktop or the user's data. Process identity, output integrity and storage
availability come before new features. This direction supersedes the
installation-first sequence in the earlier review and handoff.

## Current snapshot status

This remains the single active plan. `[x]` below means implementation with the
cited local evidence, not merged, published, matrix-verified or release-approved.
Historical measurements retain their date and snapshot. Later decisions supersede
earlier prototypes, especially the compact profile and dual-channel result.
The local stack at `24052e3` is ahead of `release/v1.0.0`; integration is pending.

| Area | Implemented locally | Remaining |
| --- | --- | --- |
| Desktop/process safety | Owned handles/groups, protocol interrupt, hidden hermetic fixture launches; recorded Windows native cleanup | Inherited MCP isolation, POSIX parent-death cleanup, fresh candidate matrix |
| Public output | Answer/diagnostic redaction split, plain consult, Markdown execution results, final-answer selection | Sticky commentary truncation/count budgets, review completeness |
| Storage/errors | Best-effort bounded archive, ENV off mode, workspace isolation, renewed leases, typed errors, single cooldown write | Ephemeral session mode, cache-failure tolerance, end-to-end budget |
| Discovery/models | Six tools, roots, cached probes, best-effort catalogs, effective-model elicitation with explicit approval | Coalesced misses, fuller invalidation, catalog/default redesign |
| Packaging/verification | Untracked dist, tarball-derived plugin/VSIX, consumer provenance, coverage once per job configured | Exact release artifact, six-job CI, native/UI acceptance where advertised |
| Governance | Consent by approximate price (relative to the default, 20 USD limit, remember for unknown prices); models and defaults from the CLIs and `config.json` (`CUR-010` closed locally) | Interactive approval UI acceptance |

The [review at `24052e3`](PROJECT_REVIEW_2026-10-05.md#review-at-24052e3-2026-10-07)
defines `CUR-*` findings. Their owning items below take precedence over
historical completion summaries. `CUR-012` was added during documentation/source
alignment, from inspection of snapshot-capacity accounting, without a runtime probe. Start with approval correctness and inherited
MCP isolation, then the execution/cache/session work. Source inspection and
temporary probes are not committed regression coverage.

Evidence from that review: `npm test` 266 total, 263 pass, zero fail, three
POSIX skips (Windows, source-loaded unit/e2e tests; setup used pre-existing dist
of unproven freshness). Typecheck passed. A later fresh build and fixture-backed
consumer check passed; the source and bundle matched that tarball. The artifact
hash and limits are in the review. These results predate this documentation edit.

## Release sequence

After the `1.0.0-beta.1` name placeholder, 1.0.0 ships through two betas for
testers (`beta.2`, `beta.3`) and up to two release candidates. Betas go to
invited testers, who report problems as GitHub issues (the `issue` tool prepares
a sanitized, prefilled report). Release candidates follow only when beta feedback
contains no open P0/P1 defects.

| Stage | Version | Audience | Entry gate |
| --- | --- | --- | --- |
| Beta 1 | `1.0.0-beta.1` | None: npm name placeholder (2026-10-05), first commit of the history | - (`REPO-001`) |
| Beta 2 | `1.0.0-beta.2` | Invited testers | Execution order 1 complete (all audit blockers); `BETA-001` checklist |
| Beta 3 | `1.0.0-beta.3` | Invited testers, wider circle | Execution order 2 complete; no open P0/P1 issue from beta 2 |
| RC 1 | `1.0.0-rc.1` | Release candidate | Execution orders 3-4 complete or explicitly deferred; scope frozen; `RC-001` checklist |
| RC 2 | `1.0.0-rc.2` | Only if needed | Release-readiness corrections to RC 1 only |
| Final | `1.0.0` | Public | Accepted RC; final release PR to `main` per [Git governance](../.agents/rules/02-git-workflow.md) |

All 1.0.0 work lands on the release branch `release/v1.0.0` through
squash-merged pull requests from topic branches. Each prerelease stage is an
annotated tag on that branch (`v1.0.0-beta.2`, `v1.0.0-beta.3`, `v1.0.0-rc.1`);
the final release is a PR from `release/v1.0.0` to `main`, tagged `v1.0.0`.
Branching, commit, pull request, versioning, changelog and release procedures
are defined in [Git governance](../.agents/rules/02-git-workflow.md).

Every stage publishes the exact artifact that passed its gate:
- prerelease versions are published as GitHub prereleases and, optionally, under
  the npm dist-tag `next`, never `latest`. The `0.0.1` name-placeholder
  arrangement is planned in `REPO-001`; current registry tags require verification;
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
  `SESSION-001`, `HISTORY-002` and `SIMPLIFY-001`;
- lower token cost per turn and per call across MCP clients (`CONTEXT-001`).

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

CoAgent8 lets an agent in a compatible MCP host ask a selected local coding CLI
for help and receive its public answer, with bounded execution, read-only access,
redaction and reliable cancellation. A host is the calling application; a backend
is the CLI executing the request. The same brand can fill either role.

### Why MCP over direct CLI commands?
While a human in a terminal can run `codex`, `agy`, or `claude` directly, CoAgent8
serves autonomous AI agents (in Cursor, Claude Desktop, Antigravity, VS Code, Zed):

1. **Agent-to-agent delegation.** Host models lack arbitrary shell execution
   privileges and knowledge of each CLI's invocation syntax; MCP standardizes
   peer invocation.
2. **Read-only execution policy (P0).** Codex app-server verifies its thread's
   readOnly/never profile; Claude verifies restricted read-only tools and empty
   MCP configuration; agy receives native `--sandbox`. External MCP tools in
   Codex/agy remain an open safety boundary (`CUR-002`), so this is not proof
   that every inherited capability is read-only.
3. **Protocol normalization.** Codex JSONL, agy NDJSON stream-json and Claude text
   become MCP text/data responses with sanitized diagnostics. Internal usage
   measurements are not promised as public execution-result token fields.
4. **Owned process supervision.** Owned child trees (`codex.exe`, `conhost.exe`)
   are torn down with bounded I/O. Teardown interrupts the backend's turn first
   and then targets only the owned handle or process group (`WINDOWS-001`).
5. **Routing (`smart_quota`).** Subsequent calls can select a provider without
   an observed cooldown, using cached quota headroom. A failed turn is not
   automatically retried or failed over.

Generic stdio configuration is the primary integration contract. A client does
not need a CoAgent8-specific installer adapter to discover tools. Setup commands,
VSIX/plugin packaging and branding are optional conveniences. Preserve existing
registrations and their rollback safeguards while separating those integrations.

The runtime enforces the State Envelope for `review` only; `consult` returns a
plain Markdown answer without a public verdict field. Every execution currently
requires a disk session; archival history is best-effort and can be disabled
with `coagent8_HISTORY=off`. The canonical profile advertises six core tools; the
deprecated aliases (`analyze`, `debug`, `implement`) stay callable but are not
advertised (`CONTEXT-001`). The compact profile was removed (`CONTEXT-001`). No new runtime option is implied by this plan unless an item
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

### Repository layout observations (2026-10-07)

**Status:** Optional maintenance observations, not accepted implementation work
or additional release gates. Recorded after comparing the current repository
with a screenshot of another project's responsibility-based layout and colocated
tests. The screenshot does not establish that project's dependency boundaries
or code quality.

- Preserve the current product boundaries: `backends/`, `execution/`, `sessions/`,
  `tools/`, `diagnostics/` and `integrations/`. They already group code by
  responsibility; copying another project's directory tree is not a goal.
- Keep the separate `tests/` layout established by `TESTS-001`. Consider making
  source-to-test correspondence more consistent where useful, while identifying
  tests that intentionally cover multiple modules. Colocated tests are an
  alternative convention, not an automatic improvement or a planned migration.
- During `HISTORY-002` or `SIMPLIFY-001`, inspect `sessions/history.ts` for
  separable responsibilities. Its size is a review signal, not evidence of a
  defect or a sufficient reason to split it. Extract only coherent owners with
  clear interfaces and preserve storage compatibility.
- Consider per-tool folders, such as `tools/review/`, only when related handlers,
  scope preparation and review policy form a substantial cohesive module. Avoid
  adding a directory around each small tool file.
- Keep descriptive filenames. Use `index.ts` for a module entrypoint when useful;
  do not replace explicit names with repeated generic entrypoint names or add
  re-export layers solely for visual uniformity.

Any implementation proposal should demonstrate a navigation, dependency or
maintenance benefit, fit the existing owning milestone and preserve behavior.
Prioritize active audit and desktop-safety work before cosmetic reorganization.

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
| [Handoff](HANDOFF.md) | Short handoff pointing here, not a second plan |
| [archive/](archive/) | Superseded plans and reviews; historical evidence, not policy |

Archived plans, the archived earlier review and the deferred interactive CLI RFC
do not define current policy. A completion mark (`[x]`) requires a reference to
evidence that measures the claim; source inspection alone is not runtime evidence.

## Audit remediation index

This index preserves findings at the historical `c265cdf` tree. Implementation
status belongs to each milestone and the current snapshot summary above; the
index is not a list of still-unfixed defects.

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
| Done | `WINDOWS-001` (window suppression), `VERIFY-SCOPE-001` (runner selection), `STARTUP-001`, `SURFACE-001`, `CONSULT-001` | Recorded below |
| 1 (gates beta 2) | `AUDIT-001` blockers: `WINDOWS-001` process identity, `REDACTION-002`, `HISTORY-002` archive isolation, `ROUTING-MIGRATE-001` cooldown fix, `ERRORS-001` typed errors, `PACKAGE-001`; `CHANGELOG-001` | No teardown without verified identity; answers unaltered except credential formats; archive failures never fail or block a turn; parsed resets survive; no unknown error reported as `INPUT_LIMIT`; no build output in Git. Each with a regression test derived from the audit reproduction |
| 2 (gates beta 3), owner may reorder | `CLAUDE-BACKEND-001`: Claude Code in restricted read-only mode with streaming and resume | Subscription authentication; per-run read-only check; typed failures from stream-json; adapter tests green in CI |
| 2 (gates beta 3) | Remaining audit P1: `EXEC-001` probes, argv and consent; `CLI-INTERACT-001` forward compatibility; `SESSION-001` resource isolation; `LOCKS-001`; `WINDOWS-001` supervision cost | One cached probe per backend and no probe in `execute`; validated model identifiers; consent not assertable by the caller; unknown agy events tolerated; resources honor workspace ownership; no permanent lease |
| 2 (gates beta 3), owner may reorder | `CONTEXT-001`: token cost and single-call success; the resolved-model and agy-denial fixes may land earlier | Measured budgets enforced by tests; minimal `{"proposal": ...}` call succeeds; resolved model and workspace in every result; client acceptance recorded for Claude Code and agy |
| 3 (gates RC 1) | `SESSION-001`, `CLI-INTERACT-001`, `HISTORY-002` remainder, `SIMPLIFY-001`, audit P2 items | Safe auto-resume; activity liveness; deletions and deduplication with behavior preserved |
| 4 (gates RC 1) | `INSTALL-001`, optional integrations | Setup/repair isolated from core and bundled separately; VSIX and host presentation verified only where supported |
| 5 (RC and final) | Remaining correctness, documentation and `RC-001`: candidate acceptance | Concrete milestone evidence; frozen scope; exact package passes full CI matrix and independent Reviewer approval |

Small fixes should land independently. Choose incremental refactoring or a
rewrite by the resulting simplicity, correctness and maintenance cost. Rewrite
modules or subsystems when that produces a better result, with explicit scope,
contract migration and reviewable validation. Renaming folders alone does not
reduce responsibilities.

## 1. Audit blockers and quiet, identity-safe Windows operation

### `AUDIT-001` - release blockers from the independent audit

**Status:** Open. This umbrella closes when every order-1 row of the
[remediation index](#audit-remediation-index) is complete in its owning milestone.
It adds no separate work.

- [ ] Turn each audit reproduction into a regression test before or with the fix.
  The reproductions cover: the redaction inputs, the controller cooldown sequence,
  streamed-history byte growth, the full-archive first flush, the commented Codex
  `model` line and the synthetic stale-PPID process snapshot.
- [ ] Re-run the audit probes against the candidate and record the results in the
  project review before requesting Reviewer approval.

- [ ] `CUR-001`: propagate omitted/truncated Git input as structured completeness
  state into the review gate. Bind the expected snapshot and define approval
  handling for FAIL/NOT_RUN without turning prose checks into fabricated PASS.
  Acceptance: over-budget diffs/untracked omissions cannot receive READY; wrong
  snapshots and failed required checks block approval.
- [ ] `CUR-002`: prove read-only capability isolation beyond shell flags for
  Codex/agy, including inherited MCP tools and recursive CoAgent8 calls. Use
  isolated fixture configurations, never a user's live writable MCP services.
  Also verify whether an agy `--sandbox` turn exposes a language-server address
  and CSRF token to its tools: agy 1.3.1 carries `ANTIGRAVITY_LS_ADDRESS` and
  `ANTIGRAVITY_CSRF_TOKEN` for agent tool environments (static evidence in
  `ANTIGRAVITY-HUB-001`), which would let a command reconfigure or start
  sessions outside the sandbox profile.
- [x] `CUR-003`: require `approve` and accept only explicit boolean true for an
  accepted elicitation. Cover missing/empty/false content and every governed
  default/session model through the real MCP request boundary. On
  `fix/explicit-consent` (2026-10-07): the elicitation schema lists `approve` as
  required and the server accepts only `approve === true`; the SDK's server-side
  schema check also refuses an empty or non-boolean answer. Evidence:
  `tests/server.test.js` drives a real in-memory MCP client through accept
  without content, with `{}`, with `approve: "true"` and with `approve: false`,
  a continued session's turn with `{}` and a governed default model with `{}`;
  each returns `POLICY_DENIED` and nothing runs. On the previous source the first
  case ran the governed model (`{"action":"accept"}`, no error). Full suite: 266
  tests, 263 pass, 0 fail, 3 skipped (POSIX only).

### `WINDOWS-001` - process windows, supervision and process identity

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

Process termination in three layers (AUD-P0-1 order 1, AUD-P1-4 order 2):

Decision (2026-10-06). The earlier (PID, creation time) snapshot design
(`process-tree.ts`, CIM polling every 200-500 ms, per-PID PowerShell kills) is
replaced. It reconstructed a tree from `ParentProcessId`, which Windows does not
maintain. It still killed some PIDs without verified identity (`created: 0`),
adopted children of a reused root PID before the first snapshot, missed
descendants created and orphaned between polls, and launched PowerShell
continuously, against the quiet-Windows priority.

The only process CoAgent8 terminates is the one it spawned. It does so through
the handle Node holds, or, on POSIX, through the process group it created.
Nothing is ever selected by PID or parent PID. Termination escalates through
three layers:

1. Protocol interrupt. The backend is asked to stop its turn over its own
   protocol. When the turn reports its terminal event, stdin is closed and the
   CLI exits by itself and cleans up its own children.
2. Forced stop of the owned root. If the CLI has not exited within the grace
   period, `terminateProcessTree` stops it. On Windows it calls `proc.kill()`
   (`TerminateProcess` on the handle held since spawn, so PID reuse cannot
   redirect it). On POSIX it sends `SIGTERM` then `SIGKILL` to the detached
   process group.
3. No tree guessing. No snapshot, polling, PPID walk, `taskkill /T` or name
   list. Descendants are the backend's responsibility. On Windows, libuv puts
   every non-detached child into a Job Object with `KILL_ON_JOB_CLOSE`, so a
   chain of Node processes dies with its root. A descendant created by a
   non-Node process (for example a command launched by native `codex.exe`) is
   outside that job and may survive a forced stop. That is a backend defect
   (openai/codex#47735, #28361, #15413). It is not fixed by guessing PIDs. If it
   becomes a measured problem, the fix is a per-run Job Object helper (below).

Evidence recorded before implementation (Windows 11, Node 22.20):
- libuv `src/win/process.c`: global job with `KILL_ON_JOB_CLOSE |
  SILENT_BREAKAWAY_OK`; the source comment states that this job control does
  not trickle down to subprocesses.
- Owned fixture node -> node -> node, `proc.kill()` on the root: all three
  exited. Owned fixture node -> `cmd.exe` -> node: the leaf survived.
- Claude Code 2.1.289 (`-p --input-format stream-json`, haiku):
  - `{"type":"control_request","request_id":...,"request":{"subtype":"interrupt"}}`
    returns a `control_response` (`success`) within about 10 ms, then a `result`
    with `subtype: error_during_execution`, `terminal_reason: aborted_streaming`
    and no `result` field (anthropics/claude-code#94741).
  - Closing stdin after `result` exits the process in under 1 s.
  - Closing stdin mid-turn did not end the process: the turn completed and the
    process stayed alive until killed after 90 s (observed once). stdin is
    therefore closed only after a terminal `result`.
- Codex 0.160 `app-server` (marked experimental):
  - The handshake (`initialize`, `initialized`, `thread/start`) needs no model
    call.
  - The `thread/start` response reports
    `sandbox: {"type":"readOnly","networkAccess":false}` and
    `approvalPolicy: "never"`, so read-only mode can be verified per run.
  - EOF on stdin exits the server within about 50 ms. The user-configured MCP
    servers it was starting left no surviving process.
  - An unknown thread on `thread/resume` returns error `-32600`
    ("no rollout found").
  - A live Codex turn and `turn/interrupt` were not exercised (owner decision:
    no live Codex calls). The protocol follows the generated 0.160 schema and the
    published app-server reference: `turn/interrupt` ends the turn with
    `turn/completed` and `status: "interrupted"`.
- agy 1.2.17 (the `gemini` backend) has `--input-format stream-json` but no
  documented interrupt. It uses layers 2 and 3 only.

Work items:
- [x] Layer 1 infrastructure in `runCommand`: an optional stdin protocol session
  (`start`, `interrupt`, grace period). Cancellation, deadline and server
  shutdown call `interrupt`, keep reading output until exit, and fall back to
  layer 2 when the grace period ends. Runs without a session keep the current
  write-and-close stdin behavior.
- [x] Claude: switch to `--input-format stream-json`. Send the prompt as one
  user message, close stdin on `result`, interrupt with `control_request`.
  Accept `control_response` and a `result` without the `result` field.
- [x] Codex: replace `codex exec --json` with `codex app-server`.
  - Handshake with `initialize`/`initialized`.
  - Start with `thread/start`, or continue with `thread/resume` and
    `excludeTurns`, so the response does not carry the full history.
  - Fail closed with `SANDBOX_UNAVAILABLE` unless the response reports
    `readOnly` and `never`.
  - Send the prompt with `turn/start`, close stdin on `turn/completed`, and
    interrupt with `turn/interrupt`.
  - Answer any server-initiated request with a JSON-RPC error.
  - Turn usage is the sum of `tokenUsage.last` over the turn's
    `thread/tokenUsage/updated` notifications (one per model request).
- [x] Layer 2: `terminateProcessTree` reduces to `proc.kill()` on Windows and
  the process-group signals on POSIX. After the root exits, a descendant that
  still holds stdout/stderr no longer blocks the run until its deadline. The
  runner destroys its pipe ends after a short drain period.
- [x] Layer 3: delete `src/execution/process-tree.ts`, `startDescendantTracking`,
  `CimMutex`, `trackedDescendants`/`trackedIdentities`, the `extraPids`
  parameter and their tests. Remove descendant tracking from the test runner,
  the stdio test helper and `integrations/rpc.ts`.
- [x] Rule: rewrite the process identity invariant in
  [05-cross-platform](../.agents/rules/05-cross-platform.md) to "terminate only
  owned handles and owned process groups; never select by PID or parent PID".
- [x] Acceptance, with owned fixture trees only (no live-desktop sweep):
  - an interrupted fixture CLI exits without forced stop and reports `cancelled`;
  - a CLI that ignores the interrupt is stopped after the grace period;
  - a Node chain dies with its root on Windows;
  - a surviving pipe holder does not delay the result past the drain period;
  - Claude and Codex adapter fixtures speak the new protocols;
  - no PowerShell or CIM helper is launched by a consult.

  Evidence (2026-10-06, Windows 11, Node 22.20, commit `ca8cf88` on
  `fix/windows-process-identity`):
  - `tests/execution/process.test.js` covers each property above. The "no helper" property
    is asserted statically: no source file references CIM, `taskkill`,
    `Stop-Process` or `ParentProcessId`.
  - Adapter fixtures: `tests/backends/claude/adapter.test.js` and
    `tests/backends/codex/adapter.test.js`.
  - Results: full suite 196/196; typecheck; build; consumer smoke (Codex and
    Gemini fixture turns through the packed bundle); `lint:docs`.
  - Live Claude 2.1.289 (haiku) through `executeClaude`:
    - completed: exit 0;
    - abort: `cancelled`, exit 1, no signal (the CLI exited by itself);
    - 4 s deadline: `timed_out`, the process ended 0.75 s after the deadline,
      inside the 3 s grace period.
  - Linux (Docker `node:22`, Node 22.23.3, WSL2 kernel 6.6): the process,
    Claude, Codex and Gemini suites pass, including the POSIX-only grace tests.
    The exception is the Codex `probe` test, which fails identically on the
    pre-branch revision `0c11032~1`. Without Codex credentials it reports
    `unauthenticated`, which the assertion does not allow. macOS is covered by
    the CI matrix only.
- [x] Open acceptance: one live Codex app-server turn, resume and
  `turn/interrupt` before beta 2. The owner authorized the model calls.
  Evidence (2026-10-07, Windows 11, Node 26.10, Codex 0.160.1, `gpt-5.6-luna` at
  `low`, through `execute` of the Codex adapter at `3480af4`):
  - turn: `completed` in 10.8 s, answer "OK", exit 0, provider usage reported;
  - resume: the same thread ID, the answer recalls the first turn, 5.6 s;
  - interrupt: aborted 8.0 s into a long answer; `cancelled` 85 ms after the
    abort, exit 0 and no signal, so Codex ended the turn and exited by itself;
  - `codex.exe` processes: 1 before and 1 after (a process this run did not own).

  Claude Code 2.1.289 (haiku) on the same stack: turn `completed` in 2.5 s; an
  abort 3.7 s into a long answer settled 785 ms later as `cancelled`, exit 1, no
  signal, as on `ca8cf88`. The AUD-P0-1 reproduction was re-run; see the
  [project review](PROJECT_REVIEW_2026-10-05.md#re-run-on-the-stack-tip-2026-10-07).

Gemini backend (agy) termination:

agy 1.2.17 offers no protocol interrupt in headless mode. Checked sources:
- `--help`: `--input-format stream-json` only queues further prompts into the
  same conversation ("runs one turn per message").
- Changelog: interruption exists only interactively (Esc, Ctrl+C) and through
  Remote Control.
- Binary strings: no `control_request`, `control_response` or similar.

Consequences:
- Windows: a cancellation or deadline force-stops `agy.exe` (layer 2). It is a
  native Go binary, not Node, but its own children did not survive the forced
  stop (live evidence below).
- POSIX: the process group receives `SIGTERM`. The changelog states that a
  session shutdown cancels running commands and streaming connections, but
  250 ms before `SIGKILL` may be too short for that.

Work items:
- [x] POSIX grace: `runCommand` accepts a per-run `SIGTERM` to `SIGKILL` grace
  period. The agy adapter uses 2 s, so agy can cancel its own commands.
  - Acceptance: a POSIX fixture that handles `SIGTERM` for 1 s exits by itself
    with a 2 s grace and is killed with the default grace.
  - Live agy `SIGTERM` handling is not verified.
  - Implemented as `signalGraceMs` (`AGY_SIGNAL_GRACE_MS = 2000`). The tests
    are in `tests/execution/process.test.js` and `tests/backends/gemini/adapter.test.js`. They are
    POSIX-only and pass on Linux (Docker `node:22`, see the evidence above).
- [x] Native deadline (`--print-timeout`): rejected after live verification.
  Do not use it.
- [x] Windows user cancellation: no workaround needed. A forced stop leaves no
  agy process behind (evidence below). A headless interrupt message for
  `stream-json` remains a nice-to-have for upstream, not a defect.

Live agy evidence (2026-10-06, agy 1.2.17, `gemini-3.8-flash`, effort `low`,
`--sandbox --output-format stream-json`, Windows 11; six turns):
- `--print-timeout 3s` on a long answer:
  - The limit counts from the start of the turn (about 3 s after launch), not
    from process start.
  - At expiry agy wrote `print timeout after 3s with turn in progress; returning
    partial output` to stderr and emitted `result` with `status: "SUCCESS"` and
    an empty `response`. It then exited with code 0.
  - A timeout is therefore indistinguishable from success without parsing
    stderr text, so the flag would turn deadlines into false successes.
- A request to run `ping -n 30 127.0.0.1`: `run_command` was auto-denied in
  headless sandbox mode (`jetski: ... auto-denied`) and no `ping` process
  started. In this configuration agy runs no shell commands.
- Process tree during a turn (observation only):
  - agy starts the user's configured MCP servers:
    `cmd.exe /c npx.cmd -y @upstash/context7-mcp`, then `node.exe` (npx), then
    `cmd.exe`, then `node.exe` (the server). It also starts `conhost.exe`.
  - After `proc.kill()` on `agy.exe`, every process of that subtree was gone
    within 2 s, checked by PID and creation time. agy contains its children
    itself.

Supervision cost (AUD-P1-4, order 2):
- [x] Descendant polling and teardown helper processes were removed by the
  owned-handle/group design (`ca8cf88`, evidence above). Native backends can
  still launch their own MCP/helper processes; this is not a zero-child claim.

Crash orphans and Job Objects (AUD-P2-14, order 3):
- On Windows the server's own libuv job already kills its direct children when
  the server dies. Descendants of native backends are not covered.
- [x] Only if non-Node descendants are measured to survive: prototype a per-run
  Job Object helper with `KILL_ON_JOB_CLOSE` and without silent breakaway.
  Evaluate compatibility with backend sandboxes, nested jobs, and the cost of
  distributing and signing a native helper. Measured on 2026-10-07 (Windows 11,
  Node 26.10): they do not survive, so no helper is needed. A Node process
  standing in for the server ran one long turn through the adapter and was
  stopped with `TerminateProcess` (no cleanup) once the turn was under way. Every
  process created after the start, other than service hosts and the observer's
  PowerShell, was listed by PID, parent and command line at the crash and 1, 10
  and 30 s later:
  - Claude Code (haiku): `claude.exe`; gone after 1 s;
  - Codex (`gpt-5.6-luna`): `node.exe` (npm shim), then the native `codex.exe`;
    gone after 1 s;
  - agy (`gemini-3.8-flash-low`): `agy.exe` with the user's MCP servers
    (CoAgent8's own `dist/index.cjs`, and `cmd.exe`, `node.exe` (npx), `cmd.exe`,
    `node.exe` for Context7); all gone after 1 s.
- [ ] agy turns start every MCP server of the user's agy configuration, here
  CoAgent8 itself and Context7 through `npx`, on every turn. That costs startup
  time and console helpers, and the user's allow rules
  (`mcp(coagent8/consult)`, `mcp(coagent8/review)`) let the backend model call
  CoAgent8 recursively. agy 1.3.1 has no option to start without MCP servers.
  Measure whether the model can reach these tools in `--sandbox` print mode and
  decide on isolation (owner decision).
- [ ] Add a POSIX parent-death strategy for detached groups. Do not rely on
  stdin EOF: Claude did not exit on EOF mid-turn (see the evidence above).
- [x] Focus-stealing console window on the first agy launch (P0, beta 2 blocker),
  reported by the owner on 2026-10-07: after restarting VS Code, the first task
  in the Codex chat showed a terminal window for about a second, and it took the
  keyboard focus. Windows 11 Pro 26200, VS Code with the Codex extension (Codex
  0.162.0-alpha.2 host, Codex CLI 0.160.1), agy 1.3.1, Windows Terminal 1.24 as
  the default terminal, Node 26.10, built server `57e803f7`.
  - Source: agy's auto-updater. On its first launch after 15 minutes agy logs
    `auto_updater.go:334] Spawned background update process`. That process starts
    another `agy.exe`, which gets a new console. Windows Terminal shows the console
    and takes the foreground for about 400 ms, even though CoAgent8 starts agy
    with `windowsHide`. The owner's window matches the update spawn at
    17:46:09.720 in the agy log of the Codex chat's first Gemini call.
  - Evidence without process auditing (no administrator rights, no Sysmon): a
    compiled observer built on `SetWinEventHook` (window create, show and
    foreground events, each with the owning process, its image and its parent
    chain). It does not poll, launch PowerShell or stop processes. A hidden-console
    control child was recorded, so the observer sees console windows; that control
    child was itself shown by Windows Terminal, which ignores `SW_HIDE`. One
    reproduction through the built server (`gemini-3.8-flash`, then
    `gemini-3.8-flash-low`) recorded the window as
    `agy.exe <- agy.exe (updater) <- agy.exe <- node.exe (server)`. A direct
    `agy models` launch did the same as soon as the 15-minute check was due.
  - Ruled out with evidence: no PowerShell 5.1 process started at the VS Code
    restart (PowerShell Operational log 40961, `Windows PowerShell` log 400). The
    PowerShell consoles of the day ran as `CodexSandboxOffline`, and each one
    matched a Codex `exec_command` in `~/.codex/.sandbox/sandbox.*.log`
    (`codex.exe` -> `codex-windows-sandbox-setup.exe` -> GUI
    `codex-command-runner.exe` -> `powershell.exe` with `CREATE_NO_WINDOW`). A
    real Codex turn through the built server that read `package.json` in that
    sandbox showed no window. CoAgent8 resolves `codex` to `node codex.js` and
    agy and Claude to native executables; it never runs `.ps1` or `.cmd`. The agy
    host's own toast (`powershell.exe -WindowStyle Hidden`, `AGY_NOTIFY_*`) runs
    after its conversation ends, not on a CoAgent8 launch.
  - Fix on `fix/agy-quiet-updater`: every agy launch (probe, `models`, `/usage`
    and turns) gets `AGY_CLI_DISABLE_AUTO_UPDATE=true`; agy 1.3.1 ignores `1`. agy
    checks the variable (`auto_updater.go:247`) before its 15-minute rule, so no
    updater starts. agy then updates only when the user runs it. Evidence:
    `tests/backends/gemini/adapter.test.js` (the four launches with an inherited
    `1`; fails on the previous adapter). Full suite: 278 tests, 275 pass, 0 fail,
    3 skipped; typecheck, `lint:docs`, `npm run docs`, build (`5a97ef5c`) and
    consumer smoke pass. Live check with the check due: agy logged "Auto-update
    disabled via environment variable", its check timestamp did not change, the
    turn answered `391`, and the observer recorded no window.
  - Upstream: agy should start its updater without a console
    (`CREATE_NO_WINDOW`). A launch of agy by the agy host itself is outside
    CoAgent8 and may still show the window.

### `REDACTION-002` - output integrity versus diagnostic redaction

**Status:** Implemented (AUD-P0-2 blocker, AUD-P2-13).

- [x] Split redaction:
  - Public answers, stored assistant messages, and user messages are filtered for high-confidence
    credential formats only via `redactCredentialFormats`: `sk-…`, `sk_live_…`,
    `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `github_pat_…`, `glpat-…`, `ya29.…`,
    `npm_…`, `hf_…`, bare JWT, AWS key IDs (`AKIA…`, `ASIA…`), PEM private keys,
    `Bearer …`, `Basic …`, and real connection strings (`postgres://`, `redis://`).
  - Keyword=value rules (`aws_secret_access_key=`, `token=`, `password:`, `auth=`),
    catch-all URL query tokens (`?token=`), and home-path redaction apply strictly to
    diagnostics, stderr, errors, doctor output, and issue reports via `redactDiagnostic`,
    ensuring ordinary code syntax and query strings in public answers are preserved.
- [x] Regression: the four audit inputs round-trip unchanged (`tests/redaction.test.js`);
  real keys inside answers are replaced.
- [x] Add missing formats: `gho_`, `ghu_`, `ghs_`, `glpat-`, `ya29.`, bare JWT,
  `sk_live_`, `npm_`, `hf_`.
- [x] Update the redaction rule in [01-security-and-sandboxes](../.agents/rules/01-security-and-sandboxes.md).

### `PACKAGE-001` - built output is not source

**Status:** AUD-P1-10 implemented on `build/untrack-dist`, plugin and VSIX
packaging from the tarball on `build/artifacts-from-tarball`; neither merged.

- [x] Remove `dist/` from Git and build it in `prepack` and CI. `dist/` is in
  `.gitignore`; `prepack` and the CI `Build bundle` step already build it.
- [x] Produce plugin/VSIX artifacts from the built tarball, not from a committed
  bundle. On `build/artifacts-from-tarball`, not yet merged:
  `npm run package:artifacts` (`scripts/package-artifacts.cjs`) packs the
  tarball, records its SHA-256, extracts it with a built-in ustar/PAX reader that
  refuses paths outside `package/`, copies it to `.artifacts/plugin/coagent8/` and
  stages the VS Code extension from it; `package:vscode` builds the VSIX from that
  staging. Evidence (Windows, Node 26.10): the extraction is byte-identical to
  Windows `tar.exe` (75 files); two packs gave the same SHA-256 (`2b502d83…`); the
  VSIX's `dist/index.cjs`, its map, the notices and the logo match the tarball's
  by SHA-256. `tests/package.test.js` covers the reader (PAX paths, escapes) and
  the plugin check.
- [x] Keep `index.js`, `mcp.json` and `bin` entries valid for installed packages.
  The artifact build fails unless `mcp.json` starts `${PLUGIN_ROOT}/dist/index.cjs`
  with `node` and `main`, every `bin` entry and the plugin icons exist in the
  package; the consumer smoke runs both bins from an installed tarball.
- [x] Make the source map reproducible. An identifier rename (`Ay` to `Py`) was
  seen once on 2026-10-06, but measurements the same day did not reproduce it:
  the bundle (esbuild 0.25.12 and tsdown 0.23.0) rebuilt byte-identically
  across repeated builds, another checkout path, CRLF and LF sources, and
  Node 24 and 26. The map is what varies, because `sourcesContent` embeds the
  checkout's line endings ([BUNDLER_COMPARISON](archive/BUNDLER_COMPARISON.md)
  section 7). Fix with an LF policy in `.gitattributes` or without
  `sourcesContent`. Removing `dist/` from Git also removes the noise from diffs.
  Fixed with `.gitattributes` `* text=auto eol=lf`: every checkout, including
  Windows with `core.autocrlf=true`, gets LF sources, so `sourcesContent` no
  longer depends on the platform. The map keeps `sourcesContent` because it also
  maps bundled `node_modules` files that the package does not ship. Evidence:
  this Windows checkout (`core.autocrlf=true`) and a fresh clone built
  byte-identical `dist/index.cjs` and `dist/index.cjs.map` (SHA-256 `03611bfc…`
  and `a41615e8…`). Before the files were checked out again the maps differed in
  the `sourcesContent` of 32 `src/` files (CRLF). Git does not rewrite existing
  working-tree files when attributes change: an existing checkout needs one fresh
  checkout of its tracked files.
- [x] Acceptance: a fresh clone cannot run a stale bundle. The consumer smoke test
  verifies the packed bundle matches a build of the packed source. Evidence: a
  fresh clone has no `dist/`. `tests/consumer/smoke.cjs` compares every packed
  `src/` file with the source and the packed `dist/` files byte for byte with a
  fresh build; run against a tarball packed before a one-line source change it
  fails with `Packed src/constants.ts matches the source`. Local run passes
  (Windows, Node 26.10). The smoke also expected 9 advertised tools with per-tool
  icons; it now checks the 6 core tools and the server-level icon (`CONTEXT-001`).

### `VERIFY-SCOPE-001` - useful verification without repeated full runs

- [x] Consolidate local policy in the quality-gate rule: prose-only edits do not
  trigger runtime tests, builds, packaging or backend invocations. Synchronize
  AGENTS, workflow skill and handoff references. This is a documentation change.
- [x] Add explicit file/suite selection to `tests/run.cjs`. No-argument discovery
  still finds the full inventory; selected files do not append other tests.
  Preserves portable arguments, bounded concurrency (`--test-concurrency=2` default with CLI override),
  and awaited cleanup. Tested via `tests/discovery.test.js` and `node tests/run.cjs tests/execution/stream-reducer.test.js`.
- [x] Group tests under module/behavior directories; portable inventory and
  exclusions are implemented (`TESTS-001`). Some historical case IDs remain
  as labels; they do not control discovery.
- [x] Configure one coverage run per matrix job rather than a duplicate full
  suite (AUD-P2-15), on `ci/coverage-once`. This marks the workflow change,
  not remote acceptance.
- [ ] Accept that workflow on the first green matrix. Scope documentation/VSIX
  jobs only through an explicit workflow change preserving required checks.
  On `ci/coverage-once`, not yet run in CI: each matrix job runs the suite once,
  through `npm run test:coverage` in place of `npm test`, and only the Ubuntu
  Node 24 job generates the API documentation. Job names, and with them the
  required status checks, are unchanged; the VSIX stays on the three Node 24 jobs.
  Locally (Windows, Node 26.10) `test:coverage` ran the full inventory: 254 tests,
  251 pass, 0 fail, 3 skipped (POSIX only), lines 92.4%, branches 82.3%,
  functions 96.2%. Close after the first green CI matrix.
- [ ] Keep complete failure logs. Rerun only to investigate a failure or validate
  a new change; do not treat an unexplained passing retry as a fix (`VERIFY-001`).
- [x] Replace tests that cement defects. Example: replaced the "O(1) appends" history
  test with a measured ratio test asserting persisted bytes <= 3× of answer size in
  `tests/sessions/history.test.js` (measured 1.05× for 60 KiB stream).

### `HANDOFF-001` - portable agent instructions and handoff templates

**Status:** Planned; supporting documentation work, without changing the product
execution order.

- [ ] Define one versioned Markdown handoff standard and short Author, Reviewer
  and advisory examples for Antigravity, Codex, Claude Code and Cursor. Separate
  task role from provider identity while preserving independent CoAgent8 Review
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
  (P0/P1/P2) from finding severity (P1/P2/P3, or the audit's P0-P3 scale).
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

### `MCP-001` - interoperability independent of installer support

- [x] Document host/backend separation, generic stdio setup and the distinction
  between automatic registration support and MCP compatibility.
- [x] Add focused acceptance for a client with an arbitrary name and no optional
  capabilities: initialization and tools/list must not invoke a backend, require
  a recognized host or mutate host registrations. A missing backend must not hide
  tools; its invocation returns an actionable error. Verified in `tests/e2e/generic-mcp.test.js`.
- [x] Confirm a fixture-backed call through the generic MCP boundary, then record
  a real Continue Agent-mode connection separately when that host is available.
  Verified generic stdio call boundary in `tests/e2e/generic-mcp.test.js` and `tests/e2e/mcp.test.js`.
- [x] Keep startup independent of optional archive maintenance failures, without
  concealing errors that affect execution safety or active session ownership.
- [x] A malformed `config.json` must not hide tools. Doctor uses diagnostic
  defaults; execution refuses unsafe fallback (AUD-P2-11). On
  `fix/malformed-config`, not yet merged. `tools/list` no longer reads the
  configuration (the tool profile was removed in `CONTEXT-001`). Decision:
  execution does not fall back to the defaults. They allow every backend, so a
  broken file that restricted `allowedBackends` would silently run a disabled
  backend; execution fails with `POLICY_DENIED` naming the file instead. Doctor
  falls back to the defaults for its report, sets `status: configuration_error`
  and `configError`, and lists the error first among the recommendations.
  Evidence: `tests/config.test.js` writes a truncated file: six tools are listed,
  doctor reports the error, and resolving `codex` is refused.
- [x] Resolve the workspace from MCP roots when `workspace_path` is absent, or
  require it. Never default silently to the server's working directory
  (AUD-P2-9). Delivered by `CONTEXT-001`; verified in `tests/workspace.test.js`
  and `tests/server.test.js`.

### `STARTUP-001` - non-blocking MCP server initialization

**Status:** Implemented; asynchronous background session maintenance unblocked server connect.

- [x] Eliminate synchronous session pruning from the MCP connection critical path:
  `pruneExpiredSessions` runs as a background task after `server.connect(transport)`.
- [x] Handle and record background pruning failures safely as redacted warnings.
- [x] Signal handlers (`SIGINT`, `SIGTERM`) and standard input EOF await the
  background pruning task during graceful shutdown.
- [x] Prevent MCP client connection timeouts on Windows caused by blocking directory
  sweeps and file lock contention during host startup, without deleting active sessions.

### `SURFACE-001` - tool surface consolidation and clear profile contracts

**Status:** Implemented; canonical six-tool surface defined and legacy actions aliased to consult.

- [x] Define the canonical six-tool public interface: `consult` (with optional
  `task_type` "architecture", "debug", "implementation" and context files),
  `review`, `doctor`, `session`, `cancel`, `issue`.
- [x] Retain the compact profile via the `run` gateway with legacy action
  compatibility (`analyze`, `debug`, `implement` mapped to `consult` with
  deprecation warnings). Superseded by `CONTEXT-001`: the profile is removed and
  `run` stays callable.
- [x] Deprecate and alias the separately advertised `analyze`, `debug` and
  `implement` tools to `consult` handlers with argument mapping. Removed the
  phantom `context_files` field from `debug`. The six-tool baseline excludes the
  temporarily advertised aliases.
- [ ] Remove remaining phantom contract fields and deduplicate prompt tokens:
  - [x] Remove `doctor.repair` and `doctor.workspace_path` from the `doctor` inputSchema (AUD-P2-8; delivered by `CONTEXT-001`).
  - Eliminate prompt token redundancy in `review` caller instructions: caller handoffs must not duplicate State Envelope rules (`VERDICT`, `[P1/P2/P3]`), because `review.tool.ts` automatically formats the required envelope protocol in the task prompt.

### `CONSULT-001` - separate advice from release approval and structured verdict output

**Status:** Implemented; plain consult and a review-only verdict. Markdown-only
execution responses supersede the earlier structured result.

- [x] Ordinary-advice mode for consult: no State Envelope instructions or gate;
  no public verdict field (the internal formatting value is NOT_APPLICABLE).
- [x] Audit status exposed to the caller; tool errors (`isError`) are distinct from
  audit conclusions. Since `CONTEXT-001` (markdown result) the verdict and reason are
  the footer line `> Verdict: ...` instead of `structuredContent`.
- [x] Keep review's diff preparation with an explicit strict-audit default.
- [x] Preserve structured execution status, typed errors, cancellation and privacy.
  A textual READY or PASS is not proof that a command ran or a release is approved.
- [x] Verify plain answers, opt-in audit formatting, partial/truncated output and
  legacy calls.

### `CONTEXT-001` - token cost and single-call success across MCP clients

**Status:** Implemented across the local context/Markdown/agent-experience
branches (2026-10-07), with the headless client measurements recorded below.
The headless AX retests in fresh Codex and agy sessions and the owner's retest in
the Codex and Antigravity chats in VS Code are recorded below. A consent dialog in
a VS Code chat remains unverified: neither chat showed one. The following
is chronological evidence: earlier schemas, budgets and result channels are
superseded by later entries. First measurements on the built stdio server:
- `tools/list`: 27.4 KB to 5.7 KB, model-visible part 9.6 KB to 3.7 KB;
- `doctor`: 5.4 KB to a 310 B summary;
- server instructions: 119 characters.

Goal: the lowest token cost per turn and
per call in Claude Code, Antigravity (agy) and Codex, and in any other MCP client,
with one call sufficient for an ordinary request. The tool names, the six-tool
surface, the separate `cancel` tool and the existing parameter names stay.

**Client behavior** (evidence in brackets):

| | Claude Code | agy (VS Code and CLI) | Codex | Other clients |
| --- | --- | --- | --- | --- |
| Result channel the model reads | `structuredContent` when present, else `content`; `content` also for `isError: true` results (2.1.289, measured 2026-10-07) | `content` (agy transcripts; stub measurement 2026-10-07) | `structuredContent` serialized as JSON; `content` ignored when it is present (`codex-rs/protocol/src/models.rs`) | usually `content` |
| Result saved to a file | above 50,000 characters, or `_meta["anthropic/maxResultSizeChars"]` up to 500,000 (Claude Code MCP docs) | above about 4 KB: results of 3,950 B or less inline, 4,165 B or more saved as `output.txt` and read with an extra `view_file` step (over 200 MCP calls of several servers) | truncation budget of the model (Codex MCP docs) | varies |
| Tool definitions | deferred; names and server instructions load at start | deferred; cached on disk as name, description and input schema, without `outputSchema` or icons | loaded upfront (`defer_loading: false`) | usually upfront |
| Server instructions | read; truncated at 2,048 characters | cached as `instructions.md` | read; first 512 characters should stand alone | per specification |
| MCP roots | `roots/list` answered with the launch directory plus added directories; `CLAUDE_PROJECT_DIR` set | `roots/list` answered with the workspace (measured 2026-10-07) | apparently unsupported | per capability |
| Tool timeout | long calls move to the background | no documented option; the CLI cancels after 180 s (measured 2026-10-07) | 60 s by default (`tool_timeout_sec`) | varies |
| Per-server configuration | `.mcp.json`, `~/.claude.json` | `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json`, with `cwd`, `env`, `disabled` and `disabledTools` (Antigravity MCP docs) | `config.toml` `[mcp_servers.<name>]` with `cwd`, `env` and `tool_timeout_sec` | varies |

Behavior described by the Antigravity docs is limited to configuration. Its result
channel, inline threshold and tool loading come only from the local measurements
above.

**Measured baseline:**
- `tools/list` is 27.4 KB:
  - icons 11.7 KB: the same 914 B PNG on all nine tools;
  - `inputSchema` 8.3 KB;
  - `outputSchema` 5.6 KB;
  - descriptions 1.3 KB.

  The model sees only names, descriptions and input schemas, about 9.6 KB.
- No server instructions.
- `doctor` returns 5.4 KB of indented JSON (5.6 KB as stored by agy): above the agy threshold, with the quotas
  duplicated (`backends.<id>.quota` and `quotas`) and the static `security_policy` included.
- Results report the requested alias (`opus`) instead of the model the backend
  resolved. Claude reports it in `system/init`.
- A real 8.4 KB review consisted of Evidence 2.7 KB, Fix 2.8 KB, Problem 1.7 KB and
  envelope lines 1.2 KB.
- An agy sandbox denial of one command fails the whole turn with
  `SANDBOX_UNAVAILABLE` and discards the answer.

Plan:

- [x] **Server instructions:** one sentence (119 characters), because every
  client pays for it on every turn: "Second opinion or code review from another
  local coding agent (Codex, Claude Code, Antigravity) in a read-only sandbox."
  Rules needed only at call time go into parameter descriptions, which are loaded
  only with the tool: continuation in `session_handle`. Superseded on 2026-10-07 by
  the agent-facing contract below (482 characters). Consent is no longer a
  parameter: the server asks the user (`EXEC-001`, AUD-P1-7).
- [x] **Tool definitions:** model-visible definitions 3.7 KB against 9.6 KB, and
  `tools/list` 6.1 KB against 27.4 KB:
  - one-line tool descriptions;
  - parameter descriptions only where the name and enum are not enough;
  - `reasoning_effort` as an enum;
  - the execution parameters defined once (`src/tools/schema.ts`).

  The prototype's 2.7 KB assumed merged and renamed parameters; keeping every
  existing parameter and accepted alias costs the difference. The `analyze`,
  `debug` and `implement` aliases left `tools/list` but stay callable until
  1.1.0. The compact profile now measures 4.2 KB against 3.7 KB for the six
  tools, so it saves nothing. Verified in `tests/tools/surface.test.js` (budget
  3,800 B).
- [x] Remove the compact profile, which no longer saves tokens. A legacy
  `toolProfile` key is ignored, and `run` stays callable. Verified in
  `tests/tools/surface.test.js`.
- [x] Limit `outputSchema` to the fields actually sent (with the compact result):
  only `provider`, `status`, `output` and `verdict` are required. Superseded by the
  markdown-only result below: execution tools declare no `outputSchema`.
- [x] **Icon:** the single brand icon is declared only in `serverInfo`. Context7
  also declares its icon only at server level, while GitHub MCP sets icons per
  toolset because each toolset has a different icon. The offline `data:` URI stays.
  The icon is sent whatever the negotiated protocol version: the SDK offers no
  supported per-version server info, and a 2025-06-18 client ignores the field.
  Light and dark background variants are embedded from `assets/logo64.png` and
  `assets/logo64-light.png`; MCP `theme` describes the background. The README
  selects SVG artwork by color scheme, and plugin metadata declares
  `composerIconDark` and `logoDark`. Native host rendering still needs acceptance.
  The [MCP comparison](MCP_COMPARISON_2026-10-07.md) records a live Context7-to-Gemini
  consultation about this contract, its provenance limits and remaining host acceptance.
  This saves 11.7 KB of transport per `tools/list`, not model tokens, which helps
  first launch.
- [x] **Single-call success:** the minimal call is `{"proposal": "..."}`:
  - `backend` resolved automatically;
  - workspace resolved from client roots;
  - default model.

  No `doctor` call is needed first. Every error states in one line what to do next,
  for example a `POLICY_DENIED` that says to retry without the top-tier model.
  Input validation failures are tool execution errors (`isError: true`), not
  protocol errors, so the model can correct itself, as specification 2025-11-25
  recommends (SEP-1303); the server already returned them so. Verified by
  the consent test in `tests/execution/controller-history.test.js`, the routing
  tests and the roots test in `tests/server.test.js`.
- [x] **Result in both channels, compact:**
  - `content` leads with the answer and ends with a one-line footer, for example
    `> CoAgent8: claude · claude-opus-5-5 · 107.8s · 8 ops · <handle> (ready)`, with
    the operation count only when non-zero and the turn only from turn 2; notices,
    warnings and the workspace note follow as separate quoted paragraphs;
  - `structuredContent` keeps the full `output` but omits `schemaVersion`,
    `activity` and empty or default fields. `historyAvailable` appears only when
    false. Measured overhead beyond the answer: about 320 B before, 197 B after
    for a result with a model and a session handle, which carry information.

  Both channels stay complete, because each client reads only one of them.
  The specification recommends (SHOULD) that `content` also carry the serialized
  `structuredContent` JSON. CoAgent8 deliberately sends markdown instead:
  - Claude Code and agy read `content`;
  - JSON escaping costs more tokens;
  - Codex reads `structuredContent` anyway.

  Recorded in the runtime contract (Structured Content). Verified in
  `tests/tools/result.test.js`. Superseded by the markdown-only result (owner
  decision of 2026-10-07, below): the Claude Code measurement contradicted the
  first bullet.
- [x] **Resolved model:**
  - Claude from `system/init`;
  - Codex from the `thread/start` response;
  - agy from `init` when reported, otherwise the requested model, otherwise an
    explicit `provider default` in the footer.

  The session stores the concrete identifier. Governance still applies, because
  its pattern matches `claude-opus-*`. `doctor` lists the Claude aliases instead
  of an empty model list. Every backend validates a reported identifier with the
  shared governance check. Verified in the Claude, Codex and agy adapter and
  collector tests.
- [x] **Backend prompts:**
  - review: Evidence at most two sentences with `file:line`, Fix one sentence, P3
    one line, no preamble and no restated diff. Estimated saving about 45%,
    bringing more reviews under the agy threshold; to be measured on real
    reviews. The envelope format and its gate stay unchanged;
  - the server fills in `SNAPSHOT`, so the reviewer no longer looks it up;
  - consult: conclusion first, concise;
  - shorter review instructions: 1,041 to 677 characters;
  - extra diff exclusions use Git's own `-diff` attribute in `.gitattributes`
    (documented in the README and runtime contract) instead of a new setting.
    The diff already uses `--unified=1` and excludes build output, maps and
    lockfiles.

  Verified in `tests/tools/review.test.js` and
  `tests/execution/git-fixture.test.js`.
- [x] **`doctor`:**
  - `detail: "summary"` (default; prototype 316 B, budget 1 KB) or `"full"`;
  - `backend` filter;
  - `quota: false` skips the slower quota probes;
  - the full report goes in `structuredContent` without the duplicated quotas
    and without `security_policy`.

  A filtered run refreshes only that provider's cached quota and keeps the
  others (`inspectQuotas` `only`). Since `perf/bounded-probes`, native agy
  quota is read separately in doctor; `quota: false` skips it. This delivers the doctor phantom fields of AUD-P2-8 (owned by
  `SIMPLIFY-001`). Verified in `tests/diagnostics/doctor.test.js`.
- [x] **Workspace:**
  1. explicit `workspace_path`;
  2. MCP roots, when the client declares the `roots` capability:
     - one root is used;
     - with several roots, as Claude Code reports after `--add-dir`, use the root
       that contains the server working directory; otherwise require
       `workspace_path`.

     Cached per connection and refreshed on `notifications/roots/list_changed`;
  3. the server working directory (owner decision of 2026-10-07), but never the
     home, a filesystem root or a system directory.

  Earlier structured results exposed workspace/source fields. The current
  Markdown result exposes only the server-directory fallback line; explicit
  paths/client roots add no workspace field or line. `session` history and close use the same workspace. This
  delivers AUD-P2-9 (owned by `MCP-001`).
- [x] **Host setup:** CoAgent8 registration for Codex sets `tool_timeout_sec` to
  1800, so reviews longer than the 60 s default can complete. `codex mcp add` has
  no option for it, so setup inserts the key after the table header and verifies
  that the parsed configuration differs by that key alone. Verified in
  `tests/integrations/setup.test.js`.
- [x] Measure the agy tool-call limit with a call longer than 5 minutes and
  document it; the Antigravity docs list no timeout option. agy 1.3.1 (CLI)
  cancels an MCP tool call after 180 s ("timed out after 3m0s"); progress
  notifications every 5 s do not extend it. Measured with a stub `wait` tool of
  420 s, which received the cancellation after 180,002 ms. Recorded in the
  [integration guide](VSCODE_INTEGRATION.md#measured-client-behavior). The agy
  IDE was not measured.
- [ ] Decide how CoAgent8 handles the 3-minute agy limit: a review that takes
  longer is cancelled with the client's request. Options: document it, or bound
  the backend turn below the limit when the client is agy (owner decision).
- [x] **Owner decision (2026-10-07):** an agy sandbox denial is a warning that
  keeps the answer, as Claude `permission_denials` already are. A denial shows
  that the sandbox works, not that it is missing. Adapter warnings of every
  backend reach the result's `warnings`. Verified in
  `tests/backends/gemini/adapter.test.js` and
  `tests/execution/controller-history.test.js`.
- [x] **Budgets as regression tests:**
  - server instructions at most 512 characters (`tests/tools/surface.test.js`);
  - model-visible tool definitions at most 3,800 B, measured 3,728 B (the 3 KB
    target assumed renamed parameters); raised to 5,300 B by the owner's decision
    of 2026-10-07 for described parameters;
  - doctor summary at most 1 KB (`tests/diagnostics/doctor.test.js`);
  - results report the resolved model when available; source tests cover
    explicit/client-root resolution and the server-directory fallback line.
- [x] **Client acceptance:** repeat the measurements in Claude Code and agy:
  - result channel;
  - inline threshold;
  - instructions visible;
  - roots.

  Measured on 2026-10-07 with `claude -p` (2.1.289) and `agy -p` (1.3.1) and a
  stub MCP server; results in the
  [integration guide](VSCODE_INTEGRATION.md#measured-client-behavior). Both show
  the server instructions, answer `roots/list` with the launch directory, declare
  form and URL elicitation and cancel it in `-p` mode. Inline limits: Claude
  between 45,000 and 60,000 B, agy between 3,900 and 4,300 B. The result channel
  contradicts the table above for Claude Code.
- [x] **Markdown as the only result channel** (owner decision of 2026-10-07,
  breaking). Claude Code 2.1.289 gives the model only `structuredContent` when a
  result has it (stream-json transcript of a stub result with different markers in
  `content` and `structuredContent`), so CoAgent8's markdown `content` and footer
  reached agy but not Claude Code, where the answer arrived JSON-escaped in
  `output`. Evidence for the decision:
  - live consults from Claude Code on 2026-10-07: both successful results
    (Codex `gpt-5.6-luna`, Gemini `gemini-3.8-flash`) arrived as JSON, with LaTeX
    double-escaped and without the duration or operation count; both failures
    (`isError: true`) arrived as the markdown `content`;
  - cost for the calling model, markdown versus JSON: Codex weather answer 413 B
    versus 584 B, Gemini weather answer 1,115 B versus 1,296 B, a review of about
    7 KB 6,986 B versus 7,321 B (134 JSON escapes);
  - Context7, measured on 2026-10-07 from an SDK client, returns text only: neither
    of its two tools declares `outputSchema`, and no result carries
    `structuredContent`;
  - nothing in `src/` or `extensions/` reads `structuredContent`.

  `consult`, `review`, `run` and the deprecated aliases declare no `outputSchema`
  and send no `structuredContent`. The footer carries what the structured fields
  carried: backend, resolved model, duration, operations, session handle with
  `ready` or `finished`, `, no history` when the turn was not archived, the review
  verdict and reason (`> Verdict: ...`), and the error code with `, retryable` when
  the same request may succeed later. `doctor` (full), `session` and `issue` keep
  `structuredContent`, because they return data. `tools/list` 5,515 B to 3,669 B;
  model-visible definitions unchanged. Recorded in the runtime contract (Execution
  Tool Result). Evidence: `tests/tools/result.test.js` (CONTEXT-001 footer test),
  `tests/e2e/mcp.test.js` and `tests/consumer/smoke.cjs` (no `outputSchema` on
  `consult` and `review` over stdio, no `structuredContent` in a fixture turn);
  both fail on the previous source (6 failures). Every execution assertion reads
  the text through `tests/helpers/result.cjs`, which rejects an unknown footer
  line. Full suite: 254 pass, 0 fail, 3 skipped.
- [ ] Predictable cost of a plain consult (owner decision): `auto` chose
  `gpt-6.1-sol` for 52.8 s from agy. Once prices are stored (`EXEC-001`, consent by
  relative price), `auto` could also prefer a cheaper model. Options: a faster default tier for `consult`,
  or only stating in the `backend` description that `auto` may run a large model.
- [ ] `auto` and consent: when the client cannot ask the user (no form
  elicitation), `auto`/`smart_quota` should skip a backend whose default model the
  governance policy asks for, instead of selecting it and failing with
  `POLICY_DENIED`. Since consent by price (2026-10-07) the owner's Claude default
  `claude-opus-5-5` asks on every turn, so a plain headless consult routed to
  Claude fails. Consent itself stays independent of quota: quota is transient and
  sometimes unmeasured, and a P0 decision must not change with it.
- [x] Live acceptance of the markdown result, 2026-10-07, built server at
  `fix/refused-call-footer`, each client a fresh headless process:
  - Claude Code 2.1.289 (`claude -p`, haiku) called `consult` on Codex
    `gpt-5.6-luna` low: the `tool_result` was the markdown
    `coagent8\n\n> CoAgent8: codex · gpt-5.6-luna · 13.8s · 1 op · <handle> (ready)`,
    no JSON;
  - Codex 0.160.1 (`codex exec`, `gpt-5.6-luna` low) called `consult` on Gemini
    `gemini-3.8-flash` without effort: `structured_content: null`, and the model
    read the text `> Error [INPUT_LIMIT]: gemini model 'gemini-3.8-flash' needs
    reasoning_effort (high, medium, low), ...`, retried once with `low` and got a
    one-line answer ("-4, or 0 as calculator notation") without added sections;
  - agy 1.3.1 (`agy -p`, `gemini-3.8-flash` low) called `consult` on Claude
    `haiku`: `OK` with the footer naming `claude-haiku-4-5-20251001`;
  - a raw Codex app-server turn (`gpt-5.6-luna` low) sent
    `phase: "commentary"` ("I will read package.json and tsconfig.json.") and then
    `phase: "final_answer"`, the shape the collector now filters.

  The Codex run showed `provider default` in the footer of the refused call, fixed
  on `fix/refused-call-footer` (`tests/server.test.js`). Recorded in the
  integration guide.

**Agent experience (owner use cases of 2026-10-07).** The owner had Codex, agy
and Claude Code each solve one task through `consult`, then compare CoAgent8 with
Context7 from the calling model's side. Findings shared by the three clients:
- the backends were clear, the models were not: `model` is a bare string, and
  `gemini-3.8-flash` without `reasoning_effort` and `luna` on Codex were found by
  failing;
- errors the caller can fix arrived as `PROCESS_ERROR` with a 1.5 KB issue link,
  and a failed agy run showed "Task completed cleanly with no textual output." as
  a partial response;
- the consult prompt adds trade-off and recommendation sections to plain questions
  (three of three Gemini answers);
- Context7 states when to use it and when not, gives examples of good and bad
  values, and resolves an identifier before the expensive call. Its two tool
  definitions take 4,587 B; CoAgent8's six take 3,492 B with most parameters
  undescribed;
- `auto` ran `gpt-6.1-sol` for 52.8 s from agy, and a Gemini answer from Claude
  Code stated the MCP specification wrongly with no hint that it is an unverified
  opinion;
- agy saw Codex's working commentary before the answer.

Owner decisions of 2026-10-07: fix all of the above; raise the model-visible
definition budget from 3,800 B to about 5 KB for described parameters.

- [x] Errors the caller can fix are typed, and a failure shows no invented answer.
  A Codex turn error whose message is the provider's raw response body is
  classified from that body and reports its inner message. A bare HTTP 4xx takes
  `MODEL_UNAVAILABLE` or `SESSION_INVALID` from the message, but never a rate limit
  or sign-in error. "not supported" and agy's "invalid model selection" are
  `MODEL_UNAVAILABLE`, which gets no issue link. The stream reducer returns no
  placeholder text. Evidence: `tests/backends/errors.test.js` with the live
  messages (`luna` on Codex 0.160, `gemini-3.8-flash` without effort on agy
  1.3.1) and `tests/execution/stream-reducer.test.js`; both fail on the previous
  source. Full suite: 256 pass, 0 fail, 3 skipped.
- [x] Explicit model and effort checked before the model turn when a usable CLI
  catalog is available (Claude has none), with the accepted values in
  the error. The probes listed models from a static table that did not match the
  CLIs: Codex offered `gpt-6.0-sol`, `luna` and `astra`, while Codex 0.160 lists
  `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
  `gpt-5.6-terra` and `gpt-5.6-luna` (`model/list`, 0.1 to 1.4 s, no model call).
  agy 1.3.1 lists its models with `agy models` (about 2 s). Both catalogs are now
  read from the CLI, on demand and cached per probe. The controller checks an
  explicit `model` or `reasoning_effort` before consent; doctor reports the
  catalogs. Live check on 2026-10-07 against the installed CLIs: `luna` on Codex is
  refused with the seven offered models, `gemini-3.8-flash` without effort with
  "needs reasoning_effort (high, medium, low), or name it with the effort, for
  example 'gemini-3.8-flash-high'", and `gpt-5.6-luna` with `low`,
  `gemini-3.8-flash` with `low` and `gemini-3.8-flash-high` pass. Evidence:
  `tests/backends/model-catalog.test.js` (fixture catalogs in the live shapes; the
  controller test fails on the previous controller, which ran the backend) and
  `tests/diagnostics/doctor.test.js`.
- [x] Only the backend's final answer is returned, without its working commentary.
  Codex 0.160 marks each `agentMessage` with `phase`: `commentary` (interim
  narration between tool calls) or `final_answer`, or null for models that do not
  emit it (generated app-server schema, `MessagePhase`). The collector joined every
  message. Once a `final_answer` arrives, the answer drops the commentary; the
  history keeps it, a message without a phase stays in the answer, and a turn
  without a final answer keeps the commentary as its partial response. Claude Code
  (`result`) and agy (`response`) already return only their final text. Evidence:
  `tests/backends/codex/collector.test.js` (fails on the previous collector). A live
  Codex turn with a tool call is part of the live acceptance below.
- [x] Neutral consult prompt: no added trade-off or recommendation sections.
  Without `task_type` the prompt was `[TASK: TECHNICAL ADVICE & CONSULTATION]` with
  the default focus "General evaluation, trade-offs, and technical advice", and
  Gemini answered a percentage question and an MCP question with trade-off and
  recommendation sections. Now a plain consult is one instruction ("Answer what
  is asked, conclusion first, concisely, without preamble or sections nobody asked
  for.") and the question, plus `specific_questions` and files when given; a task
  type keeps its header and focus. Evidence: `tests/e2e/generic-mcp.test.js` checks
  the exact prompt (fails on the previous prompt). The effect on answers is part of
  the live acceptance below.
- [x] Agent-facing contract within about 5 KB:
  - server instructions (482 characters, within the 512 Codex reads on their own)
    say when to use `consult` and `review` and when not, that the answer is
    another model's opinion to verify, and that `doctor` lists the models and
    efforts;
  - `backend` (what `auto` and `smart_quota` do), `model` (an example per backend
    and where the list is), `reasoning_effort` (the agy requirement),
    `proposal` (a good and a bad example), `specific_questions`, `context_files`
    (only paths are sent), `task_type`, `session_handle` and `workspace_path` (the
    fallback is named in the footer) are described; the `consult` and `review`
    descriptions name the footer lines;
  - the `doctor` summary lists each backend's models and efforts. Live on
    2026-10-07 against the installed CLIs: 888 B (budget 1 KB), with the seven
    Codex models, the seven agy model groups and the Claude aliases.

  Model-visible tool definitions: 5,222 B against 3,492 B (budget 5,300 B);
  `tools/list` 5,389 B. Evidence: `tests/tools/surface.test.js` (the instructions'
  three points, a description for every parameter a caller chooses, the budget) and
  `tests/diagnostics/doctor.test.js` (model lines); both fail on the previous
  source.
- [x] A continuation keeps the session's reasoning effort. Found by the headless
  AX retest of 2026-10-07 (Codex 0.160.1 host, `gpt-5.6-luna` low): after a
  successful agy turn with `gemini-3.8-flash` and `reasoning_effort: low`, the
  continuation with only `session_handle` reached agy as `--model
  "gemini-3.8-flash" --effort ""` and failed after 5.0 s with
  `MODEL_UNAVAILABLE`; the host had to repeat the effort. The session stored the
  model but not the effort. On `fix/session-effort-continuation` the session
  record keeps `reasoningEffort`, and a continuation reuses it unless the call
  names an effort, or names a model other than the session's. Evidence:
  `tests/execution/controller-history.test.js` (a turn with an effort, then
  continuations without one, with another effort and with another model); it
  fails on the previous controller with `effort: undefined`. Full suite: 267
  tests, 264 pass, 0 fail, 3 skipped (POSIX only). Live on 2026-10-07 through
  the built server at `690b3d0` (fresh stdio client, agy 1.3.1): the turn with
  `gemini-3.8-flash` and `low` answered `391`, the continuation with only the
  handle answered `400` (turn 2).
- [x] Headless AX retest, 2026-10-07: fresh `codex exec --json` (Codex 0.160.1,
  `gpt-5.6-luna` low) and `agy -p` (agy 1.3.1, `gemini-3.8-flash-low`) processes
  against the built server at `5d0c9f5`. Each host got deliberate wrong models
  and efforts, a question that makes the backend read a file, a continuation and,
  for Codex, a review of `2437d98`, with the instruction not to read files itself.
  Codex host, eight calls:
  - `gemini-3.8-flash` without effort: `INPUT_LIMIT` with the three efforts in
    0.0 s; the retry with `low` answered `391` in 7.1 s;
  - the continuation with only the handle failed (`MODEL_UNAVAILABLE`, agy got
    `--effort ""`); the host repeated the effort and got `400`. Fixed on
    `fix/session-effort-continuation` (item above);
  - `luna` with `minimal` on Codex: `MODEL_UNAVAILABLE` listing the seven models,
    then `gpt-6-luna` with `minimal`: `INPUT_LIMIT` naming the accepted efforts,
    both in 0.0 s; with `low` the backend read `package.json` (1 op) and the answer
    was only `"test": "node tests/run.cjs"`, without commentary;
  - `review` of `2437d98` on Claude `haiku`: findings and `> Verdict: READY` in
    63.4 s, 14 ops;
  - Codex has no MCP roots, so every result named the server-directory workspace.

  agy host, seven calls in 84 s, each under its 180 s limit:
  - `luna` on Codex: `MODEL_UNAVAILABLE` with the list; the retry with
    `gpt-6-luna` answered `391`; the continuation answered `400` (turn 2);
  - the host then sent the continuation a second time (`409`, turn 3) and reported
    the second result as the first. A host-side repeat; the footer's turn number
    shows it, and CoAgent8 behaved as specified;
  - Claude `haiku` with `minimal`: `Warsaw` and the footer warning that the
    effort is ignored;
  - `gemini-3.8-flash` without effort: `INPUT_LIMIT`; the retry named
    `gemini-3.8-flash-low` and quoted the test script (1 op, 12.2 s);
  - before the first call agy read its own cached tool definition
    (`~/.gemini/antigravity-cli/mcp/coagent8/consult.json`, 2,004 B), not source.

  Every wrong model or effort was corrected from the error in one retry, without
  reading source. The same steps, plus a governed-model consent dialog, are the
  owner's retest in VS Code chat hosts.
- [x] Owner's retest in VS Code chat hosts, 2026-10-07 (17:46 to 17:52), after a
  VS Code restart, built server `57e803f7` (`feat/price-based-consent`), Windows
  11 Pro 26200, VS Code 1.140.0. Hosts: the Codex chat (extension
  `openai.chatgpt` 26.1002.51308, app-server 0.162.0-alpha.2, `gpt-6.1-sol`
  medium) and the Antigravity chat (extension `google.google-antigravity` 1.7.0).
  Backends: agy 1.3.1, Claude Code 2.1.289, Codex 0.160.1 under the Codex host
  and 0.160.0 under the Antigravity host. The two hosts' PATHs resolve different
  Codex installations.

  | Step | Expected | Codex chat | Antigravity chat |
  | --- | --- | --- | --- |
  | 1 | `gemini-3.8-flash` without effort: `INPUT_LIMIT` with the three efforts, then `391` after one retry | PASS (retry `gemini-3.8-flash-low`, 8.0 s) | PASS (retry with effort `medium`, 5.9 s) |
  | 2 | continuation with only the handle: `400`, `(turn 2, ready)` | PASS (6.2 s) | PASS (9.2 s) |
  | 3 | `luna` + `minimal`: seven models, then "not 'minimal'", then only the test script, `1 op`, no commentary | PASS (8.3 s) | PASS (10.7 s; one sentence quoting the script) |
  | 4 | `haiku` + `minimal`: `Warsaw` and the ignored-effort warning | PASS (3.1 s) | PASS (3.1 s) |
  | 5 | review of `2437d98` on `haiku`: findings, then `> Verdict: ...` | format PASS, verdict wrong: `BLOCKED` (46.9 s, 7 ops) | format PASS, verdict wrong: `BLOCKED` (47.0 s, 11 ops) |
  | 6 | `opus`: consent form; decline gives "did not approve" | FAIL: no form shown, `POLICY_DENIED` "did not approve" | FAIL: same |

  CoAgent8 defects:
  - Step 6: neither host showed a form; Codex answers every elicitation with
    `cancel` (stub measurement), and CoAgent8 reported that as the user's refusal.
    Fixed on `fix/consent-unanswered` (`EXEC-001`). The consent dialog itself
    remains unverified in both VS Code chats.
  - Step 5: both reviews are false positives. The finding says the diff imports
    `isValidModelIdentifier` from `governance.js`, which "contains only
    `GovernanceSettings`, `ConsentDecision`, and `decideConsent`". At `2437d98`
    `governance.ts` did export it and `model-identifier.ts` did not exist. The
    reviewer read the checked-out files of a later revision. The envelope also
    claimed `CHECKS: typecheck=FAIL`, a check Claude's restricted tools cannot run,
    and the gate accepted both claims. Recorded as `CUR-013`; the fix needs an
    owner decision (for example a temporary worktree of the reviewed commit). The
    headless retest of the same commit returned `READY` (63.4 s).
  - The first Gemini call of the Codex chat opened a focus-stealing console
    window: agy's auto-updater (`WINDOWS-001`, fixed on `fix/agy-quiet-updater`).

  Host-side behavior, not CoAgent8 defects:
  - The Antigravity host sent `prompt` instead of `proposal` on its first call and
    corrected it from `Missing required arguments.proposal.` in one retry.
  - Each host made every call once; no duplicate calls this time.
  - The Codex host reported step 5's "first line" as a paraphrase of the first
    finding; the answer starts with the envelope (`REVIEW: 1`), as the Antigravity
    host reported.
  - Presentation (owner's note): the Antigravity chat shows a titled entry per call
    and more of what the backend did; the Codex chat shows less, but shows the
    server icon.
  - Codex's `approvals_reviewer = "auto_review"` rejected a `codex exec` call of
    `opus` inside this repository by citing rule 01, before the call reached
    CoAgent8.

## 3. Smaller execution path, robust sessions and honest routing

### `EXEC-001` - pure backend resolution, bounded probes and enforceable policy

- [x] Make backend resolution (`src/backends/routing.ts:resolveBackend`) strictly
  read-only: no `setDefaultBackend` mutation during `auto` resolution. Verified in
  `tests/backends/routing.test.js`.
- [x] Prefer an explicit backend or configured default. Owner decision of 2026-10-07
  (`CONTEXT-001`): an ambiguous `auto` no longer returns the onboarding error. It
  selects like `smart_quota`:
  - skipping the calling client's own CLI;
  - skipping providers with an observed rate limit;
  - preferring measured headroom.

  Verified in `tests/backends/routing.test.js` and `tests/server.test.js`.
- [x] Bounded probe caching (AUD-P1-4), on `perf/bounded-probes`, not yet merged:
  - one completed cached probe per backend, keyed by executable/configuration
    file size/mtime and selected environment variables, not configuration digests;
  - bounded TTL, with forced refresh in `doctor`;
  - adapters do not re-probe inside `execute` (Gemini `--version`; Claude no
    longer does, see `CLAUDE-BACKEND-001`);
  - the agy `/usage` call runs only in `doctor`, never on the request path;
  - fail-closed sandbox checks and fresh consent evaluation on every turn.

  `src/backends/probe-cache.ts` keeps one probe per backend for at most 5 minutes,
  keyed by the resolved executable files (size, mtime), the probe's configuration
  file and the environment that selects an executable or credentials; doctor
  probes afresh and replaces it. Configuration is keyed by file stamp, not by a
  digest. The agy `/usage` read moved to `inspectQuota`, now with `--sandbox`.
  Verified live on 2026-10-07 with agy 1.3.1: four reads returned a measured
  weekly window (75% headroom) in 3.3 to 4.7 s. The 5 s timeout leaves little
  margin; a slower read is reported as unmeasured quota. Doctor counts a
  quota measured in its own run as proof of a signed-in CLI, because the agy probe
  no longer reports `authenticated`. Sandbox and consent checks stay in `execute`.
  Evidence: `tests/backends/probe-cache.test.js` (five resolves, one probe; a new
  executable mtime, a changed configuration or credential variable, and doctor
  each probe again) and `tests/backends/gemini/adapter.test.js` (the probe makes no
  `/usage` call; `inspectQuota` passes `--sandbox`; `execute` launches no
  `--version`). Full suite: 237 pass, 0 fail.
- [x] Keep doctor as an explicit diagnostic operation; `inspectQuotas()` is
  integrated into `runDoctor()` and backends under active cooldown are excluded
  from `ready_backends`. Authentication evidence honesty is reopened under
  `DIAGNOSTICS-001`.
- [x] Validate `model` identifiers in the schema and in each adapter before they
  reach argv (AUD-P1-6). On `fix/model-identifier-validation`, not yet merged.
  The controller rejects an invalid `model` with `INPUT_LIMIT` before resolving a
  backend, and the Codex, Gemini and Claude adapters repeat the check
  (`isValidModelIdentifier`, the audit pattern). The pattern is not advertised in
  the tool schema: it would add about 110 B to the definitions and exceed the
  3,800 B `CONTEXT-001` budget. Evidence: `tests/backends/model-identifier.test.js`
  sends `--yolo`, `-m`, `gpt 6` and a newline-joined flag to every adapter and
  through `executeTask`; all return `INPUT_LIMIT` without running a backend. With
  the Gemini check removed, the agy fixture accepts `--model --yolo` and completes.
- [x] Parse Codex configuration with `smol-toml` (top-level `model` only), or
  omit `-m` when no model was requested and govern the model the CLI reports
  (AUD-P1-11). On `fix/codex-config-toml`, not yet merged. `readCodexConfig`
  parses the file with `smol-toml` and reads only top-level `model` and
  `model_reasoning_effort`; an unreadable or invalid file keeps the defaults and
  sets `configError` in the probe's `config`. Evidence:
  `tests/backends/codex/adapter.test.js` with the audit input (`# model = "o3"`,
  `review_model`, a `[profiles.*]` model): the old regex returns `o3`, the parser
  returns the default.
- [x] Consent the caller cannot assert (AUD-P1-7), owner decision of 2026-10-07,
  on `feat/caller-proof-consent`, not yet merged. Breaking change:
  - when the client declares form elicitation, the server asks the user with
    `elicitation/create` before a governed model runs, on every turn;
  - otherwise the turn fails with `POLICY_DENIED` and a one-line instruction;
  - the controller governs the model the backend would run
    (`CliAdapter.resolveModel`: Codex `config.toml` default, Claude alias and
    `ANTHROPIC_DEFAULT_*_MODEL` override, agy bridge default; replaced by model
    selection on `refactor/model-catalog-cache`), and adapters run a governed
    model only when it equals the approved `consentedModel`;
  - agy's own default lives in its interface state, so agy always gets `--model`
    (`gemini-3.8-flash-high` unless the caller names one);
  - `user_confirmed` is removed from the schema and rejected as unknown.

  Evidence: the audit reproduction (an agent-set `user_confirmed: true` with
  `claude-opus-4-6-thinking` on agy, and agy without a model) on the stack tip
  `3dd6abd` launches the governed model and passes no `--model`; on this branch it
  returns `POLICY_DENIED` without launching, and agy gets
  `--model gemini-3.8-flash-high`. Regression tests:
  `tests/server.test.js` (a real MCP client: no elicitation, decline, unchecked
  box, approval, no prompt for a default-tier model),
  `tests/execution/controller-history.test.js` (`user_confirmed` grants nothing;
  consent asked for the effective default and bound to that model),
  `tests/backends/gemini/adapter.test.js` and `tests/backends/claude/adapter.test.js`
  (consent for another model does not count). Model-visible tool definitions
  3,492 B against 3,728 B before (budget 3,800 B). Full suite: 247 pass, 0 fail,
  2 skipped. Not yet verified: a live interactive approval prompt in a real client.
  Headless cancellation was measured later. `CUR-003` (an accepted response
  without the checkbox passed) is closed on `fix/explicit-consent`, see
  `AUDIT-001`.
- [x] **Model catalog without model literals** (owner decision of 2026-10-07:
  "hardcoding is bad"). `src/` named models in the Codex adapter (`gpt-6.1-sol`
  when `config.toml` has no `model`), the agy adapter (`GEMINI_DEFAULT_MODEL`),
  the Claude adapter (alias list, `sonnet` default, `haiku` for `/usage`, an
  `ANTHROPIC_DEFAULT_*_MODEL` alias regex) and the parameter descriptions.
  Claude default, owner decision of 2026-10-07: the model Claude Code reports in
  `system/init`. Measured live the same day (Claude Code 2.1.289): a local
  `claude -p --output-format stream-json --verbose /usage` reports the model with
  `num_turns: 0` and `total_cost_usd: 0`; without `--model` it reported
  `claude-opus-5-5` (the bridge ran `sonnet`), `sonnet` `claude-sonnet-5-5`,
  `fable` `claude-fable-5-1`, and with `ANTHROPIC_DEFAULT_SONNET_MODEL` set,
  `sonnet` and `sonnet[1m]` the overriding model (`[1m]` kept). `--restricted`
  ignores user settings, so this is what the restricted profile runs.

  On `refactor/model-catalog-cache`:
  - `backends/model-selection.ts` picks the call's model, the session's,
    `config.json` `backends.<id>.defaultModel`, the CLI's configured default
    (Codex `config.toml`), the catalog's declared default (Codex `isDefault`),
    the first model the catalog lists (agy) or the model the CLI reports (Claude),
    else `MODEL_UNAVAILABLE`. Adapters refuse a turn without a model;
  - Claude names are resolved through `system/init` before consent, so consent
    and `--model` name the concrete model; an unresolved name is refused. The
    alias list and regex are gone; the Claude minimum is 2.1.289;
  - catalogs and observed models persist in `~/.coagent8/models.json` for a day,
    keyed by a hash of file stamps and the provider-prefixed environment
    (`ANTHROPIC_`, `CLAUDE_`, `CODEX_`, `OPENAI_`, `GEMINI_`, `AGY_`), which also
    widens the probe key (`CUR-006` in part). Failed reads and writes are reported,
    never fatal;
  - doctor reports each default and its source, and records one the CLI does not
    state itself (agy's first listed, Claude's reported) in `config.json` once;
  - the `model` and `reasoning_effort` descriptions name no model. Model-visible
    tool definitions: 5,194 B (5,256 B before, budget 5,300 B).

  Evidence: `tests/backends/model-literals.test.js` strips comments with esbuild
  and finds no model name in `src/` code except `backends/governance.ts` (the next
  item); on the previous source it lists 16. `tests/backends/model-selection.test.js`:
  the store answers a later process without a CLI read, holds no credential, is
  re-read for another installation, after a day and when unreadable; the selection
  order; doctor records agy's first listed and Claude's reported default once and a
  reversed catalog no longer moves it; a Claude alias the CLI maps to a top-tier
  model is refused without consent. Against the previous source that alias ran as
  `--model sonnet` without consent, and a Claude turn without a model ran the
  literal `sonnet`. Full suite: 273 tests, 270 pass, 0 fail, 3 skipped; typecheck,
  `lint:docs`, `npm run docs`, build and consumer smoke pass.

  Live on 2026-10-07 through the built server with a temporary data directory: doctor
  recorded `gemini-3.8-flash-high` (first listed) and `claude-opus-5-5` (reported)
  and kept Codex's `config.toml` model; agy without a model ran
  `gemini-3.8-flash-high` (`OK`, 8.6 s); Claude `haiku` ran as
  `claude-haiku-4-5-20251001`; Claude without a model was refused before launch,
  because the recorded default `claude-opus-5-5` is governed by the current name
  rule and the client offered no elicitation. Until consent by relative price lands,
  a headless client must name a Claude model.

  Test fixtures may keep model names: they reproduce recorded CLI output.
- [x] **Consent by relative price instead of name families** (owner direction of
  2026-10-07). Approximate prices are enough: the decision is only whether to ask
  the user, and the tiers differ by up to 100×. The name rule is already stale:
  the recorded `claude-fable-5-1` example (then quoted at 10/50 USD per million
  tokens) would not match the current astra/opus/best rules. That illustrates a
  name-based policy gap; the price/name is a historical observation.
  Recorded observations and pricing assumptions from 2026-10-07 (not fresh
  pricing guarantees; vendor availability and prices must be rechecked):
  - no CLI reports prices. Codex `model/list` has descriptions, `isDefault`,
    efforts and service tiers; `agy models` has names; Claude Code lists nothing.
    As far as known, OpenAI, Anthropic and Google publish no price API;
  - agy's `/usage` states that "Quota is consumed proportionally to the cost of
    the tokens", with groups "Gemini Models" and "Claude and GPT models", so the
    API price was proposed as a subscription-cost proxy. Its accuracy is an
    inference, not an enforced or independently verified billing equivalence;
  - OpenRouter `GET https://openrouter.ai/api/v1/models`: public, no key, 79 KB
    gzip, 465 models, `pricing.prompt` and `pricing.completion` per token,
    `reasoning.supported_efforts`, `canonical_slug`, `created`; no `ETag`,
    `Cache-Control: max-age=120`. It covers every model in today's Codex and agy
    catalogs and the Claude models. IDs differ: `anthropic/claude-fable-5.1` for
    `claude-fable-5-1`, `claude-opus-4.6` for agy's `claude-opus-4-6-thinking`,
    and `google/gemini-3.1-pro-preview` for agy's `gemini-3.1-pro`;
  - models.dev `api.json` (MIT, community data, 530 KB gzip) was considered and
    rejected: it is larger, and it prices `gpt-5.6-sol` at 4/20 where OpenRouter
    bills 2/10.

  Owner decisions of 2026-10-07 on the design questions of the review at `24052e3`:
  - an expensive default asks by default: an absolute limit of 20 USD per million
    output tokens (`governance.askAbovePrice`) applies to every model, the default
    included, besides the relative rule (2× the default, `priceMultiplier`); the
    user relaxes it with `neverAsk` for a model or `askAbovePrice: null`;
  - without any stored list a turn reads it once (bounded); doctor reads it again
    after a week;
  - "remember" stores approvals only, by model id, in `governance.neverAsk`; a
    decline stores nothing;
  - the limit stays at 20 USD, weighed against 10 and 15: at today's prices it is
    the opus/astra tier (`claude-opus-5.5` 20, `claude-opus-4.6` 25, `gpt-6-astra`
    and `claude-fable-5.1` 50) and leaves sonnet (10 to 15), sol (10) and pro (12)
    to the relative rule; 10 would ask on every turn of the Codex default
    `gpt-6.1-sol`. Consent stays independent of quota (`auto` item in `CONTEXT-001`);
  - the rule 01 (P0) wording, with the 20 USD limit, was confirmed before the commit.

  Prices on 2026-10-07 (OpenRouter, USD per million output tokens): Codex default
  `gpt-6.1-sol` 10, `gpt-6-astra` 50, `gpt-5.6-terra` 12, `gpt-5.6-luna` 1.2,
  `gpt-6-luna` 0.5; agy default `gemini-3.8-flash` 3.75, `gemini-3.1-pro-preview`
  12, `claude-sonnet-4.6` 15, `claude-opus-4.6` 25, `gpt-oss-120b` 0.17; Claude
  `claude-opus-5.5` 20, `claude-sonnet-5.5` 10, `claude-fable-5.1` 50,
  `claude-haiku-4.5` 5.

  On `feat/price-based-consent`:
  - `backends/prices.ts` reads OpenRouter's public list (or `coagent8_PRICES_URL`,
    URL or file), bounded to 10 s and 4 MiB, keeps each model's output price in
    `models.json` and matches names exactly (also without an effort or date
    suffix) or approximately (one name extends the other; `[1m]` variants);
  - `backends/governance.ts` decides: `alwaysAsk`, no price list, unknown or
    approximate price (with "remember"), at or above `askAbovePrice`, at least
    `priceMultiplier` times the default's; `neverAsk` exempts. The name families
    and the adapters' name checks are gone; the controller is the only consent
    owner and passes the adapter the model the user approved;
  - the elicitation names the reason and offers "remember" only for an unknown or
    approximate price; doctor shows the price list date and marks a default that
    asks on every turn.

  Evidence: `tests/backends/governance.test.js` (fable asks, luna does not, astra
  asks; the default above the limit asks unless relaxed; unknown and approximate
  models ask with remember; without prices everything not remembered asks; name
  matching; a local HTTP source read once, refused over 4 MiB or without priced
  models, read again by doctor after a week) and `tests/server.test.js` (a real MCP
  client: the form offers remember only for unknown or approximate prices, an
  unknown model approved with remember is in `neverAsk` and not asked again). The
  same cases through `executeTask` without elicitation: on the previous source
  `claude-fable-5-1` (default `claude-sonnet-5-5`) and an unknown `gpt-7-nova` ran
  without asking; on this branch both are refused. `tests/backends/model-literals.test.js`
  now covers all of `src/`. Full suite: 277 tests, 274 pass, 0 fail, 3 skipped;
  typecheck, `lint:docs`, `npm run docs`, build and consumer smoke pass. Live on
  2026-10-07 through the built server (no elicitation, temporary data directory,
  live OpenRouter list: 351 priced models, 11 KB stored): Codex `gpt-5.6-luna` and
  Claude `haiku` answered `OK`; `gpt-6-astra` and `fable` were refused (50 USD at or
  above the limit) and agy's `claude-opus-4-6-thinking` (approximate price); doctor
  marked Claude's default `claude-opus-5-5` (20 USD) as asking on every turn.

- [x] A cancelled approval request is not reported as the user's refusal. In the
  owner's VS Code retest of 2026-10-07 neither the Codex nor the Antigravity chat
  showed a consent form for Claude `opus`, and both results read "The user did not
  approve model 'claude-opus-5-5'". The Codex log (`logs_2.sqlite`) records no
  elicitation request sent to the VS Code client during that call. A stub MCP
  server measured Codex 0.160.1 (`codex exec`): it declares
  `elicitation: {form, url}` and answers `elicitation/create` with
  `{"action":"cancel"}` after 3 ms, without asking anyone. On
  `fix/consent-unanswered` a cancel yields "The client closed the approval request
  for model '...' without an answer, possibly without showing it to the user",
  followed by the price reason and "Retry with another model."; a decline or an
  unchecked box still reads "did not approve". Evidence: `tests/server.test.js` (a
  real MCP client answering `cancel`; fails on the previous server). Full suite:
  278 tests, 275 pass, 0 fail, 3 skipped. One earlier full run failed once on
  `tests/sessions/lock.test.js` (competing processes); it passed alone three times
  and in the repeated full run. Typecheck, `lint:docs`, `npm run docs`, build
  (`6609623f`) and consumer smoke pass. Live: a fresh `codex exec` (0.160.1) run
  from outside the repository got the new message for `opus`. Run inside the
  repository, Codex's `auto_review` approval reviewer rejected the MCP call itself,
  citing rule 01, before it reached CoAgent8.
- [ ] `CUR-006`: coalesce concurrent probe/catalog misses; expand invalidation
  for actual provider configuration/env selectors (including Codex home and
  Claude default aliases). Define refresh/failure behavior; acceptance measures
  process counts under concurrent calls and changes to those settings.
- [x] Correct the model/backend description promises: catalog validation is
  best-effort and quota is cached evidence. The documentation reconciliation
  measured 5,256 B against the 5,300 B budget; 15 source-loaded surface tests pass.
  Model-name examples remain until the catalog/default redesign.

### `CLAUDE-BACKEND-001` - Claude Code in restricted read-only mode

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
- [x] Native quota for diagnostics: optional `CliAdapter.inspectQuota()`,
  implemented for Claude through `claude -p /usage` on verified CLI versions (>= 2.1.289;
  versions older than 2.1.289 skip inspection to prevent prompt leakage to models; zero cost and
  no turn verified live and on every read) and called by `inspectQuotas` for
  `doctor`. Window summarizing is shared with Gemini (`src/backends/quota.ts`).
  Native reads are now off the routing path; routing uses existing measurements.
  This supersedes the earlier smart_quota latency note (5 s version + 15 s usage).
- [ ] Bound/cancel diagnostic native quota reads consistently. Review latency
  without weakening version checks that prevent a local /usage command from
  becoming a paid model prompt.
- [ ] Skills for audits: decide how workspace skills reach the Reviewer. The
  profile exposes no `Skill` tool, and `--restricted` ignores project settings;
  extend `CLAUDE_READ_ONLY_TOOLS` only with live evidence that the profile stays
  read-only.
- [ ] Open: user-level hooks and plugins could not be observed (none installed);
  their exclusion rests on the `--restricted` help text and the project-settings
  evidence. Built-in CLI plugins (`agents-md`, telemetry) still run.

### `ROUTING-MIGRATE-001` / `QUOTA-001` - honest circuit breaker and native quota introspection

**Status:** Partially implemented; the AUD-P1-1 single-write fix is on
`fix/cooldown-single-write`, not yet merged.

- [x] Gemini (`agy`) native quota: `agy --output-format json -p "/usage"` is parsed
  into measured `remaining_fraction`, `headroomPercent` and `resetsAt`. Moving this
  probe off the request path is tracked in `EXEC-001`.
- [x] Codex classification: `usage limit`, `hit your usage limit` and `spend cap`
  map to `RATE_LIMITED`.
- [x] Record exactly one cooldown per rate-limited turn, using the parsed provider
  reset when present and the tiered backoff otherwise. Remove the second write in
  the controller. Acceptance: a regression through the controller sequence, not
  only `checkAndRecordRateLimit` (AUD-P1-1, order 1). Evidence:
  `tests/execution/controller-cooldown.test.js` runs `executeTask` with a
  rate-limited fixture and reads the cooldown cache: "Try again in 3 days" records
  3 days, a message without a reset records one first-tier cooldown (15 s, level 0).
  With a second write reinjected, the same test fails with 45 s, the audit
  reproduction. The controller is the only writer; `checkAndRecordRateLimit` is
  removed because adapters already classify `RATE_LIMITED`.
- [x] Classify from structured payloads first and anchored provider phrases
  second. Stop matching bare `429`, `quota` or `auth` substrings. Parse `ms`
  before `m` and decimal durations (AUD-P2-1). On `fix/error-classification`, not
  yet merged. The Codex and Gemini text classifiers use the shared rate-limit
  detector and a new `isAuthError` (`src/backends/auth-error.ts`) of anchored
  phrases; structured payload extraction is unchanged. Evidence:
  `tests/backends/errors.test.js` (the audit inputs `line 429`, `author field`,
  `disk quota check` are `PROCESS_ERROR` for both classifiers) and
  `tests/backends/rate-limit.test.js` (`20ms` is 20 ms, `1.5s` is 1.5 s); both fail
  against the previous classifiers.
- [x] Remove remaining synthetic telemetry: a missing `remaining_fraction` is
  unmeasured, not 100% headroom (AUD-P2-2). On `fix/unmeasured-quota`, not yet
  merged. `parseGeminiUsage` drops windows without `remaining_fraction` and
  returns no quota when none is measured. Evidence:
  `tests/backends/gemini/adapter.test.js` (a payload whose only window lacks the
  field yields no quota; with one measured window of 0.3, headroom is 30%).
- [x] Claude login state comes from native `claude auth status` JSON; execution
  failures use structured/anchored classification (`CLAUDE-BACKEND-001`).
  Login evidence does not prove token validity for a model turn.
- [x] Document observed cooldowns separately from native quota. Current selection
  ranks cached measured headroom and prefers a different CLI (`CONTEXT-001`);
  unknown headroom uses 50 only as a sorting heuristic.
- [ ] `CUR-004`: make optional quota-cache failure non-blocking for automatic
  selection, with a bounded warning and deterministic safe fallback. Keep policy
  and observed limits fail-closed. Track measurement freshness separately from
  cache rewrite time; stale measurements must not silently retain fresh weight.
  Acceptance: unwritable/file-parent cache and stale-data routing regressions.

### `SESSION-001` - safe auto-resume and first-class handle exposure

- [x] Expose `sessionHandle` as a first-class field the caller can read: the footer
  states the handle with `turn <n>` and `ready` or `finished` whenever a session
  exists. It was `structuredContent.sessionHandle` until the markdown-only result
  (`CONTEXT-001`). Evidence: the footer test in `tests/tools/result.test.js` and the
  handle reuse in `tests/consumer/smoke.cjs`.
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
- [x] Enforce workspace ownership consistently (AUD-P1-8, order 2): MCP resources
  must not list or return other workspaces' sessions and histories, unless they
  are explicitly documented as an owner-wide view. The `session list` action
  follows the same rule. On `fix/resource-workspace-isolation`, not yet merged.
  `listSessions` takes the workspace; resources use the connection's workspace
  (runtime contract, "Workspace Scope"). Evidence: `tests/server.test.js` and
  `tests/tools/session.test.js` create a session in a second workspace; it is
  absent from `resources/list`, `coagent8://sessions` and `session list`, and
  reading its history fails. With the history check removed the read succeeds
  and the test fails.

### `LOCKS-001` - lease integrity

**Status:** Implemented on `fix/lease-integrity`, not yet merged (AUD-P1-9).

- [x] Create lease files atomically (write a temporary file, then link or rename),
  so no lease is ever observable empty. `publishLease` writes a temporary file and
  publishes it with `link`, which fails when a lease exists.
- [x] Reclaim an empty or unparsable lease older than a bounded age. Add a maximum
  age based on `createdAt` so a reused PID cannot keep a dead owner's lease alive.
  Decision: the maximum age counts from the last renewal, not from `createdAt`.
  The holder renews the lease's modification time every 2 s, and a lease not
  renewed for 30 s is stale whatever its PID reports. A fixed age from
  `createdAt` would either let another process take the lease of a legitimately
  long critical section (setup) or keep a dead owner's lease for minutes. An
  unreadable lease is stale after 2 s, which covers an older release that still
  creates leases with `open` and `write`.
- [x] Remove lease deletion from `sweepExpiredSessions`; reclamation belongs to
  `withFileLock` and its token protocol.
- [x] Acceptance: crash-between-open-and-write, reused-PID and concurrent-sweep
  regressions. Evidence: `tests/sessions/lock.test.js` (an empty lease 10 s old is
  reclaimed, a fresh one is not; a 60 s old lease of a live PID is reclaimed, a
  renewed one is not; the holder renews; a reader polling during 20 acquisitions
  never sees an empty lease) and `tests/sessions/session.test.js` (the sweep
  deletes no lease by name). All five fail against the previous `lock.ts` and
  `session.ts`. A failed release no longer replaces the critical section's result;
  it is written to stderr and the lease expires. A stress run of 600 acquisitions
  with a polling reader observed no empty or partial lease; Windows reported EPERM
  for 9 reads of a lease being deleted, which the test treats as no observation.
  Full suite twice: 235 pass, 0 fail (Windows, Node 26.10).

### `CLI-INTERACT-001` - stream activity liveness and backend failure modes

- [ ] `CUR-005`: preserve final-answer completeness when Codex drops commentary.
  Track current-message truncation/count pressure separately; acceptance includes
  large/over-count commentary followed by a small complete final answer.
- [ ] `CUR-007`: define an end-to-end request budget and truthful timing
  scope across Git, probes, catalogs, consent, acquisition, execution and cleanup.
  Decide consent wait accounting explicitly; never extend a caller's absolute
  execution budget by restarting a timer. Test preparation and cancellation.


- [ ] Specify an activity-aware inactivity policy for subprocess supervision in `src/execution/process.ts`:
  track stdout/stderr data events and tool progress (`lastDataAt = Date.now()`) while explicitly accommodating provider-appropriate
  silent reasoning intervals; classify idle expiration as an inactivity timeout (not a proven freeze).
- [ ] Enforce configurable idle thresholds, an absolute maximum wall-clock ceiling, and leak-free process
  tree teardown on idle expiration, absolute timeout, and caller cancellation. Stream activity must never
  extend the caller's absolute budget.
- [ ] Add focused acceptance tests: continuous output, silent reasoning intervals, absolute timeout cutoffs,
  caller cancellation, and process tree teardown without survivors.
- [x] Tolerate unknown native event types from agy and other CLIs with a warning;
  fail only on invalid known events (AUD-P1-5, order 2). On
  `fix/gemini-unknown-events`, not yet merged. The Gemini collector ignores an
  unknown type and reports one warning per type (at most five per turn); metadata
  of every event is still validated. The Codex and Claude collectors already
  ignored unknown types. Evidence: `tests/backends/gemini/adapter.test.js` feeds an
  unknown `progress_heartbeat` event twice between an answer and the terminal
  result: the answer and terminal survive with one warning, and an unknown event
  with a control character in `event_id` still fails.
- [ ] Map CLI failure modes (authentication expiration, rate limits, context length
  overflow, crashes, unexpected exit signals) to typed errors through the
  `ERRORS-001` error type.
- [ ] Investigate and fix MCP server icon display across hosts (Antigravity/Gemini/VS Code):
  ensure icon references conform to host expectations (base64 data-URI vs static assets/file URIs vs plugin manifest metadata).
- [ ] Evaluate prompt token efficiency: reject binary prompt/vector encoding schemes across the
  standard CLI/LLM text interface on simplicity and architectural grounds (text BPE tokenizers
  do not benefit from raw binary byte packing); focus token savings on lean system instructions,
  concise diffs, and eliminating redundant State Envelope formatting from ordinary consult calls.

### `HISTORY-002` - continuation versus archival storage

**Status:** Implemented (AUD-P0-3, AUD-P1-3, AUD-P2-12).

- [x] Persist streamed answers as append-only deltas. A final `assistant_message`
  replaces the deltas on load. JSON snapshots are materialized on turn finish
  and nonstreaming message batches, including the initial user-message flush;
  streaming deltas do not rewrite snapshots. Acceptance: persisted bytes stay within a small constant factor
  of the answer size (<= 3×). Tested in `tests/sessions/history.test.js` (60 KiB stream
  in 40-byte deltas measured at 1.05× persisted bytes ratio vs audit's 112×). Legacy
  snapshot logs load and paginate with identical semantics (`tests/sessions/history.test.js`).
  Split credential tail buffering ensures secrets split across deltas/flushes never reach disk
  unredacted (`tests/sessions/history.test.js`).
- [x] Uncouple archive failures from execution:
  - initial, periodic and final flush errors become redacted warnings with
    `historyAvailable: false`;
  - the initial flush must never prevent a CLI launch;
  - capacity limits evict the oldest sessions (LRU) instead of refusing new turns.
  Tested in `tests/execution/controller-history.test.js` (full archive, flush failures, 120 KiB stream)
  and `tests/sessions/history-capacity.test.js`.
- [x] Move post-execution bookkeeping (session metadata, archive, cooldown) out of
  the execution `try`. A bookkeeping failure never discards a successful answer;
  it becomes a warning with continuation disabled (AUD-P1-3). Tested in
  `tests/execution/controller-history.test.js` (`updateSession` failure returns completed answer).
- [x] Preserve fail-closed session ownership and safety: keep turn acquisition,
  lease releases (`releaseSessionTurn`), turn mutual exclusion, and workspace binding
  strictly fail-closed. A lease-release failure is a session error (`SESSION_INVALID`), not `HISTORY_ERROR`.
  Tested in `tests/execution/controller-history.test.js`.
- [x] With archival history disabled (`coagent8_HISTORY=off`), a one-shot call must not require history files.
  Tested in `tests/execution/controller-history.test.js`.
- [x] Replace whole-flush global serialization with per-session appends and
  cached capacity accounting (AUD-P2-12). A short global capacity lock remains,
  including updates per appended batch; this is not a lock-free archive.
  Tested in `tests/sessions/history.test.js` (concurrent flushes across different sessions succeed independently).
- [x] Retain file-based `.jsonl` / `.json` archives; SQLite is deferred.
- [ ] `CUR-008`: remove mandatory disk-session work for the proposed ephemeral
  mode (`SESSION-001`). Archive off currently disables archive files only.
- [x] Define retention, default mode, resource/tool behavior and migration before
  altering storage. Preserve existing histories, recovery and pagination
  consistency. Do not delete user data outside the documented retention.
  Retention rules documented in `docs/RUNTIME_CONTRACT.md`, section 4.
- [ ] `CUR-012`: enforce or explicitly specify snapshot capacity accounting.
  Source writes materialized JSON before adding its byte delta, so the 100 MiB
  archive budget is not a strict instantaneous ceiling. Add a near-capacity
  snapshot regression before claiming the stronger bound.

### `INSTALL-001` / `MIGRATION-001` - optional setup and presentation

Shared setup exists; its native-host acceptance remains partial as recorded below.
Do not expand the supported-host list as a prerequisite for core MCP compatibility.

- [x] Expand VSIX Details and package metadata on `fix/vsix-presentation`:
  Oktawian Wybieralski author, oki.dev brand, `oki-dev` publisher ID, complete extension README,
  resource links, keywords, Preview/banner metadata and generated project
  changelog. Document the separate identity and removal of the old development
  extension. Existing owner version edit to `1.0.0-beta.2` retained and manifests
  synchronized. Local evidence on 2026-10-07 (Windows, Node 26.10.0): typecheck,
  `package:vscode`, 15 focused provider/setup/package tests and fixture consumer
  smoke passed. Archive inspection verified Details sections, changelog links,
  required assets, pre-release metadata and runtime equality with the npm
  tarball. VSIX SHA-256:
  `c96597ca02735215746e3a4d06d2901c36a1a3357088c31ddcee50690ddfbca3`.
  The recorded hash predates the author's display-name correction. Current
  beta.2 metadata is for an unpublished private-testing candidate; no registry
  publication or release tag is created by these edits.
  Marketplace publisher ownership/display-name configuration and native Details
  rendering/install/update UI remain unverified. This is local packaging
  evidence, not release approval.

- [x] Follow-up private VSIX presentation on `fix/vsix-presentation`
  (2026-10-07): use the shared title "CoAgent8 - MCP bridge to coding CLIs",
  show Codex CLI / Claude Code CLI / Antigravity CLI in the setup picker while
  preserving saved client IDs, and embed the packed PNG in the private Details
  README. Typecheck, six focused provider/package tests, fixture consumer smoke
  and VSIX title/identity/PNG-byte inspection passed on Windows, Node 26.10.0.
  Publisher display names come from Marketplace metadata, not `author.name`;
  the unpublished VSIX can still display `oki-dev`. Actual Details rendering
  remains unverified; public packaging requires HTTPS-hosted README images.

- [x] Publisher identity updated to `okidev` on 2026-10-07 following the owner's
  creation of a new publisher named oki.dev. The extension ID is now
  `okidev.coagent8-mcp`; author metadata remains Oktawian Wybieralski. Earlier
  `oki-dev` packaging evidence above is historical. No publication is performed.

- [x] Details logo correction (2026-10-07): the owner reported that the embedded
  PNG still did not render after VSIX installation. Remove the Details logo and
  its inlining code; retain the main extension icon. Add three small HTTPS badges
  for oki.dev, GitHub source and issues, and restore standard vsce image validation
  and link rewriting. Packaging, typecheck and six focused provider/package tests
  passed; each badge returned HTTP 200 (473-1,664 bytes). Installed-host rendering
  of the badges remains to be confirmed.

- [x] Isolate setup/repair, native-host probes and VSIX/plugin presentation from
  core startup and backend execution (AUD-P2-10). Recognized CLI setup commands
  load the separate `dist/setup.cjs`; the core sourcemap contains no integration
  or JSONC modules. Codex backend config still uses TOML. Unknown host startup
  arguments retain MCP initialize/list behavior, covered by an isolated e2e test.
  The VSIX ships the sibling setup bundle from the packed npm tarball.
- [ ] Retain selected-client consent, idempotence, stable owned runtime paths,
  conflict detection, preservation of unrelated settings and private backups.
- [x] Implement explicit uninstall/cleanup for managed external-client registrations.
  Implementation and isolated acceptance completed below; installed-host restart/UI
  acceptance remains open.
  Owner reproduction on 2026-10-07: uninstalling the VSIX left CoAgent8 entries in
  Codex, Claude Code and Antigravity configuration, VS Code extension state,
  cached MCP definitions and the extension's auto-update exclusion. Reloading
  VS Code does not remove persistent external-client registrations. The manual
  cleanup is evidence of the gap, not an implemented uninstall feature.
  Remove only entries whose current fingerprint matches recorded setup ownership;
  preserve manual registrations, independent edits, other MCP servers and user
  history/authentication. Provide an explicit cleanup command with a preview,
  private backup and conflict reporting. Evaluate `vscode:uninstall` as a
  best-effort entrypoint after restart, never the sole cleanup mechanism.
  Acceptance: isolated install -> setup -> uninstall -> restart leaves no owned
  callable registration; manual and edited entries survive; partial failure is
  reported and recoverable; cleanup is idempotent and does not touch other clients.
- [x] Fix bundled Codex discovery and missing-CLI onboarding (2026-10-07).
  The shared resolver scans standard VS Code/Insiders extension directories on
  each fallback, selects the newest usable platform/architecture binary, prefers
  PATH and preserves explicit overrides. The VSIX picker lists all three CLI
  clients, preselects remembered choices, and offers official installer commands
  for missing clients in a visible terminal without executing them. Missing
  clients are not registered; install/sign-in, reload and rerun setup are explicit.
  Local empty-PATH discovery finds both actual Codex and Claude extension binaries;
  Antigravity remains missing. Typecheck, documentation lint/build, focused
  resolver/setup/provider/Codex/doctor/package tests and VSIX packaging passed on
  Windows. Installed VS Code picker/terminal acceptance is still pending.
- [ ] Prefer compatible existing CLI installations, including bundled extension
  binaries, before offering a separate CLI installation. Claude's bundled-binary
  fallback and equivalent Codex discovery now exist with fresh resolution
  after extension updates and no persisted version-directory paths. Keep explicit
  executable overrides authoritative and check required versions/protocols.
  Local Windows probes on 2026-10-07: `--help` and `--version` exited 0 for
  Claude Code 2.1.292 from `anthropic.claude-code` and Codex CLI 0.162.0-alpha.2
  from `openai.chatgpt`. Help advertises the streaming/tool controls for Claude
  and `app-server`, MCP and sandbox controls for Codex. This is executable/help
  evidence only, not authenticated execution or adapter compatibility acceptance.
  The Antigravity VSIX contains no agy executable, but the extension downloads
  and updates one in `~/.gemini/bin` before starting its backend
  (`ANTIGRAVITY-HUB-001`); `agy` now falls back to that copy after PATH.
  Evaluate an optional VS Code extension pack separately from core MCP setup;
  do not introduce unconditional dependencies on every backend's extension.
- [ ] Complete the clean-environment CLI onboarding described in the owner's
  2026-10-07 [implementation handoff](CLI_SETUP_HANDOFF.md). This handoff records
  context and the next-agent prompt; this roadmap remains the single active plan.
  The owner permits suggesting extension installation or justified dependencies;
  no specific extension pack or mandatory dependency has been approved as the
  final design. Recommended baseline: require at least one compatible,
  authenticated backend, reuse existing installations, and offer per-backend
  extension or standalone CLI installation only when needed. Keep core stdio
  MCP usable without VS Code or every provider's extension.
  For Codex and Claude, verify the binaries supplied by `openai.chatgpt` and
  `anthropic.claude-code`; do not assume installation implies compatibility or
  sign-in. For Antigravity, reuse the `agy` that `google.google-antigravity`
  installs in `~/.gemini/bin` when present (2026-10-07 correction: the VSIX
  ships none, the extension downloads it); otherwise offer the official
  standalone `agy` installer. Installing the Google extension alone does not
  establish the executable before its backend first starts. Consider a separate
  optional extension pack, while using `extensionDependencies` only for a real
  functional extension dependency.
  Verify current documentation through Context7 before selecting the mechanism.
  Finish compatibility/authentication diagnostics, discovery from actual active
  extension paths (including custom installation roots), and explicit recovery
  after installation, updates, removal, cancellation or failure. Keep bounded
  metadata probes separate from billable model calls. Show missing clients rather
  than hiding them; a bad explicit override must fail closed for that backend
  without hiding diagnostics/actions for unrelated backends.
  Distinguish backend installation from optional registration of CoAgent8 in a
  native chat host; choosing a backend must not silently authorize external MCP
  configuration changes. Track CLI presence, protocol compatibility, sign-in,
  registration, direct-runtime callability and native-host callability separately.
  Verify clean install, one-backend-only use, bundled-only use, Antigravity-only
  use, repeated setup and managed cleanup in isolated profiles. Preserve the
  owner's AI extensions and histories/authentication during acceptance testing.
  Installed VS Code install/uninstall acceptance passed for the owner on
  2026-10-07 (see the owner acceptance below); native-host calls remain open.
  Beta.2 remains private and unpublished.
  Progress on `fix/vsix-presentation` (2026-10-07, owner decision:
  install CLIs only through vendor extensions or official installers in their
  vendors' locations, never into a CoAgent8 directory): onboarding asks per
  missing CLI for **Install Vendor Extension** (now including
  `google.google-antigravity`) or **Install Standalone CLI**, waits with a
  cancellable bounded progress notification until the CLI is discoverable, then
  offers sign-in. An installed Google extension whose agy is not downloaded yet
  shows **Downloading** and is awaited instead of installed twice. Standalone
  installs offer **Check Now** and **Reload Window** for a stale PATH. Fixture
  tests in `vscode-extension.test.js` cover these paths; the owner's installed
  VS Code acceptance is recorded below.
- [ ] Never remove a working registration to test a replacement. Use isolated
  profiles, verify the replacement in that host, and retain/restore the original
  on failure. Do not rely on uninstall callbacks for external settings.
- [ ] Complete native host/update/repair and plugin/VSIX lifecycle acceptance only
  for integrations being changed or claimed as supported. Keep UI/icon evidence
  separate from protocol compatibility and backend readiness.

Implementation follow-up on 2026-10-07 (`fix/vsix-presentation`):

- Separate commands now own CLI onboarding/status, optional confirmed native-host
  registration and preview/apply cleanup. Picking a CLI never writes native-host
  configuration. Existing internal IDs, beta.2 metadata, `okidev` identity, icon
  and compact Details links are retained. No extension pack or mandatory vendor
  dependency is introduced.
- The editor passes current installed extension paths to shared runtime discovery,
  including custom roots; updates/removal invalidate caches. Standalone operation
  remains editor-independent. Metadata checks verify versions/required controls,
  a Codex initialize handshake and Codex/Claude local sign-in without model turns.
  Antigravity sign-in was explicitly unknown at this point; `5dc8b03` later reads
  it from agy's silent `AGY_CLI_CDE_AUTH_ACTION=check` (see the owner acceptance
  below). Installation alone is never promoted to ready. Registration,
  direct-runtime and native-host calls remain separate evidence. Native-host
  launches need their own discoverable environment; versioned editor paths are
  not persisted into their registrations.
- Cleanup works without the backend CLI, removes only unchanged fingerprint-owned
  entries, binds apply to a current preview, keeps private backups, reports partial
  failures and retains runtimes conservatively. Manual/edited/legacy entries,
  other servers, credentials, histories and extensions survive. JSONC settings
  and supported full TOML tables are edited without reserializing unrelated
  content; unsupported inline/dotted TOML ownership remains a visible conflict.
  State is read under the setup/cleanup lease and writes compare the original
  snapshot. No uninstall callback or profile SQLite/cache deletion is shipped.
- Local Windows / Node 26.10.0: typecheck, source documentation lint/generation,
  fresh build and 66 focused tests passed (setup/provider/readiness/cleanup,
  resolver/package, generic MCP, Codex/Claude adapters and doctor). Isolated tests
  cover no CLI, standard bundled discovery, custom paths/update/removal, a single
  signed-in backend, Antigravity-only unknown auth, override/registration errors,
  installation cancellation/failure, repeated repair and cleanup preserving
  manual/edited entries. Backup failure and stale preview regressions passed.
- Private packaging/consumer follow-up: `package:vscode` passed. Archive
  inspection verified `okidev`, title/author, four separate commands, main icon,
  compact Details badges, regenerated changelog with standard vsce link rewriting,
  and both runtime/setup bundles byte-equal to the packed npm contents. Consumer
  smoke passed against the same tarball digest, including separate bundled
  status/cleanup/help dispatch with installed dependencies unavailable.
  Private VSIX: `.artifacts/coagent8-mcp-1.0.0-beta.2.vsix`, SHA-256
  `d258c4ad6b51b19a2b8268a390d7952829377ee5b062b5a889b19508a43a523a`.
  npm tarball SHA-256:
  `6fede11e9cb5b94fe1093e5240b79f2b8b2f8591b867d0af5d9118097ef58500`.
  Local record: `.artifacts/cli-setup-acceptance-2026-10-07.json`. Source/package
  documentation snapshot: `1619eb0`; subsequent roadmap evidence is prose only
  and excluded from packages. These hashes are superseded by the owner
  acceptance build below; any replacement requires new inspection and hash
  evidence.
- Native-host calls for Claude/Antigravity remain pending. Fixture evidence is
  not live host acceptance, an authenticated model response, independent review
  or release approval. Beta.2 stays private; no publication, release tag or merge
  is authorized.

Owner acceptance of the installed VSIX, 2026-10-07 (`fix/vsix-presentation`):

- The owner reported **PASS** for VSIX installation and uninstallation in VS Code
  on Windows 11 Pro 26200 after a clean state (no CoAgent8 registration, data or
  VS Code extension state). Last functional change: `7402f5e`; later commits
  change only the Details README. Private VSIX built from `99a4292`:
  `.artifacts/coagent8-mcp-1.0.0-beta.2.vsix`, SHA-256
  `ed0712fe96643141929939b1bb91498d2255db62fdb57aa4dc2333048b9ac12f`.
- Exercised during the session: **CoAgent8: Set Up Coding CLIs** opens its
  picker at once and keeps it open (`2b32af7`; it previously closed when the
  setup output took focus); Codex CLI 0.162.0-alpha.2 (`openai.chatgpt`), Claude
  Code CLI 2.1.293 (`anthropic.claude-code`) and Antigravity CLI 1.3.1 (the copy
  `google.google-antigravity` downloads to `~/.gemini/bin`, `6f81071`) all report
  `supported`, `authenticated` and `ready`; agy help is read from stderr
  (`1fe2386`) and its sign-in from the silent check (`5dc8b03`); an installed CLI
  without a CoAgent8 entry reports `not-registered` (`7402f5e`); optional
  native-host registration for Codex and Claude and preview/apply cleanup
  removed exactly the owned entries.
- Residual state after uninstall, checked read-only: no registration in Claude
  Code, Codex, Antigravity or VS Code `mcp.json`, no `~/.coagent8`, no extension
  directory. Two expected leftovers are documented, not defects of the test:
  native-host registrations survive an uninstall unless cleanup runs first, and
  VS Code keeps the extension's `globalState` (`setupOffered`, remembered CLIs),
  so the welcome notification does not reappear after a reinstall.
- Local checks for these commits: typecheck, `lint:docs`, `git diff --check`,
  build and the focused integration/resolver/package tests (50 pass). This is
  owner acceptance on one desktop, not the six-job CI, independent review or
  release approval.

- [ ] Owner decision: show the welcome notification until a CLI is ready or the
  user chooses **Don't Show Again** (recommended; VS Code UX guidelines), or keep
  it once per profile.
- No `vscode:uninstall` cleanup is planned: the integration guide keeps the
  explicit preview/confirm cleanup command as the only path, and such a hook
  could not reach `globalState` either. Documentation tells users to run cleanup
  before uninstalling.

Host evidence recorded on 2026-10-05 (historical; not fresh validation):

| Host | Evidence | Remaining acceptance |
| --- | --- | --- |
| Codex 0.160.0 | App-server discovery of nine tools and `doctor` in the existing manual profile; fresh isolated install, managed update and idempotent repair passed actual host calls. | Native plugin loading, composer/name/icon and existing-chat refresh/UI. |
| Claude Code | Existing registration preserved; direct runtime initialize/list/doctor passed; bundled executable resolution follows installed extension updates. | Native-host call/connection acceptance for fresh setup, update and repair; backend authenticated execution. |
| agy 1.2.16 | Existing registration preserved; direct runtime initialize/list/doctor passed. | Native plugin inventory/loading and real chat discovery/call/presentation; managed updates deferred without native-host acceptance. |
| VS Code | Native provider retained; manual active-profile/workspace registration takes precedence; setup/remote/multi-root paths exercised by source tests; VSIX packages. | Real install/update/uninstall lifecycle, fresh/existing chat, icons and alternate-profile UI. |
| Insiders | Historical repaired profile preserved. | Executable/application installation and all native UI acceptance remain unverified. |

The CLI provides `setup`, `repair`, read-only `status` and preview/apply `cleanup`.
VSIX onboarding checks CLIs independently; optional native-host registration
reuses shared setup only after separate confirmation.
Selected local-default clients are remembered. Immutable runtime bundles are
published under `~/.coagent8/runtime/<sha256>/index.cjs`. The repaired manual
`~/.coagent8/runtime/index.cjs` registrations are preserved. No user host
configuration was removed or replaced during the real acceptance checks.

### `ANTIGRAVITY-HUB-001` - Antigravity extension backend reuse

**Status:** Investigated 2026-10-07; execution through the extension is not
adopted. Outside 1.0.0 scope. Evidence, protocol map and method are in the
[investigation record](ANTIGRAVITY_EXTENSION_BACKEND_2026-10-07.md).

**Verdict:** technically reachable but incompatible with the execution
contract. `google.google-antigravity` 1.7.0 exports only `csrfToken` and a
`port` getter. Execution exists only in the hub's private Connect service
`exa.language_server_pb.LanguageServerService`, without a compatibility
contract. The hub is not a capability boundary: its unauthenticated web page
embeds the CSRF token (live), and agent tool environments carry the hub address
and token (static). Read-only controls are optional request fields without a
verified read-back, and the hub loads the user's global MCP servers, including a
CoAgent8 registration. Commands such as `addContext`/`triggerSend` drive the
user's chat view and are UI automation.

- [x] Map the exported API, commands, iframe RPC and hub protocol from the
  installed extension and the `agy` 1.3.1 descriptors; confirm hub health and
  CSRF rejection live without a token or a model turn.
- [x] Reuse only the executable: `resolveCliCommand('agy')` falls back to the
  extension-managed `~/.gemini/bin/agy` after PATH; explicit overrides never
  fall back. Typecheck and focused resolver/setup/process tests passed apart
  from four pre-existing `vscode-extension.test.js` failures; live resolution,
  version probe and `agy models` passed on Windows without a model turn.
- [ ] Accept a model turn through the managed executable (consent applies) and
  observe its Windows launches. Not run.
- [ ] Revisit the hub only if Google publishes a supported, versioned API with
  an enforced and verifiable per-session read-only profile, MCP isolation, no
  route from agent tools back to the hub, verified model selection before the
  turn and conversations isolated from the user's state. Until then no companion
  bridge, token handling or hub transport is added. The preferred future shape
  and its lifecycle/cancellation constraints are in the investigation record.

### `SIMPLIFY-001` - deletions and deduplication

**Status:** Implemented on stacked branches, not yet merged (AUD-P2-3 to AUD-P2-6,
AUD-P2-8 and P3 nits). Behavior must be
preserved or explicitly migrated; deletion is not a contract change unless stated.

- [x] Remove production test hooks `coagent8_MAINTENANCE_GATE` and
  `coagent8_MAINTENANCE_DELAY_MS`; inject the maintenance dependency in tests
  (AUD-P2-3). On `refactor/maintenance-injection`, not yet merged. The stdio
  lifecycle moved to `src/stdio-server.ts` (`serveStdio({ maintenance })`);
  `index.ts` handles setup commands and calls it. The shutdown test starts
  `tests/fixtures/gated-maintenance-server.cjs`, which injects a gated
  maintenance function. Evidence: the e2e shutdown test passes; the bundle
  contains no `MAINTENANCE` string; consumer smoke and full suite (244 pass)
  pass.
- [x] Replace the three deprecated `*.tool.ts` files and the duplicated `run`
  mapping with one alias table. Merge the Codex and Gemini structured-error
  extractors. Validate arguments once at the server boundary (AUD-P2-4).
  - On `refactor/legacy-alias-table`: `src/tools/legacy.ts` holds one table that
    drives the definitions, the mapping to `consult` and the notices of the tools
    and the `run` actions; `consult` no longer repeats the proposal check of the
    schema, `run` and the aliases. Evidence: the backend prompt, warnings and
    errors of 36 calls (three aliases, both entry points, six argument sets) are
    identical before and after; `tests/tools/surface.test.js` covers the mapping.
  - On `refactor/structured-error-extractor`: `extractStructuredError` with one
    dialect per backend (`src/backends/structured-error.ts`). Evidence: over 5,104
    payloads the code and `retryable` flag of both backends are unchanged; a Codex
    payload without a message now reads "Rate limit or quota exhausted (429)" and
    "Model unavailable (404)", as agy's already did.
- [x] Drop the Gemini adapter's second timeout (AUD-P2-5). On
  `refactor/simplify-timeouts-capabilities`, not yet merged: `execute` relies on
  `runCommand`'s deadline, whose `timed_out`/`cancelled` status the result keeps;
  the deadline and cancellation tests in `tests/backends/gemini/adapter.test.js`
  pass unchanged.
- [x] Delete dead code (AUD-P2-6):
  - the unused half of `StreamReducer` (`pushChunk`, `flush`, `recordActivity`,
    `recordError`, `recordFallbackLine` and the state, options and getters only
    they used);
  - `killProcessSafely`, `getProgressStage`, `getToolProfile`, `CONFIG_FILE`,
    `DEFAULT_CONFIG_DIR`, `resolveCodexCommand`, `SessionLockData`;
  - the unreachable truncation-string check in `git.ts`.

  Also removed: `GEMINI_EXE`, `ProgressReporter`, `getDefaultBackend`,
  `CONFIG_CONSTANTS`, `SESSION_CONSTANTS`, `TOOL_NAMES`, `ToolName`,
  `RoutingTarget` and `hasExplicitDataDir`. Evidence: no reference remains in
  `src`, `tests`, `extensions/vscode/src` or `scripts`; `npm run typecheck`
  passes and the full suite (`node tests/run.cjs`) reports 202 tests, 200 pass,
  2 skipped, the same inventory as before the deletion except two renamed
  `tests/execution/stream-reducer.test.js` cases that no longer exercise
  activities. A follow-up removed the reducer's line framing (`pushChunk`,
  `flush`) and the Codex collector methods only tests called; production frames
  records with `createLineDecoder`, whose UTF-8, CRLF, oversized-line and
  trailing-fragment behavior `tests/execution/process.test.js` (F08) measures.
  Codex collector tests now feed records through `line` and read `snapshot()`;
  five tests of the removed framing were deleted, leaving 197 tests (195 pass,
  2 skipped).
- [x] Remove the doctor phantom contract fields `doctor.repair` and
  `doctor.workspace_path` and the hardcoded doctor `security_policy` claims
  (AUD-P2-8; delivered by `CONTEXT-001`, verified in
  `tests/diagnostics/doctor.test.js`).
- [x] Remove or implement the phantom `resources.listChanged` capability (AUD-P2-8).
  Removed on `refactor/simplify-timeouts-capabilities`; `tests/server.test.js`
  checks the declared capabilities.
- [x] Stop banner stripping for JSON-backed adapters. Redact progress messages
  once. Correct stale model names in tool descriptions. Make `cancel` report
  whether anything was cancelled. Redact home paths in `session list` (P3).
  - `fix/answer-banner-stripping`: every backend returns its answer from JSON, so
    the answer only loses escape sequences. A test answer quoting `npm notice` and
    an update box lost three lines with the old code and is unchanged now
    (`tests/execution/cli-output.test.js`).
  - `refactor/progress-redaction-once`: the progress reporter redacts each message
    once; the controller and the dispatch no longer repeat it
    (`tests/execution/progress.test.js`).
  - Tool descriptions no longer name models: the consent rule left the schema with
    `user_confirmed` (`feat/caller-proof-consent`).
  - `fix/cancel-reports-outcome`: `cancel` of an idle session returned
    `cancelled: true` with the old code and returns `false` with "nothing to
    cancel" now (`tests/tools/session.test.js`, `tests/tools/surface.test.js`).
  - `fix/session-list-home-paths`: `session list` and `coagent8://sessions` show a
    workspace under the home directory as `~`; the old code returned the absolute
    path (`tests/tools/session.test.js`, through an MCP client with roots).

  Full suite on the stack tip: 254 tests, 251 pass, 0 fail, 3 skipped (POSIX only).

## Existing completed work and remaining correctness

These statuses summarize prior implementation; they are not fresh test results.

- [x] `GEMINI-001`: production denial-stream handling and regressions for both
  orders preserve typed sandbox denial and reject genuine duplicate terminals.
- [x] `REDACTION-001`: escaped/structured home paths and synthetic secret bounds.
  Output integrity was implemented separately in `REDACTION-002`.
- [x] `ARCH-001/002`: identity primitives break the session/history cycle;
  cancellation is composed explicitly; cooldown writes moved out of rendering.
- [x] `PARSER-001`: live Codex collector coverage replaces the unused parser path.
- [x] `ROUTING-001`: smart_quota uses observed availability/cooldowns, not invented
  account headroom. Preserve or explicitly migrate that external contract.
- [x] `TYPES-001`: narrowed untrusted boundaries. The last three explicit `any`
  in `parseGeminiUsage` were replaced by `unknown` narrowing on
  `fix/unmeasured-quota`; `src/` has no explicit `any`.
- [ ] `DIAGNOSTICS-001`: authentication evidence must be explicitly unverified for
  every backend. Reopened: Codex reports `authenticated` from file presence or
  environment variables (AUD-P2-2). Claude reports the CLI's own `claude auth status`
  login state and states that token validity is proven only by an execution.
- [x] `ERRORS-001`: one typed error protocol (AUD-P1-2, order 1), on
  `fix/typed-tool-errors`, not yet merged:
  - a `ToolError` class carries an `ErrorCode`;
  - no `CODE:` string prefixes and no prefix parsing in `server.ts`;
  - an unknown failure maps to `PROCESS_ERROR`, never `INPUT_LIMIT`;
  - `ONBOARDING_REQUIRED` no longer occurs: an ambiguous `auto` selects a backend
    (`EXEC-001`).

  Evidence: `tests/server.test.js` calls `consult` through an MCP client. A plain
  `Error` from a probe returns `PROCESS_ERROR` (with the old default reinjected the
  test reports `INPUT_LIMIT`, the audit finding); a disallowed backend returns
  `POLICY_DENIED` without a code prefix in the message; an unknown session handle
  returns `SESSION_INVALID`; an empty proposal keeps `INPUT_LIMIT`. "All permitted
  providers have observed rate limits" is `RATE_LIMITED`. Adapter errors that set
  `code` by `Object.assign` and `CliResolutionError`/`BufferLimitError` are
  `ToolError`s now. Full suite: 227 pass, 0 fail (Windows, Node 24).
- [ ] `ERRORS-001` remainder (AUD-P2-7, order 3): review the 37 empty `catch {}`
  blocks individually and distinguish expected absence from actionable I/O
  errors, including `ensureConfigDir`. Partly done on `fix/empty-catches`, not yet
  merged. Removed as dead code: the probe `--version` catches (`runCommand`
  reports failures in its result and does not reject), the Basic-token decode
  catch (`Buffer.from` does not throw) and the shutdown wait on maintenance that
  cannot reject. Now reported: `ensureConfigDir` throws at the cause (before, the
  following write failed instead), a failed session invalidation is a result
  warning, and a failed server close or post-close history pruning is written to
  stderr. On `fix/history-empty-catches`: the 25 in `src/sessions/history.ts` are
  gone. Optional-file stats use `statIfExists` (only `ENOENT` means absent), the
  capacity cache goes through `readCapacityMeta`/`writeCapacityMeta`/
  `adjustCapacityMeta` (a missing or torn cache is recomputed; a failed write
  removes it), lock contention during eviction is told apart by the new
  `LockTimeoutError`, and the two rollback catches that keep the original append
  error say why. Full suite: 243 pass, 0 fail. On `fix/posix-group-signal-errors`:
  the POSIX kill fallbacks in `src/execution/process.ts` are gone.
  `signalOwnedGroup` treats `ESRCH` as an exited group, which also ends the
  teardown without the grace period, and writes any other failure (for example
  `EPERM`) to stderr. The fallback to the root alone was dead: a group without
  members has no root. Evidence: `tests/execution/process.test.js` (mocked
  `process.kill`, runs on every platform): with the old code a group that had
  exited still waited the full 5 s grace (`5015 ms`); now one `SIGTERM`, no
  `SIGKILL`, no warning, and `EPERM` produces one warning per signal. On POSIX the
  old code held every result for the signal grace after a normal exit (250 ms, or
  2 s for agy); a POSIX-only test now bounds it. That test runs in CI; Docker was
  not available locally. The test-only maintenance gate was removed on
  `refactor/maintenance-injection`.
- [x] `DOCS-001` documentation reconciliation: active manuals, contributor
  instructions, source TSDoc and archive status/link repairs. Content/link review,
  202 local links in 32 Markdown documents, documentation lint/generation,
  typecheck and 15 surface tests pass; details in `CODE_DOCUMENTATION.md`.
- [ ] `DOCS-001` remainder: expand compressed executable logic where it obscures
  ownership/error paths. The current documentation reconciliation covers active
  Markdown, contributor instructions and misleading TSDoc; it does not implement
  the proposed runtime/model/cache changes.
- [ ] `VERIFY-001`: record repeatable validation without retroactively assigning
  the historical unexplained 133/134 failure to a later discovered race. Two
  reproduced failures (a 10 ms lock-queue assumption and fixture startup
  starvation) were fixed without changing production deadlines. Their local logs,
  formerly under ignored `tests/artifacts/verification/`, were deleted on
  2026-10-06 during the repository layout cleanup and no longer exist.

### `TESTS-001` - consolidated test structure

The structural migration is implemented; final release validation remains pending.

- [x] Test files, fixtures, helpers, runner and consumer smoke live under
  tests/, mirroring the src/ layout. Generated evidence is written outside it, to
  the ignored `.artifacts/` directory. Temporary consumer installs are isolated and cleaned up.
- [x] One recursive portable discovery helper excludes fixtures/helpers/artifacts,
  preserves the inventory, supports nested tests and rejects empty discovery.
- [x] MCP requests are bounded; teardown awaits owned processes before deleting
  temporary directories, including failure paths. Assertions remain meaningful.
- [x] Package checks reject test/development artifacts while preserving required
  runtime assets, bundled loading and supplied-tarball consumer verification.
- [x] Imports/configuration follow the migration and the unused Node 20 polyfill
  was removed. Test evidence (`.artifacts/coverage`, `.artifacts/consumer`) and API/VSIX
  output (`.artifacts/api-docs`, `.artifacts/vscode`) use separate subdirectories.
- [ ] Verify the exact package, coverage thresholds and supported OS/Node matrix
  at release acceptance; complete independent review of the resulting snapshot.

## Release acceptance and deferred work

### `BETA-001` - publish 1.0.0-beta.2 and 1.0.0-beta.3 to invited testers

**Status:** Blocked by `AUDIT-001`. Testers run CoAgent8 on their own desktops,
so no beta ships while a P0 finding is open. `1.0.0-beta.1` is the npm name
placeholder, not a release for testers (`REPO-001`).

Beta 2 gate (first release for testers):
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
- [ ] Write the beta 2 GitHub release notes with known issues and security
  notes. These come from the open audit findings in
  [RUNTIME_CONTRACT section 7](RUNTIME_CONTRACT.md#7-known-limitations-and-deviations);
  the changelog does not carry them (`CHANGELOG-001`).
- [x] Create `CHANGELOG.md` (Keep a Changelog) with an Unreleased section.
- [x] `CHANGELOG.md` is generated from the commit history (`CHANGELOG-001`).
- [ ] Create the GitHub triage labels defined in
  [Git governance](../.agents/rules/02-git-workflow.md#7-issues-and-tester-feedback)
  and apply the branch and tag protection in its section 8.
- [ ] Release with the prerelease procedure in
  [Git governance](../.agents/rules/02-git-workflow.md#prerelease-beta-or-release-candidate):
  - release PR;
  - annotated tag `v1.0.0-beta.2` on `release/v1.0.0`;
  - artifacts built from the tag, with SHA-256 digests;
  - GitHub pre-release;
  - npm dist-tag `next` (never `latest`).

Beta 3 gate:
- [ ] Execution order 2 is complete.
- [ ] Every beta 2 issue is triaged. No open P0/P1 issue remains; deferred issues
  have a recorded decision.
- [ ] Same verification and publication steps as beta 2.

An independent review by the Reviewer is required for each beta's changes before merge,
as for any PR. The hash-bound release approval applies from RC 1.

### `CHANGELOG-001` - changelog generated from the commit history

**Status:** Generated changelog/release-note tooling implemented; the policy now
requires regeneration before every push. The first tester release remains beta 2.

Rationale:
- Squash-merged PR titles and bodies on `release/v1.0.0` are Conventional
  Commits ([Git governance](../.agents/rules/02-git-workflow.md)). They already
  hold one entry per change.
- A hand-written `CHANGELOG.md` duplicates that record and drifts from it. An
  entry is easy to forget, and the review does not see the omission.
- The initial 28-commit pre-rewrite history was checked; that is historical
  evidence. The current repository has the beta.1 base tag.

Decision:
- Generate `CHANGELOG.md` with [git-cliff](https://git-cliff.org/), pinned as a
  development dependency and configured in `cliff.toml` (Keep a Changelog
  layout). The output is committed so that GitHub and release notes can link
  it. It is not part of the npm package (`files` in `package.json`).
- auto-changelog was also considered and rejected. It groups by merged PRs,
  closed issues and commits rather than Conventional Commit types, so the
  type-to-section mapping would need a custom Handlebars template. Its
  pure-JavaScript install (git-cliff ships a native binary per platform, for
  every CI platform) does not outweigh that.
- Type mapping:
  - `feat` becomes Added, `fix` becomes Fixed, `perf` and `refactor` become
    Changed, `revert` becomes Removed;
  - a `!` or a `BREAKING CHANGE` footer is listed under a Breaking section;
  - `docs`, `chore`, `test`, `ci`, `build` and `style` are omitted.
- Generation happens in the release commit only (`npm run changelog`). Pull
  requests do not edit `CHANGELOG.md`. (Superseded on 2026-10-06: the file is
  regenerated before every push; see the last work items.)
- The PR title is the changelog line. It must describe the change for users.
  The Reviewer checks this like any other PR content.
- Known issues and security notes do not derive from commits. They belong in the
  GitHub release notes, written at release time.
- Rejected:
  - release-please: a bot with write permissions, and version bumps across
    several manifests;
  - semantic-release: publishes to npm by itself, which bypasses the release
    gate and the independent review.

- Each entry starts with its commit (short SHA linked to GitHub), as in
  projects such as PrestaShop (owner request, 2026-10-06).

Work items:
- [x] Add git-cliff 2.14.2 (exact pin) and `cliff.toml`. `npm run changelog`
  runs `git-cliff ... v1.0.0-beta.1..HEAD`. In a release PR, `-- --tag vX` places the
  commits since the previous tag under that version.
- [x] Migrate the hand-written `[Unreleased]` section.
  - The 1.0.0-beta.1 release (tag `v1.0.0-beta.1`) keeps its curated text as
    the oldest entry at the end of the file (`cliff.toml` footer).
  - The hand-written entries for later commits were dropped. Those commits are
    on topic branches; their SHAs disappear when the branch is squash-merged, so
    their entries come from the squash commit in the release commit.
  - The known-issues and security note moves to the beta 2 release notes
    (`BETA-001`).
- [x] Update [Git governance](../.agents/rules/02-git-workflow.md) sections 3, 5
  and 6 and `AGENTS.md`.
- [x] Splitting a squash commit's body into one entry per listed commit
  (`split_commits`) was tried and rejected. With git-cliff 2.14.2 a prose line
  containing a colon inherited the PR title as a duplicate entry, and a commit
  trailer line became an entry. Each PR is one entry instead.
- [x] GitHub release notes in the layout of the PrestaShop release pages (owner
  request, 2026-10-06; for example PrestaShop 9.2.0).
  - Configuration: `cliff.release-notes.toml` and `npm run release-notes -- --tag vX`.
  - Entries are grouped by area (commit scope), then by type.
  - Each entry is `[#PR](link): description (by @author)`.
  - Breaking changes come first. Contributors and a "Full Changelog" compare
    link follow the entries.
  - Without `GITHUB_TOKEN`, the PR number comes from the squash subject `(#N)`
    and the author is the Git author name.
- [ ] Verify the GitHub API path (`GITHUB_TOKEN`: `@username` links and the
  contributors list) on the first real release PR. It needs PRs that exist on
  GitHub.
- [x] Acceptance:
  - On this branch, `git-cliff ... ca600a1..ca600a1` (the state of
    `release/v1.0.0`) reproduces the committed `CHANGELOG.md` without a diff.
  - In a scratch clone of `release/v1.0.0`, a simulated squash commit and
    `--tag v1.0.0-beta.1` produced a `## [1.0.0-beta.1] - <date>` section whose
    entries begin with the linked squash SHA.
  - `git diff --check` passes. The output has single blank lines and one
    trailing newline.
  - Release notes in the same scratch clone, offline:
    - beta 1 (range `ca600a1..HEAD`) listed only the simulated PRs #6-#9;
    - after a `v1.0.0-beta.1` tag, beta 2 listed only #11 with the compare link
      `v1.0.0-beta.1...v1.0.0-beta.2`.
  - These checks predate `REPO-001`: their SHAs belong to the earlier history.
    Re-check on 2026-10-06: `npm run changelog` reproduces the committed file;
    for a range without commits, git-cliff adds an empty `[Unreleased]` heading,
    which the release commit replaces with `--tag`.
- [x] Review of the configuration (2026-10-06, git-cliff 2.14.2, still the
  latest on npm). git-cliff remains the right tool, but three defects were fixed:
  - A breaking commit was listed twice, under Breaking and again under its type
    (in both `cliff.toml` and `cliff.release-notes.toml`). It is now listed
    under Breaking only.
  - A non-conventional subject, such as GitHub's default `Revert "..."` title,
    was silently dropped by `filter_unconventional`. `require_conventional = true`
    now fails the generation instead.
  - The `(#N)` suffix of a squash subject was plain text in `CHANGELOG.md`. It is
    now a link to the PR.
  - Correction to the acceptance above: git-cliff 2.14.2 ignores an empty range
    (`A..A`) and processes the history of `HEAD` instead. The
    `ca600a1..ca600a1` check therefore measured `HEAD`, not `release/v1.0.0`.
    Previews must not rely on a range that can be empty.
  - Checked in a scratch clone with simulated squash commits (#12-#15): a
    `BREAKING CHANGE:` footer in the squash body is detected; a `!` only on a
    listed branch commit is not; the non-conventional revert fails with exit 1.
- [x] Changelog before every push and PR (owner decision, 2026-10-06). It
  supersedes the release-commit-only generation in the decision above.
  - Before every push the agent runs `npm run changelog` and commits a changed
    `CHANGELOG.md` alone as `chore(changelog): regenerate`. `chore` is omitted,
    so that commit does not make the file stale.
  - Before opening a PR or changing its title,
    `npm run changelog:check -- --with-commit "<PR title>"` previews the title
    as a `pending` entry and rejects a non-conventional title.
  - Accepted trade-offs: on the release branch, the last merged PR shows its
    branch commits (still reachable on GitHub through the PR) until the next
    regeneration replaces them with the squash commit; parallel PRs conflict on
    `CHANGELOG.md` and are resolved by regenerating, never by hand.
  - A check-only variant (no committed file outside release commits) was
    chosen first the same day and then replaced: the committed file stayed at
    beta 1 between releases.
  - Topic-branch commits must now be Conventional Commits too
    ([Git governance](../.agents/rules/02-git-workflow.md) sections 2, 3 and 6;
    [quality gate](../.agents/rules/04-quality-gate.md); `AGENTS.md`).

### `REPO-001` - history from beta 1, npm name placeholder

**Status:** History rewritten locally (2026-10-06). The npm steps are due before
the unpublish window closes on 2026-10-08 22:59 UTC.

Decisions (owner, 2026-10-06):
- The license stays GPL-3.0-only. Developers may use CoAgent8 freely, including
  at work; nobody may close the code and sell it as their own product.
- The repository history starts at `v1.0.0-beta.1`, the exact source of the npm
  package `coagent8@1.0.0-beta.1`. Earlier development is kept only in the
  owner's offline archive and is never pushed again. Its first days
  (2026-10-02 to 2026-10-04, OmniAgent/SynAgent) were public under the MIT
  license; publishing that history again would republish MIT-licensed code.
- Commits carry no AI attribution
  ([Git governance](../.agents/rules/02-git-workflow.md) section 2); existing AI
  co-author trailers were removed from the history.
- `coagent8@1.0.0-beta.1` was published only to reserve the package name. npm
  versions are immutable, so the first release for testers is `1.0.0-beta.2`.
- npm placeholder: a `0.0.1` package without the CoAgent8 code holds the name and
  the `latest` dist-tag until 1.0.0; running it prints how to install the
  current beta (`coagent8@next`). `1.0.0-beta.1`, which contains code with open
  audit P0 findings, is unpublished after the placeholder is live. Unpublishing
  the only version would remove the whole package and free the name after 24
  hours, so the order matters.
- The public GitHub repository was deleted and recreated on 2026-10-06; its
  `main` holds only GitHub's initial commit. This history reaches it through
  pull requests with green CI.

Work items:
- [x] Offline backups of all refs, restore-tested.
- [x] History starts at `v1.0.0-beta.1` (annotated tag); trees, authors and dates
  of the replayed commits are unchanged; no commit carries an MIT license or an
  AI co-author trailer.
- [ ] Owner, before 2026-10-08 22:59 UTC: publish `1.0.0-beta.2` if it is ready,
  otherwise the `0.0.1` placeholder; only then `npm unpublish coagent8@1.0.0-beta.1`
  and check `npm view coagent8 dist-tags`. The placeholder is needed only when beta 2
  is not published before the deadline.
- [ ] Publish the history to GitHub through pull requests.
- [x] Ship third-party license notices for the bundled dependencies
  (`THIRD_PARTY_NOTICES`) from beta 2. The build writes
  `dist/THIRD_PARTY_NOTICES.txt` from the packages that reach the bundle and
  fails without a license file; the bundle carries no license comments; the
  consumer smoke test asserts both (`5ab841f`,
  [BUNDLER_COMPARISON](archive/BUNDLER_COMPARISON.md) section 8).

### `RC-001` - freeze, validate and accept 1.0.0-rc.1 (and rc.2 if needed)

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
`CLI-INTERACT-001`; plain Markdown consult is implemented (`CONSULT-001`).
The [interactive CLI RFC](archive/RFC_INTERACTIVE_CLI_AND_TIMEOUTS.md) is historical discussion,
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
