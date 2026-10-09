/**
 * Shared execution controller orchestrating CLI adapter lifecycles, sessions, and events.
 *
 * @remarks
 * ## Lifecycle & Architecture Contract
 * - **Provider Resolution & Policy Governance**: Dynamically resolves the active CLI backend
 *   via `resolveBackend` (Codex, agy / Gemini CLI, or Claude Code). A model the governance
 *   policy prices as expensive, unknown or approximate (`consentFor`), requested or the
 *   backend's default, runs only after the user approves it through {@link ConsentPrompt};
 *   without one the turn fails with `POLICY_DENIED`.
 * - **Price Limit** (`AX-002`): `output_price_below` is checked for the concrete model, separately
 *   from consent, before the user is asked and again right before the session is acquired;
 *   a model without a verified price below the limit fails with `PRICE_LIMIT`, never
 *   replaced by another. Without a named model, routing and selection choose one that meets it.
 * - **Turn Mutual Exclusion & Lease Tokens**: Sessions are acquired with unique turn tokens
 *   (`acquireAndResolveSession`). A single session handle cannot execute concurrent turns; attempts
 *   receive `SESSION_BUSY`.
 * - **Streaming Events & Best-Effort Archive**: Emits normalized `AdapterEvent` updates to an append-only
 *   `HistoryWriter` flushed periodically every 250ms and finalized on `turn_finished`.
 * - **Progress Heartbeats**: Reports granular activity updates (`onProgress`).
 *   If no events arrive within 10 seconds, background heartbeats notify the orchestrator with
 *   elapsed seconds and active phase.
 * - **Defensive Protocol Validation**: Validates adapter terminal results (`TerminalExecutionResult`).
 *   Contradictory or missing results fail safely as `PROTOCOL_ERROR`, discarding untrusted output.
 * - **State Envelope Gate Enforcement**: Evaluates review-only reported verdicts
 *   via evaluateStateEnvelopeGate, returning structured review evaluation in TaskExecutionResult.
 *   The review handler supplies completeness, snapshot identity and check requirements;
 *   this does not independently prove a model's PASS claim or release artifact hashes.
 * - **Timing Scope**: Preparation and consent precede session acquisition and the duration
 *   timer. The adapter receives its process timeout, not a remaining end-to-end budget.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { loadConfigSnapshot } from '../config.js';
import { acquireAndResolveSession, releaseSessionTurn, updateSession, pruneExpiredSessions, setExecutionCanceller, type CancelOutcome } from '../sessions/session.js';
import { createHistoryWriter } from '../sessions/history/index.js';
import { redactDiagnostic, redactCredentialFormats } from '../security/redaction.js';
import { truncateToByteLength, BufferLimitError } from './runtime/stream.js';
import type { ExecutionOptions, ExecutionResult, TerminalExecutionResult } from '../backends/types.js';
import { ToolError, errorCodeOf, type AdapterEvent, type ProviderId } from '../contracts/index.js';
import { recordQuotaCooldown, resetQuotaCooldown } from '../backends/availability.js';
import { parseResetTimestamp } from '../backends/rate-limit.js';
import { stripAnsi } from './cli-output.js';
import { evaluateStateEnvelopeGate, type ReviewGateContext, type StateEnvelopeEvaluation } from '../review/index.js';
import type { TaskExecutionResult, ExecutionMeta, TimingObserver, MonotonicClock, ExecutionTrace } from '../contracts/execution.js';
import { createPhaseTracker } from './runtime/timing.js';
import {
  prepareTask,
  type ExecutionRequest,
  type ConsentPrompt,
  type PreparedTask,
  type PrepareTaskOptions,
  type ConfirmConsentOptions,
  type ConfirmConsentResult,
} from './preparation.js';

export type {
  TaskExecutionResult,
  ExecutionMeta,
  TimingObserver,
  MonotonicClock,
  ExecutionTrace,
  ExecutionRequest,
  ConsentPrompt,
  PreparedTask,
  PrepareTaskOptions,
  ConfirmConsentOptions,
  ConfirmConsentResult,
};

/** Per-call options of {@link executeTask} set by the server and tool handlers, never by tool arguments. */
export interface TaskOptions {
  /** Gate review results on the State Envelope. */
  requireEnvelope?: boolean;
  /** Notices added to the result, such as a deprecated tool name. */
  warnings?: string[];
  /** Absent when the client cannot ask the user; a model that needs approval is then refused. */
  askConsent?: ConsentPrompt;
  /** Input binding supplied by the review handler. */
  reviewContext?: ReviewGateContext;
  /** Rechecks the workspace after the turn; a change or failed read blocks readiness. */
  verifyReviewSnapshot?: () => Promise<string | undefined>;
  /** Optional observer callback receiving the timing trace, including on early errors. */
  onTiming?: TimingObserver;
  /** Optional custom monotonic clock for timing. */
  clock?: MonotonicClock;
  /** Optional existing phase tracker to compose spans into a single trace. */
  tracker?: import('./runtime/timing.js').PhaseTracker;
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
 * @returns Neutral execution result containing all evidence and metadata.
 */
export async function executeTask(
  prompt: string,
  publicInput: string,
  args: ExecutionRequest,
  cwd: string,
  abortSignal?: AbortSignal | null,
  onProgress?: ((info: { message?: string }) => void) | null,
  options: TaskOptions = {}
): Promise<TaskExecutionResult> {
  const task = executeTaskInternal(prompt, publicInput, args, cwd, abortSignal, onProgress, options);
  activeExecutionTasks.add(task);
  try {
    return await task;
  } finally {
    activeExecutionTasks.delete(task);
  }
}

async function executeTaskInternal(
  prompt: string,
  publicInput: string,
  args: ExecutionRequest,
  cwd: string,
  abortSignal?: AbortSignal | null,
  onProgress?: ((info: { message?: string }) => void) | null,
  options: TaskOptions = {}
): Promise<TaskExecutionResult> {
  const isOwnedTracker = !options.tracker;
  const tracker = options.tracker ?? createPhaseTracker({ clock: options.clock });
  const controllerSpans: Array<{ end: () => void }> = [];
  const startControllerPhase = (name: string) => {
    const handle = tracker.startPhase(name);
    controllerSpans.push(handle);
    return handle;
  };
  const closeControllerSpans = () => {
    for (const span of controllerSpans) {
      span.end();
    }
  };

  let traceEmitted = false;
  const observerWarnings: string[] = [];
  const recordObserverError = (err: unknown) => {
    let msg = 'Unknown observer error.';
    try {
      if (err instanceof Error) msg = err.message;
      else if (typeof err === 'string') msg = err;
      else msg = String(err);
    } catch {
      msg = 'Unstringifiable error thrown.';
    }
    const warningMsg = `Timing observer failed: ${redactDiagnostic(msg, 256)}`;
    if (!observerWarnings.includes(warningMsg)) {
      observerWarnings.push(warningMsg);
    }
  };

  let observerPromise: Promise<unknown> | undefined;
  const emitTrace = (): ExecutionTrace => {
    if (traceEmitted) return tracker.getTrace();
    traceEmitted = true;
    closeControllerSpans();
    const trace = isOwnedTracker ? tracker.complete() : tracker.getTrace();
    if (options.onTiming) {
      try {
        const ret: unknown = options.onTiming(trace);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          observerPromise = (ret as Promise<unknown>).catch(recordObserverError);
        }
      } catch (err: unknown) {
        recordObserverError(err);
      }
    }
    return trace;
  };

