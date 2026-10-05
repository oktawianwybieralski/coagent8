# CoAgent — RC1 Execution Plan & Agent Handoff

**Date:** October 3, 2026. **Release Target:** `1.0.0-rc.1`, upon fulfilling all quality gates below. Current development version remains `0.9.0-dev` until release artifacts are finalized.

**Initial Work Division:** Gemini agent owns Codex CLI adapter; Codex agent owns Gemini CLI adapter and shared integration. **Update 2026-10-03:** Primary Codex execution path, shared runner contract, live progress reporting, and trailing throttle have been implemented and verified. Message history, live progress visibility, and clean chat rendering remain in active RC1 scope.

Technical foundation: [AUDIT_CODEX.md](../AUDIT_CODEX.md), findings F01–F25. This document serves as the active execution plan. [PLAN_V1.0.0.md](PLAN_V1.0.0.md) preserves historical roadmap context; checkmarks there do not constitute release sign-off.

Implementation progress and local evidence are tracked in [RC1_STATUS.md](RC1_STATUS.md). Acceptance criteria remain binding; test suite and fixtures alone do not substitute for live smoke tests, host UI checks, or CI matrix verification.

## 1. Current State & Immediate Task Order

Current integration base: `bb4b406` -> `fee1380`; active feature branch: `feat/chat-progress-ui`.

- [x] Registered Codex adapter uses the shared runner and mandatory `TerminalExecutionResult`; resolved response loss from `PROTOCOL_ERROR`.
- [x] Production adapter with fixtures: 2-turn resume, public event mapping, durable history, and secret redaction; **58/58 tests PASS** locally on Windows / Node 22.20.0.
- [x] Live Codex execution verified: turn 1 execution, turn 2 context resume, read-only sandbox refusal ("Access denied").
- [x] Live progress UI enhanced: safe phase status events (reasoning, turn started, sandbox execution), trailing throttle (500 ms window without message drops), and contextual heartbeat.
- [x] Independent Author-Reviewer review by Codex Sol (`codex_review_code`): audited uncommitted diff, remediated two P2 findings, full acceptance achieved.
- [x] Development tarball: clean install with `--omit=dev`, 3 bin aliases, MCP handshake, 2-turn fixture history for both Codex and Gemini.

Next sequential tasks:

1. **Codex Probe & Legacy Cleanup (RC-03A/09):** Align Codex `probe()` with `AdapterProbeResult` (`executionSupported`, `capabilities`, `authStatus`, `modelSource`). Deprecate or remove unused legacy exec/review helpers in `codex.adapter.ts`.
2. **Authenticated Gemini Smoke (RC-03B/07):** Execute 2 live turns via Gemini CLI using existing local credentials; verify resume and read-only policy refusal.
3. **Chat Response & History UI Refinement (RC-06):** Format final chat Markdown cleanly across VS Code and Antigravity; introduce structured turn-based dialog view for `coagent8_session_history`.
4. **CI Matrix Verification (RC-11/12):** Run all 6 CI matrix jobs across Windows, Linux, and macOS on Node 20 and Node 22.
5. **RC Artifact & Publication (RC-12/13):** Bump version to `1.0.0-rc.1`, freeze lockfile and manifests, generate verified tarball with SHA-256 hash, and execute PR squash & merge.

## 2. Work Division & Change Boundaries

| Component | Owner | Deliverable |
| --- | --- | --- |
| Codex: argv, exec/review/resume, parser, phase events | Gemini Agent | `src/adapters/codex.adapter.ts`, `test/codex.adapter.test.js`, Codex fixtures |
| Gemini: resolver, probe, execution, parser, resume, read-only | Codex Agent | `src/adapters/gemini.adapter.ts`, `test/gemini.adapter.test.js`, Gemini fixtures |
| Shared launcher/runner, process teardown, limits | Codex Agent | `src/services/process.service.ts`, resolver/parser helpers, process tests |
| Types, registry, tool pipeline, MCP schema and validation | Codex Agent | `src/types/`, router, server, `src/tools/`, contract tests |
| Sessions, locks, history, progress, chat formatting | Codex Agent | session/progress/common, history/events modules, session tools and tests |
| Config, rebranding, doctor/quota, Git snapshot | Codex Agent | Shared services and tests; integrates adapter probe data |
| Packaging, documentation, CI, RC preparation | Codex Agent | Manifests, lockfile, workflows, README, release checklist, verification evidence |
| Independent Author-Reviewer Audit | Reviewing Agent (opposite author) | Read-only sandbox review; author remediates all findings before merge |

## 3. Conversation & Response Contract

### 3.1. Data Flow

```text
Tool Call / User Message
  -> pipeline: validation, routing, model governance, session lease
  -> provider CLI: stdin + stdout JSONL + diagnostic stderr
  -> provider parser -> normalized public adapter events
  -> local durable history + MCP notifications/progress + final result
  -> MCP client renders formatted Markdown and activity indicators
```

CoAgent captures messages and events strictly for processes it spawns. Native CLI session IDs preserve model context; local SQLite/JSON history provides durable inspection across restarts. Both mechanisms are independently tested.

Shared types in `src/types/adapter.types.ts` and `conversation.types.ts`:
- `ProviderId = 'codex' | 'gemini' | 'claude'`; routing strategies `auto` and `smart_quota`.
- `ExecutionOptions`: workspace, resolved model, native session ID, timeout, abortSignal, `onEvent(event)` callback, userConfirmed governance flag.
- `ConversationEvent`: schemaVersion, eventId, sequence, timestamp, sessionHandle, turnId, provider, nativeEventId; payload is a validated union.
- Event types: `turn_started`, `user_message`, `assistant_delta`, `assistant_message`, `tool_started`, `tool_finished`, `status`, `warning`, `error`, `turn_finished`.
- `TerminalExecutionResult`: status `completed | failed | cancelled | timed_out`, public output, nativeSessionId, exitCode/signal, typed error, provider usage, truncation flag, continuation availability.

