---
title: Roadmap
---

# CoAgent8 roadmap

Updated 2026-11-05. CoAgent8 is becoming a client-independent MCP system for
orchestrating complete agent tasks. Roles, models and providers are
independent. Read-only consultation is one execution profile, not the product
boundary. `consult` and `review` run read-only; `delegate` runs workspace-write
workers in the background under one root budget, in disjoint scopes of a work
tree or in separate linked worktrees, optionally in a server-owned loop of
checks, review and fix rounds, and a read-only coordinator can ask the server for
such workers.

This file holds the direction and the order of the milestones. The work itself
is in [GitHub Issues](https://github.com/oktawianwybieralski/coagent8/issues):
each planned result is one issue with its context, dated decisions,
`Acceptance criteria` and open steps, and a
[milestone](https://github.com/oktawianwybieralski/coagent8/milestones) names
the release it is planned for (owner decision 2026-11-05; core rule 02
"Backlog" in
[agent-standards#7](https://github.com/oktawianwybieralski/agent-standards/pull/7)).
[ARCHITECTURE.md](ARCHITECTURE.md) owns contracts and target design. Current
work and evidence are in issues and PRs (owner decision 2026-11-05). README
owns getting started; [AGENTS.md](../AGENTS.md) owns contributor rules.

The cards this file held until 2026-11-05 are in [ROADMAP at `a7c6f72`](https://github.com/oktawianwybieralski/coagent8/blob/a7c6f72/docs/ROADMAP.md);
the [former card identifiers](#former-card-identifiers) below map each open
card to its issue.

## Current status

`0.7.0` (beta.3) is released: tag `v0.7.0`, GitHub Release, npm (`latest`) and
the VS Code Marketplace, uploaded by hand
([record](https://github.com/oktawianwybieralski/coagent8/blob/7eec83a/docs/delivered/0.7.0/README.md)). `develop` holds the `0.8.0` candidate
([plan](#080-plan), [record](https://github.com/oktawianwybieralski/coagent8/blob/7eec83a/docs/delivered/0.8.0/README.md)). Agents merge a PR
when its gate and CI pass and every required reviewer is READY on its head
([standing go-ahead](../.agents/project.md#standing-go-aheads) of 2026-11-02);
tags, publication and repository settings stay the owner's.

| Area | Present on `develop` | Remaining for `0.8.0` |
| --- | --- | --- |
| Execution | Seven tools, three CLI adapters, plain consult, explicit model/effort, asynchronous `delegate` with task records and `wait`, a server-owned loop, parallel workers under one root budget in disjoint scopes or linked worktrees, a read-only coordinator of workers | Roles and verified profiles, compatibility and benchmarks (#160, #161, #165, #166) |
| Safety | Owned cleanup, hidden Windows launches, per-call Windows containment, redaction, explicit model and check consent, Codex/Claude inherited-tool controls | POSIX parent-death cleanup (#186); `arm64` and SmartScreen (#111); signing (#112) |
| Review | Completeness, snapshot gate, post-turn recheck, reviews in parts, checks the server runs before the turn | Release hashes bound to the review (#148); other-tree review (#187, unscheduled) |
| Storage/routing | Leases, bounded archives, cached catalogs/prices, writer records across server processes, root reservations, caller label (Claude Code) | Ephemeral calls and early handles for consult and review (#188) |
| Agent usability | Cached model view with CLI catalogs, per-model prices and release dates, price limit, result footer, client-declined forms reported as the client's answer | Fresh-client acceptance (#156), form-less consent (#154) |
| Integrations | Shared config, setup, VSIX, owned registration/uninstall, client skills, Claude Code wake-up | Codex and agy wake-up (#113, #114), plugins (#151) |

## 0.8.0 plan

Owner decisions 2026-10-15 and 2026-11-02: `0.8.0` is rc.1, the first release
candidate on `1.0.x`, and the full orchestra: a coordinating agent hands
complete tasks to cooperating agents that write, check and review. New
capability comes before hardening, and each result group is one PR with its
documents (owner 2026-11-02). Work is sized by owner steps, dependencies, CI
and review, not by time. The
[`0.8.0` milestone](https://github.com/oktawianwybieralski/coagent8/milestone/1)
lists every issue; this is their order.

**Delivered on `develop`** ([records](https://github.com/oktawianwybieralski/coagent8/blob/7eec83a/docs/delivered/0.8.0/README.md)): write
delegation, asynchronous by default with `wait` and task records, Claude Code
wake-up, the caller label (Claude Code only) and the first slice of the
server-owned loop; Windows per-call containment, accepted natively on `x64`;
reviews of large changes in parts and checks the server runs before a review;
the shared agent standards, one formatter and the documentation audit of
2026-11-03; parallel workers under one root
([contract](ARCHITECTURE.md#parallel-workers-159-to-162)); delegated coordination
([contract](ARCHITECTURE.md#delegated-coordination-164)).

**Remaining, in order.** Group 3 completes the orchestra; 4 needs the owner in the
clients; 5 is the release-candidate gate. Group 1, parallel workers, is delivered:
the task contract (#159) reconciled with the task records as built, writer ownership
of disjoint scopes (#160), root reservations (#161) and the writer lifecycle (#162).
Group 2, delegated coordination (#164), is delivered too: the gateway is the end of a
read-only turn, and the nested-turn refusal stays.

3. **Profiles and roles:** verified capabilities per backend, version and OS
   (#160), with POSIX parent-death cleanup (#186) and the Windows containment
   (#169) before any write or command profile is claimed; role defaults
   independent of backend (#161), the compatibility inventory (#165), then the
   loop on the accepted profiles (#168). Also open from the loop's first slice:
   agy as a loop writer and a POSIX run.
4. **Wake-up for Codex and agy** (#168 with #113 and #114). Both get
   `wakeup: none` and `wait` today; the tests need an open Codex window and the
   agy hub. Related: #137, #138.
5. **Release-candidate acceptance:** benchmark cases (#166), fresh-client runs
   (#156), the WSL lane (#172, the owner installs WSL2), skill discovery and
   management (#158, #149), Manage Coding CLIs (#150), native acceptance and
   the independent release review bound to the artifact hashes (#148), the
   audit rerun on the candidate (#189) and the Socket scores (#184).

**Owner steps:** #111 (`arm64` machine, SmartScreen), #112 (SignPath), #120
(Dependabot alerts that wait for TypeDoc), #179 (signed-commit ruleset), #177
(Open VSX, namespace `okidev` granted 2026-10-20), #174 (npm trusted publisher
on release day), the tag and publication.

**Open owner decisions before the feature freeze:**

- Plugin acceptance (#151) tests plugins against a published package, so it
  cannot come before rc.1. Proposal: the loader evidence, manifests,
  marketplaces, setup coexistence and the VS Code entry in rc.1, the native
  acceptance against the published `0.8.0` as a condition of `1.0.0`.
- Proposed to defer past rc.1, since the orchestra does not depend on them:
  the seeded fork and configured failover after quota exhaustion (#167, steps
  b and c), multi-file skills (#163), cost estimates (#152, steps e, h and i),
  the MCP adapter over the packaged CLI, the CLI topology measurement and
  readable terminal output (#170, steps g, i and j), the session modes (#188;
  its early handles stay in `0.8.0`), the documentation site (#183) and the
  connectome research (#182). Asynchronous review stays deferred (2026-10-21, #192).
  Issues the plan does not order carry no milestone; #152, #163 and #183 carry
  `1.0.0` because the proposal covers all their open steps.

## Full coagent direction

Delegation delivered a first slice of the profiles and the lifecycle (one
writer per work tree, task records, the server-owned loop); the milestones
remain, in the order of the [0.8.0 plan](#080-plan). Contract designs are
recorded in [ARCHITECTURE.md](ARCHITECTURE.md) (labelled unimplemented) before
implementation issues are opened. Roles do not grant capabilities or imply
model size; any supported provider/model may plan, implement, verify or review,
and independent review must use a separate session from the implementation
author.

| Milestone | Issue | Deliverable and acceptance |
| --- | --- | --- |
| Task contract | #159 | Start/inspect/continue/cancel; stable task/root/parent IDs, role, objective, scope, acceptance, profile, context and optional model/effort. Validated status, actual identity, changes/evidence and usage availability. Test transitions, repeats, truncation and legacy calls. Worker success is not root acceptance. |
| Profiles | #160 | Verify read-only, workspace-write and bounded commands per backend/version/OS. One writer per canonical workspace; baseline dirty files, prevent path escapes/conflicts, preserve partial work. Parallel writers need authorized separate workspaces or verified disjoint ownership. No automatic worktree/reset/cleanup. Native containment/failure tests precede claims. |
| Routing/limits | #161 | Role/task defaults independent of provider/model/effort; explicit choices and opt-in cost/latency/quality/quota preferences. Open question: whether external benchmark scores may inform an opt-in quality preference; they lag new releases, measure models through APIs rather than CLI harnesses, and could enter only as validated numbers, never as text in tool descriptions. Atomic root reservations for calls/concurrency/time/depth shared by children/retries. No silent explicit-model fallback, fabricated monetary cap or self-approved escalation. Reconcile request identity before replaying writers; test contention/lost replies. |
| Lifecycle/evidence | #162 | Minimal durable state/leases independent of transcript archival or a daemon. Early handles, progress, inspect/cancel, recovery; disconnect cancels by default. Detached execution requires verified supervision. Preserve original requirements, bounded context/omissions. Capture checks in the actual candidate with commands/exits/logs; separate observed from reported evidence. Test interruption, stale evidence and root-incomplete results. |
| Skills | #163 | Builds on `SKILLS-001/002` ownership records. Composable coordination/planning/work/verification/review/recovery `SKILL.md` packages; catalog/install/update/uninstall through shared integration logic. Owned manifests/digests, atomic rollback, conflict/path-traversal checks; preserve custom instructions and execute no bundled scripts. Verify discovery/use per advertised client. |
| Delegation | #164 | Delivered as a server-read end of a read-only turn ([contract](ARCHITECTURE.md#delegated-coordination-164)). After host-led execution, add a task-scoped gateway with verified root/parent identity, capabilities and shared limits. Keep nested refusal until accepted. Bound fan-out/depth, reject cycles/replay, propagate cancellation and recover partial launches. Account for or disable unobservable native subagents where limits require it. Test forged delegation/restarts/launch races. |
| Migration | #165 | Update schemas/profiles/security rules/README/skills together before writes. Preserve compatible config, sessions, registrations and legacy read-only calls. Commit/push/merge/deploy/publication need task/user authority; skills cannot grant it. Reuse owners, not a parallel orchestration stack. |
| Acceptance | #166 | Compare direct/host-led/delegated runs on identical starting trees: feature, bug, refactor, docs, investigation, failed-test repair, ambiguous plan, interruption. Cover strong/small, small/strong, peers and one worker. Measure correctness, regressions, time, calls, overhead, repairs and available usage, including failures. Native evidence, exact-package six-job CI and independent boundary review before RC. |

Versioned compact handoffs join the lifecycle and skills milestones: they carry
task/role/profile, branch/target, base/candidate/diff identity, objective,
scope, acceptance, context and `PASS`/`FAIL`/`NOT_RUN` evidence so fresh agents
can operate without prior chat transcripts.

## Release acceptance

Stage names stay; each stage ships as the next minor below 1.0.0, while fix-only
preview updates raise the patch
([REPO-003](https://github.com/oktawianwybieralski/coagent8/blob/a7c6f72/docs/ROADMAP.md#repo-003-one-numeric-version-for-npm-vsix-and-tags)): beta.2 is
`0.6.0` (released), `0.6.1` and `0.7.0` are released, and the following
previews are `0.8.0` (rc.1) and `0.9.0` if needed.

| Stage | Required scope |
| --- | --- |
| BETA-001: beta.2 (0.6.0, released) | Released as `v0.6.0` ([evidence](https://github.com/oktawianwybieralski/coagent8/blob/7eec83a/docs/delivered/0.6.1/README.md#060-release-evidence)): bridge audit blockers (`AUDIT-001-A01` to `A07`), `AX-007a-c`, `WINDOWS-001a`, `SKILLS-001a-d`, and `EXEC-001-T12` package/matrix/independent review and native VS Code checks. No write claim. |
| PATCH-061: 0.6.1 (fix-only preview, released) | `FEEDBACK-060` 0.6.1 fixes, `PUBLIC-001`, `DOCS-002a/b/d`, `LIC-001` MIT relicensing, `SUPPLY-001a-b` packaging fixes, and `PATCH-061-R1..R7`/`N1..N7` release acceptance. |
| BETA-001: beta.3 (0.7.0, released 2026-10-20) | The `0.7.0` rows of the [release split](https://github.com/oktawianwybieralski/coagent8/blob/a7c6f72/docs/ROADMAP.md#070-beta3-plan): public CLI (CLI-FIRST-001a-e, h), FEEDBACK-061, the acceptance runner (ACCEPT-001a/b; WSL 2.18 deferred to `0.8.0` on 2026-10-19), native acceptance of shipped skills and CLI management, the accepted PROPOSALS-001 rule and description items, RELEASE-001 and a native upgrade from the published `0.6.1` (row 5.10). No write claim. |
| RC-001: rc.1 (0.8.0, first on `1.0.x`) | Ordered by the [0.8.0 plan](#080-plan), with its open owner decisions on `PLUGIN-001f` and the deferrals. The `0.8.0` rows of the release split: asynchronous delegation with caller wake-up (DELEGATE-001), host-led COAGENT-001 through 005 and applicable 007 (verified writes/checks/review/skills), WINDOWS-001 containment before write profiles, the delegated/parallel slice, COAGENT-008, PLUGIN-001, DOCS-003, SUPPLY-001c-e, AX acceptance and AUDIT-001-A08 to A21, all complete or explicitly deferred before freeze, unsupported claims removed. |
| rc.2 if needed | Corrections with renewed evidence; never replace a published artifact. |
| 1.0.0 | Accepted audited snapshot, tagged on `1.0.x` through its release PR (rule 02 section 5). |

Every release needs a clean candidate, applicable full package gate, six OS/Node
CI jobs, exact artifact provenance, soak evidence (concurrency/cancel/EOF/crashes,
recovery/leases/histories/memory), and independent approval bound to Base SHA,
Candidate SHA, Tree SHA and Artifact SHA-256. No unresolved P1/P2; content changes
invalidate approval. Procedures belong to the [quality gate](../.agents/rules/14-quality-gate.md)
and [Git workflow](../.agents/rules/12-release-workflow.md).

### Native VS Code acceptance

Record host/CLI versions, candidate/VSIX digest and PASS/FAIL/NOT_RUN per scenario.
Each named operation below is a native acceptance scenario executed in an
isolated VS Code profile, recording pre-state, action, observed post-state and
preservation checks. A failed case produces a separate reproduction/fix card
before rerunning that case.

- Install/update: native restart, one provider, six current tools, no persistent
  restart banner.
- Configuration: custom path with spaces, shared default, editor precedence,
  reset cancellation/one backup, valid settings/schema and live server refresh.
- Onboarding: first-install notice once; Manage Coding CLIs lists state, source
  and registration; dismissing it does nothing; install/sign-in/add/remove/restart
  preserve manual registrations and unrelated servers (#150).
- Execution: quiet consult/review while typing elsewhere; report TIMEOUT/BLOCKED
  honestly. Verify consent in a client that actually displays the form.
- Skills: after Manage Coding CLIs adds CoAgent8 to a CLI's chat it lists the six
  skills and an explicit use reaches CoAgent8 (#158); removing CoAgent8
  from a chat and uninstalling remove only unchanged packages the extension installed. Manage Skills and
  `coagent8 skills` install/update/uninstall/enable/disable one or all packages
  while MCP remains; new chats observe changes, repair preserves choices,
  shared-directory effects and native overrides remain visible (#149).
- Uninstall: cancellation and both confirmations, only owned dependencies offered,
  standalone removal commands await user action. Full quit/restart and separate
  Extensions-view removal. Remove owned registrations/runtime/tagged backups/
  extension storage; preserve shared config/settings/credentials/histories.
- Reinstall: verify first-install behavior and config migration with preserved
  user configuration.

Every client run, including the upgrade from the published `0.6.1` (row 5.10),
follows these rules (FEEDBACK-061h):

- Start each client test in a new chat.
- Confirm the running runtime version first; `doctor` and the `issue` report
  show it.
- Run clients one after another when they edit or inspect the same file.
- After a client closes, check the working tree with `git status` and
  `git diff`; Antigravity once re-applied a temporary edit after its report
  claimed a verified restore.

## Verification shorthand and test groups

Select local checks by change scope using the [quality gate](../.agents/rules/14-quality-gate.md) (the single source of truth). In issues:

- **P** means prose/contract review against source, local link checks and `git diff --check`.
- **R** adds `npm run typecheck`, `npm run check:dependencies` and the listed test groups passed to `node tests/run.cjs <files>`. Source-comment changes also require `npm run lint:docs` and `npm run docs`.

| Group | Existing files under `tests/` |
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
| SETUP | `integrations/setup.test.js`, `integrations/cleanup.test.js`, `integrations/skills.test.js`, `integrations/vscode-extension.test.js`, `package.test.js` |

## Former card identifiers

Commits, PRs and ARCHITECTURE cite cards by identifier. Open cards moved to these issues on 2026-11-05; completed cards
keep their text in [ROADMAP at `a7c6f72`](https://github.com/oktawianwybieralski/coagent8/blob/a7c6f72/docs/ROADMAP.md).

| Former card | Issue |
| --- | --- |
| `ACCEPT-001` | #172 |
| `AUDIT-001` (rerun on the candidate) | #189 |
| `AX-001` | #152 |
| `AX-002` | #153 |
| `AX-003` | #154 |
| `AX-004` | #155 |
| `AX-006` | #156 |
| `AX-007` | #157 |
| `CLI-FIRST-001` | #170 |
| `CLIMGMT-001` | #150 |
| `COAGENT-001` to `COAGENT-008` | #159 to #166 |
| `CUR-011` (POSIX parent-death cleanup) | #186 |
| `CUR-013` (other-tree review) | #187 |
| `DELEGATE-001` (`001a` is #113, `001d` is #114, `001e5` is #192) | #168 |
| `DOCS-003`, `PROPOSALS-001i` | #183 |
| `ENVELOPE-001` | #173 |
| `EXEC-001-T12` | #148 |
| `FAILOVER-001` | #167 |
| `FEEDBACK-070` (observations) | #190 |
| `LIC-001` | #175 |
| `PATCH-061` | #185 |
| `PLUGIN-001` | #151 |
| `PROPOSALS-001a`, `b`, `c`, `e`, `f`, `j`, `m` | #176, #177, #178, #179, #180, #181, #182 |
| `RELEASE-001`, `REPO-002` owner step 9 | #174 |
| `REPO-002f` | #171 |
| `SESSION-001`, `HISTORY-002` | #188 |
| `SKILLS-001` | #158 |
| `SKILLS-002` | #149 |
| `SUPPLY-001` | #184 |
| `WINDOWS-001` (`001d1` is #112, `001e` is #111) | #169 |

## Documentation ownership

ROADMAP and ARCHITECTURE are the active project documents in docs/; GitHub
Issues hold the backlog, and issues and PRs hold current work and evidence.
README and extension README serve users; .agents/rules/ serve contributors.
Update the owning section or issue instead of appending session reports or
parallel plans. Useful investigations may live in ignored docs/.local/;
tracked documents must not depend on them. History stays in Git; the HANDOFF
and the delivery records removed on 2026-11-05 are at [`7eec83a`](https://github.com/oktawianwybieralski/coagent8/blob/7eec83a/docs), and
there is no other archive. Do not add a document that an issue or a PR can
hold.

Deferred unless justified: SQLite/transcript database, persistent daemon,
arbitrary third-party skill registry, private provider hub, binary prompt
encoding and broad UI/TUI expansion. No blanket sandbox opt-out.
