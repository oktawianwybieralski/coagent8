---
title: Handoff
---

# CoAgent8 handoff

Updated 2026-10-13. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities/acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Do not append another session transcript or treat old test counts as fresh evidence.

## Current state

- **Released baseline (`0.6.1`):** `v0.6.1` is an annotated tag on `55c7859`
  (`chore(release): v0.6.1 (#32)`), published on GitHub, npm (`latest` and
  `next`) and the VS Code Marketplace ([release evidence](#061-release-evidence)).
  It is the first release under the MIT License. Its changes are listed in
  `CHANGELOG.md` and the [PATCH-061 queue](ROADMAP.md#patch-061-061-task-queue).
- **Next work: the [0.7.0 plan](ROADMAP.md#070-beta3-plan)** (owner direction
  2026-10-13). Phase 0 is owner decisions on
  [`PROPOSALS-001`](ROADMAP.md#proposals-001-proposals-awaiting-an-owner-decision),
  the npm publisher mode and release channel and the `0.7.0` write scope;
  Phase 1 is the public CLI (`CLI-FIRST-001a-e`). Publication automation
  ([`RELEASE-001`](ROADMAP.md#release-001-automated-publication)) is Phase 5,
  before the tag: the `0.6.1` publication path broke twice and npm and the
  Marketplace were published by hand. The `PATCH-061` native tasks that did
  not run before `0.6.1` are part of the `0.7.0` acceptance.
- **Phase 1 status (2026-10-13):** rows 1.1-1.13 of the
  [task queue](ROADMAP.md#tasks-070-070-task-queue) are merged:
  the public CLI (`CLI-FIRST-001a-e`, #34 and #36-#42), `RELEASE-001a` (#35)
  and the Windows PATH opt-in (`CLI-FIRST-001h1/h2`, #43). On 2026-10-13 the
  owner installed the packed CLI globally (`--help`, `models`, `doctor`,
  `session list`, `status`, exit code 2 for an unknown command), and ran the
  extension's PATH prompt, shim and uninstall removal on Windows. The
  readability gaps found in that run are the unscheduled card
  `CLI-FIRST-001j`. Row 1.14 (`DELEGATE-001a`) is a native owner task.
- **Phase 2 progress (2026-10-14):** rows 2.1-2.2 (`FEEDBACK-061a1/a2`, "Accurate
  runtime/update guidance") are merged in PR #45. Rows 2.3-2.4 (`FEEDBACK-061b1/b2`,
  "Shared registration policy") are implemented in PR #46: external CLI chats omit
  `coagent8_DIR` to use shared user directory `~/.coagent8` and migrate legacy
  profile-directed registrations, while downgrade prevention preserves newer
  runtime registrations and suppresses update/downgrade offers in VS Code.
  Rows 2.26a–d (`AX-002d–i`, "Recency under a price limit") are merged in PR #47:
  selection ranks models under a price limit by release recency, the doctor models
  view lists the day the price list added each model, models without a known date
  sort last, and expiration dates are ignored.
  Rows 2.6–2.8 (`FEEDBACK-061c1`, `FEEDBACK-061d`, `FEEDBACK-061f`, "Bug-report
  content and paste flow") are completed in PR #51: `issueUrl` targets
  `?template=bug_report.yml`; the prompt has the clickable link, the link in a code
  block and the report once, in a copy block with paste instructions; `structuredContent`
  adds `prompt` and `pasteRequired`, the issue skill is updated, and reports include
  a doctor health output reminder line.
  Row 2.5 (`FEEDBACK-061b3`, "selection outside the vendor profile") is completed
  in PR #54: a `vscode-extension` selection in a profile without the vendor extension
  is reported as unavailable here (`$(warning) Selected CLI unavailable here`),
  not "Selected CLI not found", while preserving "Selected CLI not found" when the
  vendor extension is installed or a custom path is missing.
  Result group 2.9–2.10 ("Bug-report opening actions", `FEEDBACK-061c2/c3`) is completed
  in PR #55: an explicit VS Code command `coagent8.openBugReport` opens the form URL
  with `vscode.env.openExternal` and never opens automatically; `coagent8 issue` prints
  the report to stdout and opens the browser with the form link only when `--open`
  is passed. The MCP server never opens a browser automatically.
  Row 2.11 (`FEEDBACK-061e`, "server-owned review turn number") is completed in PR #56:
  the returned review envelope carries the server's turn number, ignoring the
  model's `REVIEW: n` value while preserving all other envelope fields.
  Row 2.12 (`FEEDBACK-061g`, "large Codex review prompts", #57): aligned `maxLineBytes` in
  Codex adapter to `CODEX_MAX_LINE_BYTES` (16 MiB) with serialized prompt bounding
  (`CODEX_MAX_SERIALIZED_PROMPT_BYTES`) and raw prompt bound `CODEX_MAX_PROMPT_BYTES` (4 MiB)
  with an upfront `INPUT_LIMIT` error; large prompt (>512 KB), escaped newline expansion and
  oversized/serialized prompt rejection tests verified.
  Row 2.12a (`FEEDBACK-061j`, "retry unsuccessful reviews", #48): only reviews
  with `COVERAGE: COMPLETE` and complete collected input deduplicate unchanged
  repeats; reviews ending in `COVERAGE: PARTIAL`, incomplete collected input, or
  execution errors can be retried without changing code, with or without a handle.
  Coverage is exposed on the gate evaluation, stored in `lastReview`, and lookup
  ignores records without complete coverage (including legacy records). Refusal
  and skill guidance updated (merged in PR #59).
  Row 2.12b (`FEEDBACK-061k1`, "Codex read-denial reproduction", #49): reproduced
  in a throwaway Git repository (`scratch/repro-codex`) on Windows 11 with Node v24/v26
  and `codex-cli 0.162.0-alpha.17.2`. Matrix results:
  - POSIX/WSL: `NOT_RUN` (no WSL lane yet, row 2.18).
  - Windows reproduction lanes:
    * Lane 1 (intact NTFS inheritance, before synthetic `.env`): fresh and resumed
      threads, CoAgent8 consult/review (`codex`, `gpt-6.1-sol`) and plain
      `codex exec --sandbox read-only` under inherited `CODEX_HOME` all read
      tracked `docs/*.md`, sibling `src/*` files, and untracked files successfully
      (effective policy: `sandbox_mode="read-only"`, `approval_policy="never"`,
      effective config: `windows.sandbox="elevated"`, worker token: `codexsandboxoffline`).
    * Lane 2 (intact NTFS inheritance, after synthetic ignored `docs/sub/.env`):
      all file reads succeed; the synthetic `.env` does not trigger denials
      (effective config: `windows.sandbox="elevated"`, worker token: `codexsandboxoffline`).
    * Lane 3 (broken DACL inheritance on `docs/` via `AreAccessRulesProtected: True` / `D:PAI` under inherited `CODEX_HOME`):
      tested with fresh and resumed threads across CoAgent8 consult/review and plain `codex exec --sandbox read-only`
      (effective config: `windows.sandbox="elevated"`, worker token: `codexsandboxoffline`).
      Worker runs under the restricted `CodexSandboxUsers` token (`codexsandboxoffline`); because
      `codex-windows-sandbox-setup.exe` only sets `(OI)(CI)RX` ACE at workspace root `cwd` without recursing
      into inheritance-protected subtrees, the worker is denied read/traversal on `docs/`. Observed denial events:
      - `Get-Content -LiteralPath 'docs/ARCHITECTURE.md'` fails with exitCode 1,
        `CategoryInfo: PermissionDenied: (docs\ARCHITECTURE.md:String) [Get-Content], UnauthorizedAccessException`
        (Win32 error 5 / Access Denied).
      - `git -C <repo> show HEAD:docs/HANDOFF.md` fails with exitCode 1, `fatal: failed to stat 'docs': Permission denied`.
    * Lane 4 (isolated `CODEX_HOME` without elevated sandbox): running plain `codex app-server` or
      `codex exec --sandbox read-only` without `[windows] sandbox = "elevated"` (defaulting to unelevated) fails
      closed by policy: `exec_command failed: CreateProcess ... rejected: blocked by policy`.
    * Lane 5 (elevated sandbox configuration in isolated `CODEX_HOME` via `-c windows.sandbox="elevated"`):
      tested with fresh and resumed threads, under both inherited and isolated `CODEX_HOME`,
      in CoAgent8 review and plain `codex exec`. Mechanism: on Windows, `windows.sandbox="elevated"`
      configures Codex's provisioned sandbox backend (which isolates execution under `CodexSandboxUsers` /
      `codexsandboxoffline` with network proxy rules). Codex CLI requires this backend for read-only
      sandboxing on Windows; passing `-c windows.sandbox="elevated"` enables read-only commands to run
      without failing closed by policy (`blocked by policy`). On repositories with intact inheritance,
      file reads succeed; on subtrees where DACL inheritance was stripped (Lane 3), `codexsandboxoffline`
      is denied and CoAgent8's denial reporting (2.12c) captures the tool denials, surfaces them in
      `denials`, and forces `COVERAGE: PARTIAL` and `VERDICT: BLOCKED`.
      The worker token remains restricted (`codexsandboxoffline` with `SeChangeNotifyPrivilege`), and does
      not run with the developer's interactive token.
      Non-admin / un-elevated user lane: `NOT_RUN` (requires non-administrative test account).
      Existing `windows.sandbox` setting: overridden by CoAgent8 launch args to ensure elevated execution on Windows.
  Root cause attribution: `codex-windows-sandbox-setup.exe` grants read ACE `(OI)(CI)RX`
  to group `CodexSandboxUsers` only at the workspace root directory (`cwd`) and assumes
  DACL inheritance propagates down the entire repository tree. If any subdirectory has
  inheritance disabled (e.g., protected ACLs or copied trees), processes running under
  the sandboxed user token fail with Win32 Error 5 (Access Denied / UnauthorizedAccessException)
  on file reads and Git stats.
  Verified remedy: for isolated `CODEX_HOME` configurations, passing `-c windows.sandbox="elevated"`
  prevents failing closed by policy; for repository subtrees where DACL inheritance was broken,
  running `icacls <dir> /reset /t` restores standard inheritance from the workspace root, propagating
  `CodexSandboxUsers:(OI)(CI)RX` and allowing `codexsandboxoffline` to read the entire tree (natively
  verified: exit 0, zero denials, complete file reads).
  Drafted upstream issue text for OpenAI Codex CLI (draft only; not filed):
  `[Windows] CodexSandboxUsers permission granted only to workspace root without ACL inheritance verification breaks reading subtrees`
  "In Windows sandboxed mode, `codex-windows-sandbox-setup.exe` grants read permissions `(OI)(CI)RX`
  for `CodexSandboxUsers` strictly at the workspace root directory (`cwd`) and relies on standard DACL
  inheritance. When a repository subdirectory has inheritance blocked (`D:PAI`), the restricted sandbox
  user token is denied traversal and read permissions, causing `Get-Content` to fail with
  `UnauthorizedAccessException` and Git commands to fail with `Permission denied`. The setup tool
  should recursively verify or grant read access across repository subtrees."
  Row 2.12c (`FEEDBACK-061k2`, "correction and denial reporting", #49): CoAgent8
  adds `-c windows.sandbox="elevated"` to Codex app-server launch args on Windows
  (`src/backends/codex/app-server.ts`). Observed filesystem permission denials and
  policy blocks in failed tool events are parsed by `createCodexStreamCollector` and
  reported in `denials` on `TerminalExecutionResult`. The review gate
  (`evaluateStateEnvelopeGate`) forces `COVERAGE: PARTIAL` and `VERDICT: BLOCKED`
  when required review scope was denied (matching file paths, relative/absolute forms,
  and directory prefixes), naming the denied files. `formatExecutionResult`
  renders observed tool denials in the result footer distinctly from reviewer text,
  with paths sanitized by `redactDiagnostic`. `doctor` documentation clarifies that
  backend readiness checks installation, auth and quota without probing or implying
  workspace filesystem permissions (merged in PR #60).
  Row 2.12d (`FEEDBACK-061j`/`k`, "native recovery check"): verified on Windows 11
  with Node v26.10.0 and `codex-cli 0.162.0-alpha.17.2`:
  - Tracked docs readability: `docs/ARCHITECTURE.md` (90,514 characters) read
    successfully by Codex sandbox (`windows.sandbox="elevated"` running under
    `CodexSandboxUsers` / `codexsandboxoffline`) with exit code 0.
  - Denied required scope enforcement: in a test subtree with stripped NTFS
    inheritance (`/inheritance:r`), Codex sandbox execution fails closed with
    exit code 1 (`UnauthorizedAccessException`). The review gate logic
    (`evaluateStateEnvelopeGate` in `src/review/gate.ts:177-212`, verified by
    code inspection) forces `COVERAGE: PARTIAL` and `VERDICT: BLOCKED`
    with reasons identifying the denied scope.
  - Verified remedy: running `icacls <dir> /reset /t` restores standard NTFS
    inheritance from the workspace root (where `CodexSandboxUsers:(OI)(CI)RX` was
    granted), immediately restoring file read access for `codexsandboxoffline`
    (exit code 0, 0 denials).
  - Unchanged repeat retryability in native Codex (`gpt-6.1-sol`): verified live
    with native `codex app-server`:
    * Turn 1: Codex review on diff in `docs/test.md` with stripped inheritance
      ends with `COVERAGE: PARTIAL` and `VERDICT: BLOCKED` (16.6s,
      `syn_sess_29d846176fd880da53dae17b`, denial: `read docs/test.md (Unauthorized access)`).
    * Turn 2: Unchanged repeat without `session_handle` does not deduplicate
      (`findCompletedReview` rejects partial coverage) and starts a new model
      turn (15.5s, `syn_sess_5e5ccd622f7e538025c6d094`, deduplicated: false).
    * Turn 3: Unchanged repeat with `session_handle` (`syn_sess_29d846176fd880da53dae17b`)
      starts turn 2 in the same session without deduplication
      (11.9s, deduplicated: false).
    * Turn 4: After restoring inheritance via `icacls docs /reset /t`, native Codex
      review completes with `COVERAGE: COMPLETE` and `VERDICT: READY`
      (18.3s, `syn_sess_a947b48f0b41220bf342dc31`).
    * Turn 5: Unchanged repeat after `COMPLETE` review deduplicates immediately
      without a model turn (1.0s, deduplicated: true).
    (Mock test coverage additionally retained in `tests/mcp/tools/review-repeat.test.js`).
  - POSIX/WSL: `NOT_RUN`. Owner decision 2026-10-15: the POSIX recovery checks
    move to row 2.18 (`ACCEPT-001c`), and row 2.12d is closed on the Windows evidence.
  - Upstream issue: not filed and no longer required (owner decision 2026-10-15).
    `FEEDBACK-061k` is closed; the Codex Windows sandbox behavior is known
    limitation `CUR-014` in ARCHITECTURE and README with the `icacls` remedy,
    because with the task-scoped coagent profiles (planned for `0.8.0`) the
    backend sandbox becomes one execution option.
- **Row 2.13 (`FEEDBACK-061i`, agy retry mapper and resumed turn):** the
  denial-recovery caller keeps `final` unmapped on purpose, so the recovery
  answer becomes the turn's canonical `final` message; TSDoc on
  `createRetryIdMapper` and the caller records it. A resumed turn whose agy
  output omits `conversation_id` now keeps the requested session id with
  `continuationAvailable: true`; a new turn without an id still fails with
  `PROTOCOL_ERROR`. Fixture test in `tests/backends/agy/adapter.test.js`.
- **Release split (owner decision 2026-10-15):** `0.7.0` is a stability release and
  `0.8.0` (rc.1) carries delegation and orchestration; the
  [ROADMAP split](ROADMAP.md#070-beta3-plan) assigns each open row. The owner's
  Claude Code, Codex and VS Code registrations run the working-tree build
  (`dist/index.cjs mcp`); rebuild with `npm run build` and restart the client's
  MCP server to pick up changes. The next agent work is the `0.7.0` rows: 2.13
  (`FEEDBACK-061i`) and 2.14 (`FEEDBACK-061h`) in parallel, then 2.15-2.18 (the
  POSIX recovery checks run with 2.18).
- **Rows 2.15 + 2.16 (`ACCEPT-001b` isolated user home, `ACCEPT-001a1` runner skeleton, #67):**
  `tooling/acceptance/` creates its own temporary root, gives every child an explicit
  isolated environment (contract in [ACCEPT-001](ARCHITECTURE.md#accept-001-automated-native-acceptance)),
  runs children through `runCommand` and reads archives through the shared bounded
  readers in `scripts/archive.cjs`.
  - Row 2.15: `tests/acceptance/isolated-home.test.js` runs `setupClients` with a
    hostile parent environment pointing at a seeded fake home; the fake home stays
    byte-identical. A second test proves preload, coverage, credential and shadowing
    parent variables never reach the child.
  - Row 2.16: `npm run acceptance:native` (dry run in CI through
    `tests/acceptance/runner-skeleton.test.js`). Native run on Windows 11, Node
    v26.10.0, 2026-10-16, with candidates packed from the branch (`npm run
    package:vscode`): status `INCOMPLETE` (only N2-N4 `NOT_RUN`), VS Code 1.142.0
    installed the VSIX into the isolated profile, the installed runtime reported
    0.6.1 matching both manifests, the five real home registration files were
    unchanged and the evidence held no user name. The same run against the older
    `.artifacts` 0.6.1 build failed correctly: that runtime's `doctor --json` has no
    `server_version`.
- **PR scope (owner direction, 2026-10-13):** use the
  [result groups](ROADMAP.md#pr-groups-and-existing-history), with subtasks as
  commits/checklist items on one branch. Merged #33-#45 keep their history;
  PR #46 implements result group 2.3-2.4. Required review and
  CI cover each complete result; a task ID or line count is not a PR boundary.

## 0.6.1 release evidence

Release of `0.6.1` on 2026-10-13, verified on Windows 11, Node v26.10.0, against
the downloaded release artifacts:

- PASS: release PR #32 (`60ec36d`, tree `263fb0f`) passed the six CI jobs and
  the full local release gate; independent reviews of the release commit
  (`codex`, `gpt-6.1-sol`) and of `v0.6.0...release/v0.6.1` (`claude`,
  `claude-opus-5-5`) returned `READY` with no P1/P2 finding (details in the PR).
- PASS: native acceptance of the PR's CI VSIX (`49fa279e...a78439`, run
  38323428768) in VS Code: Codex, Claude Code and Antigravity, each in a new chat
  on runtime `0.6.1`, passed `doctor`, `consult` with continuation, `review`
  BLOCKED then READY on one `session_handle`, `session` list/history/close,
  `cancel` on an idle session, the closed-session refusal and `issue`. Findings
  are recorded as [`FEEDBACK-061`](ROADMAP.md#feedback-061-findings-of-the-061-native-acceptance).
  A first round silently ran the previous `0.6.0` runtime in chats started
  before the update (`FEEDBACK-061a`) and was discarded.
- PASS: squash commit `55c7859` on `develop` has the release PR's tree, is
  Verified and passed the six CI jobs; `v0.6.1` is annotated on it.
- PASS: `release.yml` built the draft; `sha256sum -c SHA256SUMS` succeeded for
  `coagent8-0.6.1.tgz`
  (`67424664572fdae448ca704232f26ce0a02c8bb8d68cf6ab0f5af546bd37c03b`) and
  `coagent8-mcp-0.6.1.vsix`
  (`9a72f77243c7ce4d898d5ed8cc24f6e052007bdefd7b858929d9a2bd82085d7f`);
  `gh attestation verify` with signer workflow `release.yml` passed for both.
  Both contain version `0.6.1`, the VSIX has the pre-release flag, and both
  carry the accepted runtime (`dist/index.cjs`
  `d5521e10e55258609565284b1f5f70218af9cdab4b6ae27629f794e3285ce9ff`). The
  VSIX contents equal the accepted CI VSIX file for file.
- NOTE: owner decision 2026-10-13: no throwaway-repository rehearsal
  (`PATCH-061-R5`); the tag's draft was verified before publication instead.
- FAIL, then manual: `npm-publish.yml` first failed because the `npm`
  environment allowed branch `v*` instead of tag `v*` (fixed in the environment
  settings), then because `npm publish release/coagent8-0.6.1.tgz` is read as a
  GitHub shorthand without `./` (`RELEASE-001a`). The workflow at the tag cannot
  change, so the owner published the verified tarball by hand to `next` and
  added `latest`. npm trusted publishing was not validated before its deadline
  (2026-10-14 01:22 UTC) and npm shows no provenance for `0.6.1`.
- PASS: `npm view coagent8` shows `latest` and `next` at `0.6.1`; `dist.shasum`
  (`8c635ccccb95e22217cf2b8e8af5fdd61f3e4024`) equals the release tarball.
- PASS: the Marketplace package `okidev.coagent8-mcp` `0.6.1`, uploaded by hand,
  is byte-identical to the release VSIX (same SHA-256).
- PASS: the GitHub Release is published and, after npm, was switched from
  pre-release to latest (owner decision 2026-10-13); the API documentation
  workflow deployed from the tag.
- NOT_RUN at release: `PATCH-061-N1`, `N4`, `N6`, `N7`, the Claude backend
  in `N2`, part of `N3`, the consent part of `N5`, and the Socket
  scores in `R7`. They move to `0.7.0` acceptance.

## LIC-001 MIT candidate

Prepared on `chore/mit-relicense` (based on `cccfa9d`) and merged to `develop`
in PR #19 (`fc76539`, 2026-10-12) for `LIC-001a`, `LIC-001b` and `LIC-001c1`.
`LICENSE`, the four distribution license fields (`package.json`,
`package-lock.json`, `plugin.json`, `extensions/vscode/package.json`), both
README license sections and contributor guidance apply standard MIT terms to
project source, documentation and artwork from `0.6.1` onward. Manifest versions
remain `0.6.0` until the `release/v0.6.1` release PR (`PATCH-061-R2`), and
published `0.6.0` artifacts are not replaced.

Rights/material inventory (`LIC-001a`):

- Inspected all 302 tracked files by category: 113 source files, 107 tests and
  fixtures, six client skills, 25 artwork files, 19 documentation/rule files
  and 32 other files. Project copyright attribution identifies Oktawian
  Wybieralski (`oki.dev`), and [rule 02](../.agents/rules/02-git-workflow.md)
  section 2 records the owner as sole author and copyright holder of the
  first-party work. Git history contains only the owner's two email identities
  as corroborating attribution.
- Searched tracked text for copyright, SPDX and license notices and for copied,
  adapted or derived material. No additional first-party copyright holder or
  GPL-only imported code was identified. Artwork includes the Affinity source,
  SVGs and PNG derivatives; the generated server icon derives from project
  artwork.
- Test doubles implement provider protocols; recorded CLI outputs and abridged
  OpenRouter model/pricing data are external fixture data. Relicensing makes no
  ownership claim over vendor responses, protocols or model names, and no vendor
  CLI implementation is distributed with the package.
- All three lockfiles contain no dependency license labeled GPL. The bundle's
  notice inventory (`dist/THIRD_PARTY_NOTICES.txt`) contains MIT packages
  (`@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `fast-deep-equal`,
  `json-schema-traverse`, `jsonc-parser`, `zod`) and BSD-3-Clause packages
  (`fast-uri`, `smol-toml`), whose license texts remain intact. Private
  documentation and VSIX packaging manifests carry no project license field and
  leave dependency licenses untouched.
- Previously distributed GPL copies (`0.6.0` and withdrawn `1.0.0-beta.1`)
  retain their permissions; historical tags, release packages and generated
  changelog entries were not rewritten. The separate trademark notice
  (`PUBLIC-001d`) is prepared in Group 7 (`fix/vsix-user-guidance`).

Pre-merge candidate verification on `chore/mit-relicense` (Windows 11, Node
v26.10.0): PASS `typecheck`, `check:dependencies`, fresh `build`, package
regressions (`tests/package.test.js`, 7/7 pass), `test:consumer` (installed
package startup, tool discovery, fixture turns/history, setup dispatch and EOF),
`package:vscode` and exact-artifact inspection. MIT `LICENSE` and metadata were
verified in both candidate artifacts, and `dist/THIRD_PARTY_NOTICES.txt` was
byte-identical to the pre-change build (SHA-256
`b29a2a04d624f9c7630c56db62474732c6a12911ac5061657754aea91c91cb67`):

- `chore/mit-relicense` candidate tarball SHA-256:
  `18e4b2ddf8ce4a73343630786bd81ede2e3e16908ceb0235a233fbc09cc6f7f6`.
- `chore/mit-relicense` candidate VSIX SHA-256:
  `396e1652bd447cb23700f0cf4c9c23225ef91466ac57976a6e93820771495132`.

NOT_RUN: native host acceptance, published `0.6.1` MIT artifact verification and
Socket license/supply-chain remeasurement; these run in `PATCH-061-R3`, `R4` and
`R7` (`LIC-001d`, `SUPPLY-001f`).

## 0.6.0 release evidence

Published `0.6.0` release (`REPO-002` owner steps 1–8), verified on 2026-10-12 on
Windows 11, Node v26.10.0, against the downloaded release artifacts:

- PASS: `v0.6.0` is an annotated tag on `9b78a0a` (`chore(release): v0.6.0 (#3)`,
  the squash commit on `develop`); verified via `git cat-file -t v0.6.0` and
  `git rev-parse v0.6.0^{commit}`.
- PASS: `gh release download v0.6.0`; `sha256sum -c SHA256SUMS` succeeded for
  `coagent8-0.6.0.tgz`
  (`4bf66c25fa1facf8b23320f3501475361ad7f69b52e15a3e7f99e7219f19500c`) and
  `coagent8-mcp-0.6.0.vsix`
  (`a2bb079f3b8cfa6bf60b3d6267007a0adc2ed50772b346fbe82eb92e072e14d7`). The
  owner's pre-tag rehearsal of `release.yml` reported the same tarball hash; its
  repository is deleted, so that comparison was not repeated.
- PASS: `gh attestation verify <file> -R oktawianwybieralski/coagent8` verified
  SLSA provenance v1 from `release.yml` at `refs/tags/v0.6.0`, commit `9b78a0a`,
  for both artifacts.
- PASS: `npm view coagent8` lists version `0.6.0` only, with dist-tags `latest`
  and `next` set to `0.6.0`; `dist.integrity` (sha512) and `dist.shasum` match
  the release tarball, and the `1.0.0-beta.1` placeholder is unpublished.
- PASS: the VS Code Marketplace package `okidev.coagent8-mcp` `0.6.0` is
  byte-identical to the GitHub Release VSIX (same SHA-256).
- PASS: `npx -y coagent8@next` launched over MCP SDK stdio reported server
  `coagent8` `0.6.0`, six tools (`consult`, `review`, `doctor`, `session`,
  `cancel`, `issue`), clean `doctor` output, and a completed `consult` turn on
  `codex` (`gpt-6-luna`, 3.8 s).
- NOTE: GitHub Release `v0.6.0` (published `2026-10-11T22:57:25Z`) is not marked
  as a GitHub pre-release, whereas [rule 02](../.agents/rules/02-git-workflow.md)
  marks versions below `1.0.0` as pre-releases.
- Open: `REPO-002` owner step 9 (enabling npm trusted publishing for
  `npm-publish.yml`).

## FEEDBACK-060 native acceptance of 0.6.0

Executed on 2026-10-11 on Windows 11 (`10.0.26200`), Node v26.10.0, in an
isolated VS Code instance (`--user-data-dir` and `--extensions-dir`) using the
VSIX from CI run `38173983280` (`extension.cjs` and `uninstall.cjs` SHA-256
matching the downloaded VSIX) across `codex-cli 0.162.0-alpha.17.2`,
`Claude Code 2.1.296` and `agy 1.3.3` on the lowest-priced model per backend
(`gpt-6-luna`, `claude-haiku-5-5`, `gpt-oss-120b`):

- PASS: `consult` across all three backends, `review` detecting two seeded
  defects and returning `READY` after fixes, unchanged repeat review starting no
  new turn, session continuation preserving context, history paging, `close`,
  `issue` draft generation, workspace isolation, and cancellation of running
  Codex and Antigravity turns.
- FAIL/NOTE: defects identified during the run and their split between `0.6.0`
  and `0.6.1` are tracked under
  [`FEEDBACK-060`](ROADMAP.md#feedback-060-findings-of-the-060-native-acceptance)
  (including the local reproduction where `git diff --cached` in a repository
  owned by `CodexSandboxOnline` reported dubious ownership followed by
  `unknown option 'cached'`).
- NOT_RUN: cancellation of a running Claude turn (inconclusive because the turn
  completed before `cancel` arrived; covered by fixture in `FEEDBACK-060h` and
  scheduled for native retest in `PATCH-061-N4`) and `close` with
  `delete_history` (`PATCH-061-N3`).

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
  (35/35 pass) and the combined extension, setup and cleanup suites
  (`tests/integrations/vscode-extension.test.js`, `tests/integrations/setup.test.js`,
  `tests/integrations/cleanup.test.js`: 68/68 pass), local VSIX SHA-256
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
  `git diff --check`.

## SIMPLIFY-001 S4 implementation

Extracted `src/security/` (`redaction.ts`, `boundaries.ts`), narrow session
activity checks (`src/sessions/activity.ts`, `src/contracts/session.ts`) and
cohesive session history modules (`src/sessions/history/types.ts`, `page.ts`,
`retention.ts`, `reader.ts`, `writer.ts`), eliminating the runtime and type
cycles between `session.ts`, `history.ts` and `history-page.ts`.

- Verification (Windows 11, Node v26.10.0): PASS `npm run typecheck`,
  `tests/simplify-s4.test.js` (7/7), S4 scoped suite (48/48), full suite
  (413 tests: 410 pass, 0 fail, 3 skipped), `npm run lint:docs` and
  `git diff --check`.

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
  (`3d23dc1`, VSIX `261c790c...b65ed2`, and follow-up VSIX `18838a2b...74a56`):**
  Second run showed extension-storage install records were wiped on VSIX
  uninstall (`FAIL`) and missing `vscode-extension` copies suppressed install
  offers. Moved install tracking to `~/.coagent8/installs.json` with
  junction-aware `agy` detection and registry-safe user `PATH` cleanup (`3d23dc1`,
  VSIX `261c790c...b65ed2`), then reported missing selected extension copies as
  `not installed` (VSIX `18838a2b...74a56`; owner-reported `PASS` for recovery
  and skill visibility).
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
requirements and the actual candidate, not just an implementation summary
([review input](../.agents/rules/03-author-reviewer.md#review-input)). Name pull
requests by number (`PR #51`), never "this PR": the text outlives the PR.
