# CoAgent8 roadmap

Updated 2026-10-09. This is the single active plan. CoAgent8 is becoming a
client-independent MCP system for orchestrating complete agent tasks. Roles,
models and providers are independent. Read-only consultation is one execution
profile, not the product boundary. The current runtime still exposes the
read-only bridge; writing and delegated coordination are not implemented.

[ARCHITECTURE.md](ARCHITECTURE.md) owns current contracts and target design;
[HANDOFF.md](HANDOFF.md) owns current work and evidence. README owns getting
started; [AGENTS.md](../AGENTS.md) owns contributor rules.

## Current snapshot status

The checkout carries `1.0.0-beta.2`, an unaccepted development candidate.
Beta.2 remains BLOCKED pending candidate validation, native acceptance and
independent review. Local implementation and historical tests are not release
approval. The owner handles Git integration and publication; agent work stays
local and preserves the existing checkout.

| Area | Present locally | Remaining |
| --- | --- | --- |
| Execution | Six tools, three CLI adapters, plain consult, explicit model/effort | Full tasks, write/execute profiles, bounded orchestration |
| Safety | Owned cleanup, hidden Windows launches, redaction, explicit model consent, Codex/Claude inherited-tool controls | POSIX parent-death cleanup; native acceptance |
| Review | Completeness, snapshot/check gate, post-turn recheck, other-tree mismatch rejection | Other-tree review; independently observed checks and release hashes |
| Storage/routing | Leases, best-effort bounded archives, cached catalogs/prices, optional quota-cache writes | Ephemeral calls, early handles, end-to-end deadlines |
| Agent usability | Cached model view with CLI catalogs (Claude included), per-model prices, model-based routing, strict output price limit, result footer | Measured usage and estimates, effective config, consent transport, native first-use acceptance |
| Integrations | Shared config, optional setup, VSIX, owned registration/uninstall | Fresh lifecycle acceptance, client skills, public execution CLI |

## Agent usability gaps

