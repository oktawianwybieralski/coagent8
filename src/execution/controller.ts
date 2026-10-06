/**
 * Shared execution controller orchestrating CLI adapter lifecycles, sessions, and events.
 *
 * @remarks
 * ## Lifecycle & Architecture Contract
 * - **Provider Resolution & Policy Governance**: Dynamically resolves the active CLI backend
 *   via `resolveBackend` (Codex, agy / Gemini CLI, or Claude Code). Enforces governance rules
 *   requiring explicit `user_confirmed: true` for top-tier models (`astra`, `opus`).
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
import { checkModelGovernance } from '../backends/policy.js';
import { acquireAndResolveSession, getSession, releaseSessionTurn, updateSession, pruneExpiredSessions, setExecutionCanceller } from '../sessions/session.js';
import { createHistoryWriter } from '../sessions/history.js';
import { redactDiagnostic, redactSecrets } from '../redaction.js';
import { truncateToByteLength, BufferLimitError } from './stream.js';
import type { ExecutionOptions, ExecutionResult, TerminalExecutionResult, AdapterEvent } from '../types/adapter.types.js';
import { ERROR_CODES, type ErrorCode } from '../types/conversation.types.js';
import { formatExecutionResult } from '../tools/common.js';
import { recordQuotaCooldown, resetQuotaCooldown, checkAndRecordRateLimit } from '../backends/availability.js';

/**
 * Universal execution parameters accepted by execution tools and the run gateway.
 */
export interface ExecutionRequest {
  backend?: string;
  session_handle?: string;
  model?: string;
  reasoning_effort?: string;
  user_confirmed?: boolean;
  timeout_ms?: number;
}

const activeExecutionTasks = new Set<Promise<unknown>>();
const activeSessionAborts = new Map<string, { abort: () => void; wait: () => Promise<boolean> }>();

/**
 * Cancels active CLI execution for a specific session handle, aborting the process tree.
 *
 * @param handle - Session handle to abort.
 * @returns Resolves true if execution settled cleanly within the timeout window.
 */
