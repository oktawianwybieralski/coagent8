---
title: Handoff notes for 0.7.0
---

# Handoff notes for 0.7.0

Moved unchanged except for link paths from [HANDOFF.md](../../HANDOFF.md) on 2026-11-03, when it was cut back to the
current state. History, not instructions. The card records in this directory are the reviewed account.

- **Delivered records (owner decision 2026-10-20):** what 0.7.0 delivered, per
  card with PRs, review handles and evidence, is in
  [docs/delivered/0.7.0](../../delivered/0.7.0/README.md); new evidence moves there
  before this file overwrites it ([rules](../../delivered/README.md#rules)).

- **0.7.0 native acceptance (2026-10-20):** release PR #85 at `4590d34`, CI run
  `39327153830` six green jobs; CI VSIX `coagent8-mcp-0.7.0.vsix` SHA-256
  `0ebb354e98f7da94b131c10a0870aaba498866220b814ca3c16d3ddbb06c6390`, tarball
  `f0655c7b4bc2b3c48d6539fa4159175b7f60ab05e78db84ec4ec5e1e200c9ae2`, runtime
  `dist/index.cjs` `2e0828374cc8b088eefda0dd32e6a1707cf7b6ced0aa9508db1a1cba712fc043`.
  Codex, Claude Code and Antigravity in VS Code on Windows started that runtime
  (`~/.coagent8/runtime/2e0828.../index.cjs`) and passed issue, doctor, consult
  with continuation, seeded-defect review BLOCKED then READY on the same handle,
  session list/history/cancel, closed-session refusal and cleanup. Codex could
  not delete its scratch repository (its own execution policy). An earlier
  Claude Code run used a manual registration of the source build and does not
  count. Findings: [FEEDBACK-070](../../ROADMAP.md#feedback-070-findings-of-the-070-native-acceptance),
  fixed in #86 (`87c7b13`) before the tag; then #85 is rebased, its new
  artifacts accepted again and the release review bound to their hashes.

- **Next session starts here (owner decision 2026-10-19):** finish `0.7.0`
  only. Release simplification is merged as `f0de595` (#83), following the
  completed agent implementation rows (#68-#82). `DELEGATE-001` belongs to the owner on a separate branch;
  do not touch it or implement `0.8.0` work in this session.
- **Release simplification (#83, 2026-10-19):** direct npm publication and
  CI dry run are merged. Independent Codex review READY, coverage COMPLETE,
  no P1/P2, handle `syn_sess_b8101fd87f1d7fc6073c983b`, reviewed head `a753055`;
  PR CI six green jobs. Squash `f0de595` is Verified and has the same tree.
  Author checks: TypeScript, dependency boundaries, build, full tests (905 pass,
  zero fail, three skipped, expected `WINDOWS-001a` TODO), docs, consumer smoke,
  publish dry run and changelog title preview passed on Windows / Node 26.10.0.
  Never run the full suite concurrently with CoAgent8 review.
- **0.7.0 owner gates and order (2026-10-19):**
  - Later owner decision 2026-10-19 supersedes the earlier Marketplace setup
    gate: the owner uploads the exact verified release VSIX manually through
    publisher `okidev`. Do not require `VSCE_PAT` or
    `MARKETPLACE_PUBLISHING=true`, and leave the Marketplace job disabled.
    Release PR preparation may proceed. npm remains automated;
    `NPM_TRUSTED_PUBLISHING=true` already exists.
  - WSL 2.18 (`ACCEPT-001c`, including 2.12d POSIX recovery) and Open VSX 5.5
    (`PROPOSALS-001b`) move to `0.8.0`. Namespace `okidev` is created;
    [ownership request](https://github.com/EclipseFdn/open-vsx.org/issues/14422)
    is recorded. Neither blocks `0.7.0`.
  - The release PR contains only synchronized versions, generated changelog
    (`npm run changelog -- --tag v0.7.0`) and the required tester header
    `docs/releases/v0.7.0.md`. Give the owner links to the PR head's CI VSIX and
    tarball for UI acceptance (2.36); finish native acceptance and the independent
    release review bound to base, candidate, tree and artifact hashes.
  - Stop before release merge, tag or publication until the owner explicitly
    authorizes each step. Order: merge, tag `v0.7.0`, verified draft from
    `release.yml`, npm configuration, Publish, **Verify published**, later `latest`.
  - On release day just before publishing the verified draft, the owner creates
    the npm trusted publisher: user `oktawianwybieralski`, repo `coagent8`, workflow
    `npm-publish.yml`, no environment, **Allow npm publish** enabled and **Allow
    npm dist-tag** disabled. Unvalidated configuration expires after about
    48 hours. The owner removes GitHub's unused `npm` environment; `github-pages`
    stays for `docs.yml`.
  - Publishing the verified GitHub Release draft is the approval: npm publishes
    its exact verified tarball directly to `next` through trusted publishing
    with provenance. No staging or npmjs.com 2FA approval. After npm publication
    and the owner's upload of the exact verified VSIX, run **Verify published**
    for `next` and the Marketplace. The owner
    promotes a stable version manually: `npm dist-tag add coagent8@X.Y.Z latest`.
- **Released baseline (`0.6.1`):** `v0.6.1` is an annotated tag on `55c7859`
  (`chore(release): v0.6.1 (#32)`), published on GitHub, npm (`latest` and
  `next`) and the VS Code Marketplace ([release evidence](../0.6.1/README.md#061-release-evidence)).
  It is the first release under the MIT License. Its changes are listed in
  `CHANGELOG.md` and the [PATCH-061 queue](../../ROADMAP.md#patch-061-061-task-queue).
- **Next work: the [0.7.0 plan](../../ROADMAP.md#070-beta3-plan)** (owner direction
  2026-10-13). Phase 0 is owner decisions on
  [`PROPOSALS-001`](../../ROADMAP.md#proposals-001-proposals-awaiting-an-owner-decision),
  the npm publisher mode and release channel and the `0.7.0` write scope;
  Phase 1 is the public CLI (`CLI-FIRST-001a-e`). Publication automation
  ([`RELEASE-001`](../../ROADMAP.md#release-001-automated-publication)) is Phase 5,
  before the tag: the `0.6.1` publication path broke twice and npm and the
  Marketplace were published by hand. The `PATCH-061` native tasks that did
  not run before `0.6.1` are part of the `0.7.0` acceptance.
- **Phase 1 status (2026-10-13):** rows 1.1-1.13 of the
  [task queue](../../ROADMAP.md#tasks-070-070-task-queue) are merged:
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
  Rows 2.26a-d (`AX-002d-i`, "Recency under a price limit") are merged in PR #47:
  selection ranks models under a price limit by release recency, the doctor models
  view lists the day the price list added each model, models without a known date
  sort last, and expiration dates are ignored.
  Rows 2.6-2.8 (`FEEDBACK-061c1`, `FEEDBACK-061d`, `FEEDBACK-061f`, "Bug-report
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
  Result group 2.9-2.10 ("Bug-report opening actions", `FEEDBACK-061c2/c3`) is completed
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
- **Row 2.29 (`AUDIT-001-A08`-`A21`, 2026-10-19):** each card reproduced first. A08 found no
  defect (a failed session publication returns no handle, acquires no turn, leaves no
  file), so A09 is skipped. A10-A12: `writeChecked` retries a client file replacement
  that Windows refuses for a moment (EPERM/EBUSY/EACCES) and never overwrites an edit
  made meanwhile (`tests/integrations/setup-write.test.js`). A13-A15: the model
  observation cache is bounded to 100 entries (LRU). A16-A18: the torn-tail check reads
  the log backward (8 KiB instead of the whole log; agrees with the old scan on 200
  generated logs). A19: free-text bug reports have no safe boundary after a diff, so the
  conservative redaction stays and A20 is skipped. Native Windows sharing violations
  were simulated, not observed.
- **Row 2.12e (`ENVELOPE-001a`, server-owned review terminator, owner decision
  2026-10-18):** the review prompt ends the envelope with `CHECKS`; `evaluateStateEnvelopeGate`
  takes the turn's completion evidence (terminal status and `lengthLimited`) at both call
  sites (`src/execution/controller.ts`, `src/mcp/result.ts`), accepts a missing `END_REVIEW`
  only with `CHECKS` last, a completed turn and untruncated output, and the formatter then
  appends it; the Claude collector reports `stop_reason: max_tokens` as `lengthLimited`, which
  blocks with either end. Codex and agy stop reasons are `ENVELOPE-001b`. Native
  check on 2026-10-18 (Windows 11, candidate tarball `d54f1b19...47db3` packed from the
  branch, `--backends claude --model claude=claude-haiku-5-5`): all nine Claude scenarios
  and `n3_close` passed, including the review (complete coverage, server verdict BLOCKED
  on the seeded contradiction) and its unchanged repeat without a turn, so the review
  was judged; the run reproduced the `cachedGrowthBookFeaturesAt` write, accepted and
  reported by the home check.
- **Release split (owner decision 2026-10-15):** `0.7.0` is a stability release and
  `0.8.0` (rc.1) carries delegation and orchestration; the
  [ROADMAP split](../../ROADMAP.md#070-beta3-plan) assigns each open row. The owner's
  Claude Code, Codex and VS Code registrations run the working-tree build
  (`dist/index.cjs mcp`); rebuild with `npm run build` and restart the client's
  MCP server to pick up changes. Rows 2.13-2.17 and 3.9-3.13b are done; the
  server-owned review terminator is merged (#72). Remaining `0.7.0` work is
  release simplification, 2.36 and release rows 5.9-5.12. WSL 2.18 and Open VSX
  5.5 move to `0.8.0` (owner decision 2026-10-19). The owner develops delegation
  (`DELEGATE-001`) on a separate branch.
- **Rows 2.15 + 2.16 (`ACCEPT-001b` isolated user home, `ACCEPT-001a1` runner skeleton, #67):**
  `tooling/acceptance/` creates its own temporary root, gives every child an explicit
  isolated environment (contract in [ACCEPT-001](../../ARCHITECTURE.md#accept-001-automated-native-acceptance)),
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
- **Row 2.17 (`ACCEPT-001a2` scenarios N2-N4):** `npm run acceptance:native --
  --with-backend-auth` drives 30 scenario steps per run through the installed npm
  package and the real CLIs ([contract](../../ARCHITECTURE.md#scenarios-n2-n4-accept-001a2));
  the fixture lane `tests/acceptance/scenarios.test.js` runs every scenario in CI with
  the Codex double. Native runs on Windows 11, Node v26.10.0, VS Code 1.142.0, 2026-10-18,
  candidates packed from the branch (tarball
  `84f38299d3c8a2c461dc0ed1c773ddea1b07379dc348a322be946966f3266400`, VSIX
  `7c0fbbc9c70ed0ccb7334a599f9ff9bb12c07bee53e6ad012b81715d481ca184`, runtime 0.6.1,
  bundle `98ccb4b9...6e3868`), `codex-cli 0.162.0-alpha.17.2`, Claude Code 2.1.301, agy 1.4.2:
  - Recorded run (19:13 UTC, 224 s): status `INCOMPLETE` with 37 PASS and only `n2_quiet` NOT_RUN
    (a console window is an owner UI check). Codex `gpt-6.1-sol` and agy
    `gemini-3.8-flash` are their defaults; Claude ran `claude-sonnet-5-5` by
    `--model`, because its default `claude-opus-5-5` needs approval in a fresh
    configuration (the owner's allow list stays in the real home) and the runner never
    grants it. Every backend: consult, continuation, history paging, workspace
    isolation, review (server verdict BLOCKED on the seeded contradiction, recorded,
    not asserted), unchanged repeat without a turn, TIMEOUT naming the 1,000 ms budget,
    and cancel of a running turn (refused from another server process, cancelled by
    the owner, lease released, reused). Close, closed-session refusal and
    `delete_history` passed on Codex. The five watched home files were unchanged
    (no backend cache write occurred in that run).
  - Earlier runs found runner defects, fixed before the recorded run: the timeout
    check missed `[TIMEOUT, retryable]`; a cheapest-model run (`claude-haiku-5-5`)
    failed Claude's review twice with "no review envelope", an envelope whose final
    `END_REVIEW` line was apparently missing (the gate requires it), which led to the
    owner decisions below. Two runs reported the real `~/.claude.json` modified. I first
    attributed it to this session's own Claude Code client; that was wrong. The
    violation message now names the changed top-level keys (never values): only
    `cachedGrowthBookFeaturesAt` changed, at 21:05:21 local, inside the first Claude
    scenario turn (21:05:18-21:05:23), so the native Claude Code binary refreshes its
    feature cache in the real profile although `HOME` and `USERPROFILE` are isolated.
    With `--with-backend-auth` the check now accepts exactly that key and reports it;
    any other change, such as `mcpServers`, still fails.
  - Not covered here: the VSIX runtime (it starts only in the editor), quiet
    execution, model discovery after installation, and two separate client
    applications for `PATCH-061-N4`; they stay in the 5.10 acceptance.
- **Owner decisions 2026-10-18 (review models and terminator):** scenarios use each
  backend's default model, what a user gets with `auto`; `--cheapest` is opt-in.
  The review terminator `END_REVIEW` becomes server-owned: the model no longer has
  to write it, and the gate accepts an envelope without it only on observed
  completion evidence (consulted design, session `syn_sess_8bf51979b8095360e87ea4b0`).
- **Owner decisions 2026-10-18 (row 3.0):** `PROPOSALS-001k`, `l` and `n`
  accepted, `l` moved from `0.8.0` to `0.7.0` (row 3.10b, with 3.10); `m`
  deferred as research only. Rows 3.13 and 3.13b are done: rule 02 requires an
  explicit lease with `--force-if-includes`, rule 04 keeps agent files out of
  `.artifacts/`, and the rules and documents describe the branch model without
  naming an external project (#68); rows 3.9-3.11 followed in #69 and #70. WSL lane 2.18 needs an Ubuntu distribution with
  Node and signed-in CLIs; on 2026-10-18 the machine had only `docker-desktop`.
- **PR scope (owner direction, 2026-10-13):** use the
  [result groups](../../ROADMAP.md#pr-groups-and-existing-history), with subtasks as
  commits/checklist items on one branch. Merged #33-#45 keep their history;
  PR #46 implements result group 2.3-2.4. Required review and
  CI cover each complete result; a task ID or line count is not a PR boundary.