  try {
    const prepHandle = startControllerPhase('preparation');
    const configSnapshot = loadConfigSnapshot();
    const prepared = await prepareTask(args, cwd, {
      config: configSnapshot,
      abortSignal,
    });
    prepHandle.end();

    const consentHandle = startControllerPhase('consent');
    const { priceNote, warnings: consentWarnings } = await prepared.confirmConsent({
      askConsent: options.askConsent,
      abortSignal,
    });
    consentHandle.end();

    const backend = prepared.backend;
    const model = prepared.model;
    const reasoningEffort = prepared.reasoningEffort;

    const acqHandle = startControllerPhase('acquisition');
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
    acqHandle.end();
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
  const execHandle = startControllerPhase('execution');
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
      const options: ExecutionOptions = { cwd, model, reasoningEffort, nativeSessionId: session.threadId, threadId: session.threadId,
        timeoutMs: args.timeout_ms, abortSignal: cancelController.signal, onEvent: receive };
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
      execHandle.end();
      if (heartbeat) clearInterval(heartbeat); if (flushTimer) clearInterval(flushTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onCallerAbort);
    }

    const finHandle = startControllerPhase('finalization');
    const warnings: string[] = [...(options.warnings || []), ...(backend.warnings || []), ...consentWarnings, ...adapterWarnings];

    // Post-execution bookkeeping: session metadata (AUD-P1-3)
    try {
      const raw = result as ExecutionResult;
      const protocolTrusted = !result.error || result.error.code !== 'PROTOCOL_ERROR';
      if (protocolTrusted && (raw.nativeSessionId || raw.threadId)) {
        await updateSession(handle, {
          threadId: raw.nativeSessionId || raw.threadId || null,
          model: raw.model || model,
          reasoningEffort,
          cliVersion: backend.probe.version,
          safetyProfile: backend.id === 'agy' ? `agy-${backend.probe.version}-read-only` : undefined,
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

    if (options.reviewContext && options.verifyReviewSnapshot) {
      try { options.reviewContext.invalidatedReason = await options.verifyReviewSnapshot(); }
      catch (error) { options.reviewContext.invalidatedReason = `Cannot verify review snapshot: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 256)}`; }
    }

    let review: StateEnvelopeEvaluation | undefined;
    if (options.requireEnvelope) {
      if (result.isError || result.error) {
        review = {
          verdict: 'BLOCKED',
          reason: result.error?.message || 'Execution error',
        };
      } else {
        review = evaluateStateEnvelopeGate(
          stripAnsi(result.output || '').trim(),
          result.truncated,
          true,
          options.reviewContext
        );
      }
    }
    finHandle.end();
    const durationMs = Date.now() - started;

    const trace = emitTrace();
    if (observerPromise) {
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      await Promise.race([
        observerPromise,
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, 500);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        observerWarnings.push('Timing observer timed out after 500ms.');
      }
    }
    for (const w of observerWarnings) {
      if (!warnings.includes(w)) warnings.push(w);
    }

    return {
      isError: result.isError,
      provider: backend.id,
      result,
      sessionHandle: handle,
      meta: {
        turn: session.turnCount || 1,
        toolCount,
        durationMs,
        historyAvailable: !writer.disabled && !historyError,
        phases: trace.phases,
      },
      warnings,
      price: priceNote,
      review,
    };
  } finally {
    closeControllerSpans();
    emitTrace();
  }
}
