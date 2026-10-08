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
import { resolveBackend } from '../backends/routing.js';
import { readModelCatalog } from '../backends/probe-cache.js';
import { checkModelSelection, findCatalogEntry } from '../backends/model-catalog.js';
import { selectModel, type PriceConstraint } from '../backends/model-selection.js';
import { checkPriceLimit, priceEvidence, readPrices } from '../backends/prices.js';
import { consentDeclinedMessage, consentRequiredMessage, consentUnansweredMessage } from '../backends/governance.js';
import { isValidModelIdentifier } from '../backends/model-identifier.js';
import { consentFor } from '../backends/consent.js';
import { rememberApprovedModel } from '../config.js';
import { acquireAndResolveSession, getSession, releaseSessionTurn, updateSession, pruneExpiredSessions, setExecutionCanceller, type CancelOutcome } from '../sessions/session.js';
import { createHistoryWriter } from '../sessions/history.js';
import { redactDiagnostic, redactCredentialFormats } from '../redaction.js';
import { truncateToByteLength, BufferLimitError } from './runtime/stream.js';
import type { ExecutionOptions, ExecutionResult, TerminalExecutionResult } from '../backends/types.js';
import { ToolError, errorCodeOf, type AdapterEvent, type ProviderId } from '../conversation.js';
import { recordQuotaCooldown, resetQuotaCooldown } from '../backends/availability.js';
import { parseResetTimestamp } from '../backends/rate-limit.js';
import { assertNotNestedTurn } from './nested-turn.js';
import { stripAnsi } from './cli-output.js';
import { evaluateStateEnvelopeGate, type ReviewGateContext, type StateEnvelopeEvaluation } from '../review/index.js';
import type { TaskExecutionResult, ExecutionMeta } from '../contracts/execution.js';

export type { TaskExecutionResult, ExecutionMeta };

/**
 * Universal execution parameters accepted by execution tools and the run gateway.
 */
export interface ExecutionRequest {
  backend?: string;
  session_handle?: string;
  model?: string;
  reasoning_effort?: string;
  timeout_ms?: number;
  /** User's price limit in USD per million output tokens; strict (`AX-002`). */
  output_price_below?: number;
}

/**
 * Asks the user, not the calling agent, to approve a model; `approved` is true only on the
 * user's approval, `unanswered` when the client cancelled the request without a decision, and
 * `remember` only when the request offered it and the user chose it.
 * The server implements it with MCP elicitation when the client supports it (AUD-P1-7).
 */
export type ConsentPrompt = (request: { backend: string; model: string; reason: string; offerRemember: boolean }) => Promise<{ approved: boolean; unanswered?: boolean; remember?: boolean }>;

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
 * Resolves the backend for a named model. `auto` routes to a backend whose CLI lists the
 * model, by id or alias; when none lists it, to one whose CLI decides itself: it runs
 * unlisted models (Claude Code) or lists none. An explicit backend is kept and its catalog
 * check reports a model it does not offer.
 * @throws `MODEL_UNAVAILABLE` naming each permitted backend that does not offer the model.
 */
