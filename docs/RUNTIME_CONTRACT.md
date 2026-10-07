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

Workspace selection, per call:
1. an explicit `workspace_path`;
2. the client's MCP roots, when the client declares the `roots` capability:
   - one root is used;
   - with several, the root containing the server's working directory is used,
     otherwise the call asks for `workspace_path`;
   - roots are read once per connection and again after
     `notifications/roots/list_changed`;
3. the server's working directory, unless it is the home, a filesystem root or a
   system directory.

Execution results carry `workspace` and `workspaceSource`, and the text notes the
server-directory fallback. `session` history and close use the same workspace;
`cancel` without `workspace_path` stays unscoped. `cancel` returns
`cancelled: true` only when it stopped a running turn or released one left
running; otherwise `cancelled: false` with "nothing to cancel".

### Tool Surface
Every client is offered the six core tools:
* Core execution: `consult` (optional `task_type`: `architecture`, `debug`,
  `implementation`), `review`. Without `task_type`, `consult` passes the question on
  as asked, with only an instruction to answer it concisely; a task type adds its
  header and default focus.
* Management: `doctor`, `session`, `cancel`.
* Feedback & Diagnostics: `issue`.

Callable but not advertised:
* the deprecated aliases of `consult`: `analyze`, `debug`, `implement`. Each maps
  its arguments to `consult` and returns a deprecation warning;
* the legacy `run` gateway (actions: `consult`, `review`, `issue`; deprecated
  `analyze`, `debug`, `implement`).

The former `toolProfile` configuration key is ignored. Its compact profile
measured more model-visible bytes than the six tools.

