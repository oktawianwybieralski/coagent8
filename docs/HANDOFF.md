# CoAgent8 handoff

Updated 2026-10-09. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities/acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Do not append another session transcript or treat old test counts as fresh evidence.

## Scope and decisions

The owner requested analysis of three agents' arithmetic trials and consolidation
around these three documents. The target is full MCP orchestration: complete tasks,
write/check/fix workflows, independent roles/models and installable client skills.
Current read-only profiles remain enforced until verified replacements land.
AX-001/002 (per-model prices and the price limit) were implemented on
feat/ax-price-selection, branched from docs/coagent-direction at 3a9a4bb.
The current task is SIMPLIFY-001: S0-S6 implemented, with the two S6 enforcement
gaps found in follow-up inspection corrected locally.
Current branch: `refactor/simplify-001`, created from the preserved local stack
at `ac394ad` after the owner authorized changing the branch.
The S6 follow-up is committed at `af9f7d2` after the owner requested a commit.
The next planned work is EXEC-001-T01 through T12 in ROADMAP, covering measured
preparation and the complete call lifecycle alongside AX-004. The tasks remain
unimplemented; each has an owner inspection checkpoint. Prior independent
approval does not approve the S6 follow-up or these future changes.

Preserve the local stack and owner-managed Git integration; no new checkout,
reset, merge, push or publication is part of this handoff. Inspect status again
before editing. Development ultimately targets release/v1.0.0 under the
repository Git rules.

## What the trials establish

| Evidence | Observation | Limit |
| --- | --- | --- |
| Codex, this conversation | doctor summary and full both omitted per-model prices. A separate public price lookup verified gpt-6-luna at USD 0.50 per million output tokens for the base tier; consult with codex/low returned 17 x 23 = 391 in 4.0 s. | Historical unit price, not request billing. Footer excludes preparation. Running server bundle identity was not verified. |
| Claude, owner-provided report | Selected luna/flash by name, reports two successful backend calls at 4.3 s and 12.2 s; noticed missing prices, agy readiness ambiguity and effort syntax. | No raw transcript/usage/phase trace here; not independently rerun. Price compliance was not established by governance. 4.3 s versus 12.2 s is not a controlled speed comparison: the footer excludes preparation and no phase trace attributes the difference to CLI startup. |
| Gemini, owner-provided report | Explicit model hit unanswered elicitation; fallback changed the requested model; first config edit targeted an inactive default path because an older registration set coagent8_CONFIG to VS Code storage. It attributed latency to full diagnostics, but both formats run the same probes. | Reported sequence, not independently rerun. No permission to edit the live config follows from this report. |
| Source inspection at 1353fb9 | DoctorPrices has source/fetchedAt/count only; both formats call runDoctor. Price parsing stores completion unit rates only. Governance checks approval thresholds, not a user ceiling. Config path can be overridden. | Static confirmation, not new behavioral/native acceptance. |

The successful Codex result still had excess discovery and repository-reading
overhead. Ordinary users should not need a source checkout, web price lookup or
full diagnostic dump. Claude could not use a public estimate that does not exist;
choosing by name and treating consent as cost compliance was the agent's mistake.
The product fix is executable selection metadata and constraints.

Source anchors:
- src/diagnostics/doctor.ts: DoctorPrices, runDoctor, formatDoctorSummary.
- src/tools/doctor.tool.ts: shared diagnostic work for summary/full.
- src/backends/prices.ts and governance.ts: unit-price storage and consent.
- src/tools/schema.ts and src/server.ts: caller-visible selection instructions.
- src/config.ts, config-overrides.ts and extensions/vscode/src/extension.ts:
  effective config and latest shared-default behavior.

## Next implementation

