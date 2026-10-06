# CoAgent Runtime Contract (v1.0.0 Specification)

> **Status:** Authoritative Runtime Contract  
> **Release Target:** CoAgent v1.0.0  
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

### Dual Tool Profiles
1. **Canonical Profile (Default)**: Advertises nine tools — six core tools plus
   three deprecated aliases:
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

### Append-Only Storage & Torn-Tail Resilience

Every execution currently acquires a session and writes history; optional durable
history is not implemented. A history or lease-release failure can mark an otherwise
successful turn failed with HISTORY_ERROR. Separating optional archival failures
from execution/ownership failures requires the planned contract migration.

* Streaming batches append to `.jsonl` without rewriting the materialized snapshot. Copying and serialization scale with assembled message bytes; recovery and storage accounting can read existing history.
* Under directory file lock, `createHistoryWriter` inspects the log tail for torn or partial records from unexpected process crashes, repairing byte boundaries via in-place `fs.truncate`.
* Materialized `.json` snapshots are written atomically upon message completion or `turn_finished`.

### Pagination & Revisions
* `session` (`action: "history"`) returns at most 100 events and a 240 KiB page budget.
* Large messages are split at UTF-8 code point boundaries with `{ offsetBytes, totalBytes, complete }`.
* Cursors are opaque base64url structures bound to a specific snapshot revision. Concurrent writes trigger `HISTORY_CHANGED` to prevent skipping final response texts.

---

## 5. Subprocess Execution & Supervision

* `runCommand(command, args, options)` runs strictly with `shell: false`.
* **Windows**: Child processes and descendants are tracked via CIM/WMI background polling (every 500 ms, serialized by `CimMutex`). Teardown uses `taskkill.exe /PID <pid> /T /F`, followed by a PowerShell CIM sweep when `taskkill` fails — including after every normal exit, where `taskkill` returns 128. Descendants are currently matched by parent PID only; see section 7.
* **POSIX**: Spawns detached process groups (`detached: true`) and terminates using `process.kill(-proc.pid, 'SIGTERM')` followed by `SIGKILL` after 250ms.
* **Buffer Capacities**: Prompts up to 4 MiB (via stdin), diagnostics up to 512 KiB per channel, public output up to 1 MiB. StringDecoder preserves split UTF-8 code points across chunks.

---

## 6. Provider Contracts

### Google Antigravity (`agy` / Gemini Adapter)
* Invokes `agy` binary in headless mode with native `--sandbox` for read-only isolation.
* Prompts are delivered via standard input (stdin) to eliminate Windows 32 KiB command-line overflows.
* Real-time events stream via `--output-format stream-json`.
* Multi-turn resume uses `--conversation <uuid>`.

### OpenAI Codex (`codex`)
* Invokes `codex exec` with `--sandbox read-only` and `--json`.
* Discards private model thoughts and raw tool stdout/stderr.
* Resumes multi-turn context via native session IDs.

### Claude Code (`claude`)
* Runs `claude -p --restricted --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none` with `--settings {"disableAllHooks":true} --strict-mcp-config --mcp-config {"mcpServers":{}}`. `--restricted` removes code-running tools and WebFetch, confines file tools to the working directory, ignores user, project and local settings files and keeps subscription (OAuth) authentication; API keys also work.
* Every run fails closed with `SANDBOX_UNAVAILABLE` unless `system/init` reports only the read-only tools, no MCP server and `dontAsk`; any execution that emits content or completes without a verified `system/init` is rejected.
* Prompts are delivered on stdin. Events stream via `--output-format stream-json --verbose --include-partial-messages`; thinking blocks, tool inputs and tool results are discarded. Unknown event types and `system` subtypes produce one warning each.
* A new session pins `--session-id <uuid>`; continuation uses `--resume <uuid>`. UUID comparison is case-insensitive. Reasoning effort maps to `--effort` (`low`, `medium`, `high`, `xhigh`, `max`). Model identifiers are validated before argv.
* Failures are typed from `assistant.error`, `result.api_error_status` and anchored `result.errors` prefixes through the table in `src/backends/claude-errors.ts`; stderr is not classified.
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
| AUD-P0-1 | Teardown terminates only owned processes | Windows descendants are matched by parent PID alone; a stale parent PID can match unrelated user processes, which are then stopped with `Stop-Process -Force`. Only a fixed list of system/shell names is excluded |
| AUD-P0-2 | Redaction removes credentials from public output | Keyword rules also rewrite ordinary code: `const token = getToken();` becomes `const token = ***[REDACTED]***` |
| AUD-P0-3 | History is archival and bounded | Streamed answers are stored 50–110× their size; reaching 10 MiB per session turns a successful turn into `HISTORY_ERROR`; above 100 MiB in total, new executions fail before the CLI starts |
| AUD-P1-1 | A rate limit records the provider's reset time | The controller writes a second, tiered cooldown that replaces the parsed reset (3 days becomes 45 s) |
| AUD-P1-2 | Error codes identify the cause | Errors without a known `CODE:` prefix, including `ONBOARDING_REQUIRED` and lock timeouts, are returned as `INPUT_LIMIT` |
| AUD-P1-3 | A completed CLI answer is returned | A session-metadata update failure after execution replaces the answer with an empty failed result |
| AUD-P1-4 | agy runs with native `--sandbox` | The `/usage` quota probe runs on every Gemini request without `--sandbox` |
| AUD-P1-5 | Native stream parsing tolerates CLI evolution | An unknown agy event type fails the call with `PROTOCOL_ERROR` |
| AUD-P1-7 | Top-tier models require the user's consent | `user_confirmed` is asserted by the caller; agy's default model is not governed |
| AUD-P1-8 | History is visible only to its workspace | MCP resources list and read sessions of every workspace |
| AUD-P1-11 | The configured Codex model is used | A regex reads the first `model = "…"` text in `config.toml`, including comments and `review_model` |
| AUD-P2-2 | Missing data is reported as unknown | An empty Gemini answer is returned as "Task completed cleanly with no textual output."; missing quota fractions count as 100% headroom |
