# RC1 - Implementation & Acceptance Status

Date: 2026-10-03. Current branch: `feat/chat-progress-ui`, integration base: `bb4b406` -> `fee1380`. Development version remains `0.9.0-dev`; `1.0.0-rc.1` is not declared ready until all release gates in [PLAN_RC1](PLAN_RC1.md) are satisfied. Scope of current work: progress UI enhancement, Author-Reviewer review, documentation translation, and local commits. No push, PR, merge, tag, or publication has occurred.

History: `43969b0` - audit/plan; `7f01e72` - shared foundation; `bb4b406` - Gemini, pipeline, and history; `fee1380` - Codex execution restoration; `3da6d09` - safe live phase progress, trailing throttle, and contextual heartbeat. [Handoff GEMINI](HANDOFF_GEMINI_RC01_RC02.md) documents initial delegation.

## Codex Integration Fix & Live Verification - 2026-10-03

The branch continues from snapshot `bb4b406`. Reproduced regression: legacy adapter result omitted `status`, causing shared controller to return `PROTOCOL_ERROR`, empty response, and continuation failure. The registered Codex adapter now uses the shared runner and returns the required `TerminalExecutionResult`. The registry enforces this type for all providers.

Live testing against real local Codex CLI (`codex-cli 0.160.0`):
- Turn 1 real execution: `completed`, returned valid `threadId` and output in 21s.
- Turn 2 multi-turn resume: `completed`, remembered turn 1 context cleanly via native thread resume.
- Read-only sandbox guard: attempted write of `test_sandbox.txt` was actively blocked by CLI sandbox ("Access denied"). File was not created.
- Progress reporting: phase status events emitted for task analysis, reasoning, and tools; trailing throttle prevents message drop on close.
- Independent Author-Reviewer review by Codex Sol (`codex_review_code`): evaluated uncommitted diff, remediated two P2 findings (flush on close, idle threshold for heartbeat), and received full green acceptance.

## Current Local Verification Evidence

Windows, Node **22.20.0**, 2026-10-03:

- Typecheck, build, `npm test`, `npm pack --dry-run`, and `git diff --check`: PASS; **62/62 tests**, 0 skipped/todo.
- Test coverage across `src`: satisfies CI development threshold of 70/70/70/75; `codex.adapter.ts` statement coverage is **86.97%** and functions **76.47%**.
- `npm run test:consumer`: PASS. Clean installation of development tarball with `--omit=dev`, three bin aliases, MCP initialize/list/EOF, 2 fixture turns each for **Codex and Gemini**, durable history and redaction verified. Consumer uses installed bundle without tsx or esbuild.
- Build time: 45-51 ms, consistently meeting the <100 ms target.
- Codex **0.160.0**: live multi-turn execution and sandbox refusal verified.
- Antigravity / Gemini CLI (`agy.exe 1.2.15`): live command execution verified (`agy -p` answered repository inspection prompts in full Markdown).
- CoAgent8 MCP Commands: live verification of `coagent8_doctor`, `coagent8_quota_status`, `coagent8_report_bug`, `coagent8_set_default`, `coagent8_session_history`, and `coagent8_close_session`.
- Chat UI Refinement (RC-06): Response layout updated to answer-first clean Markdown with discrete footer metadata; live heartbeat computes total elapsed runtime from start; session history implements turn-grouped readable dialog formatting with global turn numbers (`getTurnMapping`) preserved across pagination.

## Release Stages (Snapshot `bb4b406` + Current Enhancements)

| Stage | Implemented & Verified | Open Acceptance Criteria |
| --- | --- | --- |
| RC-01/02 | Shared contract, typed status/errors, UTF-8 resolver/runner, resource limits, process teardown, F02/F05/F06/F08 regressions | POSIX / CI cross-platform matrix |
| RC-03A | Production Codex adapter migrated to runner, live 2-turn execution, sandbox refusal verified, dead legacy helpers removed | Complete (`4146beb`) |
| RC-03B | Production Gemini adapter modernized to Antigravity agy CLI, live multi-turn execution, sandbox refusal verified, obsolete npm profile removed | Complete |
| RC-04 | Asynchronous unique claims, atomic file operations, PID/token lease, TTL/schema/invalidation/workspace, Windows mkdir race fix | Multi-OS cross-platform verification |
| RC-05 | 3-provider registry, distinct routing, unified execution controller, MCP validation/schema, provider/workspace pinning | Complete |
| RC-06 | Durable public history, canonical snapshots, deduplication, live phase progress, trailing throttle, contextual heartbeat | Host UI verification across different clients |
| RC-07 | Shared secret redaction across streams and truncation boundaries, effective model governance before spawn | Live authenticated Claude verification |
| RC-08/09 | Primary/legacy data paths, doctor diagnostics, rate-limit cooldown cache, unsupported CLI filtering, probe capability alignment | Complete (`4146beb`) |
| RC-10 | Git scope fixture: staged/uncommitted/SHA/branch/range/untracked, subdirectory workspaces, bounded prompts | Cross-platform CI confirmation |
| RC-11/12 | Zero-argument discovery, 62 tests, coverage >70%, Node 20 minimum, clean packaging, consumer tarball smoke | 6/6 CI matrix (Ubuntu/macOS × Node 20/22) |
| RC-13 | Independent static reviewer: zero P1/P2 findings on progress diff; regressions and fixes documented | Final PR squash & merge, authorized publication |

## Release Blockers

1. **CI Matrix 6/6**: Execute all 6 matrix jobs across Windows, Linux, and macOS on Node 20 and Node 22.
2. **Formal RC Version Bump**: Maintain `0.9.0-dev` until all criteria above pass before promoting to `1.0.0-rc.1`.

