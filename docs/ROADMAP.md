# CoAgent8 roadmap

Updated 2026-10-08. This is the single active plan. CoAgent8 is becoming a
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
| Agent usability | Model/effort discovery with per-model prices, strict output price limit, result footer | Request estimates, effective config, consent transport, native first-use acceptance |
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
- An unanswered approval form is followed by advice to use another model even
  when the user chose this one (`AX-003`).
- Older registrations can point at a different config file than the default the
  agent edits; summary and full doctor do the same diagnostic work (`AX-004`).
- agy can report not-ready and then execute successfully (`AX-005`).
- Tool descriptions discourage model selection even when the user sets a price
  limit, and effort syntax needs trial and error (`AX-006`).
- A plain `consult` through `auto` can run an expensive default model; earlier
  `auto` chose a large model for 52.8 s (owner decision: make plain consult cost
  predictable, `AX-002`). A per-call limit now bounds a constrained call; a call
  without one still runs the default.

## Execution order

1. Preserve/finalize audit and desktop-safety fixes (`AUDIT-001`). Resolve
   relevant blockers before enabling affected capabilities.
2. Fix agent-facing selection (`AX-001` through `AX-006`) while designing
   the shared task/profile contract (`COAGENT-001/002`).
3. Deliver one host-led write/check/review/fix path, role configuration and
   skill installation (`COAGENT-003/004/005/007`).
4. Add delegated coordination and parallel work (`COAGENT-006`), with root
   limits, writer ownership and recoverable task state.
5. Accept CLI execution, supported clients/platforms and benchmarks
   (`CLI-FIRST-001`, `COAGENT-008`), then complete the release gates.

## Agent usability acceptance

All items below are planned, not available arguments. Extend existing owners;
do not create separate selection/policy implementations per client.

### AX-001 - prices before execution

- [x] Expose a bounded MCP selection view: backend, concrete model, accepted
  efforts, default source, output USD per million tokens, price source/date,
  exact/approximate/unknown match and approval requirement/reason. Keep concise
  text and structured data consistent; reuse it for the planned CLI models command.
  Doctor selection rows and summary (3,900 bytes), from listModelCandidates.
- [ ] Separate unit prices, request estimates, measured tokens, quota and billing.
  Unknown stays unknown. Estimates identify input/output/cache/context-tier
  assumptions and provider evidence; a unit price is not a request estimate.
  Done for unit prices (labelled list prices, unknown kept unknown); request
  estimates and measured tokens are open.
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
- [ ] Preserve minimal unconstrained calls. Accept a constrained call in at most
  one discovery plus one execution, without web lookup or private config reads.
  Test the boundary, no match, resume, config changes and concurrent root budgets.
  Local fixture tests cover all but concurrent root budgets (COAGENT-006); fresh
  native clients are retested under AX-006.
- [ ] Make a plain consult's cost predictable without a per-call limit (owner
  decision), for example a configured default limit. Not designed yet.

### AX-003 - consent across clients

- [ ] Report unsupported, advertised, displayed/verified, declined and unanswered
  approval states where observable. Capability advertisement does not prove UI.
- [ ] Return model, policy reason and recovery. Preserve an explicit model after
  denial; alternatives require user policy. Auto may skip an approval-requiring
  route only under a defined preference.
- [ ] Design a user-controlled approval path for form-less clients, shared with
  CLI-FIRST-001: request/model/scope binding, expiry and replay protection.
  No agent-set flag, guessed config edit or silent neverAsk insertion. Keep
  current fail-closed elicitation until the replacement is accepted.
- [ ] Test absent capability, cancelled form, false/missing checkbox, replay,
  changed model and actual rendered approval in advertised clients.

### AX-004 - diagnostics and effective configuration

- [ ] Separate cached selection metadata from explicit fresh diagnostics.
  Doctor can refresh caches and record an observed default; expose these effects.
  Bound/cancel native reads and measure cold/warm phases and total elapsed time.
- [ ] Expose effective config/data location and provenance with diagnostic
  redaction: defaults, environment, explicit editor settings and backend overrides.
  Name each setting's source and restart requirements without dumping credentials.
- [ ] Test old registrations overriding the shared default, custom paths, editor
  overrides, invalid config, missing caches and live-host config changes.

### AX-005 - readiness with evidence

- [ ] Separate installation, login evidence, execution support, quota freshness
  and profile verification into unknown/failed/verified states. Timestamp turn
  success for its model/profile; do not generalize it to universal readiness.
  Keep agy's inherited-tool limitation explicit.
- [ ] Test quota disabled, cold agy discovery followed by success, expired login,
  rate limits and profile rejection. Missing evidence is not a failure, and
  a shell flag is not proof of isolation.

### AX-006 - first-use contract

- [ ] Schemas must suffice without repository access or skills: minimal call,
  priced selection, exact model plus effort, continuation and actionable errors.
  Permit model selection for user constraints; omit choices for ordinary defaults
  (schema and instruction wording landed with AX-002; native retest pending).
  Measure client ToolSearch separately from server overhead.
- [ ] Retest fresh Codex/Claude/agy clients with the same task and price ceiling.
  Record calls, model, price evidence, effort, preparation/execution/total time,
  retries and host/tool versions. Require correct first-attempt selection without
  hidden fallback/config mutation or source reading. Preserve the useful footer.

## Full coagent direction

All milestones are pending. Roles do not grant capabilities or imply model size.
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

| Owner | Remaining acceptance |
| --- | --- |
| `AUDIT-001` | Rerun original process/redaction/history/cooldown/error/config/lease/resource reproductions on the candidate. CUR-001/003/004/005/006/010/012 have local fixes; old reports do not reopen them. Independent scope/check evidence remains required. |
| `WINDOWS-001` | CUR-011: POSIX parent-death cleanup. Native no-survivor/quiet-desktop evidence, including cold agy updater conditions. Never PID/name/PPID-select teardown; owned handles/groups and protocol interrupt only. |
| `REDACTION-002` | Preserve credential-only answers, broader diagnostic redaction and split-stream secret handling in new task paths. |
| `EXEC-001`, `CLI-INTERACT-001` | CUR-007: end-to-end deadline across Git/probes/consent/acquisition/execution/cleanup, explicit consent accounting and phase timing. Activity-aware idle policy permits silent reasoning without extending deadlines. Test cancel/EOF/output/crash/typed failures; account for measured agy host deadlines. |
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

- [ ] Share typed requests/results and policy with the task engine. Preserve
  no-argument stdio/setup/cleanup; add explicit MCP startup, execution/models/
  sessions/diagnostics, backend/model aliases, bounded stdin/JSON/JSONL,
  help/version and stable exit codes. Final syntax needs implementation review.
- [ ] MCP invokes its matching packaged CLI without shell/PATH lookup.
  Bind consent/cancel/lifecycle to request and owned child; test concurrent turns,
  resume, EOF, broken pipes and crashes. Flags/TTY detection cannot grant consent.
- [ ] Verify global/local command/PATH diagnosis/change/rollback on Windows/Linux/
  macOS, including shims, links, permissions and Bash/Zsh startup. Preserve shared
  PATH entries; no silent execution-policy or machine-wide changes.
- [ ] Measure cold/warm process count, memory and latency. Verify exact-artifact
  sibling versions and native six-job evidence. Decide/defer TUI after bounded
  comparison; no UI dependencies in MCP startup or unmeasured persistent worker.

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