Private reasoning, raw environment variables, authentication secrets, and raw tool arguments containing sensitive data are strictly excluded from public events and history. Diagnostic stderr is never treated as assistant text.

### 3.2. Final Tool Result in Chat

`content[0].text` delivers clean Markdown for user consumption; `structuredContent` and matching `outputSchema` provide machine-readable metadata.

Response layout:
- Primary assistant answer in full Markdown at the top.
- Minimal, discrete footer:
  > ⏱️ *Codex (gpt-6.1-sol) · Completed in 18.2s · 2 operations*  
  > 💬 *Session:* `syn_sess_...` *(continuation available)*
- On failure, clear error code, actionable diagnostic summary, and partial response if available.

### 3.3. In-Progress Execution (Live Progress)

- Emit standard `notifications/progress` using request `_meta.progressToken`. Monotonically increasing `progress` counter without `total` when overall steps are indefinite.
- Emit constant, safe phase labels for CLI events (e.g. session initialization, task analysis, sandbox execution, response formulation) without leaking raw tokens, private thoughts, or raw command lines.
- Throttling: buffer the latest update (trailing dispatch) with a ~500 ms window to prevent client UI flicker while guaranteeing delivery of the latest state.
- Contextual heartbeat: when no new events arrive for >= 10 seconds (e.g. extended reasoning), report a contextual message tied to the last known phase (e.g. `Operation in progress (Analyzing context and architecture..., 15s)...`) rather than a raw bus idle timer.
- Terminal cleanup: cancel heartbeats, timers, and pending buffers immediately upon completion or disconnection.

### 3.4. History & Retention

- Durable, versioned event store under CoAgent data directory with tool `coagent8_session_history(session_handle, workspace_path?, cursor?, limit?)`.
- Reads are ordered, byte-bounded, paginated, and scoped to canonical workspace.
- Default resource boundaries: 512 KiB per diagnostic stream, 512 KiB per JSONL record, 1 MiB public response, 4 MiB composite prompt, 10 MiB per session history, 100 MiB total storage, 100 events / 240 KiB per page.
- History retained locally for 7 days by default; configurable via `coagent8_HISTORY`. `close_session(delete_history=true)` removes local session transcripts.

## 4. Release Stages & Quality Gates

| Stage | Priority | Owner | Scope & Findings | Acceptance Criteria |
| --- | --- | --- | --- | --- |
| RC-01 | P0 | Shared | Freeze event/result/options contracts, error codes, runner launcher; F15/F16 | Unified interface across both adapters; identical public event mapping |
| RC-02 | P0 | Codex | Shared resolver and runner; F02/F05/F06/F08 | `.exe` and `.cmd` shims run via JS entrypoint; pre-abort prevents spawn; teardown cleans process tree; buffer limits enforced |
| RC-03A | P0 | Gemini | Codex execution, review, resume, terminal status; F03/F07, F17/F18 | Valid argv, sandbox enforcement, error classification, 2-turn live resume |
| RC-03B | P0 | Codex | Production Gemini adapter; F01/F02/F06/F08 | Real headless execution, exact UUID resume, read-only profile, typed errors |
| RC-04 | P1 | Codex | Sessions: atomicity, async locks, ownership leases, schema, invalidation; F09–F12 | Deterministic lock race and multi-process tests pass; non-blocking event loop |
| RC-05 | P0 | Codex | Registry, routing, unified tool pipeline; F01/F15/F16 | All tools route to appropriate adapter; schema consistency; session pinning |
| RC-06 | P0 | Shared | History, message capture, live progress, final chat renderer; F12/F20 | Full public conversation available across restarts; no duplicates; UI verified |
| RC-07 | P1 | Codex | Redaction and model governance; F13/F14 | Secrets redacted from errors/progress/diagnostics; top-tier confirmation enforced |
| RC-08 | P2 | Codex | Config/session/quota migration, clean branding; F17/F25 | Primary paths with explicit legacy fallback; Omni aliases preserved cleanly |
| RC-09 | P2 | Shared | Doctor diagnostics, rate-limit cooldown, candidate ranking; F18/F19 | Installed/auth/capability separated; model provenance; atomic cooldown cache |
| RC-10 | P2 | Codex | Git snapshot & prompt budgets; F21 | Staged/uncommitted/SHA/branch scopes verified; subdirectory support; 4 MiB prompt budget |
| RC-11 | P1 | Shared | Tests, coverage, CI matrix; F24 | 100% test pass rate, 0 skipped, >70% coverage across whole `src/`, 6/6 CI matrix |
| RC-12 | P0 | Codex | Toolchain, metadata, packaging, onboarding; F04/F22/F23 | Clean tarball install on supported OS/Node, bin aliases and MCP functional |
| RC-13 | P0 | Independent Reviewer | Final review, release checklist, publication | 0 open P0/P1/P2 findings; accepted PR + green 6/6 CI; authorized npm publish |

## 5. Local Quality Gate Workflow

Before any commit or PR, execute the mandatory local gate:

```powershell
npm run typecheck
npm run build
npm test
npm pack --dry-run
git diff --check
```

Merge exclusively via **Pull Request with Squash and Merge** after independent review approval and 6/6 green CI matrix.

