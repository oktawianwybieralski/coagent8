/**
 * Shared execution controller orchestrating CLI adapter lifecycles, sessions, and events.
 *
 * @remarks
 * ## Lifecycle & Architecture Contract
 * - **Provider Resolution & Policy Governance**: Dynamically resolves the active CLI backend
 *   via `resolveBackend` (Codex, agy / Gemini CLI, or Claude Code). A top-tier model (`astra`,
 *   `opus`), requested or the backend's effective default, runs only after the user approves it
 *   through {@link ConsentPrompt}; without one the turn fails with `POLICY_DENIED`.
 * - **Turn Mutual Exclusion & Lease Tokens**: Sessions are acquired with unique turn tokens
 *   (`acquireAndResolveSession`). A single session handle cannot execute concurrent turns; attempts
 *   receive `SESSION_BUSY`.
 * - **Streaming Event Bus & Durability**: Emits normalized `AdapterEvent` updates to an append-only
 *   `HistoryWriter` flushed periodically every 250ms and finalized on `turn_finished`.
 * - **Progress & Inactivity Heartbeats**: Reports granular activity updates (`onProgress`).
 *   If no events arrive within 10 seconds, background heartbeats notify the orchestrator with
 *   elapsed seconds and active phase.
 * - **Defensive Protocol Validation**: Validates adapter terminal results (`TerminalExecutionResult`).
 *   Contradictory or missing results fail safely as `PROTOCOL_ERROR`, discarding untrusted output.
 * - **State Envelope Gate Enforcement**: Calls `formatExecutionResult` with `requireEnvelope`,
 *   programmatically gating review/consult verdicts to `BLOCKED` if high-severity issues are found.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { resolveBackend } from '../backends/routing.js';
import { readModelCatalog } from '../backends/probe-cache.js';
import { checkModelSelection } from '../backends/model-catalog.js';
import { consentDeclinedMessage, consentRequiredMessage, isGovernedModel, isValidModelIdentifier } from '../backends/governance.js';
import { acquireAndResolveSession, getSession, releaseSessionTurn, updateSession, pruneExpiredSessions, setExecutionCanceller, type CancelOutcome } from '../sessions/session.js';
import { createHistoryWriter } from '../sessions/history.js';
import { redactDiagnostic, redactCredentialFormats } from '../redaction.js';
import { truncateToByteLength, BufferLimitError } from './stream.js';
import type { ExecutionOptions, ExecutionResult, TerminalExecutionResult } from '../backends/types.js';
import { ToolError, errorCodeOf, type AdapterEvent } from '../conversation.js';
import { formatExecutionResult } from '../tools/result.js';
import { recordQuotaCooldown, resetQuotaCooldown } from '../backends/availability.js';
import { parseResetTimestamp } from '../backends/rate-limit.js';

/**
 * Universal execution parameters accepted by execution tools and the run gateway.
 */
export interface ExecutionRequest {
  backend?: string;
  session_handle?: string;
  model?: string;
  reasoning_effort?: string;
  timeout_ms?: number;
}

/**
 * Asks the user, not the calling agent, to approve a top-tier model; resolves true only on
 * the user's approval. The server implements it with MCP elicitation when the client
 * supports it (AUD-P1-7).
 */
export type ConsentPrompt = (request: { backend: string; model: string }) => Promise<boolean>;

/** Per-call options of {@link executeTask} set by the server and tool handlers, never by tool arguments. */
export interface TaskOptions {
  /** Gate review results on the State Envelope. */
  requireEnvelope?: boolean;
  /** Notices added to the result, such as a deprecated tool name. */
  warnings?: string[];
  /** Absent when the client cannot ask the user; a top-tier model is then refused. */
  askConsent?: ConsentPrompt;
}

const activeExecutionTasks = new Set<Promise<unknown>>();
const activeSessionAborts = new Map<string, { abort: () => void; wait: () => Promise<boolean> }>();
/** Distinct adapter warnings carried into one result, such as sandbox denials. */
const MAX_ADAPTER_WARNINGS = 5;

/**
 * Cancels active CLI execution for a specific session handle, aborting the process tree.
 *
 * @param handle - Session handle to abort.
 * @returns `none` when no turn of this handle runs here, `settled` when it ended within the timeout, `timed_out` otherwise.
 */