The next authorized work boundary is owner inspection of
[SIMPLIFY-001 S5](#simplify-001-s5-implementation). On continuation, execute S6 in the
[roadmap's order](ROADMAP.md#execution-checkpoints), with its boundary enforcement and
scope-based checks, then stop again. S1, S2, S3, S4, and S5 modules are implemented and verified;
automated dependency enforcement remains scheduled for S6.
Recheck the current checkout rather than assuming that the baseline below is still current.
The migration does not change the release status or make historical runtime evidence fresh.

AX-001/002 landed locally (contract in
[ARCHITECTURE.md](ARCHITECTURE.md#price-limit)): output_price_below with strict,
consent-independent checks before consent and before session acquisition;
PRICE_LIMIT without substitution; auto choosing the qualifying default or the
highest-priced qualifying model. Owner decisions of 2026-10-08 set that rule and
the 5,500/3,900-byte budgets.

Stage 1 of the model registry followed the same day, verified first against the
installed CLIs without model turns (Claude Code 2.1.294 initialize lists 13 names
with concrete models; Codex model/list and account/rateLimits/read; agy 1.3.1
models lists Claude and GPT-OSS models too, so provider prefixes cannot route):
Claude catalog with aliases; model-based auto routing; Codex quota; per-model
stored prices (input, cached input, output) refreshed daily in the background;
doctor's cached model view as default and scope health; consent refusals that
do not advise another model.

Open: stage 2 measured usage per turn (tokens, list-price cost, subscription
window change for all three backends) and stage 3 pre-turn estimates and a
predictable plain consult (AX-001/002); concurrent root budgets (AX-002); the
fresh-client retest (AX-006).

Remaining AX work: independent review of the feat/ax-price-selection work, then
AX-003/004/005/006 for approval transport, effective config, readiness and
fresh-client acceptance. Keep consent
fail-closed and never insert a model into neverAsk. Design COAGENT-001/002
alongside, then one verified host-led write/check/review path before delegated
coordinators, preserving the roadmap's root-budget, writer, interruption and
evidence criteria.

Open runtime limitations and the CUR items with local fixes are listed in
[ARCHITECTURE.md](ARCHITECTURE.md#known-limitations); do not reimplement fixed
items from an old snapshot report. Revalidate the candidate before claiming acceptance.

## SIMPLIFY-001 S0 baseline

Captured 2026-10-08 before documentation edits, on Windows, Node v26.10.0,
npm 11.19.1. Scope: static baseline and sequential implementation checkpoints.
No source migration, Git integration, live configuration edit or model turn.

### Checkout and evidence identity

- Initial inventory branch: `feat/ax-price-selection`.
- Working branch: `refactor/simplify-001`, created at the same HEAD after the
  owner authorized branch separation during S0. The two documentation edits
  were preserved across `git switch -c refactor/simplify-001`.
- HEAD: `ac394adf3ae31181f88a210d07c1d5a1d4e0fdde`.
- Tree: `e2ad8e735630336c4721428207bf978519e13d8c`.
- Local `release/v1.0.0` and merge base:
  `ae55f017fdc7f54776549b94ea5d2e9833601894`.
- `git rev-list --left-right --count release/v1.0.0...HEAD`: `0 199`.
  This is the existing local stack, not a newly integrated release branch.
  The owner authorized preserving this stack as the topic branch's starting
  point. Integration into release/v1.0.0 remains owner-managed; this branch
  operation is not evidence of an up-to-date release base or merge readiness.
- Initial and pre-edit `git status --short --branch`: clean on the initial branch.
  `git worktree list --porcelain`: one worktree. The collaboration roster showed
  only this agent. These observations cannot exclude an external editor/process;
  re-read touched files before every edit. No stash/reset/rebase/new checkout.

Optional ignored evidence is under `.artifacts/simplify-001/`:
`inventory.cjs`, `baseline-graph.json`, `baseline-state.json`, `references.txt`
and `legacy-table.md`. These are inspection artifacts, not another active plan.
The required debt decisions and findings are recorded here. Reproduce the graph
on the recorded source with `node .artifacts/simplify-001/inventory.cjs` while
that local script is available; S6 must supply maintained graph enforcement.

Graph SHA-256:
`3dc8703cc840437cf3a38f01326836b1c4e1fa91d8b70c22525b7d066425bc8f`.
Inventory script SHA-256:
`16024718bb163fefaa06c866f6a125fa51f4c868282a19b086f599266665a4c6`.

### Actual graph and cycles

The inventory parses all 158 tracked TS/JS/CJS/MJS files, including 77 source
modules and the extension/tests/tooling. It resolves relative `.js` imports to
their `.ts` source, records bindings/line numbers and distinguishes imports,
explicit type imports, import type queries, dynamic calls and re-exports.
All parsed files had zero parser errors; no literal relative import was
unresolved. This does not validate computed paths or packaged files.

Source has 410 dependency declarations: 352 ordinary imports, 56 explicit
type imports, one type query and one re-export. There are 329 internal source
edges. Symbol-aware TypeScript 6.0.3 emit from the already-installed documentation
tooling, captured only in memory, identifies 272 runtime edges and 57 erased
type edges. Two ordinary declarations are erased despite lacking `import type`:
`backends/availability.ts:5 -> backends/types.ts` and
`sessions/session.ts:5 -> sessions/types.ts`. This is static classification,
not a fresh TypeScript 7.0.2 gate, bundle build or runtime observation.

| Graph | Exact cycle edges (paths relative to src/) | Removal owner |
| --- | --- | --- |
| Runtime | `sessions/session.ts:10 -> sessions/history.ts`; `sessions/history.ts:37 -> sessions/session.ts` | S4: narrow activity/lease contract; preserve lock order and eviction protection |
| Types plus runtime | Above runtime cycle plus `sessions/history.ts:27 -> sessions/history-page.ts`; `sessions/history-page.ts:2 -> sessions/history.ts` (History type) | S4: history-owned snapshot contract; no page/reader cycle |
| Types plus runtime | `integrations/setup.ts:29 -> integrations/cli-readiness.ts`; `integrations/cli-readiness.ts:7 -> integrations/setup.ts` (SetupClient type) | S5: import the existing setup-clients owner directly |

One source re-export exists: `integrations/setup.ts:27 -> setup-clients.ts`
exports SETUP_CLIENTS and the SetupClient type. Its consumer surface must be
classified before removing any forwarding path. No literal runtime dynamic
import exists under src/. The type query at `index.ts:12 -> integrations/setup-cli.ts`
does not eagerly load setup; the adjacent computed runtime require deliberately
loads sibling `setup.cjs` only for setup/repair/status/cleanup/help dispatch.

Three further computed calls were inspected separately: the gated maintenance
fixture resolves `src/stdio-server.ts`; two VS Code fixture VM callbacks use
`require(name)` to supply mocked vscode or native dependencies. The reference
sweep covers launch arguments, esbuild fixture interceptors and embedded code
strings that a literal import graph cannot treat as ordinary source edges.

### Exact migration debt and caller ownership

Paths below are relative to src/ unless prefixed with extensions/. These rows
record exact existing edges/callers, not directory-wide dependency exemptions.
Allowed adapter/application consumption of a mechanism also needs updating
when its current mixed owner splits. All source/test/fixture callers must be
updated in the slice that changes their dependency, not deferred to S5.

| Slice | Current target | Exact consumers | Required ownership change |
| --- | --- | --- | --- |
| S1 | `sessions/lock.ts` | `extensions/vscode/src/configuration.ts:5`, `backends/availability.ts:7`, `backends/model-store.ts:20`, `config.ts:7`, `integrations/cleanup.ts:12`, `integrations/setup.ts:22`, `sessions/history.ts:30`, `sessions/session.ts:7` | File locking and atomic writes belong to storage |
| S1 | `execution/stream.ts` | `extensions/vscode/src/configuration.ts:4`, `backends/availability.ts:10`, `backends/codex/adapter.ts:14`, `backends/model-store.ts:19`, `backends/prices.ts:22`, `config.ts:6`, `execution/cli-resolver.ts:4`, `execution/git.ts:4`, `integrations/setup-storage.ts:10`, `integrations/setup.ts:15`, `integrations/vscode-profile.ts:4`, `sessions/history.ts:34`, `sessions/lock.ts:25`, `sessions/session.ts:9` | Bounded file reads belong to storage; split mixed imports |
| S1 | `execution/stream.ts` | `backends/agy/collector.ts:2`, `backends/claude/collector.ts:2`, `backends/codex/collector.ts:2`, `diagnostics/issue.ts:21`, `execution/controller.ts:48`, `execution/git.ts:4`, `execution/process.ts:31`, `execution/stream-reducer.ts:2`, `integrations/rpc.ts:8`, `redaction.ts:2`, `sessions/history.ts:34` | Byte/line primitives belong to execution/runtime; shared errors must retain identity without loading application policy |
| S1 | `sessions/identity.ts` | `server.ts:27`, `sessions/history.ts:32`, `sessions/session.ts:11` | canonicalPath belongs to workspace; sanitizeHandle stays with sessions |
| S1 | `backends/model-identifier.ts`; `backends/governance.ts` | `config.ts:8` (runtime syntax validator); `config.ts:9` (GovernanceSettings type) | Independent syntax/settings contracts prevent config/models reverse dependency during S3 |
| S2 | `tools/result.ts`; `tools/review-gate.ts` | `execution/controller.ts:51` (formatter); `execution/controller.ts:55` (ReviewGateContext type) | Neutral execution result; review-owned contract, transport-owned formatting |
| S2 | `execution/git.ts`; `tools/review-gate.ts` | `tools/review-input.ts:3,4`; `tools/review.tool.ts:5` (Git); `tools/result.ts:17` (gate) | Review policy/input belongs to review; Git evidence belongs to workspace; handlers format the outcome |
| S2 | `diagnostics/issue.ts` | `tools/result.ts:15`, reached transitively by controller | Keep diagnostic presentation at transport edge; do not import it back into execution |
| S3 | `backends/registry.ts`; `backends/probe-cache.ts` | `backends/model-selection.ts:18,19` | Keep pure policy in models; move native observation/selection orchestration to application |
| S3 | `backends/model-selection.ts` | `backends/consent.ts:11`; `diagnostics/doctor.ts:5`; `execution/controller.ts:39` | Shared pure policy plus application consent sequencing; update doctor in S3 |
| S3 | `backends/consent.ts` | `execution/controller.ts:43` | Split governance decisions from default observation, price reads and sequencing |
| S3 | `backends/registry.ts`, `backends/probe-cache.ts`, `config.ts`, `backends/availability.ts` | `backends/routing.ts:1,2,3,4`; controller calls routing at `execution/controller.ts:36` | Application owns routing composition; native probes/quota/cache remain backend-owned |
| S4 | `sessions/history.ts` | `sessions/session.ts:10`; `sessions/history-page.ts:2` | Remove both recorded cycles; split reader/recovery, writer and retention/capacity without duplicate state |
| S4 | `sessions/session.ts` | `sessions/history.ts:37` | Activity/lease evidence contract instead of session-service dependency |
| S4 | `sessions/history.ts` internal credential boundary logic | computeSafeCommitPoint and its writer use | Move safe credential fragments together with redaction to security; preserve persisted/public bytes |
| S5 | `integrations/setup.ts` | `integrations/cli-readiness.ts:7` (type) | Use setup-clients.ts; remove the recorded type cycle |
| S5 | Existing physical paths and setup re-export | Extension/source-test/build/reference inventory below | Finish consumers and genuine mixed responsibilities; remove stale internal aliases, preserve public paths |
| S6 | Missing dependency enforcement | `package.json` scripts and `.github/workflows/ci.yml` have no boundary check | Enforce actual runtime/type/dynamic/re-export graph and isolated negative fixtures; no directory exclusions |

Shared conversation/provider/error/event and adapter/catalog/quota contracts
currently live in conversation.ts and backends/types.ts; split cohesive shared
contracts in S1, keeping adapter-local types with backends. paths.ts currently
mixes data-directory resolution and workspace choice; split those in S1.
constants.ts mixes branding and MCP tool names; separate the tool constants
with MCP in S2. Generated SDK Icon typing remains a transport asset, not a
shared domain contract. These are ownership splits, not moves of whole files
under misleading directory names.

### Entrypoints, consumers and generated references

- Package main and both bin names resolve to `dist/index.cjs`; `index.js` is
  the compatibility wrapper. mcp.json loads `${PLUGIN_ROOT}/dist/index.cjs`.
  package.json ships src/, dist/, selected branding assets and plugin manifests.
- scripts/build.cjs has separate `src/index.ts -> dist/index.cjs` and
  `src/integrations/setup-cli.ts -> dist/setup.cjs` entries, source maps and
  THIRD_PARTY_NOTICES.txt. Preserve the sibling bundle's lazy runtime require
  and constants.ts's relative package.json lookup when changing depth.
- scripts/branding.cjs generates src/generated/server-icon.ts from the two
  64x64 PNG assets and copies the two 256x256 images. server.ts consumes the
  generated icons; build regeneration must agree with tracked generated source.
- scripts/build-vscode.cjs bundles extension.ts and uninstall.ts and copies the
  exact server/setup runtime set. package-artifacts.cjs obtains runtimes from an
  npm tarball; tooling/vscode/package.cjs consumes that staged package. Preserve
  extension main/uninstall entrypoints and artifact provenance.
- 59 test files are discovered through the existing discovery helper; no test
  was executed by counting them. There are 232 literal source import edges
  from 59 non-src code files, including 13 extension-to-source edges. The full
  graph identifies their exact files/lines; the reference sweep has 299 lines.
- Extension configuration imports stream/lock; extension.ts imports setup,
  cleanup, redaction, config, vscode-profile, cli-resolver, config-overrides and
  setup-storage; uninstall.ts imports cleanup, setup-storage and redaction.
  vscode-profile.ts has no incoming src/ import but has extension/test callers;
  it is not an orphan. index.ts is the deliberate root entrypoint.
- MCP e2e launches src/index.ts through tsx; the gated fixture launches
  src/stdio-server.ts. Setup tests and package tests inspect existing dist/.
  Consumer smoke imports the source CLI resolver, installs a tarball and compares
  shipped bundles to a fresh source build. VS Code tests bundle extension source
  and intercept old source paths in fixture plugins. Update those paths in their
  owning slice and build before tests that require current dist/ evidence.
- Typecheck covers src/ and extension source; TypeDoc expands ../../src.
  CI has six OS/Node jobs with typecheck, docs lint, build, coverage, package
  inspection and consumer smoke; documentation generation and VSIX packaging
  are scoped within that matrix. S6 must add enforcement without bypassing gates.

Existing ignored bundles were hashed, not rebuilt or accepted as current source:
index.cjs SHA-256
`57a0014ad5d7fabe7050781bce2573e3abcb48e543fcd6f5ad0c0e7ec75e0e7c`;
setup.cjs SHA-256
`4dc9c940f923f3f20ce77c27ad53a85975879e72397d4e76b6533e302c1fe8db`.
baseline-state.json records their sizes and the license-notice hash.

### S0 checks and acceptance limits

PASS: checkout/status/worktree observations; AST import inventory and explicit
computed-call inspection; cycle/caller/build/reference review; existing test
discovery enumeration; changed Markdown content/local links/anchors/ASCII review
and `git diff --check`. Source hashes are captured in the graph to detect drift.

NOT_RUN: runtime typecheck, tests, build, docs tooling, package/consumer/VSIX
checks, backend calls, independent review and remote/native acceptance. S0 changes
only plan/evidence prose; these gates belong to the affected migration slices.
No fresh runtime failure or pass is established. The unexplained historical
cross-process lock-test failure below remains a baseline risk; if it recurs,
retain the failure log and investigate rather than relabel a retry as a fix.
The three recorded import cycles precede migration and are existing debt.

## SIMPLIFY-001 S1 implementation

Captured 2026-10-08 after S1 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/contracts/`: Cohesive contracts created for `provider.ts`, `error.ts`, `conversation.ts`, `execution.ts`, `models.ts` (including `isValidModelIdentifier`), `quota.ts`, and `governance.ts` (`GovernanceSettings`, `ConsentBasis`). `src/conversation.ts` and `src/backends/types.ts` forward shared contracts.
- `src/storage/`: Atomic file locking (`storage/lock.ts`: `withFileLock`, `atomicWrite`, `LockTimeoutError`, `inProcessLocks`) and bounded file reads (`storage/read.ts`: `readBoundedFile`, `readBoundedFileSync`). `sessions/lock.ts` forwards to `storage/lock.js`.
- `src/execution/runtime/`: Byte/line decoding primitives extracted to `execution/runtime/stream.ts` (`truncateToByteLength`, `createLineDecoder`, `BufferLimitError`). `execution/stream.ts` forwards to runtime and storage. Runtime has zero imports of `controller.ts`.
- `src/workspace/`: Canonical workspace identity moved to `workspace/identity.ts` (`canonicalPath`), and workspace resolution to `workspace/workspace.ts` (`chooseWorkspace`, `resolveWorkspacePath`, `WorkspaceSource`, `ResolvedWorkspace`). `sessions/identity.ts` retains `sanitizeHandle` and forwards `canonicalPath`. `paths.ts` isolates `getDataDir` and forwards workspace resolution.
- Consumer updates: `config.ts`, `availability.ts`, `model-store.ts`, `prices.ts`, `codex/adapter.ts`, `git.ts`, `cli-resolver.ts`, `setup.ts`, `cleanup.ts`, `setup-storage.ts`, `vscode-profile.ts`, `server.ts`, `result.ts`, `session.tool.ts`, and `extensions/vscode/src/configuration.ts` all updated to consume `storage/`, `workspace/`, `contracts/`, and `execution/runtime/`.
- No consumer in config, model stores, or integrations depends on session implementation or application execution for file operations.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s1.test.js` (4/4 tests pass).
- PASS: `node tests/run.cjs` (392 tests: 389 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S1 completed and reviewed with VERDICT: READY (b4f05f3).

## SIMPLIFY-001 S2 implementation

Captured 2026-10-08 after S2 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/workspace/git.ts`: Git evidence extraction (`collectGitScope`, `snapshotId`, `assertReviewWorkspace`). `src/execution/git.ts` forwards to it.
- `src/review/`: Dedicated review input and verdict policy module (`review/gate.ts`: `evaluateStateEnvelopeGate` (server verdict and causes; the reviewer text is never rewritten), `StateEnvelopeEvaluation`, `ReviewGateContext`; `review/input.ts`: `collectReviewInput`, `proseOnly`; `review/index.ts`). `src/tools/review-gate.ts` and `src/tools/review-input.ts` forward to it.
- `src/contracts/execution.ts`: `TaskExecutionResult` and `ExecutionMeta` defined as neutral contracts with zero transport/Markdown dependencies.
- `src/execution/controller.ts`: `executeTask` neutralised to return pure `TaskExecutionResult` (no `content` array, no Markdown wrapping, no MCP SDK imports). Stripping ANSI moved to `cli-output.ts`.
- `src/mcp/`: Transport layer isolated under `src/mcp/`:
  - `mcp/server.ts`, `mcp/stdio-server.ts`, `mcp/result.ts` (`formatExecutionResult`, `withWorkspace`, `ExecutionToolResult`), `mcp/progress.ts` (`createProgressReporter`), `mcp/schema.ts`, `mcp/constants.ts`, `mcp/arguments.ts`, `mcp/index.ts`.
  - Transport tool handlers moved to `src/mcp/tools/` (`consult.tool.ts`, `review.tool.ts`, `doctor.tool.ts`, `session.tool.ts`, `issue.tool.ts`, `legacy.ts`, `run.tool.ts`).
  - Compatibility shims maintained at `src/server.ts`, `src/stdio-server.ts`, `src/constants.ts`, and `src/tools/*`.
  - `src/index.ts` simplified to dispatch only (`./mcp/stdio-server.js`).
- `src/brand.ts`: Leaf branding module extracted to prevent reverse runtime dependencies from backends and diagnostics into `mcp/constants.js` via `constants.js`.
- Clean architectural boundaries verified: zero runtime or type imports from `mcp/` or `@modelcontextprotocol/sdk` inside `src/execution/` or `src/review/`. Also verified zero `constants.js` or `mcp/` imports inside `src/backends/` and `src/diagnostics/`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s2.test.js` (3/3 tests pass).
- PASS: `node tests/run.cjs` (395 tests: 392 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S2 completed and reviewed with VERDICT: READY.

## SIMPLIFY-001 S3 implementation

Captured 2026-10-09 after S3 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/models/`: Dedicated model domain modules extracted with zero dependencies on `backends/`, `execution/`, or `mcp/`:
  - `models/catalog.ts`: Pure catalog rules (`findCatalogEntry`, `describeModels`, `lookupName`, `checkModelSelection`).
  - `models/identifier.ts`: Model identifier syntax validation (`isValidModelIdentifier`).
  - `models/store.ts`: Pure disk store for `models.json` (`readObservedModels`, `recordObservedModels`, `readStoredPrices`, `recordPrices`, `readObservedModelNames`).
  - `models/prices.ts`: Price evidence, fetching, matching, and limit checks (`readPrices`, `checkPriceLimit`, `priceEvidence`, `findPrice`, `isPriceListStale`, `matchPrices`, `parsePriceList`, `refreshPrices`, `settlePriceReads`).
  - `models/governance.ts`: Pure consent rules (`decideConsent`, `consentRequiredMessage`, `consentDeclinedMessage`, `consentUnansweredMessage`).
  - `models/selection.ts`: Pure selection policy decisions (`catalogDefault`, `catalogNames`, `choosePricedModel`, `listModelCandidates`, types `ModelCandidate`, `ModelSelection`, `ModelSource`, `PriceConstraint`).
  - `models/index.ts`: Public barrel exports for `models/`.
- `src/execution/`: Application operations extracted:
  - `execution/selection.ts`: Native observation and effective model selection orchestration (`selectModel`), composing pure policy from `models/` with native probes from `backends/probe-cache.js`, `backends/registry.js`, and `config.js`. Shared by both execution and diagnostics (`doctor.ts`).
  - `execution/consent.ts`: User consent sequencing (`consentFor`).
  - `execution/routing.ts`: Provider routing composition moved from `backends/routing.ts` (`resolveBackend`, `resolveBackendForModel`, `providerForClient`, `setCallerProvider`).
- `src/backends/`: Compatibility forwarding shims maintained at `src/backends/model-catalog.ts`, `src/backends/model-identifier.ts`, `src/backends/model-store.ts`, `src/backends/prices.ts`, `src/backends/governance.ts`, `src/backends/model-selection.ts`, `src/backends/consent.ts`, and `src/backends/routing.ts`.
- Consumer updates: `src/execution/controller.ts`, `src/diagnostics/doctor.ts`, `src/backends/probe-cache.ts`, `src/mcp/server.ts`, `src/mcp/stdio-server.ts`, and `src/mcp/result.ts` updated to consume canonical modules from `models/` and `execution/`.
- Architectural boundary invariants verified: `models/` has 0 dependencies on `backends/` or `execution/`; `backends/` has zero dependencies on application routing or selection orchestration.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s3.test.js` (5/5 tests pass).
- PASS: S3 scoped test suite: 57/57 tests pass (`tests/simplify-s3.test.js`, `tests/backends/model-catalog.test.js`, `tests/backends/model-identifier.test.js`, `tests/backends/model-selection.test.js`, `tests/backends/price-limit.test.js`, `tests/backends/governance.test.js`, `tests/backends/routing.test.js`, `tests/backends/probe-cache.test.js`, `tests/execution/model-routing.test.js`, `tests/execution/price-limit.test.js`, `tests/diagnostics/doctor.test.js`).
- PASS: `node tests/run.cjs` full test suite (406 tests: 403 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: stop after S3 for owner inspection and independent review (codex sol-6.1). Do not proceed to S4 without owner instruction.

## SIMPLIFY-001 S4 implementation

Captured 2026-10-09 after S4 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/security/`: Dedicated security and redaction boundaries extracted:
  - `security/redaction.ts`: Automated secret redaction for credentials, tokens, and sensitive diagnostics (`redactCredentialFormats`, `redactSecrets`, `redactDiagnostic`).
  - `security/boundaries.ts`: Safe credential stream fragment commit calculation (`computeSafeCommitPoint`, `isPotentialSecretPrefix`).
  - `security/index.ts`: Barrel exports for `security/`.
  - Compatibility forwarding shim maintained at `src/redaction.ts`.
- `src/sessions/activity.ts`: Narrow activity and process liveness inspection (`isProcessAlive`, `getSessionsDir`, `getSessionFilePath`, `isSessionActive`, type `SessionActivityChecker`).
- `src/contracts/session.ts`: Narrow `SessionActivityChecker` contract defined in `contracts/`.
- `src/sessions/history/`: History split into cohesive single-responsibility modules:
  - `history/types.ts`: History snapshot types (`History`, `CachedHistorySnapshot`), limits (`SESSION_LIMIT`, `TOTAL_LIMIT`), path resolvers, and event validation (`validateEvent`, `sanitize`, `cloneEvent`, `cloneHistory`).
  - `history/page.ts`: Pure pagination of validated history snapshots (`paginateHistory`, `PAGE_LIMIT`).
  - `history/retention.ts`: Directory capacity accounting, eviction, and pruning (`pruneHistoryDirectory`, `evictOldestSessions`, `reserveCapacity`, `releaseCapacity`, `sessionMayBeActive`, `setSessionActivityChecker`, `adjustCapacityMeta`). Connects to `isSessionActive` via narrow activity contract.
  - `history/reader.ts`: History snapshot reading, cache management (`clearHistoryCache`, `invalidateHistoryCache`), and crash recovery (`load`, `getHistory`, `sessionHistory`, `deleteHistory`, `getTurnMapping`).
  - `history/writer.ts`: Append-only history writing, streaming delta coalescing, torn-tail truncation, and atomic JSON snapshots (`createHistoryWriter`).
  - `history/index.ts`: Unified barrel exports for `history/`.
- Compatibility forwarding shims maintained at `src/sessions/history.ts` and `src/sessions/history-page.ts`.
- `src/sessions/session.ts` updated to import `getSessionsDir`, `isProcessAlive`, `getSessionFilePath` from `./activity.js`, and history pruning/cache invalidation from `./history/index.js`.
- Architectural boundary invariants & cycle removals verified:
  - Runtime cycle `sessions/session.ts <-> sessions/history.ts` completely eliminated: `history/` has zero dependencies on `session.ts`.
  - Type cycle `sessions/history.ts <-> sessions/history-page.ts` completely eliminated: `page.ts` depends only on `types.ts`.
  - `security/` has zero dependencies on `sessions/`, `backends/`, `mcp/`, or `controller`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s4.test.js` (7/7 tests pass).
- PASS: S4 scoped test suite: 48/48 tests pass (`tests/sessions/history.test.js`, `tests/sessions/history-capacity.test.js`, `tests/sessions/session.test.js`, `tests/redaction.test.js`, `tests/execution/controller-history.test.js`).
- PASS: `node tests/run.cjs` full test suite (413 tests: 410 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S5 complete, stop for owner inspection and independent review (codex sol-6.1). Do not proceed to S6 without owner instruction.

## SIMPLIFY-001 S5 implementation

Executed on 2026-10-09, Windows 11, Node v26.10.0, npm 11.19.1. Scope: finishing
consumers, physical layout, retiring internal shims, test layout mirroring, and eliminating
type cycles without changing public contracts or data formats.

### Structural changes and boundary cleanup:
- Retired and removed all 28 stale internal forwarding files and the `src/tools/` directory:
  - `src/conversation.ts` (replaced by canonical imports from `src/contracts/`)
  - `src/redaction.ts` (replaced by canonical imports from `src/security/`)
  - `src/server.ts` and `src/stdio-server.ts` (replaced by canonical imports from `src/mcp/`)
  - `src/backends/` forwarding shims: `consent.ts`, `governance.ts`, `model-catalog.ts`, `model-identifier.ts`, `model-selection.ts`, `model-store.ts`, `prices.ts`, `routing.ts`
  - `src/execution/` forwarding shims: `git.ts` (workspace), `stream.ts` (runtime/stream & storage/read)
  - `src/sessions/` forwarding shims: `history.ts`, `history-page.ts`, `lock.ts`
  - `src/tools/` shims: `arguments.ts`, `consult.tool.ts`, `doctor.tool.ts`, `issue.tool.ts`, `legacy.ts`, `result.ts`, `review-gate.ts`, `review-input.ts`, `review.tool.ts`, `run.tool.ts`, `schema.ts`, `session.tool.ts`
- Eliminated recorded type cycle:
  - `src/integrations/cli-readiness.ts` now imports `SetupClient` directly from `./setup-clients.js` instead of `./setup.js`.
- Mirrored source owners in unit test layout:
  - `tests/models/`: `governance.test.js`, `catalog.test.js`, `identifier.test.js`, `literals.test.js`, `selection.test.js`, `prices.test.js`.
  - `tests/review/`: `gate.test.js`.
  - `tests/security/`: `redaction.test.js`.
  - `tests/storage/`: `lock.test.js`.
  - `tests/workspace/`: `git.test.js`, `git-fixture.test.js`, `workspace.test.js`.
  - `tests/mcp/`: `server.test.js`, `result.test.js`, `surface.test.js`, `tools/issue.test.js`, `tools/review.test.js`, `tools/session.test.js`.
  - `tests/execution/`: `routing.test.js` moved alongside execution tests.
  - Retired `tests/tools/` directory.
- Preserved distinct test purposes:
  - `tests/e2e/`, `tests/consumer/`, `tests/helpers/`, `tests/fixtures/`.
- Updated all consumer imports across `src/`, `extensions/vscode/src/`, and `tests/` to canonical owning modules.
- Preserved genuinely public compatibility paths:
  - `index.js` compatibility wrapper (delegates to `dist/index.cjs`).
  - `package.json` main (`dist/index.cjs`) and bin (`coagent8`, `coagent8-mcp`).

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run build` (tsdown build completes cleanly in ~2.7 s).
- PASS: `node tests/run.cjs tests/simplify-s5.test.js` (5/5 tests pass).
- PASS: `npm test` (`node tests/run.cjs` full test suite: 418 tests: 415 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc generates `.artifacts/api-docs` with 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S5 complete; proceed to S6 under owner direction.

## SIMPLIFY-001 S6 implementation

Executed on 2026-10-09, Windows 11, Node v26.10.0, npm 11.19.1. Scope: automated
dependency boundary and cycle enforcement, test fixtures for forbidden edges/cycles,
wiring into local and CI verification, and updating architecture documentation.

### Structural changes and boundary enforcement:
- Added `scripts/check-dependencies.cjs`:
  - Parses real module graph using TypeScript AST (`import`, `export`, `dynamic-import`, `require`, `type-query`, `import-equals`).
  - Distinguishes runtime vs type-only elided edges via in-memory compiler emit.
  - Implements Tarjan's Strongly Connected Components (SCC) algorithm to detect both runtime and type-level dependency cycles.
  - Enforces architectural boundary rules across all 15 target owners with zero legacy exemptions allowed (`allowedLegacyEdges: []`).
  - Reports unresolved relative imports, parse errors, cycles, and boundary violations with clear rule rationale and source line numbers.
- Cleaned remaining indirect backend type import in `src/mcp/result.ts`:
  - `TerminalExecutionResult` now imported directly from `../contracts/execution.js` instead of `../backends/types.js`.
- Wired into tooling and verification workflows:
  - Added `"check:dependencies": "node scripts/check-dependencies.cjs"` script to `package.json`.
  - Added `Verify dependency boundaries` step to `.github/workflows/ci.yml`.
  - Added `check:dependencies` to required local evidence in `.agents/rules/04-quality-gate.md`.
  - Updated `docs/ARCHITECTURE.md` dependency boundaries section to reflect realized ownership.
  - Updated `docs/ROADMAP.md` marking S6 complete.
- Added comprehensive test suite `tests/simplify-s6.test.js`:
  - Verifies that the real repository passes with 0 violations, 0 cycles, and 0 unresolved imports across 103 source files.
  - Verifies accurate owner mapping for all layers.
  - Uses isolated test fixtures to prove detection of forbidden edges (models -> backends, execution -> mcp, contracts -> storage).
  - Uses isolated test fixtures to prove detection of runtime cycles and type-only cycles.
  - Uses isolated test fixtures to prove detection of unresolved relative imports.
  - Proves legacy exemption tracking accepts individually specified edges with removal stages and rejects unrecorded edges.
  - Proves untracked source files are discovered and their forbidden edges/cycles flagged.
  - Proves unallowed computed require/import calls in source modules are rejected.
  - Proves runtime dependencies and cycles are accurately classified under ESM compiler options.
  - Proves arbitrary computed targets in src/index.ts mentioning setup.cjs are rejected unless matching the fixed AST path.join(__dirname, 'setup.cjs').
  - Proves discovery includes .mts and .cts modules and detects their forbidden edges and cycles.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (103 source files analyzed, 508 total edges, 344 runtime internal edges, 72 type-only internal edges, 1 computed call (0 violations), 0 legacy exemptions, 0 violations, 0 cycles, exit code 0).
- PASS: `node tests/run.cjs tests/simplify-s6.test.js` (12/12 tests pass, duration 14.0 s).
- PASS: `npm run build` (tsdown build completes cleanly in 419 ms).
- PASS: `npm test` (`node tests/run.cjs` full test suite: 425 tests: 422 pass, 0 fail, 3 skipped, duration 107.8 s, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc generates `.artifacts/api-docs` with 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

The original S6 implementation has a recorded independent review (codex
sol-6.1, VERDICT: READY). That historical verdict does not approve later changes.

### S6 enforcement follow-up (2026-10-09)

Base: f97ffeb6e552752cfc2d0fa9e16238e927c115b4 on refactor/simplify-001.
The owner requested fixes for two reproduced false passes: an external MCP SDK
import in contracts, and contracts -> constants.ts -> mcp/constants.ts.

- External imports now keep their identity for MCP/editor SDK ownership checks
  across all supported declaration forms. Node imports remain permitted.
- Indirect transport, SDK, editor and optional setup dependencies are checked
  across runtime and type edges; violations report the full dependency path.
- Unassigned modules no longer receive root composition privileges. Removed
  src/constants.ts and updated its remaining test consumer to mcp/constants.ts.
  The generated server icon remains an explicitly owned MCP asset.
- Discovery excludes deleted tracked files from the analyzed source count.
- Four new regression tests failed before the fix. After the fix, the scoped
  S6/S5/S2/MCP surface suite passed 39/39, with no skips (19.3 s).
- PASS: typecheck; check:dependencies (102 modules, 506 edges, 342 runtime
  internal edges, 72 type-only internal edges; no violations/cycles/exemptions);
  build; lint:docs; docs; npm pack --dry-run (123 packaged files).

- PASS: consumer smoke on Windows/Node v26.10.0, using a newly packed tarball
  (123 files), SHA-256
  266aad67bcf29c2fdbe85cbb534a360db823c82801f4d79edb2e33707c996462.
  Installed bin aliases, bundled SDK isolation, setup dispatch, fixture MCP
  turns/history and EOF passed. This is fixture evidence, not native CLI acceptance.
- PASS: final diff/content/local-link review and git diff --check.

Implementation commit: `af9f7d2`. Next action: independent review of this
follow-up before Git integration, then EXEC-001-T01 baseline under the detailed
[ROADMAP tasks](ROADMAP.md#exec-001---measured-preparation-and-complete-call-lifecycle).
No new independent approval, remote CI or native-client acceptance is established.
The subsequent plan edit requires content/local-link review and git diff --check;
it does not change runtime behavior or require repeating the preceding tests.

## Documentation disposition

Tracked project documentation is ROADMAP, ARCHITECTURE and HANDOFF. Runtime
contract and useful design material were consolidated; old plans, duplicate
handoffs/reports and docs/archive were removed. History remains in Git.

Optional ignored docs/.local/ preserves the pre-consolidation roadmap, detailed
audit, CLI proposal, integration/checklist, code-doc notes and provider/bundler
investigations. These snapshots are reference material, not current instructions;
their old relative links are not maintained. These eight snapshots match the
pre-consolidation HEAD after line-ending normalization and are recoverable from Git.
The pre-existing private competitor notes now live at docs/.local/competitors.md.
No version of those notes was found in reachable Git history; deleting that file
loses the local research unless backed up separately. Its historical product
claims are not current contracts. Required decisions, open work and acceptance
do not depend on local files.

README remains the quick start; extension README remains the editor guide.
Contributor rules retain safety/Git/verification authority. The workflow skill
now points directly to the three documents and includes a short usage path.

## Historical runtime verification

Scope: AX-001/002 and model-registry stage 1 (runtime, schema, TSDoc and docs),
on Windows 11, Node 26.10.0, source loaded through tsx:

- PASS: stage-0 verification against installed CLIs without a model turn:
  Claude Code 2.1.294 initialize (13 names with resolvedModel, 0.9 s, no result
  event), Codex app-server model/list and account/rateLimits/read (5h/weekly,
  0.7 s), agy 1.3.1 models. Read-only metadata calls, no paid backend call.
- PASS: npm run typecheck.
- PASS: focused tests via node tests/run.cjs, including price-limit (unit and
  controller), model-routing, Claude catalog and alias selection, Codex rate
  limits, per-model price storage/refresh, doctor model view and health scope,
  surface/budget, server and pipeline tests.
- PASS: full suite, node tests/run.cjs: 388 tests, 385 pass, 3 skipped, 0 fail.
  One earlier full run failed "storage locks serialize actual competing Node
  processes" once; it passed alone and in three later full runs. Unexplained,
  not attributed to this change.
- PASS: surface budgets: 5,459 of 5,500 tool-definition bytes, 507 of 512
  instruction characters.
- PASS: npm run lint:docs, npm run docs (warnings as errors) and git diff --check.
- NOT_RUN: build, consumer smoke and packaging (no bundle/package change claimed);
  dependency-cycle tooling (SIMPLIFY-001 is not implemented); paid backend calls
  and native fresh-client retests (AX-006).

No independent review, six-job CI or native acceptance is established for this
branch. Full native lifecycle and consent acceptance remain in ROADMAP.

## Compact handoff contract

For subsequent tasks supply: objective/role/profile, allowed scope and acceptance;
workspace/branch/target plus base/candidate or dirty-diff identity; changes;
checks with commands, platform, PASS/FAIL/NOT_RUN and evidence; unresolved work and
next action. Link to rules instead of copying them. A reviewer needs original
requirements and the actual candidate, not just an implementation summary.