async function resolveBackendForModel(requested: string | undefined, model: string) {
  const offers = (acceptUnlisted: boolean) => async (id: ProviderId) => {
    const catalog = await readModelCatalog(id);
    if (catalog && findCatalogEntry(catalog, model)) return undefined;
    if (acceptUnlisted && (!catalog || catalog.acceptsUnlisted)) return undefined;
    return new ToolError('MODEL_UNAVAILABLE', `does not list '${model}'; doctor lists its models.`);
  };
  try { return await resolveBackend(requested, { eligible: offers(false) }); }
  catch (err) {
    if (!(err instanceof ToolError) || err.code !== 'MODEL_UNAVAILABLE') throw err;
    return resolveBackend(requested, { eligible: offers(true) });
  }
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
  // A server started by a backend inside a turn never starts another one (CUR-002).
  assertNotNestedTurn();
  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled before provider resolution.');
  // The model reaches CLI argv; option-like or whitespace values are rejected before any backend runs.
  if (args.model !== undefined && !isValidModelIdentifier(args.model)) throw new ToolError('INPUT_LIMIT', 'Invalid model identifier.');
  const previous = args.session_handle ? getSession(args.session_handle, { workspace: cwd }) : null;
  if (args.session_handle && !previous) throw new ToolError('SESSION_INVALID', 'Session is expired, invalidated, closed or belongs to another workspace.');
  if (previous && args.backend && !['auto', 'smart_quota', previous.backend].includes(args.backend)) throw new ToolError('SESSION_INVALID', 'A session cannot switch provider.');
  const below = args.output_price_below;
  const constraint: PriceConstraint | undefined = below === undefined ? undefined : { below, effort: args.reasoning_effort };
  // Without a named model, only backends with a model below the limit are chosen from.
  const choosing = constraint && args.model === undefined && !previous ? constraint : undefined;
  const backend = previous ? await resolveBackend(previous.backend)
    : args.model !== undefined ? await resolveBackendForModel(args.backend, args.model)
    : await resolveBackend(args.backend, choosing ? { eligible: async (id, probe) => {
      try { await selectModel(id, probe, {}, { constraint: choosing }); return undefined; }
      catch (err) { if (err instanceof ToolError && (err.code === 'PRICE_LIMIT' || err.code === 'MODEL_UNAVAILABLE')) return err; throw err; }
    } } : {});
  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled before acquiring the session.');
  if (previous && !previous.threadId) throw new ToolError('SESSION_INVALID', 'Native continuation is unavailable for this session; history remains accessible.');
  // The model comes from the call, the session, the configuration or the CLI, never from the
  // bridge; a name the CLI resolves itself becomes the model it reports, so consent (asked on
  // every turn) and the turn name the same model.
  const { model } = await selectModel(backend.id, backend.probe, { model: args.model, session: previous?.model }, choosing ? { constraint: choosing } : {});
  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while selecting the model.');
  // A continuation keeps its session's selection: the effort follows the model it was chosen for.
  const reasoningEffort = args.reasoning_effort ?? (args.model === undefined || args.model === previous?.model ? previous?.reasoningEffort : undefined);
  // An explicit model or effort is checked against the CLI's own catalog before the user is
  // asked for consent and before a model call.
  if (args.model !== undefined || args.reasoning_effort !== undefined) {
    const rejected = checkModelSelection(backend.id, await readModelCatalog(backend.id), model, args.reasoning_effort);
    if (rejected) throw new ToolError(rejected.code, rejected.message);
    if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while reading the model catalog.');
  }
  // The limit is the user's, not governance's: neverAsk or an approval cannot satisfy it.
  const assertPriceLimit = async () => {
    // A limit needs a current price list: a week-old one is read again first.
    const prices = await readPrices({ current: true, models: [model] });
    const evidence = priceEvidence(prices, model);
    const rejected = checkPriceLimit(model, evidence, below!);
    if (rejected) {
      throw new ToolError('PRICE_LIMIT', choosing ? `${rejected} The price list changed after the model was chosen; retry to choose again.`
        : `${rejected} It was not replaced by another model; name one below the limit (doctor lists prices)${previous ? ' or start a new session' : ' or omit model'}.`);
    }
    return `${Number(evidence.outputUsdPerMTok!.toFixed(4))} USD per million output tokens (${evidence.source} ${evidence.fetchedAt!.slice(0, 10)}, exact), below the limit of ${Number(below!.toFixed(4))} USD`;
  };
  if (below !== undefined) await assertPriceLimit();
  // Asked on every turn, for the model this turn runs (EXEC-001: price, not name).
  const decision = await consentFor(backend.id, backend.probe, model);
  const consentWarnings: string[] = [];
  if (decision.ask) {
    if (!options.askConsent) throw new ToolError('POLICY_DENIED', consentRequiredMessage(model, decision.reason));
    const answer = await options.askConsent({ backend: backend.id, model, reason: decision.reason, offerRemember: decision.offerRemember });
    if (!answer.approved) {
      throw new ToolError('POLICY_DENIED', answer.unanswered ? consentUnansweredMessage(model, decision.reason) : consentDeclinedMessage(model));
    }
    if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while waiting for the user.');
    if (decision.offerRemember && answer.remember) {
      // The approval stands even when it cannot be stored; the next turn asks again.
      try { await rememberApprovedModel(model); }
      catch (err) { consentWarnings.push(`The approval of '${model}' was not remembered: ${redactDiagnostic((err as Error).message, 256)}`); }
    }
  }
  // Rechecked right before the turn: the list or the limit's evidence may have changed while the user decided.
  const priceNote = below === undefined ? undefined : await assertPriceLimit();
  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while checking the price limit.');
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
    if (heartbeat) clearInterval(heartbeat); if (flushTimer) clearInterval(flushTimer);
    if (abortSignal) abortSignal.removeEventListener('abort', onCallerAbort);
  }

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

  return {
    isError: result.isError,
    provider: backend.id,
    result,
    sessionHandle: handle,
    meta: {
      turn: session.turnCount || 1,
      toolCount,
      durationMs: Date.now() - started,
      historyAvailable: !writer.disabled && !historyError,
    },
    warnings,
    price: priceNote,
    review,
  };
}
