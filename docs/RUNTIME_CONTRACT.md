# CoAgent8 Runtime Contract (v1.0.0 Specification)

> **Status:** Authoritative Runtime Contract  
> **Release Target:** CoAgent8 v1.0.0  
> **Applicability:** All CLI adapters (`codex`, `gemini`, `claude`), shared controller, process runners, and storage services.

This describes current implementation, not the proposed simplified API.
[ROADMAP.md](ROADMAP.md) owns migration and acceptance for optional durable
history, reduced supervision and audit remediation. Where the implementation
violates this contract, the deviation is listed in
[section 7](#7-known-deviations-audit-at-c265cdf) rather than silently assumed
away. Local contributor verification is defined separately in the
[quality gate](../.agents/rules/04-quality-gate.md).

---

## 1. Controller & Tool Surface

The central execution controller is [`src/execution/controller.ts`](../src/execution/controller.ts). Tool handlers supply a composed internal prompt and a sanitized public user message. Dynamic routing chooses an active CLI adapter; the adapter handles command arguments and native event parsing. Process execution, storage, progress telemetry, heartbeats, and Markdown rendering are completely shared.

Backend selection: an explicit `backend` or the configured `defaultBackend` is used as given. Otherwise `auto` with one eligible backend uses it, and with several it selects like `smart_quota`:
* it skips the calling client's own CLI, derived from `clientInfo.name` (`claude` → Claude Code, `codex` → Codex, `antigravity`/`agy`/`gemini` → agy), unless only that CLI is available;
* it skips providers with an observed rate limit;
* it prefers the largest measured headroom, counting an unmeasured quota as 50%;
* ties keep the provider order `codex`, `gemini`, `claude`.

The client name is self-reported and only steers this preference; it never relaxes a policy.

### Dual Tool Profiles
1. **Canonical Profile (Default)**: Advertises the six core tools; the three
   deprecated aliases are callable but not advertised:
   * Core execution: `consult` (optional `task_type`: `architecture`, `debug`,
     `implementation`), `review`.
   * Management: `doctor`, `session`, `cancel`.
   * Feedback & Diagnostics: `issue`.
   * Deprecated aliases of `consult`: `analyze`, `debug`, `implement`. Each maps
     its arguments to `consult` and returns a deprecation warning.
2. **Compact Profile (`run`)**: Subcommand gateway exposing four tools:
   * `run` (actions: `consult`, `review`, `issue`; deprecated `analyze`, `debug`, `implement`).
   * `doctor`, `session`, `cancel`.

Every tool is callable in either profile; the profile controls advertisement only.

The server sends one sentence of `instructions` in `initialize` and declares its
icon once, in `serverInfo`; tools carry no icon. Execution parameters are defined
once (`src/tools/schema.ts`) with descriptions only where the name and enum leave
them unclear; the consent rule is in the `user_confirmed` description. The icon is
sent for every negotiated protocol version, because the SDK offers no supported
per-version server info; clients of protocol 2025-06-18 ignore the unknown field.

---

## 2. Options, Results & Typed Error Codes

### Execution Parameters (`ExecutionOptions`)
* `cwd`: Absolute canonical workspace path.
* `model`: Optional model override.
* `reasoningEffort`: Reasoning depth level where supported (`low`, `medium`, `high`, `xhigh`, `max`).
* `nativeSessionId`: CLI-native thread/conversation UUID for multi-turn resume.
* `timeoutMs`: Execution deadline in milliseconds.
* `abortSignal`: AbortController signal for in-flight cancellation.
* `userConfirmed`: Mandatory boolean true when requesting top-tier models (`astra`, `opus`).
* `onEvent`: Callback streaming normalized `AdapterEvent` updates to the history writer.

### Terminal Results (`TerminalExecutionResult`)
* `status`: `completed` | `failed` | `cancelled` | `timed_out`.
* `isError`: Boolean error indicator.
* `output`: Public sanitized Markdown response text.
* `error`: Optional typed error envelope `{ code, message, retryable }`.
* `continuationAvailable`: True if native multi-turn resume is supported and thread ID is valid.
* `truncated`: True if output reached capacity buffer limits.

### Structured Content
Execution tools return `structuredContent` validated by `outputSchema`:
`schemaVersion`, `provider`, `status`, `output`, `model`, `sessionHandle`, `turn`,
`verdict` (`READY` | `BLOCKED` | `NOT_APPLICABLE`), optional `reason`,
`warnings`, `continuationAvailable`, `truncated`, `historyAvailable`, optional
`error` and `activity` (`toolCount`, `durationMs`). Tool errors (`isError`) are
distinct from audit conclusions (`verdict`).

### Typed Error Codes (`ERROR_CODES`)
`CLI_NOT_FOUND`, `CLI_UNSUPPORTED`, `AUTH_REQUIRED`, `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `SESSION_INVALID`, `SESSION_BUSY`, `ABORTED`, `TIMEOUT`, `SANDBOX_UNAVAILABLE`, `PROTOCOL_ERROR`, `BUFFER_LIMIT`, `INPUT_LIMIT`, `PROCESS_ERROR`, `HISTORY_ERROR`, `POLICY_DENIED`.

`INPUT_LIMIT` is intended for rejected input. The current mapping of unknown
failures to it is a known deviation (section 7).

---

## 3. State Envelope Contract & Verification Gate

`review` (and `run` with `action: "review"`) enforces the structured **State
Envelope**. `consult` and its aliases return a plain answer with
`verdict: "NOT_APPLICABLE"` and no envelope instructions:

```text
REVIEW: <turn>
SNAPSHOT: <git_commit_sha>
COVERAGE: COMPLETE | PARTIAL
VERDICT: READY | BLOCKED

[P1/P2/P3] <file>:<line>
Problem: <concise statement>
Evidence: <reproducible detail>
Fix: <actionable remedy>

CHECKS: typecheck=<PASS|FAIL>; tests=<PASS|FAIL|NOT_RUN>
END_REVIEW
```

### Server-Side Gate Evaluation
In `formatExecutionResult` / `enforceStateEnvelopeGate`:
* Any reported `P1` or `P2` finding programmatically forces `VERDICT: BLOCKED`.
* Incomplete envelopes, missing `END_REVIEW`, partial coverage, or response truncation automatically overrides `VERDICT` to `BLOCKED`.
* Only complete reviews with 0 blockers (`P1`/`P2`) and complete coverage receive `VERDICT: READY`.

This gate validates reported text and envelope structure. It does not independently
execute or verify the reported CHECKS, inspect the named snapshot, or approve a
release. The `verdict` field is derived from model-written text: any `[P1]` or
`[P2]` string in the output blocks, including one quoted in prose.

---

## 4. Public Event Streaming & Storage

### Event Model
Adapters emit validated payloads: `assistant_delta`, `assistant_message`, `tool_started`, `tool_finished`, `status`, `warning`, `error`. The controller manages `turn_started`, `user_message`, and `turn_finished`. Identifiers and tool names are bounded to 256 UTF-8 bytes without control characters.

### Append-Only Storage, Retention & Torn-Tail Resilience

Session archival history is best-effort and bounded. Initial, periodic and final flush errors emit redacted warnings with `historyAvailable: false` and never fail the turn, block CLI invocation, or overwrite successful responses. Session turn leases remain fail-closed: a failure in `releaseSessionTurn` yields a hard session error (`SESSION_INVALID`), not `HISTORY_ERROR`. Post-execution session metadata and cooldown bookkeeping run outside the execution block; a metadata failure returns the secured output with a warning and `continuationAvailable: false`.

#### Retention and Capacity Policy
* **Capacity Bounds**: Each individual session's history log (`.jsonl`) is bounded by `SESSION_LIMIT` (10 MiB). Global history storage across all sessions is bounded by `TOTAL_LIMIT` (100 MiB).
* **Expiry Retention**: Sessions inactive for longer than 7 days (based on file `mtime` and `updatedAt`) are automatically pruned during directory retention maintenance.
* **Capacity Retention (LRU Eviction)**: When total history storage exceeds `TOTAL_LIMIT` or when writing a new batch would exceed it, the storage engine evicts whole inactive sessions in order of least recently used (LRU by `updatedAt` / `mtime`) until storage is within limits.
* **Active Session Immunity**: Sessions with an active turn lease (`activePid != null` or active turn lock) are strictly protected and are never evicted.
* **Oversized Output Handling**: If an answer or cumulative session exceeds `SESSION_LIMIT` (10 MiB), the full response is returned to the caller; archival persistence is truncated or skipped with a warning (`historyAvailable: false`).
* **Disabled Archival**: Setting `coagent8_HISTORY=off` disables history persistence completely; one-shot executions do not create or require history directories or files.

#### Streaming Deltas & Crash Resilience
* Streaming assistant deltas append to `.jsonl` as coalesced deltas per flush. Copying and serialization scale with new delta bytes, keeping persisted bytes within a small constant factor (<= 3×) of the response text size. Materialized `.json` snapshots are written atomically once, upon `turn_finished`.
* Secret redaction buffers an uncommitted tail across deltas so that credentials split across stream batches never reach disk unredacted.
* Under session file lock, `createHistoryWriter` inspects the log tail for torn or partial records from unexpected process crashes, repairing byte boundaries via in-place `fs.truncate`.
* Legacy logs with full snapshots continue to load, paginate, and resume with identical semantics.

### Pagination & Revisions
* `session` (`action: "history"`) returns at most 100 events and a 240 KiB page budget.
* Large messages are split at UTF-8 code point boundaries with `{ offsetBytes, totalBytes, complete }`.
* Cursors are opaque base64url structures bound to a specific snapshot revision. Concurrent writes trigger `HISTORY_CHANGED` to prevent skipping final response texts.

---

## 5. Subprocess Execution & Supervision

* `runCommand(command, args, options)` runs strictly with `shell: false`.
* Termination is layered. Only the spawned process is ever targeted, through the handle Node holds or the process group it created; nothing is selected by PID or parent PID, and no process snapshot or polling exists.
  1. **Protocol interrupt**: a run with a stdin protocol session (Claude, Codex) keeps stdin open. Cancellation, deadlines and server shutdown ask the CLI to end its turn; the session closes stdin on the terminal event and the CLI exits by itself.
  2. **Forced stop**: when the CLI has not exited within the grace period (3 s), or for runs without a session, the root is stopped. **Windows**: `proc.kill()` (`TerminateProcess` on the owned handle). **POSIX**: the detached process group (`detached: true`) receives `SIGTERM`, then `SIGKILL` after 250ms by default (2 s for agy, which has no headless interrupt and shuts down its own commands on `SIGTERM`).
  3. **Descendants**: on Windows, libuv's `KILL_ON_JOB_CLOSE` job ends a chain of Node processes with its root; descendants of native backends are the backend's responsibility. After the root exits, a descendant still holding stdout/stderr cannot delay the result by more than 2 s.
* **Buffer Capacities**: Prompts up to 4 MiB (via stdin), diagnostics up to 512 KiB per channel, public output up to 1 MiB. StringDecoder preserves split UTF-8 code points across chunks.

---

## 6. Provider Contracts

### Google Antigravity (`agy` / Gemini Adapter)
* Invokes `agy` binary in headless mode with native `--sandbox` for read-only isolation.
* Prompts are delivered via standard input (stdin) to eliminate Windows 32 KiB command-line overflows.
* Real-time events stream via `--output-format stream-json`.
* Multi-turn resume uses `--conversation <uuid>`.
* agy 1.2.17 has no headless interrupt; cancellation and deadlines force-stop it (POSIX: `SIGTERM` with a 2 s grace, then `SIGKILL`).

### OpenAI Codex (`codex`)
* Runs `codex app-server -c sandbox_mode="read-only" -c approval_policy="never"` (JSON-RPC over stdio, Codex 0.160) for one turn: `initialize`/`initialized`, `thread/start` or `thread/resume` (`excludeTurns`), `turn/start`; stdin is closed on `turn/completed`.
* Every run fails closed with `SANDBOX_UNAVAILABLE` unless the thread response reports a `readOnly` sandbox and `approvalPolicy: "never"`. Server-initiated requests are answered with a JSON-RPC error; nothing is approved.
* Cancellation and deadlines send `turn/interrupt`. Notifications of other threads (sub-agents) are ignored. Turn usage sums `tokenUsage.last` over the turn's `thread/tokenUsage/updated` notifications.
* Discards private model thoughts and raw tool stdout/stderr.
* Resumes multi-turn context via native thread IDs; an unknown thread is `SESSION_INVALID`.

### Claude Code (`claude`)
* Runs `claude -p --restricted --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none` with `--settings {"disableAllHooks":true} --strict-mcp-config --mcp-config {"mcpServers":{}}`. `--restricted` removes code-running tools and WebFetch, confines file tools to the working directory, ignores user, project and local settings files and keeps subscription (OAuth) authentication; API keys also work.
* Every run fails closed with `SANDBOX_UNAVAILABLE` unless `system/init` reports only the read-only tools, no MCP server and `dontAsk`; any execution that emits content or completes without a verified `system/init` is rejected.
* The prompt is one user message on stdin (`--input-format stream-json`); stdin stays open until the terminal `result`, and cancellation and deadlines send a `control_request` `interrupt` first. Events stream via `--output-format stream-json --verbose --include-partial-messages`; thinking blocks, tool inputs and tool results are discarded. Unknown event types and `system` subtypes produce one warning each.
* A new session pins `--session-id <uuid>`; continuation uses `--resume <uuid>`. UUID comparison is case-insensitive. Reasoning effort maps to `--effort` (`low`, `medium`, `high`, `xhigh`, `max`). Model identifiers are validated before argv.
* Failures are typed from `assistant.error`, `result.api_error_status` and anchored `result.errors` prefixes through the table in `src/backends/claude/errors.ts`; stderr is not classified.
* Probe: `claude --version` (minimum 2.1.259) and `claude auth status`, without a model call.
* Quota: `inspectQuota` runs `claude -p /usage` on verified CLI versions (minimum 2.1.289; versions older than 2.1.289 skip inspection to ensure no prompt is sent to a model; a reported model turn or cost is discarded) and parses the `Current session` and `Current week (all models)` lines into measured windows; the bottleneck sets headroom and reset. Model-specific weekly limits are ignored. API billing prints no limits and stays unmeasured. Quota inspection (`doctor`, `smart_quota`, 60 s cache) calls it; `execute` never does.


## Host setup and diagnostic evidence

`setup`/`repair` select local-default host registrations independently of backend
execution. Direct runtime calls and native host discovery/calls are separate
status fields. Managed replacements require native acceptance; manual or changed
entries are preserved. Native Claude/agy acceptance is pending, so their managed
updates are deferred. Auth files/keys are evidence, not proof of authenticated
model execution. Claude reports the login state of `claude auth status` (token validity is proven only by an execution), and Gemini reports
`authenticated` only after a successful native `/usage` call. Codex currently
reports `authenticated` from file presence or environment variables (section 7).

Setup's recognized clients are codex, claude and agy. This list does not constrain
MCP initialization or tools/list, which do not inspect the calling client's name.
Ordinary stdio registration is documented in the README; setup lifecycle and
presentation acceptance are owned by the integration guide.

Gemini stderr sandbox-denial evidence does not create a terminal result. A real
terminal remains required and real duplicate terminals still fail the protocol.
Denial produces `SANDBOX_UNAVAILABLE` with continuation disabled.

## 7. Known deviations (audit at c265cdf)

The [independent audit](PROJECT_REVIEW_2026-10-05.md#independent-audit-at-c265cdf)
found these differences between the intended contract and the implementation.
Each is owned by a roadmap milestone (see the
[remediation index](ROADMAP.md#audit-remediation-index)). Remove an entry only
when its fix lands with a regression test.

| ID | Intended contract | Current behavior |
| --- | --- | --- |
| AUD-P0-2 | Redaction removes credentials from public output | Keyword rules also rewrite ordinary code: `const token = getToken();` becomes `const token = ***[REDACTED]***` |
| AUD-P1-1 | A rate limit records the provider's reset time | The controller writes a second, tiered cooldown that replaces the parsed reset (3 days becomes 45 s) |
| AUD-P1-2 | Error codes identify the cause | Errors without a known `CODE:` prefix, including lock timeouts, are returned as `INPUT_LIMIT` |
| AUD-P1-4 | agy runs with native `--sandbox` | The `/usage` quota probe runs on every Gemini request without `--sandbox` |
| AUD-P1-5 | Native stream parsing tolerates CLI evolution | An unknown agy event type fails the call with `PROTOCOL_ERROR` |
| AUD-P1-7 | Top-tier models require the user's consent | `user_confirmed` is asserted by the caller; agy's default model is not governed |
| AUD-P1-8 | History is visible only to its workspace | MCP resources list and read sessions of every workspace |
| AUD-P1-11 | The configured Codex model is used | A regex reads the first `model = "…"` text in `config.toml`, including comments and `review_model` |
| AUD-P2-2 | Missing data is reported as unknown | An empty Gemini answer is returned as "Task completed cleanly with no textual output."; missing quota fractions count as 100% headroom |