async function cancelSessionExecution(handle: string): Promise<CancelOutcome> {
  const entry = activeSessionAborts.get(handle);
  if (!entry) return 'none';
  entry.abort();
  return await entry.wait() ? 'settled' : 'timed_out';
}
/** Composes session cancellation explicitly at the server/application lifecycle owner. */
export function composeExecutionCancellation(): void {
  setExecutionCanceller(cancelSessionExecution);
}

/**
 * Awaits settlement of all currently active background execution tasks.
 * Primarily used during graceful server shutdown.
 */
export async function waitForActiveExecutionTasks(): Promise<void> {
  await Promise.allSettled([...activeExecutionTasks]);
}

/**
 * Executes a task through the unified controller pipeline.
 *
 * @param prompt - Internal prompt payload passed to the CLI adapter (e.g. system instructions + task).
 * @param publicInput - Clean, user-facing prompt recorded in public history.
 * @param args - Request parameters (backend, model, session handle, etc.).
 * @param cwd - Absolute canonical working directory for workspace isolation.
 * @param abortSignal - Optional caller abort signal.
 * @param onProgress - Optional MCP progress callback.
 * @param options - Execution formatting options (e.g. `requireEnvelope` for reviews).
 * @returns Formatted MCP CallToolResult with the markdown answer and footer.
 */
export async function executeTask(prompt: string, publicInput: string, args: ExecutionRequest, cwd: string, abortSignal?: AbortSignal | null, onProgress?: ((info: { message?: string }) => void) | null, options: TaskOptions = {}) {
  const task = executeTaskInternal(prompt, publicInput, args, cwd, abortSignal, onProgress, options);
  activeExecutionTasks.add(task);
  try {
    return await task;
  } finally {
    activeExecutionTasks.delete(task);
  }
}

