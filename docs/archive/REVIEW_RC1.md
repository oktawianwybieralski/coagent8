# Independent Review of RC1 Preparation

Date: 2026-10-03. Author: Codex Integrator. Reviewer: Independent local executions of Codex Sol (`gpt-6.1-sol`), `--sandbox read-only --ephemeral`, without models requiring explicit approval. The Codex adapter was initially excluded from this passed snapshot: it was owned by the GEMINI agent and tracked as a separate release blocker.

The initial execution against the live working tree could not read files: execution policy rejected `Get-Content`/`git diff` in the sandbox. Permissions were not escalated. Subsequent reviews received a complete numbered snapshot of sources, tests, scripts, fixtures, and the Windows supervisor via stdin. The reviewer performed a **static review** without direct tools, test runs, or live smoke tests. This does not replace independent test execution or formal RC acceptance.

## Findings and Remediations

| Reviewer Finding | Author Remediation | Regression Evidence |
| --- | --- | --- |
| P1: oversized message/native ID could hang history fragment reduction | IDs bounded to 256 bytes, metadata budget and progress condition | `oversized provider metadata cannot hang history pagination` |
| P2: page limit=1 advanced cursor past unreturned fragment | Event limit checked prior to calculating fragment/cursor | `history fragment pagination ... without skipping an unreturned prefix` |
| P2: close of expired/invalidated/closed session bypassed workspace | Workspace verified on raw record under storage lock | `closing expired, invalidated or already closed sessions ...` |
| P1: implicit default Opus in Claude bypassed governance | Explicit Sonnet / effective environment mapping, alias verification before spawn | `Claude uses the common runner ... governed effective model ...` |
| P2: smart_quota selected installed but unsupported CLI | Filtered capabilities in auto/ranking, explicit choice without fallback | `auto and smart_quota ignore an installed but unsupported provider ...` |
| P2: child processes held pipe open after leader exit until deadline | Teardown starts on exit, close awaits completion | `F06: timeout, cancellation, EOF shutdown ...` with inherited stdout/stderr |
| P2: close ignored unmigrated legacy record | Unified read for raw fallback and primary tombstone | `RC-08: legacy config/session/quota migrate ...` |
| P2: missing production pruning for metadata/claim dirs | Pruning at startup and execution, deleting only empty dirs | `production execution automatically prunes ... history disabled` |
| P1: Claude startup hooks bypassed read allowlist | Verified availability of `--bare`, disabled hooks, and strict empty MCP | Claude argv fixture; real Claude remains unverified |
| P2: deletion of empty claim dir between mkdir and publication | Publication retry on ENOENT, unique claim files | `claim publication recovers deterministically ...` with forced interleaving |
| P2: cursor after draft skipped subsequent final snapshot | Cursor tied to revision, explicit HISTORY_CHANGED and read restart | `live pagination rejects a changed snapshot ...` |
| P2: migration ignored live lock in legacy directory | Checked primary and legacy locks; live/corrupt fail closed | `RC-08: legacy ...`, live PID next to unmigrated record |
| P2: relative data dir corrupted Gemini profile isolation | Central `path.resolve` before switching provider cwd | `Gemini resolves relative primary and legacy data directories ...` |
| P2: truncation before redaction exposed credential prefix | Redaction before truncation and recognition of truncated prefixes | `diagnostic and issue truncation cannot expose ...`, 64/512/4096/512KiB |
| P2: relative workspace routed Gemini to isolated cwd | Workspace resolver returns absolute paths; adapter absolutizes instructions | Test of relative Gemini workspace capturing prompt and `resolveWorkspacePath('.')` |
| P2: large staged/commit/range/branch exceeded prompt input limit | Unified `boundedSnapshot` applied across all Git scopes, 3 MiB | Live Git fixture with diff >4 MiB across four scopes; prompt fits within 4 MiB |
| P2: unclosed quoted credentials leaked across aborted stream | Redaction to end of incomplete text, including broken escapes | `cancelled Gemini partial quoted credentials ...`, runner/parser fixture and disk save |
| P2: shutdown snapshot allowed spawning next phase of pending task | Dedicated lifecycle latch blocks admission before teardown; basic cancel-all does not block future tasks | `F06: server shutdown blocks a pending task ...`, isolated process and no launch marker |

Multi-process tests additionally uncovered Windows delete-pending EPERM. Claim reading is retried with a limit, avoiding falsely marking an inaccessible live owner as dead. All fixes are applied by the author; the reviewer remains independent.

One unconfirmed finding regarding alleged removal of `resolveOrInitSession` was rejected: the snapshot contains that exact export in `session.service.ts` and imports/calls in tests. The test and entire suite passed on Node 22.20.0 and 20.0.0. Valid APIs were not changed based on inconsistent reviewer descriptions.

## Final State

Final snapshot **`7588ab7058bbc1f2778e038db10d2c37a1341a5e091ad9e47dc21d542fe16c2b`**: `completed`, terminal `turn.completed`, no protocol errors. Reviewer verdict: **"No concrete P1/P2 findings in the supplied snapshot."** Reviewer confirmed that hypotheses regarding a non-existent helper and suffix leakage after semicolons were not supported by the codebase. Verification was static; reviewer did not execute tests directly. Subsequent changes consist of documentation updates and EOF formatting adjustments without altering code behavior.

Timeouts or missing terminal events do not constitute passing review; previous findings files are never treated as the result of a subsequent run. Private reasoning of the reviewer is never recorded.

Full independent test/read-only execution of both CLIs, host UI verification, and 6/6 CI matrix remain open per [RC1_STATUS.md](RC1_STATUS.md). Specifically, Claude fixtures and static review do not prove live tool refusal.

