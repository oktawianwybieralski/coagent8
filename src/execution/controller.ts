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
 * - **Timing Scope**: Single monotonic execution budget wraps the complete task lifecycle
 *   (Git collection, preparation, consent, session acquisition, CLI execution, and teardown).
 *   The adapter receives the monotonic remaining time, not a static process timeout.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { loadConfigSnapshot } from '../config.js';
import { acquireAndResolveSession, releaseSessionTurn, updateSession, pruneExpiredSessions, setExecutionCanceller, assertSessionNotExpired, findCompletedReview, getSession, isProcessAlive, MAX_REVIEW_REASON_CHARS, type CancelOutcome } from '../sessions/session.js';
import { createHistoryWriter } from '../sessions/history/index.js';
import { redactDiagnostic, redactCredentialFormats } from '../security/redaction.js';
import { truncateToByteLength, BufferLimitError } from './runtime/stream.js';
import { combineSignals } from '../storage/lock.js';
import { isValidModelIdentifier } from '../models/identifier.js';
import type { ExecutionOptions, ExecutionResult, TerminalExecutionResult } from '../backends/types.js';
import { ToolError, errorCodeOf, type AdapterEvent, type ProviderId } from '../contracts/index.js';
import { recordQuotaCooldown, resetQuotaCooldown } from '../backends/availability.js';
import { createExecutionBudget } from './runtime/budget.js';
import { parseResetTimestamp } from '../backends/rate-limit.js';
import { stripAnsi } from './cli-output.js';
import { evaluateStateEnvelopeGate, type ReviewGateContext, type StateEnvelopeEvaluation } from '../review/index.js';
import type { TaskExecutionResult, ExecutionMeta, TimingObserver, MonotonicClock, ExecutionTrace, ExecutionBudget, BackendReadContext } from '../contracts/execution.js';
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
  /**
   * Collected review snapshot and scope. With the resolved backend and model they identify the
   * request: an equal completed review in this workspace answers without a model turn (`AX-007c`).
   */
  reviewIdentity?: { snapshot: string; scope: string };
  /** Optional observer callback receiving the timing trace, including on early errors. */
  onTiming?: TimingObserver;
  /** Optional custom monotonic clock for timing. */
  clock?: MonotonicClock;
  /** Optional existing phase tracker to compose spans into a single trace. */
  tracker?: import('./runtime/timing.js').PhaseTracker;
  /** Optional execution budget contract tracking call deadlines. */
  budget?: ExecutionBudget;
  /** Optional context for observation and read operations. */
  context?: BackendReadContext;
  /** Optional factory override to inject history writer errors or custom writers during tests. */
  createHistoryWriter?: (handle: string, workspace: string, provider: ProviderId, turnId: string) => ReturnType<typeof createHistoryWriter>;
  /** Optional hook to simulate failure immediately during turn registration. */
  simulateRegistrationFault?: () => void;
  /** Optional hook to simulate metadata update failure during finalization. */
  updateSession?: typeof updateSession;
  /** Optional hook to simulate lease release failure during finalization. */
  releaseSessionTurn?: typeof releaseSessionTurn;
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
  const isOwnedBudget = !options.budget && !options.context?.budget;
  const budget = options.budget ?? options.context?.budget ?? createExecutionBudget({
    totalBudgetMs: typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) ? args.timeout_ms : undefined,
    parentSignal: abortSignal ?? undefined,
    clock: options.clock,
  });

  const executionContext: BackendReadContext = {
    ...options.context,
    abortSignal: combineSignals(options.context?.abortSignal, abortSignal, budget.executionSignal) ?? undefined,
    budget,
    timeoutMs: budget.remainingExecutionMs(),
  };

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
    if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
      throw new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`);
    }
    if (budget.isCallerAborted()) {
      throw new ToolError('ABORTED', 'Request cancelled before task preparation.');
    }

    const prepHandle = startControllerPhase('preparation');
    const configSnapshot = loadConfigSnapshot();
    const prepared = await prepareTask(args, cwd, {
      config: configSnapshot,
      abortSignal,
      budget,
      context: executionContext,
      // A review prompt is self-contained: a failed review with no native thread is retried in its session.
      allowFreshNativeThread: Boolean(options.reviewIdentity),
    });
    prepHandle.end();

    // An unchanged repeat review costs no turn: the earlier server verdict for the same input
    // and reviewer stands (AX-007c). A failed lookup is reported and the review runs.
    const repeatWarnings: string[] = [];
    const reviewIdentity = options.reviewIdentity ? { ...options.reviewIdentity, model: prepared.model || null } : undefined;
    if (reviewIdentity) {
      let previous: ReturnType<typeof findCompletedReview> = null;
      try {
        previous = findCompletedReview(cwd, prepared.backend.id, reviewIdentity);
      } catch (error) {
        repeatWarnings.push(`Repeat-review check unavailable, so this review ran: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 256)}`);
      }
      if (previous) {
        const trace = emitTrace();
        const totalMs = typeof budget.elapsedMs === 'function' ? Math.max(trace.totalDurationMs, budget.elapsedMs()) : trace.totalDurationMs;
        let explicitSession: ReturnType<typeof getSession> = null;
        if (prepared.previousSession) {
          try {
            const current = getSession(prepared.previousSession.sessionHandle, { workspace: cwd });
            if (current && current.backend === prepared.backend.id) {
              explicitSession = current;
            }
          } catch {
            explicitSession = null;
          }
        }
        const retainedHandle = explicitSession?.sessionHandle ?? previous.sessionHandle;
        const continuationAvailable = explicitSession
          ? !isProcessAlive(explicitSession.activePid) && explicitSession.state === 'idle' && Boolean(explicitSession.threadId)
          : previous.continuationAvailable;
        return {
          isError: false,
          provider: prepared.backend.id,
          result: {
            status: 'completed',
            isError: false,
            output: `No model turn: this request matches a completed review with complete coverage and input (same snapshot, scope, backend and model) in session ${previous.sessionHandle}, completed ${previous.review.completedAt}. Its server verdict below still applies. Change the code or the scope, or choose another backend or model, to review again (incomplete or failed reviews can be retried).`,
            ...(prepared.model ? { model: prepared.model } : {}),
            truncated: false,
            continuationAvailable,
          },
          sessionHandle: retainedHandle,
          meta: { turn: 0, toolCount: 0, durationMs: totalMs, totalMs, historyAvailable: false, phases: trace.phases },
          warnings: [...(options.warnings || []), ...(prepared.backend.warnings || [])],
          review: { verdict: previous.review.verdict, ...(previous.review.reason ? { reason: previous.review.reason } : {}) },
        };
      }
    }

    const consentHandle = startControllerPhase('consent');
    const { priceNote, warnings: consentWarnings } = await prepared.confirmConsent({
      askConsent: options.askConsent,
      abortSignal,
      budget,
      context: executionContext,
    });
    consentHandle.end();

    const backend = prepared.backend;
    const model = prepared.model;
    const reasoningEffort = prepared.reasoningEffort;

    if (!isValidModelIdentifier(model)) {
      throw new ToolError('INPUT_LIMIT', 'Invalid model identifier.');
    }

    const sessionContext: BackendReadContext = {
      ...executionContext,
      abortSignal: combineSignals(executionContext.abortSignal, abortSignal, budget.executionSignal) ?? undefined,
      budget,
      timeoutMs: budget.remainingExecutionMs(),
    };

    const assertSessionContextNotExpired = (timing: 'before' | 'immediately after') => {
      const effectiveSignal = combineSignals(sessionContext.abortSignal, sessionContext.budget?.executionSignal);
      assertSessionNotExpired(effectiveSignal, sessionContext.budget, `session acquisition (${timing})`);
    };

    const acqHandle = startControllerPhase('acquisition');
    let acquired: Awaited<ReturnType<typeof acquireAndResolveSession>>;
    try {
      assertSessionContextNotExpired('before');
      await pruneExpiredSessions();
      assertSessionContextNotExpired('before');

      acquired = await acquireAndResolveSession(args.session_handle, backend.id, cwd, sessionContext);
      if (!acquired.session) throw new ToolError('SESSION_BUSY', acquired.error ?? 'Session is busy executing another turn.');
    } catch (err) {
      acqHandle.end();
      throw err;
    }
    const session = acquired.session, handle = session.sessionHandle, token = session.turnToken!;

    let notifySettled!: () => void;
    const settled = new Promise<void>(resolve => { notifySettled = resolve; });
    const cancelController = new AbortController();
    let callerAbortListenerAdded = false;
    const onCallerAbort = () => cancelController.abort();
    let abortEntry: { abort: () => void; wait: () => Promise<boolean> } | undefined;
    let abortEntryRegistered = false;
    let turnReleased = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    let onBudgetAbort: (() => void) | undefined;
    let budgetAbortListenerAdded = false;

    try {
      assertSessionContextNotExpired('immediately after');

      if (abortSignal) {
        if (abortSignal.aborted) cancelController.abort();
        else {
          abortSignal.addEventListener('abort', onCallerAbort, { once: true });
          callerAbortListenerAdded = true;
        }
      }
      abortEntry = {
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
      };
      activeSessionAborts.set(handle, abortEntry);
      abortEntryRegistered = true;
      if (options.simulateRegistrationFault) {
        options.simulateRegistrationFault();
      }

      const writerFactory = options.createHistoryWriter ?? createHistoryWriter;
      const writer = writerFactory(handle, cwd, backend.id, randomUUID(), { context: sessionContext });
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

        const remainingExecutionMs = budget.remainingExecutionMs();
        if (remainingExecutionMs <= 0 || budget.isExecutionExpired() || budget.isTimedOut()) {
          throw new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`);
        }
        if (budget.isCallerAborted()) {
          throw new ToolError('ABORTED', 'Request cancelled before CLI execution.');
        }

        onBudgetAbort = () => {
          cancelController.abort(budget.abortReason() ?? new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`));
        };
        budgetAbortListenerAdded = false;
        if (budget.executionSignal.aborted) {
          cancelController.abort(budget.abortReason() ?? new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`));
        } else {
          budget.executionSignal.addEventListener('abort', onBudgetAbort, { once: true });
          budgetAbortListenerAdded = true;
        }

        const options: ExecutionOptions = { cwd, model, reasoningEffort, nativeSessionId: session.threadId, threadId: session.threadId,
          timeoutMs: remainingExecutionMs, abortSignal: cancelController.signal, onEvent: receive };
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
        if (budgetAbortListenerAdded && onBudgetAbort) {
          budget.executionSignal.removeEventListener('abort', onBudgetAbort);
          budgetAbortListenerAdded = false;
        }
        if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
        if (flushTimer) { clearInterval(flushTimer); flushTimer = undefined; }
        if (callerAbortListenerAdded && abortSignal) {
          abortSignal.removeEventListener('abort', onCallerAbort);
          callerAbortListenerAdded = false;
        }
      }

      const finHandle = startControllerPhase('finalization');
      const warnings: string[] = [...(options.warnings || []), ...(backend.warnings || []), ...repeatWarnings, ...consentWarnings, ...adapterWarnings];
      const rawExecutionError = result.error;

      // Post-execution bookkeeping: session metadata (AUD-P1-3)
      const doUpdateSession = options.updateSession ?? updateSession;
      try {
        const raw = result as ExecutionResult;
        const protocolTrusted = !result.error || result.error.code !== 'PROTOCOL_ERROR';
        if (protocolTrusted && (raw.nativeSessionId || raw.threadId)) {
          await doUpdateSession(handle, {
            threadId: raw.nativeSessionId || raw.threadId || null,
            model: raw.model || model,
            reasoningEffort,
            cliVersion: backend.probe.version,
            safetyProfile: backend.id === 'agy' ? `agy-${backend.probe.version}-read-only` : undefined,
          }, token);
        }
        if (result.error?.code === 'SESSION_INVALID') {
          await doUpdateSession(handle, { state: 'invalidated', threadId: null, lastErrorCode: result.error.code }, token);
        }
      } catch (sessionErr) {
        warnings.push(`Session update failed: ${redactDiagnostic((sessionErr as Error).message, 512)}`);
        result = { ...result, continuationAvailable: false };
        try {
          await doUpdateSession(handle, { state: 'invalidated' }, token);
        } catch (invalidateErr) {
          warnings.push(`Session could not be invalidated: ${redactDiagnostic((invalidateErr as Error).message, 512)}`);
        }
      }

      // History archival finalization (Primary Task Supremacy: archive failure preserves valid answer)
      try {
        if (result.output && !sawPublicMessage) writer.accept({ type: 'assistant_message', messageId: 'final', text: result.output });
        if (result.error) writer.accept({ type: 'error', error: result.error });
        writer.accept({ type: 'turn_finished', status: result.status });
        await writer.flush();
      } catch (err) {
        if (!historyError) historyError = err as Error;
      }

      // Release session turn lease (fail-closed)
      const doReleaseSessionTurn = options.releaseSessionTurn ?? releaseSessionTurn;
      let releaseError: string | undefined;
      try {
        turnReleased = true;
        const released = await doReleaseSessionTurn(handle, token);
        if (!released.ok) {
          releaseError = released.error || 'Failed to release session turn lease';
        }
      } catch (err) {
        releaseError = (err as Error).message || 'Failed to release session turn lease';
      }

      if (releaseError && !cancelController.signal.aborted) {
        result = {
          ...result,
          isError: true,
          status: 'failed',
          error: { code: 'SESSION_INVALID', message: redactDiagnostic(releaseError), retryable: false },
          continuationAvailable: false,
        };
      }

      if (historyError) {
        warnings.push(`History not saved: ${redactDiagnostic(historyError.message, 512)}`);
      }

      // Quota cooldown update: exactly one write per rate-limited or completed turn
      try {
        const rateErr = (result.error?.code === 'RATE_LIMITED' ? result.error : undefined)
          ?? (rawExecutionError?.code === 'RATE_LIMITED' ? rawExecutionError : undefined);
        if (rateErr) {
          const reset = parseResetTimestamp(rateErr.message);
          await recordQuotaCooldown(backend.id, reset?.cooldownMs, rateErr.message.slice(0, 200) || undefined);
        } else if (!result.isError && result.status === 'completed') {
          await resetQuotaCooldown(backend.id);
        }
      } catch (error) {
        warnings.push(`Cooldown cache update failed: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 512)}`);
      }

      // Review snapshot verification & gate evaluation: failed snapshot recheck cannot yield READY
      let snapshotError: string | undefined;
      if (options.verifyReviewSnapshot) {
        try {
          snapshotError = await options.verifyReviewSnapshot();
        } catch (error) {
          snapshotError = `Cannot verify review snapshot: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 256)}`;
        }
      }

      let reviewContext = options.reviewContext;
      if (snapshotError) {
        if (!reviewContext) {
          reviewContext = {
            expectedSnapshot: '',
            requiredChecks: [],
            inputComplete: true,
            invalidatedReason: snapshotError,
          };
        } else {
          reviewContext.invalidatedReason = snapshotError;
        }
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
            reviewContext
          );
        }
      }
      // Only a completed turn whose input stayed unchanged identifies a review to refuse repeating.
      // Only a judged review with COMPLETE coverage and complete collected input suppresses an unchanged repeat (FEEDBACK-061j).
      const isInputComplete = !reviewContext || reviewContext.inputComplete;
      const effectiveCoverage = isInputComplete ? review?.coverage : 'PARTIAL';
      if (reviewIdentity && review?.judged && review.verdict !== 'NOT_APPLICABLE' && !snapshotError && !result.isError && !result.error && result.status === 'completed') {
        try {
          await doUpdateSession(handle, { lastReview: {
            ...reviewIdentity,
            verdict: review.verdict,
            ...(effectiveCoverage ? { coverage: effectiveCoverage } : {}),
            ...(review.reason ? { reason: review.reason.slice(0, MAX_REVIEW_REASON_CHARS) } : {}),
            completedAt: new Date().toISOString(),
          } }, token);
        } catch (error) {
          warnings.push(`Review outcome not recorded, so an unchanged repeat will run again: ${redactDiagnostic(error instanceof Error ? error.message : 'Unknown error.', 256)}`);
        }
      }
      finHandle.end();
      const trace = emitTrace();
      const totalMs = typeof budget.elapsedMs === 'function'
        ? Math.max(trace.totalDurationMs, budget.elapsedMs())
        : trace.totalDurationMs;
      const durationMs = totalMs;

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
          totalMs,
          historyAvailable: !writer.disabled && !historyError,
          phases: trace.phases,
        },
        warnings,
        price: priceNote,
        review,
      };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (flushTimer) clearInterval(flushTimer);
      if (callerAbortListenerAdded && abortSignal) {
        abortSignal.removeEventListener('abort', onCallerAbort);
        callerAbortListenerAdded = false;
      }
      if (!turnReleased) {
        turnReleased = true;
        try {
          const doRelease = options.releaseSessionTurn ?? releaseSessionTurn;
          await doRelease(handle, token);
        } catch {
          // ignore error in emergency fallback release
        }
      }
      if (abortEntryRegistered) {
        if (activeSessionAborts.get(handle) === abortEntry) {
          activeSessionAborts.delete(handle);
        }
        abortEntryRegistered = false;
      }
      notifySettled();
    }
  } finally {
    closeControllerSpans();
    emitTrace();
    if (isOwnedBudget) {
      budget.dispose();
    }
  }
}