async function executeTaskInternal(prompt: string, publicInput: string, args: ExecutionRequest, cwd: string, abortSignal?: AbortSignal | null, onProgress?: ((info: { message?: string }) => void) | null, options: TaskOptions = {}) {
  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled before provider resolution.');
  // The model reaches CLI argv; option-like or whitespace values are rejected before any backend runs.
  if (args.model !== undefined && !isValidModelIdentifier(args.model)) throw new ToolError('INPUT_LIMIT', 'Invalid model identifier.');
  const previous = args.session_handle ? getSession(args.session_handle, { workspace: cwd }) : null;
  if (args.session_handle && !previous) throw new ToolError('SESSION_INVALID', 'Session is expired, invalidated, closed or belongs to another workspace.');
  if (previous && args.backend && !['auto', 'smart_quota', previous.backend].includes(args.backend)) throw new ToolError('SESSION_INVALID', 'A session cannot switch provider.');
  const backend = await resolveBackend(previous?.backend || args.backend);
  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled before acquiring the session.');
  if (previous && !previous.threadId) throw new ToolError('SESSION_INVALID', 'Native continuation is unavailable for this session; history remains accessible.');
  const config = backend.probe.config as { defaultModel?: string } | undefined;
  const model = args.model || previous?.model || config?.defaultModel;
  // Consent covers the model the backend will run, defaults and aliases applied, and is asked on every turn.
  const effectiveModel = backend.adapter.resolveModel ? backend.adapter.resolveModel(model) : model;
  // An explicit model or effort is checked against the CLI's own catalog before the user is
  // asked for consent and before a model call; the default selection needs no catalog read.
  if (args.model !== undefined || args.reasoning_effort !== undefined) {
    const rejected = checkModelSelection(backend.id, await readModelCatalog(backend.id), effectiveModel, args.reasoning_effort);
    if (rejected) throw new ToolError(rejected.code, rejected.message);
    if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while reading the model catalog.');
  }
  let consentedModel: string | undefined;
  if (isGovernedModel(effectiveModel)) {
    if (!options.askConsent) throw new ToolError('POLICY_DENIED', consentRequiredMessage(effectiveModel));
    if (!(await options.askConsent({ backend: backend.id, model: effectiveModel! }))) throw new ToolError('POLICY_DENIED', consentDeclinedMessage(effectiveModel));
    if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while waiting for the user.');
    consentedModel = effectiveModel;
  }
  await pruneExpiredSessions();
  const acquired = await acquireAndResolveSession(args.session_handle, backend.id, cwd);
  if (!acquired.session) throw new ToolError('SESSION_BUSY', acquired.error ?? 'Session is busy executing another turn.');
  const session = acquired.session, handle = session.sessionHandle, token = session.turnToken!;
  const writer = createHistoryWriter(handle, cwd, backend.id, randomUUID());
  const cancelController = new AbortController();
  const onCallerAbort = () => cancelController.abort();
  if (abortSignal) {
    if (abortSignal.aborted) cancelController.abort();
    else abortSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let notifySettled: () => void;
  const settled = new Promise<void>(resolve => { notifySettled = resolve; });
  activeSessionAborts.set(handle, {
    abort: () => cancelController.abort(),
    wait: async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          settled.then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  });
  const started = Date.now(); let toolCount = 0, historyError: Error | undefined, sawPublicMessage = false;
  let lastEvent = Date.now();
  let lastPhase = 'Initialization';
  const adapterWarnings = new Set<string>();
  // The progress reporter redacts each message once, where it leaves for the client.
  const report = (message: string) => onProgress?.({ message });
  const receive = (event: AdapterEvent) => {
    if (event.type === 'user_message' || event.type === 'turn_started' || event.type === 'turn_finished') return;
    lastEvent = Date.now();
    if (event.type !== 'status') {
      try {
        writer.accept(event);
      } catch (err) {
        if (!historyError) historyError = err as Error;
      }
    }
    if (event.type === 'assistant_delta' || event.type === 'assistant_message') sawPublicMessage = true;
    if (event.type === 'tool_finished') {
      toolCount++;
      const name = event.name === 'command_execution' ? 'sandbox command' : event.name;
      report(`Completed: ${name} (${event.success ? 'success' : 'error'})`);
    } else if (event.type === 'tool_started') {
      const name = event.name === 'command_execution' ? 'sandbox command' : event.name;
      lastPhase = `Tool (${name})`;
      report(`Running: ${name}...`);
    } else if (event.type === 'status') {
      lastPhase = event.message;
      report(event.message);
    } else if (event.type === 'warning') {
      report(`Warning: ${event.message}`);
      if (adapterWarnings.size < MAX_ADAPTER_WARNINGS) adapterWarnings.add(event.message);
    } else if (event.type === 'error') {
      report(`Error: ${event.error.message}`);
    } else if (event.type === 'assistant_message') {
      lastPhase = 'Formulating response';
      report('Formulating response...');
    }
  };
  let heartbeat: NodeJS.Timeout | undefined, flushTimer: NodeJS.Timeout | undefined;
  let result: TerminalExecutionResult;
  try {
    try {
      writer.accept({ type: 'turn_started' });
      writer.accept({ type: 'user_message', text: publicInput });
      await writer.flush();
    } catch (err) {
      historyError = err as Error;
    }
    heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - lastEvent;
      if (elapsedMs >= 10000) {
        const totalElapsedSec = Math.floor((Date.now() - started) / 1000);
        report(`Operation in progress (${lastPhase}, ${totalElapsedSec}s elapsed)...`);
      }
    }, 5000);
    flushTimer = setInterval(() => { void writer.flush().catch(err => { if (!historyError) historyError = err; }); }, 250);
    const options: ExecutionOptions = { cwd, model, reasoningEffort: args.reasoning_effort, nativeSessionId: session.threadId, threadId: session.threadId,
      consentedModel, timeoutMs: args.timeout_ms, abortSignal: cancelController.signal, onEvent: receive };
    const raw: ExecutionResult = await backend.adapter.execute(prompt, options);
    // Validate terminal results defensively, including adapters supplied at runtime.
    const validStatus = ['completed', 'failed', 'cancelled', 'timed_out'].includes(raw.status || '');
    const contradictory = raw.status === 'completed' && (raw.isError || !!raw.error);
    const protocolTrusted = validStatus && !contradictory;
    const error = raw.error || (!validStatus || contradictory || (raw.status !== 'completed' && !raw.error) ? { code: 'PROTOCOL_ERROR' as const, message: 'Adapter returned a missing or inconsistent terminal result.', retryable: false } : undefined);
    if (Buffer.byteLength(raw.output || '') > 1024 * 1024) throw new BufferLimitError('Public response exceeds 1 MiB.');
    result = { ...raw, status: error && raw.status !== 'cancelled' && raw.status !== 'timed_out' ? 'failed' : raw.status || 'failed', isError: !!error || raw.status !== 'completed',
      error, truncated: !!raw.truncated, continuationAvailable: protocolTrusted && !!raw.continuationAvailable && !!(raw.nativeSessionId || raw.threadId || session.threadId) && error?.code !== 'SESSION_INVALID' && error?.code !== 'SANDBOX_UNAVAILABLE', output: protocolTrusted ? redactCredentialFormats(raw.output || '') : '' };
  } catch (err) {
    const code = errorCodeOf(err);
    result = { isError: true, status: 'failed', output: '', error: { code, message: redactDiagnostic((err as Error).message), retryable: false }, truncated: code === 'BUFFER_LIMIT', continuationAvailable: false };
  } finally {
    if (heartbeat) clearInterval(heartbeat); if (flushTimer) clearInterval(flushTimer);
    if (abortSignal) abortSignal.removeEventListener('abort', onCallerAbort);
  }

  const warnings: string[] = [...(options.warnings || []), ...adapterWarnings];

  // Post-execution bookkeeping: session metadata (AUD-P1-3)
  try {
    const raw = result as ExecutionResult;
    const protocolTrusted = !result.error || result.error.code !== 'PROTOCOL_ERROR';
    if (protocolTrusted && (raw.nativeSessionId || raw.threadId)) {
      await updateSession(handle, {
        threadId: raw.nativeSessionId || raw.threadId || null,
        model: raw.model || model,
        cliVersion: backend.probe.version,
        safetyProfile: backend.id === 'gemini' ? `gemini-${backend.probe.version}-read-only` : undefined,
      }, token);
    }
    if (result.error?.code === 'SESSION_INVALID') {
      await updateSession(handle, { state: 'invalidated', threadId: null, lastErrorCode: result.error.code }, token);
    }
  } catch (sessionErr) {
    warnings.push(`Session update failed: ${redactDiagnostic((sessionErr as Error).message, 512)}`);
    result = { ...result, continuationAvailable: false };
    try {
      await updateSession(handle, { state: 'invalidated' }, token);
    } catch (invalidateErr) {
      warnings.push(`Session could not be invalidated: ${redactDiagnostic((invalidateErr as Error).message, 512)}`);
    }
  }

  // History archival finalization
  try {
    if (result.output && !sawPublicMessage) writer.accept({ type: 'assistant_message', messageId: 'final', text: result.output });
    if (result.error) writer.accept({ type: 'error', error: result.error });
    writer.accept({ type: 'turn_finished', status: result.status });
    await writer.flush();
  } catch (err) {
    if (!historyError) historyError = err as Error;
  }

  // Release session turn lease (fail-closed)
  const released = await releaseSessionTurn(handle, token);
  activeSessionAborts.delete(handle);
  notifySettled!();

  if (!released.ok && !cancelController.signal.aborted) {
    result = {
      ...result,
      isError: true,
      status: 'failed',
      error: { code: 'SESSION_INVALID', message: redactDiagnostic(released.error), retryable: false },
    };
  }

  if (historyError) {
    warnings.push(`History not saved: ${redactDiagnostic(historyError.message, 512)}`);
  }

  // Quota cooldown update: exactly one write per rate-limited turn, using the provider
  // reset when the message states one and the tiered backoff otherwise.
  try {
    if (result.error?.code === 'RATE_LIMITED') {
      const reset = parseResetTimestamp(result.error.message);
      await recordQuotaCooldown(backend.id, reset?.cooldownMs, result.error.message.slice(0, 200) || undefined);
    } else if (!result.isError && result.status === 'completed') {
      await resetQuotaCooldown(backend.id);
    }
  } catch (error) {
    warnings.push(`Cooldown cache update failed: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 512)}`);
  }

  return formatExecutionResult(
    backend.id,
    result,
    '',
    handle,
    { turn: session.turnCount || 1, toolCount, durationMs: Date.now() - started, historyAvailable: !writer.disabled && !historyError },
    { ...options, warnings }
  );
}
