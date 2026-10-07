# Handoff: Shared Foundations → Codex Adapter Author (GEMINI Agent)

> Historical snapshot. Original findings, plans, commands and version labels
> are preserved as evidence; they do not define current policy or release status.
> Use the [active roadmap](../ROADMAP.md), [runtime contract](../RUNTIME_CONTRACT.md)
> and [archive index](README.md). Historical source references describe their
> original tree, including modules that no longer exist.


**Historical Document.** Per user instructions, the primary execution path of the Codex adapter has been migrated on `fix/codex-execution-contract`, following the `bb4b406` integration. The registry now requires `TerminalExecutionResult`, the adapter uses the shared runner, and `test/codex.adapter.test.js` along with consumer smoke tests verify multi-turn execution and history persistence. Do not cherry-pick just the foundation commit as a new base, and do not duplicate adapter implementations. Current remaining scope: [PLAN_RC1.md](PLAN_RC1.md); evidence: [RC1_STATUS.md](RC1_STATUS.md). Remaining notes below document the original handoff context.

Base checkpoint: `43969b0`. Integrator branch: `feat/rc1-shared-gemini`.
Foundation commit: **`7f01e72ebbccc52a5349d78f3776883418bed2d8`**, `feat(rc): establish shared execution contract and process runner`. Do not copy working tree; cherry-pick this commit to a dedicated worktree. Subsequent shared integrator changes are documented in [RC1_STATUS.md](RC1_STATUS.md); incorporate shared pipeline/history commits from this branch prior to integration.

## Contract

`src/types/conversation.types.ts`: `provider` is `codex | gemini | claude`; `auto` and `smart_quota` are routing strategies. The adapter emits `AdapterEvent` via `ExecutionOptions.onEvent`. The pipeline wraps it in `ConversationEvent`: schemaVersion=1, UUID eventId/turnId, monotonic sequence, ISO timestamp, sessionHandle, provider. The adapter does not write history or manage global sequence numbers.

`TerminalExecutionResult` is mandatory for RC: status `completed | failed | cancelled | timed_out`, output, isError, typed error, nativeSessionId, exitCode/signal, model, truncated, continuationAvailable, and optional usage with source=provider. The legacy `ExecutionResult` is retained strictly for backward compatibility during adapter migration; an optional status does not fulfill RC requirements. The pipeline must never treat unverified protocol output as success.

`ExecutionOptions`: cwd, model, reasoningEffort, nativeSessionId (legacy threadId), timeoutMs, abortSignal, userConfirmed, onEvent. Model selection and user confirmation are verified prior to spawn; resume uses an exact ID with no silent fallback to a fresh conversation.

## Process Runner

```ts
const publicMessages = new Map<string, string>();
const processResult = await runCommand(process.env.CODEX_PATH || 'codex', argv, {
  cwd: options.cwd,
  stdinInput: prompt,
  abortSignal: options.abortSignal,
  timeoutMs: options.timeoutMs, // default 120 s
  maxLineBytes: 512 * 1024,
  onStdoutLine(line) {
    const event: unknown = JSON.parse(line); // validate before mapping
    // Ignore private reasoning. Map agent_message snapshot to assistant_message.
    // options.onEvent?.({ type: 'assistant_message', messageId, text });
    // Record turn.completed / turn.failed independently of process exit code.
  },
});
```

`runCommand` returns status and a typed error (never throwing on spawn/abort/deadline). Native executable resolution handles PATH/PATHEXT, npm .cmd shims → actual JS + process.execPath without shell. Windows Job Object is assigned before process resume; POSIX detached process groups use TERM→KILL escalation. Diagnostic collection is capped at 512 KiB per stream. The line decoder handles UTF-8 and bounds each record prior to JSON parsing, including long lines and trailing fragments. Callback exceptions terminate the process with PROTOCOL_ERROR or BUFFER_LIMIT.

`stream.service`: unified `truncateToByteLength` (budget includes truncation marker), `createLineDecoder`, `readBoundedFile`. Output file `-o` must use `readBoundedFile` (1 MiB), a private `mkdtemp`, and a `finally` cleanup block. Never read output files via unbounded `readFileSync`. Input prompts are capped at 4 MiB.

## Public Events & Assembly

- `assistant_delta`: appends text to `messageId`; `assistant_message`: snapshot replaces text for this `messageId`. Native event IDs combined with phase deduplicate repeats; item IDs alone must not drop subsequent completed snapshots.
- `tool_started` / `tool_finished`: toolId, name, success. Map actual `command_execution` to user-facing activity; never emit raw arguments or shell output as chat text.
- `status` / `warning` / `error`: sanitized diagnostics; no private reasoning, thoughts, or raw environment variables.
- Pipeline records user input once and discards CLI echos; pipeline owns `turn_started`, `turn_finished`, and final status.
- `messageId`, `toolId`, `nativeEventId`, and tool names must be non-empty, up to 256 UTF-8 bytes, and free of control characters. Non-conforming metadata is discarded before persistence. Runner callbacks can propagate typed errors via `error.code`.
- Asynchronous sessions: mutations, acquisition, and release must be awaited. The adapter does not manage leases. Pipeline pins nativeSessionId, provider/workspace/model, and writes history. Results lacking status are rejected; unverified output or native IDs cannot be used for continuation.
- `probe.executionSupported = false` excludes the provider from `auto` and `smart_quota`; explicit user selection returns `CLI_UNSUPPORTED`. The Codex adapter must report verified execution/capabilities and effective default models; a static model catalog does not constitute verified account availability.
- `turn.failed` or errors at exit code 0 → status failed; missing terminal event → `PROTOCOL_ERROR`. Rate limits do not delete sessions; invalid resume → `SESSION_INVALID`.

## Ownership & Acceptance

GEMINI Agent: owns Codex adapter, fixtures/tests, argv for exec/review/resume, terminal protocol handling, model/config probe, and public events. Codex Integrator: runner, Gemini adapter, registry, pipeline, sessions, schema, history, progress reporting, renderer, diagnostics, and packaging. Propose shared contract changes via dedicated patches rather than overwriting shared modules.

Foundation tests: `test/process.test.js` reproduces F02/F05/F06/F08. Local Windows runs do not validate the POSIX/Node matrix or real Codex/Gemini execution. F02/F05/F06/F08 in the legacy Codex adapter remain open until migration to the shared runner is verified. Run the 5-step local quality gate before committing. Report commit, CLI versions, test results, and live 2-turn/read-only verification or concrete blockers. Independent review of Gemini integration remains assigned to the second author.

Windows supervisor uses `PROC_THREAD_ATTRIBUTE_JOB_LIST`: Job assignment is an atomic part of `CreateProcess` (Windows 10 / Server 2016+). The JS entrypoint does not require an executable bit; POSIX npm symlinks run via the current `process.execPath`. These improvements are part of the integration commit and should be tracked alongside the pipeline.

