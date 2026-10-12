---
title: Handoff
---

# CoAgent8 handoff

Updated 2026-10-12. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities/acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Do not append another session transcript or treat old test counts as fresh evidence.

## LIC-001 MIT candidate

2026-10-12, `chore/mit-relicense`, based on `cccfa9d` (merged PR #16).
The owner instructed implementation of MIT relicensing after that PR.
LICENSE, the four distribution license fields, both README license sections
and contribution guidance now describe MIT for project source, documentation
and artwork. Version remains 0.6.0 until the 0.6.1 release PR. This is a local
candidate, not a replacement for any published 0.6.0 artifact.

Rights/material inventory:

- Inspected all 302 tracked files by category: 113 source files, 107 tests and
  fixtures, six client skills, 25 artwork files, 19 documentation/rule files
  and 32 other files. Existing project copyright attribution identifies
  Oktawian Wybieralski (oki.dev), and rule 02 section 2 records the owner as
  sole author and copyright holder of the project work. The owner's instruction
  authorizes this project license change. History has the owner's two email identities only,
  which is corroborating attribution, not proof of rights to imported work.
- Searched tracked text for copyright/SPDX/license notices and copied/adapted/
  derived-material attribution. No additional first-party copyright holder or
  GPL-only imported code was identified. Artwork includes the Affinity source,
  SVGs and PNG derivatives. Generated server icon comes from project artwork.
- Test doubles implement provider protocols; recorded CLI outputs and the
  abridged OpenRouter model/pricing data are external fixture data. The change
  makes no new ownership claim over vendor responses, protocols or model names.
  No vendor CLI implementation is distributed with the package.
- All three lockfiles contain no dependency license labeled GPL. The bundle's
  notice inventory contains MIT packages (@modelcontextprotocol/sdk, ajv,
  ajv-formats, fast-deep-equal, json-schema-traverse, jsonc-parser, zod) and
  BSD-3-Clause packages (fast-uri, smol-toml). Their license texts remain intact.
  Private documentation/VSIX tooling manifests have no project license field
  to change; their dependency licenses are untouched.
- Previously distributed GPL copies retain their permissions. Historical tags,
  release packages and generated changelog entries were not rewritten.
  PUBLIC-001d's separate trademark notice remains pending owner wording approval.

Local evidence, Windows 11 / Node v26.10.0: PASS typecheck,
`check:dependencies`, fresh build, package regressions (7 pass / 0 fail),
consumer smoke (installed package startup/tool discovery, fixture turns/history,
setup dispatch and EOF), VSIX packaging and exact-artifact inspection.
The consumer tarball equals the one used to stage the VSIX. MIT LICENSE and
metadata are present in both, and the third-party notices are byte-identical
to the pre-change build (SHA-256
`b29a2a04d624f9c7630c56db62474732c6a12911ac5061657754aea91c91cb67`).

- Tarball SHA-256:
  `18e4b2ddf8ce4a73343630786bd81ede2e3e16908ceb0235a233fbc09cc6f7f6`.
- VSIX SHA-256:
  `396e1652bd447cb23700f0cf4c9c23225ef91466ac57976a6e93820771495132`.

NOT_RUN: native host acceptance, published MIT artifact verification and Socket
remeasurement; these belong to the 0.6.1 release tasks. Independent review and
integration of this local candidate are pending.

## 0.6.0 release evidence

Release of 0.6.0 (REPO-002 owner steps 1-8), checked again on 2026-10-12 on
Windows 11, Node v26.10.0, from downloads of the published release:

- PASS: `v0.6.0` is an annotated tag on `9b78a0a` (`chore(release): v0.6.0 (#3)`,
  the squash commit on `develop`); `git cat-file -t v0.6.0`, `git rev-parse v0.6.0^{commit}`.
- PASS: `gh release download v0.6.0`; `sha256sum -c SHA256SUMS` OK for
  `coagent8-0.6.0.tgz` (`4bf66c25fa1facf8b23320f3501475361ad7f69b52e15a3e7f99e7219f19500c`)
  and `coagent8-mcp-0.6.0.vsix`
  (`a2bb079f3b8cfa6bf60b3d6267007a0adc2ed50772b346fbe82eb92e072e14d7`). The
  owner's rehearsal (step 5b) reported the same tarball hash; its repository is
  deleted, so that comparison was not repeated.
- PASS: `gh attestation verify <file> -R oktawianwybieralski/coagent8` for both
  files: SLSA provenance v1 from `release.yml` at `refs/tags/v0.6.0`, commit `9b78a0a`.
- PASS: `npm view coagent8`: versions `0.6.0` only, dist-tags `latest` and `next`
  = `0.6.0`; `dist.integrity` (sha512) and `dist.shasum` equal those computed from
  the release tarball. `1.0.0-beta.1` is unpublished, not deprecated.
- PASS: the VS Code Marketplace VSIX `okidev.coagent8-mcp` 0.6.0 is byte-identical
  to the release VSIX (same SHA-256); the owner installed it from the Marketplace.
- PASS: `npx -y coagent8@next` started by an MCP SDK stdio client: server
  `coagent8` 0.6.0, six tools (consult, review, doctor, session, cancel, issue),
  `doctor` without error, `consult` on codex `gpt-6-luna` answered in 3.8 s.
- NOTE: the GitHub Release `v0.6.0` (published 2026-10-11T22:57:25Z) is not
  marked as a pre-release, while rule 02 keeps releases below 1.0.0 as
  pre-releases; the owner decides whether to change it.
- NOTE: the rehearsal repository `coagent8-release-test` no longer exists.
- Open: REPO-002 owner step 9 (npm trusted publishing).

## FEEDBACK-060 native acceptance of 0.6.0

2026-10-11, Windows 11 10.0.26200, Node v26.10.0, isolated VS Code instance
(`--user-data-dir`/`--extensions-dir`) with the VSIX from CI run 38173983280
(`extension.cjs` and `uninstall.cjs` SHA-256 equal to the downloaded VSIX).
Backends: codex-cli 0.162.0-alpha.17.2, Claude Code 2.1.296, agy 1.3.3. Three
agents (Claude Code, Codex, Antigravity) called every tool on the cheapest
model per backend (`gpt-6-luna`, `claude-haiku-5-5`, `gpt-oss-120b`).

- PASS: consult on all three (13524), review found both seeded defects and
  returned READY after the fixes, an unchanged repeat started no turn,
  continuation kept context, history paging, close, issue drafts, workspace
  isolation, cancel of a running Codex and agy turn.
- FAIL/NOTE: findings and their split before/after 0.6.0 are the
  [FEEDBACK-060 cards](ROADMAP.md#feedback-060-findings-of-the-060-native-acceptance).
  Reproduced locally: `git diff --cached` in a repository owned by
  `CodexSandboxOnline` prints dubious ownership, then `unknown option 'cached'`.
- NOT_RUN: cancel of a running Claude turn (inconclusive), `delete_history`.

## PLUGIN-001g VS Code installed-server entry

Commit `1f36525` on the `0.6.0` release branch. Local checks on 2026-10-11:
typecheck, `lint:docs`, build, full suite 688 pass / 0 fail (3 skipped, 1 todo),
including `tests/integrations/vscode-profile.test.js`.

Native check on VS Code 1.141.0 (Windows):

- PASS: "MCP Servers - Installed" lists CoAgent8 beside other gallery servers;
  its page shows type `stdio`, command `node`, the runtime copy in
  `globalStorage/okidev.coagent8-mcp/runtime/<sha256>/index.cjs` and the four
  environment variables, while `~/.coagent8/vscode-mcp.json` records the entry digest.
- NOT_RUN: start and tool discovery from the entry, toggle, output, setting-change
  restart, user removal respected, update to another build and clean uninstall
  (`PATCH-061-N1`).

## REPO-003a one numeric version

Card: [REPO-003](ROADMAP.md#repo-003-one-numeric-version-for-npm-vsix-and-tags).
Synchronized numeric `major.minor.patch` versioning (`0.6.0` for the `beta.2`
stage; `0.5.0` skipped after withdrawing the `1.0.0-beta.1` npm placeholder)
across `package.json`, `package-lock.json`, `plugin.json` and
`extensions/vscode/package.json`:

- `scripts/build-vscode.cjs` refuses a version that differs from the server or is
  not numeric `major.minor.patch`, and `isPreview` (every version below `1.0.0`)
  sets `Microsoft.VisualStudio.Code.PreRelease` to `true` in `extension.vsixmanifest`.
- `release.yml` requires an annotated numeric `vX.Y.Z` tag and marks `0.*`
  releases as GitHub pre-releases; `npm-publish.yml` publishes `0.*` to `next`.
- Local evidence (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `npm run build`, `node tests/run.cjs tests/package.test.js` (7/7 pass),
  `npm run package:vscode` (local tarball SHA-256
  `e90e972637218371d5a3a0073897ce1cb3a5d3c184433e6d9c0bf7d1c32318b0`, VSIX
  SHA-256 `0bb40ace577c31a13ed0f13230cbcab77e7c9a66fc78fdbcff33796b3bf0520d`),
  `npm test` (682 tests: 678 pass, 0 fail, 3 skipped, 1 todo), `changelog:check`
  and `git diff --check`.

## CLIMGMT-001 manage coding CLIs

Card: [CLIMGMT-001](ROADMAP.md#climgmt-001-manage-coding-clis). Implemented
`CLIMGMT-001a` through `CLIMGMT-001d` for `0.6.0`:

- `src/integrations/setup.ts`: added `listInstallations` (vendor extension copy,
  `PATH` directories, profile installer locations and configured file without
  spawning a process or scanning the disk), `configuredExecutable` and
  `checkExecutable` (resolution plus `inspectCli` compatibility verification).
- `extensions/vscode/src/extension.ts`: replaced `coagent8.setup` and
  `coagent8.uninstall` with `coagent8.manageClis` (**CoAgent8: Manage Coding CLIs**),
  providing bulk chat actions and a sectioned per-CLI menu (`Installations`,
  `Install`, `Chat`, `Skills`, `Remove`) with Back navigation and step counts.
  Vendor extension installs pass `donotSync: true` (`isMachineScoped`) to avoid
  VS Code's extension-sync prompt; extension removal delegates to the Extensions
  view (`removingExtensions` state plus `finishRemovals` cleanup).
- Local evidence (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `npm run lint:docs`, `npm run build`, `tests/integrations/vscode-extension.test.js`
  (35/35 pass) and `tests/integrations/setup.test.js` (68 pass across setup,
  extension and cleanup suites), local VSIX SHA-256
  `17fb9139c991c8765aa25e3c28dc2e2c288cbc2e2ea4f14a1d700e4f999221f4`.
  NOT_RUN: native VS Code acceptance (`CLIMGMT-001e`, tracked under `PATCH-061-N1`/`N6`).

## What the trials establish

Cross-agent baseline trials (2026-10-08) tested whether Codex, Claude and Gemini
could select a model below USD 5 per million output tokens using MCP tools alone:

| Evidence | Observation | Limit |
| --- | --- | --- |
| Codex trial | `doctor` omitted per-model prices; an external price lookup was required before calling `consult` on `gpt-6-luna` (USD 0.50/M output tokens, 4.0 s). | Historical unit price, not request billing; footer duration excluded preparation. |
| Claude trial | Selected models by name (`4.3 s` and `12.2 s`) and noted missing per-model prices, `agy` readiness ambiguity and effort syntax. | Price compliance was not enforced by governance; no phase trace separated CLI startup from preparation. |
| Gemini trial | Hit unanswered elicitation on an explicit model, switched models on fallback, and edited an inactive default config path because `coagent8_CONFIG` pointed to VS Code storage. | Reported sequence; both `doctor` formats ran the same probes. |
| Source baseline (`1353fb9`) | `DoctorPrices` exposed only `source`/`fetchedAt`/`count`; governance checked approval thresholds rather than a caller ceiling (`output_price_below`). | Addressed in `0.6.0` by `AX-001`/`AX-002` and `EXEC-001-T03`/`T11` (`src/diagnostics/doctor.ts`, `src/models/prices.ts`, `src/models/selection.ts`, `src/config.ts`). |

## SKILLS-001 client skills

Card: [SKILLS-001](ROADMAP.md#skills-001-client-skills-installed-with-the-registration).
Implemented `SKILLS-001a` through `SKILLS-001d` in `0.6.0`:

- Packaged six single-file client skills (`consult`, `review`, `doctor`,
  `session`, `issue`, `loop`) under `skills/` and wired installation, digest
  tracking (`setup.json`) and unchanged-copy cleanup across `src/integrations/skills.ts`,
  `setup.ts`, `cleanup.ts`, `extensions/vscode/src/extension.ts` and `uninstall.ts`.
- Local evidence (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `npm run check:dependencies`, `npm run lint:docs`, `npm run docs`,
  `tests/integrations/skills.test.js` (7/7 pass), setup/cleanup/extension/package
  suites (70/70 pass) and `npm pack --dry-run`.
- NOT_RUN: native skill discovery and invocation per client (`SKILLS-001e`,
  tracked under `PATCH-061-N6`).

## SIMPLIFY-001 S0 baseline

Captured 2026-10-08 at `ac394adf3ae31181f88a210d07c1d5a1d4e0fdde` (tree
`e2ad8e735630336c4721428207bf978519e13d8c`) on Windows 11, Node v26.10.0:

- Parsed all 158 tracked TS/JS/CJS/MJS files (77 source modules, 410 source
  dependency declarations: 272 runtime edges and 57 erased type edges) with zero
  parser errors.
- Identified three pre-migration cycles to eliminate: runtime and type cycles
  between `sessions/session.ts`, `sessions/history.ts` and
  `sessions/history-page.ts` (assigned to S4), and a type cycle between
  `integrations/setup.ts` and `integrations/cli-readiness.ts` (assigned to S5).
- Mapped exact caller ownership across slices S1 through S6 (`contracts/`,
  `storage/`, `workspace/`, `execution/`, `models/`, `review/`, `security/`,
  `sessions/`, `integrations/`, `mcp/`).

## SIMPLIFY-001 S1 implementation

Extracted cohesive shared contracts (`src/contracts/`), atomic file locking and
bounded file reads (`src/storage/lock.ts`, `src/storage/read.ts`), runtime
stream primitives (`src/execution/runtime/stream.ts`) and canonical workspace
resolution (`src/workspace/identity.ts`, `src/workspace/workspace.ts`).

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `tests/simplify-s1.test.js` (4/4), full suite (392 tests: 389 pass, 0 fail,
  3 skipped), `npm run lint:docs` and `git diff --check`; independent review
  `VERDICT: READY` (`b4f05f3`).

## SIMPLIFY-001 S2 implementation

Extracted Git scope collection (`src/workspace/git.ts`), review input/gate
policy (`src/review/gate.ts`, `src/review/input.ts`), neutral `TaskExecutionResult`
contracts and the MCP transport layer (`src/mcp/` and `src/mcp/tools/`), plus
leaf branding (`src/brand.ts`), eliminating all `mcp/` and `@modelcontextprotocol/sdk`
imports from `src/execution/` and `src/review/`.

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `tests/simplify-s2.test.js` (3/3), full suite (395 tests: 392 pass, 0 fail,
  3 skipped), `npm run lint:docs` and `git diff --check`; independent review
  `VERDICT: READY`.

## SIMPLIFY-001 S3 implementation

Extracted pure model domain modules (`src/models/catalog.ts`, `identifier.ts`,
`store.ts`, `prices.ts`, `governance.ts`, `selection.ts`) with zero dependencies
on `backends/`, `execution/` or `mcp/`, and moved application selection, consent
and routing orchestration to `src/execution/selection.ts`, `consent.ts` and
`routing.ts`.

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `tests/simplify-s3.test.js` (5/5), S3 scoped suite (57/57), full suite
  (406 tests: 403 pass, 0 fail, 3 skipped), `npm run lint:docs` and
  `git diff --check`; independent review `VERDICT: READY`.

## SIMPLIFY-001 S4 implementation

Extracted `src/security/` (`redaction.ts`, `boundaries.ts`), narrow session
activity checks (`src/sessions/activity.ts`, `src/contracts/session.ts`) and
cohesive session history modules (`src/sessions/history/types.ts`, `page.ts`,
`retention.ts`, `reader.ts`, `writer.ts`), eliminating the runtime and type
cycles between `session.ts`, `history.ts` and `history-page.ts`.

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `tests/simplify-s4.test.js` (7/7), S4 scoped suite (48/48), full suite
  (413 tests: 410 pass, 0 fail, 3 skipped), `npm run lint:docs` and
  `git diff --check`; independent review `VERDICT: READY`.

## SIMPLIFY-001 S5 implementation

Retired all 28 temporary internal forwarding shims and `src/tools/`, resolved the
`cli-readiness.ts -> setup-clients.ts` type cycle, updated all `src/`, extension
and test imports to canonical owners, and mirrored source ownership across
`tests/` while preserving public entrypoints (`index.js`, `dist/index.cjs`,
`dist/setup.cjs`).

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `npm run build`, `tests/simplify-s5.test.js` (5/5), full suite (418 tests:
  415 pass, 0 fail, 3 skipped), `npm run lint:docs`, `npm run docs` and
  `git diff --check`.

## SIMPLIFY-001 S6 implementation

Added AST and Tarjan SCC dependency-boundary enforcement in
`scripts/check-dependencies.cjs` (`npm run check:dependencies`, wired into
`.github/workflows/ci.yml` and [rule 04](../.agents/rules/04-quality-gate.md))
with zero legacy exemptions (`allowedLegacyEdges: []`), plus indirect external
SDK/transport edge detection (`af9f7d2`).

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `npm run check:dependencies` (102 modules, 506 edges, 0 violations, 0 cycles),
  `tests/simplify-s6.test.js` and scoped boundary suites (39/39), `npm run build`,
  `npm run test:consumer`, `npm run lint:docs`, `npm run docs` and `git diff --check`.

## EXEC-001-T01a call and wait map

Inventoried every phase of `consult`, `review` and `doctor` across MCP dispatch,
Git diff collection, workspace assertions, configuration loading, CLI probes,
catalog/price reads, consent elicitation, session lock acquisition, CLI adapter
execution, history/cooldown finalization and post-turn snapshot rechecks,
establishing the baseline harness in `tests/execution/baseline.test.js`
(`T01b`/`T01c` at `42e4cbd`) and driving stages `EXEC-001-T02` through `T11c`:

- **Monotonic phase timing and configuration provenance (`T02`–`T05`):**
  monotonic phase tracker (`preparation`, `consent`, `acquisition`, `execution`,
  `finalization`), single-load immutable `ConfigSnapshot` with redacted
  `DoctorConfigProvenance` (`T03`), cohesive `prepareTask`/`confirmConsent`
  lifecycle (`T04`), and coalesced catalog/default-model observation reuse (`T05`).
- **Guaranteed finalization and complete-call budget (`T06`–`T11c`):**
  unconditional turn-lease/process/history settlement (`T06`), monotonic
  `ExecutionBudget` with teardown reserve and centralized timeout constants
  (`T07`), cancellable shared native reads across Codex, Claude, Antigravity and
  price fetches with last-waiter abort (`T08a`–`T08f`), budget-bound Git review
  collection, FIFO lock waiters and session rollbacks (`T09a`–`T09c`),
  budget-bound consent elicitation, pre-acquisition revalidation and fault-isolated
  `neverAsk` persistence (`T10a`–`T10c`), and end-to-end budget activation for
  `consult`/`review`, bounded `doctor` execution (`DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 60_000`)
  and wall-clock `totalMs` reporting (`T11a`–`T11c`).

## AUDIT-001-A01-A03: quota cache read failure

- **Reproduction (`A01`):** REPRODUCED in `tests/backends/quota-read-failure.test.js`
  (simulated `fs.openSync` failure on a seeded cache with `codex` and `claude`
  cooldowns caused partial `agy` updates to overwrite the cache with `[ 'agy' ]`).
- **Fix (`A02`/`A03`):** `src/backends/availability.ts` classifies cache reads as
  `missing`, `valid`, `invalid` or `unreadable`; locked writers (`inspectQuotas`,
  `recordQuotaCooldown`, `resetQuotaCooldown`) refuse destructive merges when an
  existing cache file is unreadable, while `inspectQuotas` with `onCacheError`
  still answers from an unlocked read without writing.
- **Verification:** PASS `tests/backends/quota-read-failure.test.js` (7/7),
  `DOCTOR` and `CACHE` groups (46/46), `npm run typecheck`,
  `npm run check:dependencies`, `npm run lint:docs` and `git diff --check`.

## AUDIT-001-A04-A05: serialize configuration writers

- **Reproduction (`A04`):** REPRODUCED 5/5 in `tests/config-writer-lease.test.js`
  (`saveConfig` and `setDefaultBackend` bypassed the configuration file lease and
  overwrote concurrent leased writes).
- **Fix (`A05`):** `saveConfig` and `setDefaultBackend` now run asynchronously
  under the configuration file lease across all callers.
- **Verification:** PASS `tests/config-writer-lease.test.js` (3/3 across 5 runs),
  `CONFIG` group (17/17), full suite (643 tests: 640 pass, 0 fail, 3 POSIX skips),
  `npm run typecheck`, `npm run check:dependencies`, `npm run lint:docs` and
  `git diff --check`.

## AUDIT-001-A06-A07: atomic configuration writes

- **Reproduction (`A06`):** REPRODUCED in `tests/config-write-failure.test.js`
  (simulated transient `EPERM` rename failures caused `writeConfig` to fail on the
  first attempt without retry; native Windows handle-sharing violation remains
  `NOT_RUN`).
- **Fix (`A07`):** `writeConfig` awaits shared `atomicWrite` (temporary file,
  bounded `EPERM`/`EBUSY`/`EACCES` rename retry and cleanup) inside the
  configuration lease across all five configuration writers.
- **Verification:** PASS `tests/config-write-failure.test.js` (3/3), full suite
  (647 tests: 644 pass, 0 fail, 3 POSIX skips), `npm run typecheck`,
  `npm run check:dependencies`, `npm run lint:docs` and `git diff --check`.

## AX-007a: state when another review cannot help

Implemented `AX-007a`, `AX-007b` and `AX-007c` for bounded review and
continuation cost in `0.6.0`:

- **`AX-007a` (`src/review/gate.ts`):** When a read-only reviewer returns `READY`
  with no `[P1]`/`[P2]` findings and the only gate blocker is `NOT_RUN` required
  checks, the gate reason states that a read-only review cannot execute checks
  and repeating the review will not change the verdict.
- **`AX-007b` (`src/mcp/result.ts`, `src/mcp/schema.ts`):** Result footers label
  `session_handle=<handle> (<state>)` and tool schemas instruct callers to pass
  the footer handle for same-topic follow-ups.
- **`AX-007c` (`src/sessions/session.ts`, `src/execution/controller.ts`):**
  Completed judged reviews record `lastReview` (`snapshotId#digest`, scope,
  backend, model) in the session record; an unchanged repeat review in the same
  workspace is refused before consent or model execution and returns the earlier
  verdict and session handle (`tests/mcp/tools/review-repeat.test.js`, 5/5 pass;
  full suite 654 tests: 651 pass, 0 fail, 3 POSIX skips).

## WINDOWS-001a: per-call descendant survivors

Experiment `tests/execution/descendant-survivor.test.js` (`native-descendant`
fixture mode on Windows 11, Node v26.10.0, 3 runs):

| Descendant | Windows 11, Node v26.10.0 (3 runs) |
| --- | --- |
| In the root's libuv kill-on-close job (normal child of a Node root) | `NOT_REPRODUCED` 3/3: ended with the root |
| Outside any job (`detached`, no console): model of a native, non-libuv root's child | `REPRODUCED` 3/3: kept running after the cancelled turn returned |

- **Interpretation and limits:** `terminateProcessTree` on Windows terminates the
  owned root process (`proc.kill()`). While server termination closes the
  server-wide libuv job (`AUD-P2-14`), per-call cancellation or timeout of a
  native `agy` turn can leave child processes outside that root job (such as MCP
  servers started for the turn) running until they exit or the CoAgent8 server
  stops. Documented as a known limitation of read-only `0.6.0`/`0.6.1`; per-call
  Job Object containment (`WINDOWS-001b-e`) is required before enabling write or
  command profiles.

## EXEC-001-T12b: local candidate package validation

Early `0.6.0` candidate builds carried version `1.0.0-beta.2` before
[`REPO-003a`](#repo-003a-one-numeric-version) unified package, VSIX and tag
numbering on `0.6.0`:

- **Baseline repetition on final `EXEC-001` source (`240ac3c`, tree `eff2aed`):**
  5/5 runs of `tests/execution/baseline.test.js` and `tests/environment.test.js`
  passed (9/9 tests; runner median 3,572 ms, wall median 3,894 ms) with scenario
  probe/catalog/launch counters identical to `T01c` (`plain cold` 1/1/1,
  `plain warm` 0/0/1, `explicit model/effort` 1/0/1, `priced auto` 1/0/1,
  `continuation` 0/0/1, `review` 1/0/1, `concurrent` 1/1/4).
- **Initial candidate gate (`751d922`, tree `6e53be3`, Windows 11, Node v26.10.0):**
  PASS `typecheck`, `check:dependencies` (0 violations, 0 cycles), `build`,
  `test:coverage` (656 tests: 652 pass, 0 fail, 3 POSIX skips, 1 `WINDOWS-001a`
  todo; 93.23% statements/lines, 84.75% branches, 95.44% functions), `npm pack`,
  `test:consumer`, `lint:docs`, `docs` (0 warnings) and `package:vscode`
  (local tarball `10896f67dacedf60d9a3544408e7ae1a764b1f36c8ccb3ca0dbd71d0ca3c55c3`,
  VSIX `72798f469f6d19e363c2646a24fd0e7c681743377b1099f0389f12bab07384c5`).
- **Pre-release candidate gate (`861f350`, tree `787720a`, after `SKILLS-002` and
  `T12c` fixes):** PASS `typecheck`, `check:dependencies`, `build`,
  `test:coverage` (679 tests: 675 pass, 0 fail, 3 POSIX skips, 1 todo; 93.27%
  statements, 84.85% branches), `npm pack`, `test:consumer`, `lint:docs`, `docs`
  (0 warnings) and `package:vscode` (local tarball SHA-256
  `7e9b3b2b668b8cd347246570b303956e83fc948bf3c3214b53759ce0cc1e9b51`, VSIX
  SHA-256 `6f1cc358f9dcb965c6fab17664e5de02a82a096d1295c87e4d96293b449b95ff`).

## REPO-002c/d/e: beta.2 pull request branch and API site

Card: [REPO-002](ROADMAP.md#repo-002-branch-model-and-release-workflow).
Prepared the `develop` + `X.Y.x` workflow, CI/release automation and TypeDoc
API site for `0.6.0`:

- **`REPO-002a`–`e` (`7adccdc`, tree `d84f40d`):** configured
  [rule 02](../.agents/rules/02-git-workflow.md), `.github/workflows/ci.yml`
  (six OS/Node 24.x and 26.x jobs on `develop` and `[0-9]+.[0-9]+.x`),
  `.github/workflows/release.yml` (tag-triggered draft release with `SHA256SUMS`
  and `git-cliff` notes), `.github/workflows/docs.yml` (TypeDoc API and project
  documents with Mermaid rendering deployed to GitHub Pages on release), and the
  frozen `0.6.0` section in `cliff.toml` (local gate tarball SHA-256
  `56c8956e62c50839609925762465abd087b9c41b928236d9eeb5e92ea322d5d9`, VSIX
  SHA-256 `612ac5855b1898c73b1123b6bfbff826ac137be61c68eeed3592fbbf95873a87`).
- **`REPO-002g`:** added SLSA build provenance attestation
  (`actions/attest-build-provenance`) for both the tarball and VSIX in
  `release.yml` and added `.github/workflows/npm-publish.yml` (gated by the `npm`
  environment and `NPM_TRUSTED_PUBLISHING`).

## EXEC-001-T12c: native VS Code acceptance, first run (2026-10-10)

Pre-release native VS Code runs on Windows 11 (VS Code 1.141.0) exposed and
verified fixes before `0.6.0`:

- **Stale registration ownership (`a2306e1`, VSIX `a56fc6d0...fa01fe`):** First
  run (`612ac585...873a87`) left older VSIX MCP entries behind when
  `~/.coagent8/setup.json` was missing (`FAIL`), while switching between
  standalone `agy` and the Google extension download passed (`PASS`). Fixed
  `entryOwnership` in `src/integrations/setup-storage.ts` to recognize
  extension-owned runtime paths (`globalStorage/okidev.coagent8-mcp`); the second
  run verified `PASS` for hook removal, 3-client registration and 18 installed skills.
- **Standalone CLI install tracking and missing `vscode-extension` copies
  (`3d23dc1`, VSIX `18838a2b...74a56`):** Second run showed extension-storage
  install records were wiped on VSIX uninstall (`FAIL`) and missing
  `vscode-extension` copies suppressed install offers. Moved install tracking to
  `~/.coagent8/installs.json`, added junction-aware `agy` detection and
  registry-safe user `PATH` cleanup, and reported missing selected extension
  copies as `not installed` (owner-reported `PASS` for recovery and skill
  visibility).
- **Cross-client MCP smoke:** `consult` calls succeeded across Codex (`agy` /
  `gemini-3.8-flash-high`), Claude Code (`codex` / `gpt-5.6-luna` and `agy` /
  `gpt-oss-120b-medium` with `output_price_below: 3`) and Antigravity (`codex` /
  `gpt-6-luna`). Evidence boundary: establishes MCP consultation and skill
  loading, not billing, phase timing boundaries, sandbox isolation or review gate
  behavior.
- **Uninstall selection and post-uninstall transition:** Owner-accepted `PASS`
  for extension selection/removal; post-uninstall `RestartExtensionHostAction`
  was `FAIL` (did not apply pending extension removals), first replaced with
  **Reload Window** (`0c276677...662f`, native retest `NOT_RUN`) and later
  superseded in `CLIMGMT-001` / `FEEDBACK-060b` by Extensions-view removal
  (`extension.open` plus `vscode:uninstall`). Remaining native lifecycle checks
  run under `PATCH-061-N1` and `N6`.

## SKILLS-002: complete independent skill management

Card: [SKILLS-002](ROADMAP.md#skills-002-independent-skill-management).
Implemented `SKILLS-002a` and `SKILLS-002b` in `0.6.0`:

- Added **CoAgent8: Manage Skills** in VS Code and
  `coagent8 skills status|install|uninstall|enable|disable` on the CLI, storing
  desired `installed`/`disabled` lists in `backends.<client>.skills` in shared
  `config.json` and actual digests/origins in `setup.json`.
- Portable disable moves packages to `~/.coagent8/disabled-skills/<client>/`
  outside client discovery; mutations use a bounded rollback/recovery journal under
  the setup and configuration leases, and removing or rolling back packages
  cleans up empty `disabled-skills` directories without following links.
- Verification (Windows 11, Node v26.10.0): PASS `typecheck`, `build`,
  `check:dependencies` (109 files, 589 edges, 0 violations/cycles), `lint:docs`,
  `docs`, 76 focused setup/skills/VS Code/package tests and 678 full-suite tests
  (674 pass, 0 fail, 3 platform skips, 1 `WINDOWS-001a` todo; pre-cleanup tarball
  `8b23bbe6c9d0ddee7fc736a2aea7cbf940717765cbd0fe3fa209ab302ca06e82`, VSIX
  `7e4e63044a9aec22c66afaaeb56ad54d81302981bfb4f588c7dd0bec4cd7bc00`), followed
  by 44 scoped skills/setup/cleanup tests on the empty-directory fix and the
  `861f350` full candidate gate above. Independent read-only review (`agy` /
  `gemini-3.8-flash-high`) reported model `READY` (0 P1/P2) with server gate
  `BLOCKED` (`typecheck` and `tests` `NOT_RUN`). Native `SKILLS-002c` acceptance
  remains `NOT_RUN` (`PATCH-061-N6`).

## Compact handoff contract

For subsequent tasks supply: objective/role/profile, allowed scope and acceptance;
workspace/branch/target plus base/candidate or dirty-diff identity; changes;
checks with commands, platform, PASS/FAIL/NOT_RUN and evidence; unresolved work and
next action. Link to rules instead of copying them. A reviewer needs original
requirements and the actual candidate, not just an implementation summary.