The 2026-10-08 trials, in which Codex, Claude and Gemini each asked CoAgent8 for a
simple calculation with a model below USD 5 per million output tokens, showed
that an agent with only MCP tools cannot select a model by price. Evidence and
its limits are recorded in [HANDOFF.md](HANDOFF.md#what-the-trials-establish).

- Doctor exposed the price list's source, date and size, not per-model prices,
  and no request accepted a price limit. Fixed locally on 2026-10-08: doctor lists
  each model's output price, match, freshness and approval need, and
  `output_price_below` enforces a strict limit separate from consent (`AX-001/002`);
  native fresh-client acceptance remains (`AX-006`).
- Trials exposed misleading fallback advice after unanswered approval. Refusal
  messages were corrected locally; form-less recovery and native acceptance
  remain (`AX-003`).
- Older registrations can point at a different config file than the default the
  agent edits. Doctor now separates cached models from explicit health checks;
  effective config provenance and bounded diagnostics remain (`AX-004`).
- agy can report not-ready and then execute successfully (`AX-005`).
- Model/price-limit/effort descriptions were corrected locally; fresh-client
  first-attempt acceptance remains (`AX-006`).
- A plain `consult` through `auto` can run an expensive default model; earlier
  `auto` chose a large model for 52.8 s (owner decision: make plain consult cost
  predictable, `AX-002`). A per-call limit now bounds a constrained call; a call
  without one still runs the default.

## Execution order

1. Preserve/finalize audit and desktop-safety fixes (`AUDIT-001`). Resolve
   relevant blockers before enabling affected capabilities.
2. Fix agent-facing selection (`AX-001` through `AX-006`) while designing
   the shared task/profile contract (`COAGENT-001/002`). Complete the measured
   execution work below (`EXEC-001-T01` through `T12`) before expanding the
   affected lifecycle owners for writing or delegation.
3. Deliver one host-led write/check/review/fix path, role configuration and
   skill installation (`COAGENT-003/004/005/007`).
4. Add delegated coordination and parallel work (`COAGENT-006`), with root
   limits, writer ownership and recoverable task state.
5. Accept CLI execution, supported clients/platforms and benchmarks
   (`CLI-FIRST-001`, `COAGENT-008`), then complete the release gates.

## SIMPLIFY-001 - module boundary migration

Local implementation plan requested on 2026-10-08. Status: S0 baseline captured;
S1, S2, S3, S4, S5, and S6 implemented and verified. This is
the active plan, not an additional plan under docs/.local/. Work stays local;
Git integration and publication remain owner-managed. Audit blockers retain
priority. Apply the slices before expanding the affected owners for COAGENT
and CLI-FIRST, without implementing those features as part of this refactor.

Use the [target ownership map](ARCHITECTURE.md#dependency-boundaries) and
[P0 rules](../.agents/rules/00-core-invariants.md#dependency-and-responsibility-boundaries).
Success means clear ownership and dependency direction, not fewer visible files.

### Ordered slices and acceptance

- [x] **S0 - Capture the actual baseline.** Recheck branch, dirty files and
  concurrent work before any move. Preserve the current checkout and local
  changes; no automatic stash/reset/rebase or new checkout. Inventory runtime,
  type-only, dynamic and re-export edges, cycles, package/build entrypoints,
  source-importing tests, extension imports and generated references. Record
  exact legacy edges with S1-S6 owners. Distinguish existing failures from
  migration failures. Implement on an appropriate topic branch under the Git
  rules when the owner integrates the existing local stack.
  Evidence: [S0 baseline](HANDOFF.md#simplify-001-s0-baseline), captured at
  `ac394ad`. S0 inspection authorized starting S1 on this branch.
- [x] **S1 - Extract contracts and shared mechanisms.** Split conversation.ts
  and the shared parts of backends/types.ts into cohesive contracts; keep
  adapter-local types in backends. Move file locking/atomic writes from
  sessions/lock.ts and bounded file reads from execution/stream.ts to storage/.
  Keep byte/stream/process primitives in execution/runtime/; they must not
  import the controller. Group configuration and separate data-directory
  resolution from workspace choice in paths.ts. Move canonical workspace
  identity to workspace/; session handle validation stays with sessions.
  Acceptance: config, model stores and integrations no longer depend on
  session implementation or application execution for file operations.
  Evidence: [S1 implementation](HANDOFF.md#simplify-001-s1-implementation).
- [x] **S2 - Separate execution from MCP presentation.** Extract review input
  and verdict policy into review/. Make the controller return a neutral result
  with all evidence needed by handlers. Move formatting to the transport edge;
  keep consent, cancellation and progress contracts independent of the SDK.
  Then group server.ts, stdio-server.ts and transport parts of tools/ in mcp/.
  Keep index.ts as dispatch/composition. Acceptance: execution and review have
  no runtime or type imports from MCP; review completeness/post-turn snapshot
  checks, redaction, error status and Markdown-only execution answers survive.
  Evidence: [S2 implementation](HANDOFF.md#simplify-001-s2-implementation).
- [x] **S3 - Separate model policy from provider discovery.** Group catalog,
  identifier, price, governance and model-store modules in models/. Split
  model-selection.ts and consent.ts: pure decisions stay there; registry,
  native observations, effective selection and user-consent sequencing belong
  to application operations. Move the routing composition accordingly; keep
  probes, native quota reads, cooldown/cache mechanisms and adapters in
  backends. Supply observations through narrow contracts. Doctor and execution
  reuse the same selection policy. Acceptance: no models/backends cycle,
  duplicate policy or change to explicit-model, price-limit and consent rules.
  Evidence: [S3 implementation](HANDOFF.md#simplify-001-s3-implementation).
- [x] **S4 - Split history by responsibility.** With storage extracted,
  split sessions/history.ts into history reader/recovery, writer and
  retention/capacity modules; place history-page.ts alongside them. Move safe
  credential fragment boundaries together with redaction into security/.
  Keep the session service entrypoint cohesive. Replace the current
  session.ts/history.ts import cycle with a narrow activity/lease contract.
  Extract one responsibility at a time; preserve lock order, reservations
  and finalization semantics. Acceptance: history remains compatible on disk
  and across restart; no session/history cycle or duplicated cache/capacity state.
  Evidence: [S4 implementation](HANDOFF.md#simplify-001-s4-implementation).
- [x] **S5 - Finish consumers and physical layout.** Update diagnostics,
  integrations, extension imports, tests, fixtures, scripts and documentation
  to their owning modules. Mirror source owners in unit tests; retain e2e,
  consumer, helpers and fixtures as distinct test purposes. Split remaining
  mixed files only for demonstrated responsibility conflicts. Keep adapters
  in provider directories and generated assets in generated/. Remove stale
  internal forwarding files instead of leaving permanent import aliases.
  Acceptance: no unresolved old paths, orphan modules, eager setup imports or
  broken packaged entrypoints; preserve genuinely public compatibility paths.
  Evidence: [S5 implementation](HANDOFF.md#simplify-001-s5-implementation).
- [x] **S6 - Enforce and accept the final boundaries.** Add an automated
  dependency check using the real module graph, covering types, dynamic imports
  and re-exports as well as ordinary imports. Prove it detects forbidden edges
  and cycles with isolated fixtures. Enforce external MCP/editor SDK ownership
  and indirect paths to transport or optional setup; forwarding modules must not
  inherit entrypoint privileges. If staged earlier, allow only individually
  recorded legacy edges with removal stages, never directory-wide exclusions;
  remove those entries as slices land. Wire it into local and CI verification
  without bypassing existing checks. Update the architecture's current map
  only after source moves, and record evidence in HANDOFF. Independent review
  and required remote checks precede merge; local passes are not release approval.
  Evidence: [S6 implementation](HANDOFF.md#simplify-001-s6-implementation).

Every slice includes its import/caller/test/reference updates and relevant
checks; S5 is a final sweep, not permission to leave earlier slices broken.
Separate mechanical moves from behavior-affecting boundary extraction so each
diff is reviewable. Roll back only the owned slice against its recorded baseline,
preserving concurrent edits and user data; never reset the whole workspace.

### Execution checkpoints

Owner instruction of 2026-10-08: work sequentially and stop after each slice
for owner inspection. Do not begin the next slice until the owner continues.
Keep the current slice's evidence and next action in HANDOFF so a new context
can resume without rereading a session transcript. Recheck HEAD, dirty paths
and affected file contents at every resumption; reconcile concurrent changes
before using the S0 inventory as a migration baseline.

| Slice | Internal work order | Completion checkpoint |
| --- | --- | --- |
| S0 | Checkout identity and concurrent-work visibility; real import graph and cycles; caller/build/reference inventory; exact debt owners and evidence limits | Recorded in HANDOFF; stop for owner inspection |
| S1 | Extract cohesive contracts and independent config syntax/settings types; extract locks/atomic writes and bounded reads; separate runtime primitives and shared errors; group config/data paths and workspace identity; update every affected caller | Config/model stores/integrations use storage, runtime never loads controller, no new cycles; scoped checks and stop |
| S2 | Extract review input/verdict policy; neutralize controller results and preserve evidence; move formatting to handlers; group MCP modules and tool constants; retain lazy startup composition | No execution/review import from MCP, including types; review/result/MCP checks and stop |
| S3 | Move pure catalog/identifier/price/governance/store owners; separate selection policy from native observations; move routing/consent sequencing to application; supply narrow observations to shared doctor/execution policy | No models/backends cycle or duplicated policy; selection/consent/cache checks and stop |
| S4 | Extract credential commit boundaries to security; split history types/reader/writer/retention without duplicating state; keep pagination with history; replace session service dependency with activity/lease contract | Remove both runtime session/history and type history/page cycles; disk/restart/lock/redaction checks and stop |
| S5 | Resolve remaining consumer/layout conflicts, including cli-readiness/setup type cycle; update extension/test/fixture/build/docs references; remove stale internal forwarding modules and check generated/public paths | All consumers point to owners; optional setup stays lazy; packaging/reference checks and stop |
| S6 | Implement real graph enforcement and negative fixtures; remove individually recorded migration debt; wire local/CI checks; run combined package gate once; update actual architecture and evidence | No forbidden edges/cycles; local gates recorded, independent/remote approval still separate; stop |

The S0 graph also found the history-page/history type cycle and the
cli-readiness/setup type cycle. Their exact edges and S4/S5 removal owners are
recorded in HANDOFF; do not preserve them as type-only exceptions in S6.

### Risks and verification

| Area | Preserve and verify |
| --- | --- |
| Concurrent local work | Re-read files immediately before edits; do not move modules while another change owns them. Stop the affected slice on a conflict and reconcile it without overwriting work. |
| Import graph | Check types and runtime edges separately; avoid barrel-induced eager loading, split singleton caches and duplicate registries. A successful typecheck alone does not prove boundaries. |
| Model/config state | Preserve precedence, exact/approximate/stale price handling, explicit selections, consent recheck timing, remembered approvals, observation keys and on-disk schemas. Re-inspect current source; the price work is evolving. |
| Execution and review | Preserve cancellation propagation, active task tracking, session release, warnings/footer, typed failures and server-derived review acceptance. Moving formatting must not bypass security/review gates. |
| Storage and history | Test lock contention/renewal, torn-tail recovery, capacity reservation/release, cache invalidation, retention and UTF-8 pagination. Preserve file paths, bytes and history compatibility. |
| Redaction | Test secrets split across chunks and persisted bytes, credential-only answers and diagnostic home-path redaction. Moving redaction must not change when unsafe fragments become visible. |
| Processes | Preserve hidden Windows children, owned teardown and protocol interruption; never switch to PID/name/PPID-selected cleanup. Directory changes do not establish native-host safety. |
| Packaging | Check relative package.json/assets paths, setup.cjs sibling loading, generated icon output, build entrypoints, source tests, VSIX imports and tarball contents. Build before tests that consume dist. |

Select checks using the [quality gate](../.agents/rules/04-quality-gate.md):

- This rules/plan change: content/source/link review and git diff --check only.
- S1: typecheck; config/editor, workspace, lock, stream, cache and affected
  integration tests. Build/package/consumer checks when moved paths affect
  entrypoints or shipped contents.
- S2: typecheck, build, controller/pipeline, tool result/review, surface/server
  and MCP/stdio e2e checks, including legacy aliases and workspace resources.
- S3: typecheck and catalog/identifier/selection/governance/price-limit,
  routing/probe/cache/doctor plus execution selection tests; adapter tests when
  their discovery bindings change.
- S4: typecheck, history/capacity/session/lock/redaction and controller-history
  regressions, including interruption and restart recovery.
- S5-S6: dependency-check fixtures, test discovery and docs tooling if affected;
  full local package gate once for the combined shared-runtime refactor:
  typecheck, build, full suite, package inspection and consumer smoke. Run
  lint:docs/docs when source documentation changes. Preserve all required CI
  jobs and distinguish fixture evidence from native client/OS acceptance.

Do not repeat a passing full gate after every move. New failures or changes
determine which checks must run again. Add behavioral regressions for uncovered
risks, not tests that merely mirror the new directory tree.

## EXEC-001 - measured preparation and complete call lifecycle

Plan requested on 2026-10-09 after SIMPLIFY-001. All tasks below are pending.
This is the detailed work breakdown for existing `EXEC-001`,
`CLI-INTERACT-001`/CUR-007 and the timing/configuration portions of `AX-004`;
it does not create a second execution stack or replace the coagent roadmap.
The S6 follow-up is committed at `af9f7d2`; its independent review remains
required before integration. Resolve relevant audit blockers first.

The inspection found repeated configuration/selection reads across routing,
selection and consent. `loadConfig` reads and validates the file each time.
The controller starts its duration timer after preparation and session
acquisition, and passes the original timeout to the adapter. These are source
observations, not measured bottlenecks or a demonstrated speedup. Preparation,
consent, execution and finalization currently share one large lifecycle owner.

T01-T12 are stages, not single implementation assignments. Execute one
task card below, for example `EXEC-001-T03b`, at a time. Short IDs such as `T03b`
always carry the `EXEC-001-` prefix. All cards are pending. Finish cards in their
listed order; each stage depends on the preceding stage. The named stage
acceptance criteria apply to every relevant card and close only when all its
cards pass. Completed SIMPLIFY-001 slices are historical evidence, not new work.

### Instructions for executing one task card

1. Read HANDOFF, the assigned card, its parent acceptance criteria and the
   relevant ARCHITECTURE contract. Record `git status --short`, branch and HEAD.
   Preserve unrelated edits; an earlier PASS does not approve a changed file.
2. Read the listed starting files and their direct callers/tests. Paths are
   current at `32b9f8e`; use `rg` to find moved symbols if a prerequisite renamed
   them. A proposed new file is explicitly marked **new**. Never guess an API.
3. State the one behavior/deliverable being changed. Update required callers
   in the same card so the checkout remains usable. Start a new owner module
   only for the responsibility named by the card; do not copy policy or leave
   forwarding aliases to make imports pass.
4. Use existing fixture/adapter injection seams. Run tests through
   `node tests/run.cjs`, which installs the isolated environment. Do not launch
   native model turns or edit live config to produce test data. Use an injected
   clock or controlled fixture events for timing assertions; wall-clock speed
   alone is not a deterministic regression test.
5. Run the card's checks and the applicable [quality gate](../.agents/rules/04-quality-gate.md).
   Record command, exit code and evidence path. `Done` is an observable result,
   not merely a new function or a green typecheck. An unrelated failure is
   recorded and investigated, never fixed by weakening an assertion.
6. Update this card and HANDOFF with changed behavior, actual checks and the next
   card. Stop at the owner inspection checkpoint. A design choice left open in
   a card must be resolved there before dependent code; never invent a timeout,
   consent rule or migration silently. No commit/push/merge follows from a
   checkbox alone; use the authority already granted in the active session.

Test groups below are shorthand for exact existing files, not new npm scripts.
For a group, pass its files to `node tests/run.cjs <files>`. Add the regression
created by the card to that same command. **P** means content/source/local-link
review and `git diff --check` only. **R** adds `npm run typecheck`,
`npm run check:dependencies` and the listed test groups. Source-comment changes
also require `npm run lint:docs` and `npm run docs`; runtime/package changes use
the linked gate. Do not run the complete suite for every small card.

| Group | Existing files under tests/ |
| --- | --- |
| CONFIG | `config.test.js`, `config-editor-settings.test.js` |
| SELECT | `execution/routing.test.js`, `execution/model-routing.test.js`, `models/selection.test.js` |
| POLICY | `models/governance.test.js`, `execution/price-limit.test.js` |
| CACHE | `backends/probe-cache.test.js`, `models/prices.test.js`, `backends/availability.test.js` |
| LIFE | `execution/controller-history.test.js`, `execution/controller-cooldown.test.js`, `execution/pipeline.test.js` |
| SESSION | `sessions/session.test.js`, `sessions/history.test.js`, `sessions/history-capacity.test.js` |
| LOCK | `storage/lock.test.js` |
| PROCESS | `execution/process.test.js`, `execution/progress.test.js` |
| REVIEW | `workspace/git.test.js`, `workspace/git-fixture.test.js`, `review/gate.test.js`, `mcp/tools/review.test.js` |
| MCP | `mcp/server.test.js`, `mcp/result.test.js`, `mcp/surface.test.js` |
| DOCTOR | `diagnostics/doctor.test.js` |
| E2E | `e2e/mcp.test.js`, `e2e/stdio.test.js` |
| CODEX | `backends/codex/adapter.test.js`, `backends/codex/collector.test.js` |
| CLAUDE | `backends/claude/adapter.test.js`, `backends/claude/collector.test.js`, `backends/claude/usage.test.js` |
| AGY | `backends/agy/adapter.test.js` |
| REDACT | `security/redaction.test.js` |

Example for a CONFIG/POLICY card:

```text
npm run typecheck
npm run check:dependencies
node tests/run.cjs tests/config.test.js tests/config-editor-settings.test.js tests/models/governance.test.js tests/execution/price-limit.test.js
git diff --check
```

### EXEC-001-T01 - establish a reproducible baseline

- [ ] **T01a - map calls and waits.** Start: `src/mcp/tools/consult.tool.ts`,
  `src/mcp/tools/review.tool.ts`, `src/execution/controller.ts` and direct
  routing/selection/consent/session callees. Change: HANDOFF only; add one row
  per phase with function, caller, side effect, timeout and abort support.
  Done: the map includes early exceptions, review Git work and finalization.
  Check: P; unknown behavior is labelled unverified, not inferred.
- [ ] **T01b - prepare the baseline harness.** Start: `tests/helpers/environment.cjs`,
  `tests/execution/price-limit.test.js`, `tests/backends/probe-cache.test.js` and
  `tests/fixtures/`. Add a **new** fixture-only baseline test under
  `tests/execution/`, using existing injection seams to count observations and
  adapter launches. Cover plain, explicit model/effort, priced auto, continuation
  and review. Done: cold runs reset only owned fixture state; warm/concurrent
  runs reuse it intentionally. Record counters that cannot yet be observed as
  NOT_MEASURED. Check: R, the new test and `tests/environment.test.js`.
- [ ] **T01c - record baseline measurements.** Run the T01b command against the
  recorded source identity; keep configuration, delays and repetition count in
  the evidence. Report individual samples and median/range, not a single fast
  run. Done: HANDOFF links reproducible logs and states platform, Node, commit,
  tree, dirty diff identity and missing counters. Check: P plus the baseline
  run itself; native/client overhead stays NOT_MEASURED.

Acceptance: another agent can reproduce the baseline; no performance claim
depends on footer timing alone. Verification: inspect existing fixtures and run
only the selected baseline scenarios. Depends on the S6 follow-up.

### EXEC-001-T02 - measure phases without changing timeout behavior

- [ ] **T02a - implement the timing primitive.** Start: `src/contracts/execution.ts`
  and `src/execution/runtime/`. Add a **new** timing primitive with an injectable
  monotonic clock and bounded named phases. Done: nested/overlapping intervals
  preserve total wall time; closing a phase twice does not double-count it;
  no module imports MCP. Check: R and a **new** timing test with a fake clock.
- [ ] **T02b - instrument the controller.** Start: `executeTask` and
  `executeTaskInternal` in `src/execution/controller.ts`. Record preparation,
  consent, session acquisition, execution and finalization, including throws
  before session creation. Done: fixture delays enter the right spans and the
  existing `durationMs` retains its meaning. Use an internal observer for early
  failures rather than changing public error shape here. Check: R, LIFE/POLICY.
- [ ] **T02c - instrument outer preparation and diagnostics.** Start:
  `src/mcp/tools/review.tool.ts`, `src/review/input.ts`,
  `src/diagnostics/doctor.ts`. Include Git collection and health/model-report
  work in a call-level trace; reuse the primitive without inventing a task
  session. Done: delayed Git/probes are visible once, totals do not sum parallel
  spans, and traces contain no prompt/path/credential. Check: R, REVIEW/DOCTOR;
  repeat T01c only for previously missing phase measurements.

Acceptance: deliberate fixture delays appear in the correct phase and total;
instrumentation does not change routing, retries or timeouts. Verification:
focused success/failure/timing fixtures and typecheck. Depends on T01.

### EXEC-001-T03 - supply effective configuration with provenance

- [ ] **T03a - specify snapshot freshness.** Start: `loadConfig`, `getConfigFile`
  in `src/config.ts`, `src/config-overrides.ts` and `src/paths.ts`. Document the
  current precedence and which settings must be re-read after consent. Define
  a request-local view and non-secret change identity. Done: cases for config
  path changes, invalid JSON, editor overrides and governance changes have an
  explicit expected outcome. Check: P; settle these choices before T03b.
- [ ] **T03b - return settings and provenance together.** Implement T03a in the
  existing config owner. Done: one load returns validated effective settings
  and each setting's source; defaults and malformed config behave as before;
  public diagnostic identities contain no raw secrets. Check: R, CONFIG.
- [ ] **T03c - pass one view through preparation.** Start:
  `src/execution/routing.ts`, `selection.ts`, `consent.ts` and `controller.ts`.
  Supply the view explicitly and update all callers in this change. Done:
  unchanged preparation reads once, required post-consent revalidation still
  occurs and concurrent requests cannot overwrite each other's settings.
  Check: R, CONFIG/SELECT/POLICY; use counting fixture evidence from T01b.
- [ ] **T03d - show redacted provenance in doctor.** Start:
  `src/diagnostics/doctor.ts`, `src/mcp/tools/doctor.tool.ts` and
  `src/security/redaction.ts`. Use T03b data without copying precedence logic.
  Done: custom paths/old registration overrides are understandable, secrets
  and home paths are redacted, summary remains bounded and invalid config
  produces diagnostic evidence. Check: R, DOCTOR/MCP and REDACT if changed.

Acceptance: stable preparation does not repeatedly read the same config;
custom paths, old registration overrides and editor settings remain effective.
Verification: config/editor/doctor tests, malformed and concurrently changed
config fixtures, typecheck and dependency check. Depends on T02.

### EXEC-001-T04 - extract cohesive task preparation

- [ ] **T04a - extract input/continuation validation.** Start:
  `executeTaskInternal`, `src/sessions/session.ts:getSession` and
  `src/models/identifier.ts`. Move preparation validation to a **new** cohesive
  execution preparation owner; have the controller call it immediately.
  Done: invalid model, expired/foreign handle and provider-switch cases retain
  their errors and start no backend turn. Check: R, SELECT/SESSION/POLICY.
- [ ] **T04b - extract provider/model preparation.** Move routing, concrete
  model/alias resolution and effort/catalog checks into the T04a owner, returning
  neutral prepared data to the controller. Keep price policy in models/, native
  reads in backends/, consent and lease acquisition explicit in the controller.
  Done: plain, named, priced and continued calls match baseline identity/effort;
  busy acquisition remains a later fail-closed operation. Check: R, SELECT/POLICY/LIFE.

Acceptance: behavior and error codes match the baseline for plain, explicit,
priced and continued calls; invalid/busy handles fail closed. Verification:
selection/routing/price-limit/continuation regressions, typecheck and dependency
check. Depends on T03. Treat this as structural extraction, not a speedup claim.

### EXEC-001-T05 - reuse observations within preparation

- [ ] **T05a - reuse catalog evidence.** Start: `src/execution/selection.ts`,
  `src/execution/routing.ts`, `src/backends/probe-cache.ts`. Pass an observation
  obtained during provider eligibility into final model selection. Done: counts
  decrease only for duplicate reads with the same backend/key/freshness; a
  different key or explicit fresh request still reads again. Check: R, SELECT/CACHE.
- [ ] **T05b - reuse the default-model price reference.** Start:
  `src/execution/consent.ts:consentFor` and the prepared data from T04b. Reuse
  the backend default observation, keeping it distinct from the requested
  model; preserve unknown-default handling and relative-price governance.
  Done: consent decisions match POLICY fixtures, including expensive explicit
  models and missing defaults, with fewer repeated observations. Check: R, POLICY/CACHE.
- [ ] **T05c - verify invalidation and measure the delta.** Extend counting
  fixtures for TTL expiry, environment/executable/config changes, fresh doctor,
  replaced adapter and concurrent misses. Re-run the same baseline conditions.
  Done: each removed read is explained; changed prices while consent is pending
  still fail or revalidate, never reuse stale permission. Check: R, CACHE/POLICY
  and the T01b baseline; record speed as unproven if samples do not support it.

Acceptance: fixture counters show which reads/launches were removed while
selection, price limits and approval outcomes remain identical. Verification:
probe-cache/selection/governance/price-change concurrency tests and a focused
cold/warm baseline comparison. Depends on T04.

### EXEC-001-T06 - guarantee finalization after resource acquisition

- [ ] **T06a - guard acquisition and registration.** Start:
  `src/execution/controller.ts` around `acquireAndResolveSession`, writer
  creation, `activeSessionAborts` and timer/listener registration. Enter a
  guaranteed finalization scope immediately after acquiring the turn token.
  Done: injected writer/registration failure releases owned state and settles
  waiters. Check: R, LIFE/SESSION with failure after each acquisition boundary.
- [ ] **T06b - isolate finalization failures.** In that scope, ensure metadata
  failure, archive failure and lease failure cannot skip the other mandatory
  cleanup attempts. Preserve warning/error priority and continuation invalidation.
  Done: archive failure keeps a valid answer, lease failure remains fail-closed,
  cooldown is recorded at most once, failed snapshot recheck cannot yield READY.
  Check: R, LIFE/SESSION/REVIEW.
- [ ] **T06c - verify cancellation settlement.** Start:
  `cancelSessionExecution`, `waitForActiveExecutionTasks` and
  `src/execution/process.ts`. Cover cancel/EOF during execution and finalization
  without changing process ownership. Done: awaited settlement means timers,
  listeners and owned children have completed cleanup; no orphaned raced promise
  is treated as completion. Check: R, PROCESS/LIFE/E2E; report platform limits.

Acceptance: injected failure/cancellation at each acquisition/finalization
boundary leaves no owned active entry, timer or turn lease without a reported
outcome; archive failure does not erase a valid answer. Verification: controller,
history/session and process failure-path tests on affected platforms. Depends
on T05. Report fixture and native teardown evidence separately.

### EXEC-001-T07 - define the complete-call budget contract

- [ ] **T07a - settle timeout semantics in writing.** Start:
  `src/contracts/execution.ts:ExecutionOptions`, `src/mcp/schema.ts` and timeout
  sites found by `rg` in execution/backends. Propose start-before-Git,
  consent-counted timing and a finite teardown allowance; specify omitted/zero/
  invalid timeout behavior, host cancellation and migration of `timeout_ms`.
  Done: HANDOFF records the owner's accepted semantics and chosen values;
  no unresolved choice is implemented by T07b. Check: P.
- [ ] **T07b - implement budget arithmetic.** Add a **new** neutral budget
  primitive alongside the timing owner; it uses one absolute monotonic deadline,
  reports remaining time and distinguishes timeout from caller abort. Done:
  already-expired, exact-boundary and repeated checks cannot reset the budget;
  cleanup allowance is separate and finite. Check: R and a **new** fake-clock
  budget test. Public timeout behavior remains unchanged until T11.
- [ ] **T07c - centralize timeout defaults.** Move only duplicated settings
  identified in T07a into their owning contract/config mechanism and update
  current consumers. Done: defaults have one owner and existing adapter behavior
  remains identical; no layer imports controller policy. Check: R, PROCESS and
  the affected provider adapter tests; docs checks for changed source comments.

Acceptance: the contract answers what happens when a deadline expires in every
phase, including consent and cleanup. Owner inspection of this contract is the
checkpoint before propagation. Verification: focused budget arithmetic/expiry
tests and documentation review. Depends on T06.

### EXEC-001-T08 - make native observations cancellable

- [ ] **T08a - define read ownership and extend the contract.** Start:
  `src/backends/types.ts:CliAdapter`, `src/backends/probe-cache.ts:coalesce` and
  the T07 budget. Define per-waiter deadline/abort versus shared-read ownership,
  then thread the neutral context through callers and adapter signatures.
  Done: existing callers still work, actual support is not claimed prematurely,
  and a decision table specifies who owns cancellation and inflight removal.
  Check: R, CACHE/CODEX/CLAUDE/AGY for contract compatibility.
- [ ] **T08b - implement shared-read waiter ownership.** Change only the
  probe-cache coalescing mechanism and its neutral callbacks from T08a. Done:
  one cancelled waiter leaves another live waiter intact; the last waiter
  triggers owned abort; late settlement cannot remove a newer inflight entry.
  Check: R, CACHE with two-waiter/all-cancelled/replacement-race fixtures.
- [ ] **T08c - bound Codex reads.** Start: `src/backends/codex/adapter.ts`,
  `models.ts`, `app-server.ts`. Implement context propagation for probe/catalog/
  quota paths of this backend only. Done: stalled fixture RPCs abort, pending
  promises settle and owned handles close. Check: R, CACHE and
  `tests/backends/codex/adapter.test.js`; fetch current CLI docs before API edits.
- [ ] **T08d - bound Claude reads.** Start: `src/backends/claude/adapter.ts`,
  `usage.ts`. Cover probe, model observation/catalog and native quota reads.
  Done: stalled initialize/usage fixtures clean up, and no native model call
  is used to obtain missing evidence. Check: R, CACHE/CLAUDE;
  fetch current CLI docs before protocol edits.
- [ ] **T08e - bound agy reads.** Start: `src/backends/agy/adapter.ts` and its
  discovery/quota callees. Done: stalled discovery cleans up without changing
  sandbox/inherited-tool policy or mislabelling timeout as unauthenticated.
  Check: R, CACHE and `tests/backends/agy/adapter.test.js`; fetch current CLI docs.
- [ ] **T08f - bound price fetches and close shared-read races.** Start:
  `src/models/prices.ts`, `src/backends/probe-cache.ts`,
  `src/backends/availability.ts`. Apply cancellation to owned price I/O and verify
  fresh/default reads, cache failures and last-waiter cancellation across the
  integrated providers. Done: late completions do not poison inflight/cache
  state; freshness and unknown-price policy remain unchanged. Check: R, CACHE/POLICY.

Acceptance: deliberately stalled fixture reads settle within their allocated
budget, clean owned processes and do not poison concurrent calls. Verification:
probe-cache, price fetch, native quota and process cancellation tests; Context7
documentation before changing provider-specific CLI/API behavior. Depends on T07.

### EXEC-001-T09 - bound Git collection and storage waits

- [ ] **T09a - bound review Git work.** Start: `src/workspace/git.ts:runGit`,
  `collectGitScope`, `snapshotId` and `src/review/input.ts`. Pass the request
  budget through collection and recheck; await owned process cleanup on expiry.
  Done: stalled Git stops, partial input and failed recheck cannot be READY,
  and foreign-tree rejection survives. Check: R, REVIEW/PROCESS.
- [ ] **T09b - cancel lock waiters safely.** Start:
  `src/storage/lock.ts:withFileLock`. Cover both the in-process queue and on-disk
  lease contention; preserve queue progress, token ownership and renewal.
  Done: aborting the middle of three waiters does not strand the third or
  release another owner's lease. Check: R, LOCK and cross-process contention
  fixtures. Keep ordinary callers without context compatible.
- [ ] **T09c - stop session acquisition after expiry.** Start:
  `src/sessions/session.ts:acquireAndResolveSession` and history reservation
  callers. Pass the context into waits and check around synchronous boundaries.
  Done: cancellation during acquisition creates no executable turn or leaked
  reservation; partial acquisition is finalized through T06. Check: R, SESSION/
  LIFE/LOCK; document I/O that cannot be interrupted immediately.

Acceptance: stalled Git and contended-lock fixtures cannot start a model turn
after expiry or leak a reservation; failed snapshot verification blocks READY.
Verification: review/workspace, lock/session and controller cancellation
regressions. Depends on T08.

### EXEC-001-T10 - bind consent and revalidation to the budget

- [ ] **T10a - cancel a pending approval.** Start: `ConsentPrompt` and the
  consent block in `src/execution/controller.ts`, plus elicitation in
  `src/mcp/server.ts`. Bind the response to this request/backend/model and the
  T07 deadline. Done: missing/false/late responses and cancelled forms cannot
  start a turn or remember approval. Check: R, POLICY/MCP with a delayed reply.
- [ ] **T10b - revalidate just before acquisition.** Start:
  `src/execution/consent.ts`, `src/models/governance.ts`, the controller's price
  checks and the T03 snapshot. Recheck changed identity/policy/price evidence.
  Use fail-closed retry guidance for invalidated approval unless a bounded
  renewal flow was explicitly accepted; do not invent that flow here.
  Done: changed prices/config during consent cannot bypass policy or replace
  the selected model. Check: R, CONFIG/POLICY/SELECT.
- [ ] **T10c - preserve remembered-approval outcomes.** Start:
  `src/config.ts:rememberApprovedModel` and controller consent warnings. Test
  valid remembered approval, failed persistence and cancellation before storage.
  Done: a storage failure retains an otherwise valid approval with a warning;
  next-call policy remains correct and credentials do not leak. Check: R,
  CONFIG/POLICY/MCP. Form-less approval design remains AX-003.

Acceptance: cancellation, late replies, changed prices/config and invalidated
approval never start an unauthorized turn. Verification: consent, governance,
price-limit and MCP elicitation fixtures; native consent acceptance remains
AX-003/006. Depends on T09.

### EXEC-001-T11 - wire the complete call and migrate timing output

- [ ] **T11a - activate the budget for consult/review.** Start:
  `src/mcp/tools/consult.tool.ts`, `review.tool.ts`, `src/mcp/server.ts`, and
  `src/execution/controller.ts`. Create one context before preparation/Git and
  pass remaining time to every adapter. Update `timeout_ms` documentation and
  source contracts in this same card. Done: expiry in any earlier phase
  prevents execution, and idle activity cannot reset the budget. Check: R,
  LIFE/REVIEW/MCP/E2E/CODEX/CLAUDE/AGY; build before bundle checks.
- [ ] **T11b - apply bounds to diagnostics.** Start: `runDoctor`, `runModelReport`
  in `src/diagnostics/doctor.ts`, `src/mcp/tools/doctor.tool.ts` and their server
  dispatch. Thread caller cancellation and an explicitly defined diagnostic
  budget; do not silently add an execution timeout argument to doctor. Done:
  health reads are bounded, cached model view remains cheap, startup waits for
  no probes and doctor creates no session. Check: R, DOCTOR/CACHE/MCP/E2E.
- [ ] **T11c - expose accurate timing.** Start: `ExecutionMeta` in
  `src/contracts/execution.ts`, `src/mcp/result.ts`, error formatting in
  `src/mcp/server.ts`. Add accepted phase/total fields, preserving or explicitly
  migrating legacy duration semantics. Done: preparation failures and cleanup
  overruns are represented honestly; footer remains useful and bounded. Update
  README/ARCHITECTURE with implemented behavior. Check: R, MCP/POLICY/REVIEW,
  REDACT if affected, lint:docs/docs and fresh package consumer checks.

Acceptance: total accounting includes every phase and cleanup; idle reasoning
can remain silent without granting extra time. Verification: adapter/controller,
MCP/stdio, review and doctor regressions, typecheck, dependency check, build and
applicable docs checks. Depends on T10; caller-visible migration follows T07.

### EXEC-001-T12 - compare results and bind independent acceptance

- [ ] **T12a - repeat the baseline.** Run T01b with the same parameters and
  repetitions as T01c. Done: HANDOFF compares phase/total timings, reads and
  launches for each scenario, including concurrent/error paths; inconclusive
  results are labelled so. Check: P plus baseline execution; retain raw logs.
- [ ] **T12b - validate the local candidate package.** Follow the full package
  gate once on the final source, build before bundle-dependent tests and retain
  the actual tarball digest/manifest. Done: source, bundle and exact-package
  results are recorded separately. Check: typecheck, dependency check, build,
  full suite or equivalent full coverage run, pack inspection, consumer smoke
  and applicable docs/VSIX gates. Do not publish as part of validation.
- [ ] **T12c - collect native/remote acceptance.** Use the candidate from T12b
  for the required six OS/Node jobs and applicable native client scenarios.
  Do one client/platform scenario at a time; record CLI/host versions and
  quiet-desktop/no-survivor evidence. Done: every required cell has observed
  evidence or an explicit NOT_RUN blocker. Do not infer native PASS from fixtures.
- [ ] **T12d - bind independent review.** Review the actual committed scope
  through `review`, recording base/candidate/tree, reviewer session/reference,
  commands/exits/logs and artifact digest when accepting a release. Done: no
  unresolved P1/P2 and evidence matches that candidate; changes invalidate the
  affected acceptance. A READY string alone is not approval. Depends on T12c.

Acceptance: HANDOFF makes the achieved behavior, measured differences and
remaining native/remote limits reproducible. Follow-up coagent work reuses
these owners; early handles, ephemeral modes and delegation stay in their
existing SESSION-001/COAGENT milestones. Depends on T11.

## Agent usability acceptance

Checked items are local implementations; unchecked cards are remaining work
or acceptance. Existing model/price-limit arguments remain available. Execute
one labelled card at a time under the same task-card instructions and test
groups as EXEC-001. A parent requirement is satisfied only after its dependent
cards pass. Extend existing owners; do not copy selection/policy per client.

### AX-001 - prices before execution

- [x] Expose a bounded MCP selection view: backend, concrete model, accepted
  efforts, default source, output USD per million tokens, price source/date,
  exact/approximate/unknown match and approval requirement/reason. Keep concise
  text and structured data consistent; reuse it for the planned CLI models command.
  Doctor selection rows and summary (3,900 bytes), from listModelCandidates.
- [ ] **AX-001a - define usage evidence.** Start: `src/contracts/execution.ts`,
  `src/contracts/conversation.ts`, `src/models/prices.ts`. Specify measured input,
  cached input, output and reasoning tokens, source/availability and price-tier
  assumptions. Distinguish unit price, estimate, list-price equivalent, quota
  and actual billing. Done: unknown is never zero and absent provider fields
  have example payloads. Check: P; accept the contract before adapter changes.
- [x] Keep a model registry from the CLIs themselves: Codex model/list, agy models,
  Claude stream-json initialize (aliases with concrete models); store prices only
  for offered models, refreshed daily; route a named model by catalog (2026-10-08).
- [ ] **AX-001b - parse Codex usage.** Start: `src/backends/codex/collector.ts`,
  `app-server.ts` and their tests. Implement AX-001a using recorded provider
  events, fetching current protocol docs first. Done: missing/repeated/partial
  events neither fabricate nor double-count usage. Check: R, CODEX.
- [ ] **AX-001c - parse Claude usage.** Start: `src/backends/claude/collector.ts`,
  `adapter.ts` and Claude recordings. Same contract; verify streamed versus
  terminal counters and cached-token semantics. Done: fixture totals retain
  source and unknown fields. Check: R, CLAUDE.
- [ ] **AX-001d - parse agy usage.** Start: `src/backends/agy/collector.ts`,
  `adapter.ts` and agy fixtures. Verify current event semantics before mapping
  fields. Done: unsupported fields remain unknown and repeated events do not
  inflate counts. Check: R, AGY.
- [ ] **AX-001e - define subscription-window observations.** Start:
  `src/backends/availability.ts`, Codex account/rateLimits and Claude/agy quota
  readers. Specify before/after evidence, freshness, read cost and effects of
  concurrent calls. Done: a window delta is not attributed as exact turn cost;
  any added native reads follow the bounded-read contract and explicit policy.
  Check: P first, then one provider implementation card per accepted protocol;
  do not add three live quota reads inside execute as a shortcut.
- [ ] **AX-001f - persist usage compatibly.** After AX-001b-d, start:
  `src/sessions/history/types.ts`, `writer.ts`, `reader.ts`.
  Add optional history fields and round-trip tests. Done: old history still
  loads and new records retain measured values/source without changing public
  answer bytes. Check: R, SESSION/LIFE.
- [ ] **AX-001g - present usage and list-price equivalents.** After AX-001f,
  start: `src/models/prices.ts`, `src/mcp/result.ts`. Calculate only from usable
  usage/price evidence and label billing versus equivalent explicitly. Done:
  cached/reasoning tokens are not counted twice, unknowns stay visible and the
  footer remains bounded. Check: R, MCP/CACHE with arithmetic fixtures.
- [ ] **AX-001h - specify the estimate policy.** After AX-001g, define grouping
  by backend/model/tool, minimum sample policy, retention window and displayed
  assumptions. Done: accepted examples state when estimates remain unknown
  and how mixed/partial observations are excluded. Check: P only.
- [ ] **AX-001i - calculate estimates from history.** Implement AX-001h in one
  owner consuming measured history; reuse it in presentation. Done: no history
  means unknown and controlled samples produce the specified median. Check: R,
  focused history/estimate tests and MCP.
- [x] Test missing/stale lists, aliases, approximate matches, tiers, truncation
  and invalid price fields. Expose freshness/matching before selection.

### AX-002 - enforce the selection constraint

- [x] Define currency, token unit, direction and strict/inclusive boundary:
  below USD 5 per million output tokens excludes 5. Recheck the concrete model
  and applicable price before execution. Unknown/stale/approximate data cannot
  silently satisfy a constraint. `output_price_below`, `PRICE_LIMIT`.
- [x] Keep selection separate from consent: neverAsk cannot override a requested
  ceiling. Auto chooses only qualifying policy-allowed models. An explicit
  unavailable/over-limit model returns a reason without substitution. Auto takes
  the qualifying default, else the highest-priced qualifying model, which still
  asks where governance says so (owner decision of 2026-10-08).
- [ ] **AX-002a - accept the existing selection flow.** Use AX-006's per-client
  cards for minimal unconstrained calls and constrained calls with at most one
  discovery plus one execution, without web/config reads. Keep POLICY fixtures
  for boundaries/no-match/resume/config changes. Concurrent root budgets belong
  to COAGENT-003/006 and need their own evidence; do not mark them done here.
- [ ] **AX-002b - choose the plain-consult default policy.** Compare a configured
  default ceiling with the present unconstrained default using existing config/
  selection/governance owners. State precedence, unavailable-price behavior and
  migration for current users; record the owner decision. Check: P only.
- [ ] **AX-002c - implement the accepted default policy.** After AX-002b,
  update config validation and selection plus schema/README together. Done:
  explicit requests and consent remain binding, the accepted default is tested
  at the exact boundary, and no model is silently substituted. Check: R,
  CONFIG/SELECT/POLICY/MCP. Do not implement an unchosen policy.

### AX-003 - consent across clients

- [ ] **AX-003a - classify current elicitation outcomes.** Start:
  `src/mcp/server.ts`, `src/execution/consent.ts`, `src/models/governance.ts`.
  Separate unsupported, advertised, declined and unanswered outcomes; claim
  displayed/verified only from native observation. Done: absent capability,
  cancelled form and false/missing checkbox fixtures retain the concrete model
  and actionable policy reason. Check: R, MCP/POLICY. Refusal wording is already fixed.
- [ ] **AX-003b - design form-less consent.** Produce request/model/scope binding,
  expiry/replay examples and a human-controlled interaction compatible with
  CLI-FIRST-001. Done: review of the proposal identifies who can approve and
  how the server verifies that fact. Check: P. Agent flags, guessed config edits
  and neverAsk insertion cannot act as approval; retain current refusal meanwhile.
- [ ] **AX-003c - split the accepted protocol into code cards.** After AX-003b,
  write separate cards for server proof validation, client interaction and replay/
  expiry failures, naming the accepted protocol files/tests. Implement one card
  at a time after this planning card; reuse T10's cancellation and evidence
  binding. Done: each new card names a verifiable failure outcome, and native
  form-less acceptance is assigned under AX-006. Check: P. Explicit-model
  preservation remains mandatory; auto route-skipping needs an accepted preference.

### AX-004 - diagnostics and effective configuration

The shared configuration/timing/cancellation work is broken down in
[EXEC-001](#exec-001---measured-preparation-and-complete-call-lifecycle),
especially T02/T03/T08/T11/T12. The configuration and native acceptance items
below retain their own acceptance criteria.

- [ ] **AX-004a - accept config provenance in fixtures.** Implementation belongs
  to T03a-d. Extend CONFIG/DOCTOR and setup fixtures for old registration paths,
  paths with spaces, explicit editor/backend overrides and malformed files.
  Done: effective source/location is correct and redacted; no config is silently
  rewritten to make diagnostics green. Check: R plus affected setup tests.
- [ ] **AX-004b - accept read effects and timings.** After T08/T11b, use DOCTOR/
  CACHE to compare cold/warm model and health views. Done: measured native reads,
  optional cache writes and observed-default writes match documented behavior;
  missing caches and cancellation remain controlled. Check: R and phase evidence.
- [ ] **AX-004c - accept one live config change.** In an isolated client profile,
  record registration/config path, change an owned setting, perform any required
  restart and inspect the resulting effective value. Repeat as separate cases
  for each claimed client. Done: real host evidence supports refresh/restart
  guidance and custom user state is preserved. Record NOT_RUN if host unavailable.

### AX-005 - readiness with evidence

- [ ] **AX-005a - define the readiness decision table.** Start:
  `src/diagnostics/doctor.ts`, `src/backends/types.ts`, `availability.ts`.
  Specify unknown/failed/verified separately for installation, login, execution,
  quota freshness and profile evidence. Done: quota disabled, expired login,
  rate limit and sandbox rejection have distinct outcomes. Check: P first.
- [ ] **AX-005b - implement and render that evidence.** After AX-005a, keep the
  decision logic in one diagnostic owner and update report/summary together.
  Done: a successful turn is timestamped for its actual model/profile; cold agy
  followed by success does not imply universal isolation. Check: R, DOCTOR/CACHE/
  MCP with each decision-table row, preserving agy's inherited-tool limitation.

### AX-006 - first-use contract

- [ ] **AX-006a - prepare the acceptance script.** Start: `src/mcp/schema.ts`,
  `src/mcp/constants.ts`, `tests/mcp/surface.test.js`. Write identical prompts
  for plain consult, price ceiling, exact model/effort, continuation and a
  rejected request. Define recorded fields and expected outcomes in HANDOFF.
  Done: schemas alone contain needed instructions and fixtures pass. Check: R, MCP/POLICY.
- [ ] **AX-006b - run fresh Codex acceptance.** Execute AX-006a in an isolated
  Codex client. Record calls, actual model/effort, price source, retries, ToolSearch,
  phase/total time and versions. Done: first-attempt selection uses no source or
  private config reads; consent rendering is observed, not assumed.
- [ ] **AX-006c - run fresh Claude acceptance.** Repeat AX-006a with the same
  task/ceiling in an isolated Claude client and record the same fields. Do not
  inherit Codex's result or change config to hide a failed first attempt.
- [ ] **AX-006d - run fresh agy acceptance.** Repeat AX-006a in an isolated agy
  client; additionally record host timeout and inline-result behavior. Keep
  inherited-tool limitations explicit. Native unavailability is NOT_RUN.

Native cards do not authorize paid model escalation, live user-config mutation
or installation changes. Use existing task authority and server-mediated consent.

## Full coagent direction

All milestones are pending. The table summarizes milestones; a whole row is
not an assignment for a model. Start with the design cards below, then write
implementation cards against accepted contracts and current source. Do not
invent write/delegation interfaces while implementing an EXEC or AX card.
Roles do not grant capabilities or imply model size.
A client may coordinate or delegate coordination. Any supported provider/model
may plan, implement, verify or review. Independent review uses a separate session
and cannot be supplied by the implementation author.

| Milestone | Deliverable and acceptance |
| --- | --- |
| `COAGENT-001` Task contract | Start/inspect/continue/cancel; stable task/root/parent IDs, role, objective, scope, acceptance, profile, context and optional model/effort. Validated status, actual identity, changes/evidence and usage availability. Test transitions, repeats, truncation and legacy calls. Worker success is not root acceptance. |
| `COAGENT-002` Profiles | Verify read-only, workspace-write and bounded commands per backend/version/OS. One writer per canonical workspace; baseline dirty files, prevent path escapes/conflicts, preserve partial work. Parallel writers need authorized separate workspaces or verified disjoint ownership. No automatic worktree/reset/cleanup. Native containment/failure tests precede claims. |
| `COAGENT-003` Routing/limits | Role/task defaults independent of provider/model/effort; explicit choices and opt-in cost/latency/quality/quota preferences. Atomic root reservations for calls/concurrency/time/depth shared by children/retries. No silent explicit-model fallback, fabricated monetary cap or self-approved escalation. Reconcile request identity before replaying writers; test contention/lost replies. |
| `COAGENT-004` Lifecycle/evidence | Minimal durable state/leases independent of transcript archival or a daemon. Early handles, progress, inspect/cancel, recovery; disconnect cancels by default. Detached execution requires verified supervision. Preserve original requirements, bounded context/omissions. Capture checks in the actual candidate with commands/exits/logs; separate observed from reported evidence. Test interruption, stale evidence and root-incomplete results. |
| `COAGENT-005` Skills | Composable coordination/planning/work/verification/review/recovery SKILL.md packages; catalog/install/update/uninstall through shared integration logic. Owned manifests/digests, atomic rollback, conflict/path-traversal checks; preserve custom instructions and execute no bundled scripts. Detect real client/loader, scope and remote path access. Verify discovery/use per advertised client; unsupported clients retain MCP. |
| `COAGENT-006` Delegation | After host-led execution, add a task-scoped gateway with verified root/parent identity, capabilities and shared limits. Keep nested refusal until accepted. Bound fan-out/depth, reject cycles/replay, propagate cancellation and recover partial launches. Account for or disable unobservable native subagents where limits require it. Test forged delegation/restarts/launch races. |
| `COAGENT-007` Migration | Update schemas/profiles/security rules/README/skills together before writes. Preserve compatible config, sessions, registrations and legacy read-only calls. Commit/push/merge/deploy/publication need task/user authority; skills cannot grant it. Reuse owners, not a parallel orchestration stack. |
| `COAGENT-008` Acceptance | Compare direct/host-led/delegated runs on identical starting trees: feature, bug, refactor, docs, investigation, failed-test repair, ambiguous plan, interruption. Cover strong/small, small/strong, peers and one worker. Measure correctness, regressions, time, calls, overhead, repairs and available usage, including failures. Native evidence, exact-package six-job CI and independent boundary review before RC. |

### Coagent contract cards

These are pending design/evidence cards, checked with P. Their deliverable is
an in-place proposal in the owning ARCHITECTURE section, labelled unimplemented,
with acceptance examples and unresolved decisions in HANDOFF. EXEC-001 runtime
work remains the immediate implementation track; contract design may proceed
alongside it as the execution order permits. After acceptance, add code cards
here before implementation: one operation/provider/storage transition per card,
real starting files, a failure example and an exact test command. Model strength
never substitutes for acceptance of an unresolved contract.

- [ ] **COAGENT-001a - task payload examples.** Read `src/contracts/execution.ts`,
  `src/mcp/schema.ts` and the target task contract in ARCHITECTURE. Specify one
  valid start/inspect/continue/cancel payload and invalid variants; distinguish
  task/root/parent identity, role, profile and actual provider/model. Done:
  examples preserve legacy consult/review and never infer capabilities from role.
- [ ] **COAGENT-001b - task transitions.** After 001a, define allowed status
  transitions and outcomes for repeated request, lost reply, cancel and restart.
  Start from `src/sessions/types.ts` and `session.ts`. Done: duplicate starts
  cannot create duplicate writers; worker completion cannot finish the root.
- [ ] **COAGENT-002a - profile evidence inventory.** Read all three adapters and
  `.agents/rules/01-security-and-sandboxes.md`. Record current verified/unknown
  capabilities per backend/version/OS and the agy limitation. Done: existing
  read-only evidence is separate from planned write/command profiles.
- [ ] **COAGENT-002b - writer ownership design.** After 001b/002a, start from
  `src/workspace/identity.ts`, `src/storage/lock.ts`, `src/sessions/session.ts`.
  Specify dirty-baseline ownership, conflicts, path escapes, partial work and
  restart recovery. Done: examples reject two writers to one canonical workspace
  and preserve user edits. Split later profile implementation by backend and
  native acceptance by OS; no write claim before those tests pass.
- [ ] **COAGENT-003a - role/route precedence.** After 001a, read config, routing
  and model selection. Specify request versus role versus configured defaults
  with examples for explicit model and optional preferences. Done: roles remain
  provider-independent and explicit-model refusal never becomes fallback.
- [ ] **COAGENT-003b - root reservation protocol.** After 001b, specify atomic
  reservation/release/recovery for calls, concurrency, time and depth across
  children and retries. Use the existing storage/lease owners. Done: race and
  lost-reply timelines prove no double execution or overspend of defined limits;
  monetary caps require measured support and cannot be invented from token limits.
- [ ] **COAGENT-004a - durable state and early handles.** After 001b/002b, read
  session/history owners and T06 finalization. Specify a minimal task record,
  handle publication, inspect/cancel and restart recovery independent of archives.
  Done: disconnect cancellation and absence of history have explicit outcomes;
  detached supervision remains unimplemented until verified separately.
- [ ] **COAGENT-004b - observed evidence and compact handoff.** After 004a, read
  `src/review/input.ts`, `gate.ts` and Git snapshot logic. Specify candidate-bound
  command/exit/log evidence and HANDOFF-001 fields. Done: reported PASS differs
  from observed PASS, omissions are explicit and stale evidence blocks acceptance.
- [ ] **COAGENT-005a - skill ownership manifest.** Read `.agents/skills/coagent8-workflow/`,
  `src/integrations/setup-storage.ts`, `cleanup.ts`. Specify catalog/manifest,
  digests, conflicts, traversal rejection and rollback for one skill. Done:
  examples cover custom user files and scripts that must never execute.
- [ ] **COAGENT-005b - one client loader contract.** After 005a, select one
  supported client and verify its current loader docs through Context7. Specify
  scope, remote-path access, discovery and install/update/uninstall acceptance.
  Done: each lifecycle operation becomes a separate implementation card; other
  clients require their own loader evidence, not copied claims.
- [ ] **COAGENT-006a - delegation failure protocol.** After accepted 001-005/007
  host-led execution, read `src/execution/nested-turn.ts` and root reservations.
  Specify capability-bound parent/root requests, fan-out/depth, replay/cycle
  refusal, partial launch recovery and tree cancellation. Done: forged-request
  and launch-race examples fail closed; the existing nested guard stays enabled
  until a complete replacement passes acceptance.
- [ ] **COAGENT-007a - compatibility inventory.** Alongside the relevant contract,
  list affected MCP schemas, config/history formats, registrations, README,
  skills and security rules. Start from existing MCP/session/setup tests. Done:
  every changed contract has a legacy fixture and migration owner; documentation
  and profile changes ship with their feature, not after enabling writes.
- [ ] **COAGENT-008a - benchmark cases.** After task/evidence contracts are
  accepted, define one starting-tree fixture per task category in the milestone
  table. Specify expected changes/checks, interruption recovery and role/model
  combinations. Done: each run can be assigned independently with identical
  inputs; fixture validation and native model runs are reported separately.

`HANDOFF-001` joins COAGENT-004/005: versioned compact handoffs carry task/role/
profile, branch/target, base/candidate/diff identity, objective, scope, acceptance,
context and PASS/FAIL/NOT_RUN evidence. Fresh agents must understand them without
previous chat. Do not copy rulebooks or duplicate the review tool's envelope.

Claudex was inspected historically at `8cf5e2c1771c5151d90c12642391d0ba8fa71b0e`.
Its composable skills/handoffs are design input, not a dependency or verified
integration. Do not copy opposite-provider routing, host-only budgets or PID-based
teardown. Preserve applicable licenses if reusing material. Fetch current client
documentation through Context7 before implementing adapters.

## Remaining foundation work

Retain these work IDs; local fixes still need candidate acceptance.

These rows are acceptance inventories, not permission to rewrite every listed
subsystem. For an assigned row, first select one finding/behavior and one
platform or client. Create a card using the EXEC template (start/change/done/
check) before implementation. Reuse the following concrete split points:

| Owner | Small assignment sequence and starting point |
| --- | --- |
| AUDIT-001 | Reproduce one historical finding on the candidate; use its mapped owner/test below. Record fixed/reproduced/NOT_RUN, then make one regression/fix card only if evidence requires it. |
| WINDOWS-001 | Read `src/execution/process.ts`; first reproduce POSIX parent death, then specify owned-supervision behavior, then implement it. Native Windows quiet-desktop and cold-updater scenarios are separate acceptance cards. |
| REDACTION-002 | Start with `tests/security/redaction.test.js` and history tests; assign credential-only answer, split-chunk credential and persisted bytes as separate cases. Assert the actual public/disk bytes. |
| SESSION-001/HISTORY-002 | Specify new/auto/none semantics first, then implement one mode per card using `src/sessions/session.ts`. Early-handle publication is a separate COAGENT-004a-dependent card; native-expiry retry needs its own proof-before-execution fixture. |
| LOCKS-001/QUOTA-001 | Use LOCK/CACHE/LIFE tests; assign token renewal, cooldown single-write and optional-cache failure separately. Reuse T08/T09 changes instead of adding another cache or lock owner. |
| SURFACE-001/STARTUP-001 | Start with `src/mcp/constants.ts`, schema and surface tests; separately remove duplicated review wording, measure definition bytes, and verify no-probe startup. Preserve six tools and legacy compatibility. |
| INSTALL-001/MIGRATION-001/UNINSTALL-002 | One client and one lifecycle operation per card, starting with `src/integrations/setup.ts` or `cleanup.ts` and their fixtures. Test owned registration/rollback before the matching isolated native-host scenario. |
| ERRORS-001/DOCS-001 | Inventory one owner's catch sites; classify expected absence versus real I/O failure. Fix one error path with a behavioral fixture. Timeout defaults already belong to T07c. |
| PACKAGE-001/VERIFY-001 | Use T12b for local package evidence, T12c for native/remote cells and T12d for independent binding. Reuse those results rather than inventing another full gate. |

For rows whose design is not settled, the first card produces a decision and
failure examples, not speculative implementation. Preserve every acceptance
condition in the inventory when splitting; a narrower card does not waive it.

| Owner | Remaining acceptance |
| --- | --- |
| `AUDIT-001` | Rerun original process/redaction/history/cooldown/error/config/lease/resource reproductions on the candidate. CUR-001/003/004/005/006/010/012 have local fixes; old reports do not reopen them. Independent scope/check evidence remains required. |
| `WINDOWS-001` | CUR-011: POSIX parent-death cleanup. Native no-survivor/quiet-desktop evidence, including cold agy updater conditions. Never PID/name/PPID-select teardown; owned handles/groups and protocol interrupt only. |
| `REDACTION-002` | Preserve credential-only answers, broader diagnostic redaction and split-stream secret handling in new task paths. |
| `EXEC-001`, `CLI-INTERACT-001` | CUR-007: complete [T01-T12](#exec-001---measured-preparation-and-complete-call-lifecycle): reproducible baseline, phase timing, config/preparation reuse, guaranteed finalization, complete-call budget, cancellable observations/Git/storage/consent, transport migration and independent measured acceptance. Preserve activity-aware idle behavior and account for agy host deadlines. |
| `SESSION-001`, `HISTORY-002` | CUR-008: return a session handle before the turn ends and allow calls without a disk session; this is separate from `coagent8_HISTORY=off`, which only disables archives. Specify how session modes `new`, `auto` and `none` relate to existing calls. Explicit invalid/busy handles fail closed; opt-in `auto` reuses a session of the same workspace/provider used within 15 minutes and starts a fresh one when that session is busy. Only a native expiry proven before execution permits one fresh retry within the original time budget. Preserve retention, pagination and migration of existing histories. |
| `LOCKS-001`, `ROUTING-MIGRATE-001`, `QUOTA-001` | Keep renewed token leases, single cooldown recording, honest quota and optional caches under concurrency. No retries of policy/sandbox/cancel/partial-execution errors. |
| `SURFACE-001`, `CONSULT-001`, `CONTEXT-001`, `MCP-001`, `STARTUP-001` | Preserve the six tools, plain consult, client roots/resources and startup that does not wait for backend probes. Remove review instructions duplicated between tool descriptions and prompts; measure the definition-size budgets in native clients. Icon or UI claims need evidence from the host. Failures of a first call by a fresh agent belong to AX-006. |
| `CLAUDE-BACKEND-001`, `DIAGNOSTICS-001` | CUR-009: auth evidence, bounded cancellable native quota reads, real approval/client acceptance. Verify user hooks/plugins and skill delivery in restricted review without silently enabling tools. |
| `INSTALL-001`, `MIGRATION-001`, `ONBOARDING-002`, `UNINSTALL-002` | Clean-environment setup and shared-config migration; native install/update/repair/restart/uninstall for claimed clients. Preserve manual registrations/credentials/histories. Single setup list has preliminary owner acceptance; full lifecycle is pending. |
| `ANTIGRAVITY-HUB-001` | Accept configured managed CLI and quiet launches. Revisit private hub only with supported versioned API, verified task capabilities and no authority escape through inherited tools. |
| `ERRORS-001`, `SIMPLIFY-001`, `DOCS-001` | Finish the review of I/O errors and empty catch blocks so every failure is actionable; type auth, quota, context-length and crash failures; remove duplicated timeout constants. Refactor only where a module holds unrelated responsibilities, and document logic that is hard to follow. Do not change behavior merely to rename folders. |
| `PACKAGE-001`, `TESTS-001`, `VERIFY-SCOPE-001`, `VERIFY-001` | `dist/` stays untracked; the VSIX and plugin payloads are derived from the npm tarball. Tests prove they remove only their own temporary files and keep logs that explain a failure. Accept in CI the change that runs the suite once per matrix job through `test:coverage` instead of a separate full run. Report source tests, bundle checks, exact-artifact checks and native-host evidence separately. |
| `CHANGELOG-001`, `REPO-001` | Keep generated changelog/pre-push/title checks and license notices. GitHub release-note API, protections and registry state need owner-led verification; no automatic history/npm action. |

### Audit traceability

Audit `c265cdf` predates rewritten history; review `24052e3` is historical too.
Mappings retain ownership, not an assertion that all findings remain open.
Detailed reproductions remain recoverable from Git; optional local copies are
not dependencies of this plan.

| Historical findings | Owner |
| --- | --- |
| AUD-P0-1, AUD-P2-14 | WINDOWS-001 |
| AUD-P0-2, AUD-P2-13 | REDACTION-002 |
| AUD-P0-3, AUD-P1-3, AUD-P2-12 | HISTORY-002 |
| AUD-P1-1, AUD-P2-1/2 | ROUTING-MIGRATE-001, DIAGNOSTICS-001 |
| AUD-P1-2, AUD-P2-7 | ERRORS-001 |
| AUD-P1-4/6/7/11 | EXEC-001, WINDOWS-001 |
| AUD-P1-5/8/9/10 | CLI-INTERACT-001, SESSION-001, LOCKS-001, PACKAGE-001, respectively |
| AUD-P2-9/11, AUD-P2-10, AUD-P2-15 | MCP-001, INSTALL-001, VERIFY-SCOPE-001, respectively |
| AUD-P2-3/4/5/6/8, P3 | SIMPLIFY-001 |

### CLI-FIRST-001 - public CLI and MCP adapter

These cards follow the accepted task/profile contracts and preserve the public
MCP bridge until the CLI replacement is accepted. Use one command or native
platform scenario per implementation assignment.

- [ ] **CLI-FIRST-001a - specify syntax and outcomes.** Start: `src/index.ts`,
  `src/mcp/schema.ts`, neutral execution contracts and COAGENT-001. Define
  commands, backend/model aliases, bounded stdin/JSON/JSONL, help/version,
  error/exit mapping and consent transport. Done: invocation examples cover
  success, invalid input and cancel while preserving no-argument stdio/setup/
  cleanup. Check: P; final syntax requires review before code cards.
- [ ] **CLI-FIRST-001b - add dispatch/help/version.** After 001a, change the
  existing root dispatch and lazy setup boundary. Done: explicit MCP startup
  and accepted help/version routes work without eager provider/setup loading;
  old invocations still work. Check: R, MCP/E2E and package consumer smoke.
- [ ] **CLI-FIRST-001c - expose models.** After 001b, consume
  `src/diagnostics/doctor.ts:runModelReport` using the accepted CLI output format.
  Done: model/price/approval data agree with MCP and output stays bounded.
  Check: R, DOCTOR/MCP and an installed-bin models fixture.
- [ ] **CLI-FIRST-001d - expose session inspection.** After 001c, consume
  session/history owners for list and history using the accepted parser.
  Done: workspace isolation, invalid handles and pagination match existing
  behavior. Check: R, SESSION plus installed-bin fixtures. Plan close/delete
  as a separate mutation card with the accepted ownership/authority contract.
- [ ] **CLI-FIRST-001e - expose diagnostics.** After 001d, consume `runDoctor`
  and its T11b context. Done: diagnostics create no sessions, preserve redaction,
  report errors with accepted exit codes and remain cancellable. Check: R,
  DOCTOR/REDACT and an installed-bin diagnostics fixture.
- [ ] **CLI-FIRST-001f - expose one execution path.** After accepted profiles,
  route CLI execution through the shared engine. Done: bounded input/output,
  continuation, expiry, EOF and broken-pipe cases settle owned work; neither
  flags nor TTY detection can grant consent. Check: R, LIFE/PROCESS/E2E with
  exact installed-bin fixtures. Add separate code cards for additional commands.
- [ ] **CLI-FIRST-001g - make MCP invoke the packaged CLI.** Start: MCP dispatch,
  `src/execution/process.ts`, `scripts/build.cjs`, consumer fixtures. Resolve
  the matching packaged sibling directly without shell/PATH lookup; bind
  request/consent/cancel to its owned child. Done: concurrent/resumed turns,
  EOF and crash preserve identity and package version. Check: R, MCP/E2E,
  build/package inspection and exact-artifact smoke.
- [ ] **CLI-FIRST-001h - accept PATH behavior per OS.** First produce separate
  Windows, Linux and macOS cards for read-only diagnosis, then owned change/
  rollback scenarios. Start from `src/execution/cli-resolver.ts` and its tests.
  Done: native shims/links/permissions and Bash/Zsh startup are observed; shared
  PATH entries are preserved and no machine-wide/execution-policy edit is
  silently made. Fixtures cannot approve a native platform cell.
- [ ] **CLI-FIRST-001i - measure and accept the CLI topology.** Compare cold/warm
  process count, memory and latency with identical tasks. Use T12's package,
  native six-job and independent evidence format. Done: sibling versions match,
  overhead is measured and limitations are explicit. A TUI/persistent worker
  remains deferred unless a separate bounded comparison justifies it.

## Release acceptance

| Stage | Required scope |
| --- | --- |
| BETA-001: beta.2 | Bridge audit blockers, fresh package/matrix/independent review and native VS Code checks below. First tester release; beta.1 was the name placeholder. No write claim. |
| BETA-001: beta.3 | Host-led COAGENT-001 through 005 and applicable 007: verified writes/checks/review/skills, AX acceptance, triaged beta.2 feedback; no open P0/P1 defects. |
| RC-001: rc.1 | Delegated/parallel slice, COAGENT-008, CLI-first and included foundation work complete or explicitly deferred before freeze, unsupported claims removed. |
| rc.2 if needed | Corrections with renewed evidence; never replace a published artifact. |
| 1.0.0 | Accepted audited snapshot through the final release PR to main. |

Every release needs a clean candidate, applicable full package gate, six OS/Node
CI jobs, exact artifact provenance, soak evidence (concurrency/cancel/EOF/crashes,
recovery/leases/histories/memory), and independent approval bound to Base SHA,
Candidate SHA, Tree SHA and Artifact SHA-256. No unresolved P1/P2; content changes
invalidate approval. Procedures belong to the [quality gate](../.agents/rules/04-quality-gate.md)
and [Git workflow](../.agents/rules/02-git-workflow.md).

### Native VS Code acceptance

Record host/CLI versions, candidate/VSIX digest and PASS/FAIL/NOT_RUN per scenario:

Each named operation below is one native acceptance case in an isolated profile,
not a request to execute the entire lifecycle against the owner's installation.
Record pre-state, action, observed post-state and preservation checks. A failed
case produces a separate reproduction/fix card before rerunning that case.

- Install/update: native restart, one provider, six current tools, no persistent
  restart banner.
- Configuration: custom path with spaces, shared default, editor precedence,
  reset cancellation/one backup, valid settings/schema and live server refresh.
- Onboarding: first-install notice once; single list with state/source/registration;
  unchanged acceptance does nothing; install/sign-in/add/remove/restart preserve
  manual registrations and unrelated servers.
- Execution: quiet consult/review while typing elsewhere; report TIMEOUT/BLOCKED
  honestly. Verify consent in a client that actually displays the form.
- Uninstall: cancellation and both confirmations, only owned dependencies offered,
  standalone removal commands await user action. Full quit/restart and separate
  Extensions-view removal. Remove owned registrations/runtime/tagged backups/
  extension storage; preserve shared config/settings/credentials/histories.
- Reinstall: first-install behavior with preserved config. Preliminary owner
  acceptance predates 1353fb9 and does not accept its config migration.

## Documentation ownership

Only ROADMAP, ARCHITECTURE and HANDOFF are active project documents in docs/.
README and extension README serve users; .agents/rules/ serve contributors.
Update the owning section instead of appending session reports or parallel plans.
Useful investigations may live in ignored docs/.local/; tracked
documents must not depend on them. History stays in Git, not an archive directory.

Deferred unless justified: SQLite/transcript database, persistent daemon,
arbitrary third-party skill registry, private provider hub, binary prompt
encoding and broad UI/TUI expansion. No blanket sandbox opt-out.