The server sends one sentence of `instructions` in `initialize` and declares its
icon once, in `serverInfo`; tools carry no icon. Execution parameters are defined
once (`src/tools/schema.ts`) with descriptions only where the name and enum leave
them unclear. There is no consent parameter: the server asks the user (see
[Top-tier model consent](#top-tier-model-consent)). The icon is
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
* `consentedModel`: The top-tier model the user approved for this turn. Set only by the
  controller after the user's answer, never from tool arguments; an adapter refuses a
  top-tier model unless it equals this value.
* `onEvent`: Callback streaming normalized `AdapterEvent` updates to the history writer.

### Terminal Results (`TerminalExecutionResult`)
* `status`: `completed` | `failed` | `cancelled` | `timed_out`.
* `isError`: Boolean error indicator.
* `output`: Public sanitized Markdown response text.
* `error`: Optional typed error envelope `{ code, message, retryable }`.
* `continuationAvailable`: True if native multi-turn resume is supported and thread ID is valid.
* `truncated`: True if output reached capacity buffer limits.

### Execution Tool Result
`consult`, `review`, `run` and the deprecated aliases return one markdown text
block and `isError`. They declare no `outputSchema` and send no
`structuredContent` (breaking change in 1.0.0, `CONTEXT-001`): Claude Code 2.1.289
shows the model only `structuredContent` when a result has one, agy reads
`content`, and Codex reads `structuredContent` when present and `content`
otherwise (its source, `codex-rs/protocol/src/models.rs`). One
channel keeps every client on the same text and avoids JSON escaping.

The text has three parts:
1. On failure, a first line `> Error [<CODE>]: <message>`, or
   `> Error [<CODE>, retryable]: <message>` when the same request may succeed
   later (for example `RATE_LIMITED` or `TIMEOUT`). The status follows from the
   code: `ABORTED` is cancelled, `TIMEOUT` timed out, any other code failed. Any
   answer the backend produced follows under `Partial response:`.
2. The answer, unchanged apart from escape-sequence stripping, the review gate and
   credential redaction.
3. The footer, quoted paragraphs separated by an empty `>` line so markdown
   renderers keep each on its own line:
   * always `> CoAgent8: <backend> · <model> · <seconds>s`, then ` · <n> ops` when
     non-zero and ` · <handle> (<state>)` when a session exists. The model is the
     one the backend resolved, or `provider default`. The state is `ready` (the
     handle continues the conversation) or `finished`, preceded by `turn <n>, `
     from turn 2 and followed by `, no history` when the turn was not archived;
   * `review` only: `> Verdict: READY` or `> Verdict: BLOCKED (<reason>)`, the
     State Envelope gate's verdict; a failed run gives its reason in the error line;
   * `> Notice: Output reached buffer limit.` when truncated;
   * `> Warning: <text>` per warning, adapter warnings such as sandbox denials
     included;
   * `> Report this issue: [...](<url>)` for `PROCESS_ERROR`, `CLI_UNSUPPORTED`
     and `PROTOCOL_ERROR`;
   * `> Workspace: <path> (server directory)` when the server directory was the
     fallback workspace. An explicit `workspace_path` or a client root adds no line.

Example: `> CoAgent8: claude · claude-opus-5-5 · 107.8s · 8 ops · <handle> (turn 2, ready)`.

Tool errors (`isError`) are distinct from audit conclusions (`Verdict`). Input
validation failures are tool execution errors, and a consent refusal says in one
line to retry without the top-tier model or with a non-top-tier one. `doctor`
with `detail: "full"`, `session` and `issue` return data, not an answer, and keep
`structuredContent`.

### Model and effort selection
When a call names `model` or `reasoning_effort`, the controller checks the model the
backend would run against the catalog the CLI reports, before consent and before any
model call:
* Codex: `codex app-server` `model/list` (visible models, each with its efforts);
* agy: `agy models`, grouped by effort: `gemini-3.8-flash-high` is
  `gemini-3.8-flash` with effort `high`; a model listed only with efforts needs one,
  either as `reasoning_effort` or in its name;
* Claude Code lists no models; its aliases and full identifiers are passed on.

A model the CLI does not offer is `MODEL_UNAVAILABLE`; an effort the model does not
accept, or a missing required one, is `INPUT_LIMIT`. Both messages name the
accepted values. Efforts the adapter does not pass on (Codex `ultra`) are not
offered. The catalog is read at most once per probe lifetime (5 minutes, same
executable and environment); when it cannot be read, nothing is refused and the CLI
decides. A call without `model` and `reasoning_effort` reads no catalog. `doctor`
reports each catalog under `backends.<id>.models` with `detail: "full"`.

### Top-tier model consent

A top-tier model (`astra`, `opus` and `best` families) runs only after the user
approves it (AUD-P1-7). The calling agent cannot grant consent: `user_confirmed`
was removed in 1.0.0-beta.2 and is rejected as an unknown argument.

* The controller governs the model the backend would run, defaults and aliases
  applied (`CliAdapter.resolveModel`): the requested model, the session's model, or
  the backend default. Codex reads the `config.toml` default, Claude Code resolves
  its alias (default `sonnet`, `ANTHROPIC_DEFAULT_*_MODEL` overrides applied), and
  agy runs `gemini-3.8-flash-high` unless a model is given. agy keeps its own
  default in internal interface state, so the bridge always passes `--model`.
* When the client declares form elicitation, the server sends one
  `elicitation/create` request per governed turn, with an `approve` checkbox. The
  turn runs only when the user accepts with the box checked. Declining, cancelling
  or unchecking returns `POLICY_DENIED`. The user has five minutes to answer; a
  failed request is `POLICY_DENIED` and a cancelled tool call is `ABORTED`.
* Without elicitation the turn fails with `POLICY_DENIED`, before any session is
  acquired or process launched.
* Consent covers one turn and one exact model. Continuing a session on a governed
  model asks again.

### Typed Error Codes (`ERROR_CODES`)
`CLI_NOT_FOUND`, `CLI_UNSUPPORTED`, `AUTH_REQUIRED`, `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `SESSION_INVALID`, `SESSION_BUSY`, `ABORTED`, `TIMEOUT`, `SANDBOX_UNAVAILABLE`, `PROTOCOL_ERROR`, `BUFFER_LIMIT`, `INPUT_LIMIT`, `PROCESS_ERROR`, `HISTORY_ERROR`, `POLICY_DENIED`.

Each code is raised where the cause is known, as a `ToolError` carrying the code;
messages carry no code prefix. `INPUT_LIMIT` means rejected input (schema
validation, an unknown action, an unusable workspace path). Any other failure is
reported as `PROCESS_ERROR`.

---

## 3. State Envelope Contract & Verification Gate

`review` (and `run` with `action: "review"`) enforces the structured **State
Envelope**. `consult` and its aliases return a plain answer with
`verdict: "NOT_APPLICABLE"` and no envelope instructions:

```text
REVIEW: <turn>
SNAPSHOT: <snapshot>
COVERAGE: COMPLETE | PARTIAL
VERDICT: READY | BLOCKED
[P1|P2|P3] <file>:<line>
Problem: <one sentence>
Evidence: <at most two sentences, citing file:line>
Fix: <one sentence>
CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>
END_REVIEW
```

The server fills in `SNAPSHOT`:
* the short HEAD with `+uncommitted` or `+staged`;
* the reviewed commit;
* the range;
* `<base>...<HEAD>`;
* `no-commit`.

P3 findings take one line without Evidence and Fix. The answer starts with the
envelope, without a preamble. A file marked `-diff` in `.gitattributes` (for
example a generated `CHANGELOG.md`) appears in the diff only as `Binary files ...
differ`, which keeps generated content out of the review prompt.

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

### Workspace Scope
Sessions and histories are visible only in the workspace that created them. The
`session` tool (`list`, `history`, `close`) uses the call's workspace. The MCP
resources `coagent8://sessions` and `coagent8://sessions/{id}/history` use the
connection's workspace: its single client root, or the server directory without
roots. When no single workspace resolves, `resources/list` returns only the
`coagent8://sessions` index and reading it fails with the validation error.

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
* Always passes `--model`: the requested model or `gemini-3.8-flash-high`, so a model selected in agy's interface never runs ungoverned.
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
| AUD-P2-2 | Missing data is reported as unknown | An empty Gemini answer is returned as "Task completed cleanly with no textual output."; missing quota fractions count as 100% headroom |