export async function cancelSessionExecution(handle: string): Promise<boolean> {
  const entry = activeSessionAborts.get(handle);
  if (entry) {
    entry.abort();
    return await entry.wait();
  }
  return true;
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
 * @returns Formatted MCP CallToolResult with markdown text and structuredContent metadata.
 */
export async function executeTask(prompt: string, publicInput: string, args: ExecutionRequest, cwd: string, abortSignal?: AbortSignal | null, onProgress?: ((info: { message?: string }) => void) | null, options: { requireEnvelope?: boolean; warnings?: string[] } = {}) {
  const task = executeTaskInternal(prompt, publicInput, args, cwd, abortSignal, onProgress, options);
  activeExecutionTasks.add(task);
  try {
    return await task;
  } finally {
    activeExecutionTasks.delete(task);
  }
}

async function executeTaskInternal(prompt: string, publicInput: string, args: ExecutionRequest, cwd: string, abortSignal?: AbortSignal | null, onProgress?: ((info: { message?: string }) => void) | null, options: { requireEnvelope?: boolean; warnings?: string[] } = {}) {
  if (abortSignal?.aborted) throw new Error('ABORTED: Request cancelled before provider resolution.');
  const previous = args.session_handle ? getSession(args.session_handle, { workspace: cwd }) : null;
  if (args.session_handle && !previous) throw new Error('SESSION_INVALID: Session is expired, invalidated, closed or belongs to another workspace.');
  if (previous && args.backend && !['auto', 'smart_quota', previous.backend].includes(args.backend)) throw new Error('SESSION_INVALID: A session cannot switch provider.');
  const backend = await resolveBackend(previous?.backend || args.backend);
  if (abortSignal?.aborted) throw new Error('ABORTED: Request cancelled before acquiring the session.');
  if (previous && !previous.threadId) throw new Error('SESSION_INVALID: Native continuation is unavailable for this session; history remains accessible.');
  const config = backend.probe.config as { defaultModel?: string } | undefined;
  const model = args.model || previous?.model || config?.defaultModel;
  if (checkModelGovernance(model, args.user_confirmed)) throw new Error('POLICY_DENIED: Effective model requires explicit user_confirmed: true.');
  await pruneExpiredSessions();
  const acquired = await acquireAndResolveSession(args.session_handle, backend.id, cwd);
  if (!acquired.session) throw new Error(`SESSION_BUSY: ${acquired.error}`);
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
  const report = (message: string) => onProgress?.({ message: redactDiagnostic(message, 512) });
  const receive = (event: AdapterEvent) => {
    if (event.type === 'user_message' || event.type === 'turn_started' || event.type === 'turn_finished') return;
    lastEvent = Date.now();
    if (event.type !== 'status') writer.accept(event);
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
    writer.accept({ type: 'turn_started' }); writer.accept({ type: 'user_message', text: publicInput }); await writer.flush();
    heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - lastEvent;
      if (elapsedMs >= 10000) {
        const totalElapsedSec = Math.floor((Date.now() - started) / 1000);
        report(`Operation in progress (${lastPhase}, ${totalElapsedSec}s elapsed)...`);
      }
    }, 5000);
    flushTimer = setInterval(() => { void writer.flush().catch(err => { historyError = err; }); }, 250);
    const options: ExecutionOptions = { cwd, model, reasoningEffort: args.reasoning_effort, nativeSessionId: session.threadId, threadId: session.threadId,
      userConfirmed: args.user_confirmed, timeoutMs: args.timeout_ms, abortSignal: cancelController.signal, onEvent: receive };
    const raw: ExecutionResult = await backend.adapter.execute(prompt, options);
    // Validate terminal results defensively, including adapters supplied at runtime.
    const validStatus = ['completed', 'failed', 'cancelled', 'timed_out'].includes(raw.status || '');
    const contradictory = raw.status === 'completed' && (raw.isError || !!raw.error);
    const protocolTrusted = validStatus && !contradictory;
    const error = raw.error || (!validStatus || contradictory || (raw.status !== 'completed' && !raw.error) ? { code: 'PROTOCOL_ERROR' as const, message: 'Adapter returned a missing or inconsistent terminal result.', retryable: false } : undefined);
    if (Buffer.byteLength(raw.output || '') > 1024 * 1024) throw new BufferLimitError('Public response exceeds 1 MiB.');
    result = { ...raw, status: error && raw.status !== 'cancelled' && raw.status !== 'timed_out' ? 'failed' : raw.status || 'failed', isError: !!error || raw.status !== 'completed',
      error, truncated: !!raw.truncated, continuationAvailable: protocolTrusted && !!raw.continuationAvailable && !!(raw.nativeSessionId || raw.threadId || session.threadId) && error?.code !== 'SESSION_INVALID' && error?.code !== 'SANDBOX_UNAVAILABLE', output: protocolTrusted ? redactSecrets(raw.output || '') : '' };
    if (protocolTrusted && (raw.nativeSessionId || raw.threadId)) await updateSession(handle, { threadId: raw.nativeSessionId || raw.threadId || null, model: raw.model || model, cliVersion: backend.probe.version,
      safetyProfile: backend.id === 'gemini' ? `gemini-${backend.probe.version}-read-only` : undefined }, token);
    if (error?.code === 'SESSION_INVALID') await updateSession(handle, { state: 'invalidated', threadId: null, lastErrorCode: error.code }, token);
    if (error?.code === 'RATE_LIMITED') {
      await checkAndRecordRateLimit(backend.id, error.message).catch(() => {});
    }
    if (result.output && !sawPublicMessage) writer.accept({ type: 'assistant_message', messageId: 'final', text: result.output });
  } catch (err) {
    const code = (err as { code?: ErrorCode })?.code;
    result = { isError: true, status: 'failed', output: '', error: { code: code && ERROR_CODES.includes(code) ? code : 'PROCESS_ERROR', message: redactDiagnostic((err as Error).message), retryable: false }, truncated: code === 'BUFFER_LIMIT', continuationAvailable: false };
    if (result.error?.code === 'RATE_LIMITED') {
      await checkAndRecordRateLimit(backend.id, result.error.message).catch(() => {});
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat); if (flushTimer) clearInterval(flushTimer);
    if (abortSignal) abortSignal.removeEventListener('abort', onCallerAbort);
  }
  try {
    if (result.error) writer.accept({ type: 'error', error: result.error });
    writer.accept({ type: 'turn_finished', status: result.status }); await writer.flush();
  } catch (err) { historyError = err as Error; }
  const released = await releaseSessionTurn(handle, token);
  activeSessionAborts.delete(handle);
  notifySettled!();
  if ((historyError || !released.ok) && !cancelController.signal.aborted) {
    result = { ...result, isError: true, status: 'failed', error: { code: 'HISTORY_ERROR', message: redactDiagnostic(historyError?.message || released.error), retryable: false } };
    if (!historyError) {
      try { writer.accept({ type: 'error', error: result.error! }); writer.accept({ type: 'turn_finished', status: 'failed' }); await writer.flush(); }
      catch (err) { historyError = err as Error; }
    }
  }
  const warnings: string[] = [...(options.warnings || [])];
  try {
    if (result.error?.code === 'RATE_LIMITED') await recordQuotaCooldown(backend.id);
    else if (!result.isError && result.status === 'completed') await resetQuotaCooldown(backend.id);
  } catch (error) {
    warnings.push(`Cooldown cache update failed: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 512)}`);
  }
  return formatExecutionResult(backend.id, result, '', handle, { turn: session.turnCount || 1, toolCount, durationMs: Date.now() - started, historyAvailable: !writer.disabled && !historyError }, { ...options, warnings });
}
