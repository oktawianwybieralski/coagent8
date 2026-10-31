/**
 * Cohesive task preparation for the execution controller (`EXEC-001-T04`).
 *
 * @remarks
 * Encapsulates input validation, session continuation checking, provider routing,
 * effective model selection, model catalog validation, price limit enforcement,
 * and user consent confirmation into a typed `PreparedTask` lifecycle object.
 *
 * @packageDocumentation
 */

import { ToolError, errorCodeOf, type ProviderId, type ExecutionBudget, type ExecutionProfile, type ListPrice } from '../contracts/index.js';
import type { BackendReadContext } from '../backends/types.js';
import { effortVariant } from '../contracts/models.js';
import { isValidModelIdentifier } from '../models/identifier.js';
import { getSession, isBudgetExpired, sessionProfile, unavailableSessionState } from '../sessions/session.js';
import { combineSignals } from '../storage/lock.js';
import type { SessionRecord } from '../sessions/types.js';
import { assertNotNestedTurn } from './nested-turn.js';
import { loadConfigSnapshot, rememberApprovedModel, type CoAgent8Config, type ConfigSnapshot } from '../config.js';
import { resolveBackend, resolveBackendForModel, type ResolvedBackend } from './routing.js';
import { effortRun, selectModel, type ModelSelection, type PriceConstraint } from './selection.js';
import { readModelCatalog } from '../backends/probe-cache.js';
import { checkModelSelection } from '../models/catalog.js';
import { checkPriceLimit, findPrice, priceEvidence, readPrices } from '../models/prices.js';
import { revalidateConsent } from './consent.js';
import { consentDeclinedMessage, consentRequiredMessage, consentUnansweredMessage, decideConsent, findModelRule, modelDeniedMessage } from '../models/governance.js';
import { redactDiagnostic } from '../security/redaction.js';

/**
 * Universal execution parameters accepted by execution tools and the run gateway.
 */
export interface ExecutionRequest {
  backend?: string;
  session_handle?: string;
  model?: string;
  reasoning_effort?: string;
  /**
   * Total monotonic call budget in milliseconds for the complete task lifecycle
   * (Git collection, task preparation, consent negotiation, CLI execution, and graceful teardown).
   */
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
export type ConsentPrompt = (request: {
  backend: string;
  model: string;
  reason: string;
  offerRemember: boolean;
  budget?: ExecutionBudget;
  abortSignal?: AbortSignal | null;
}) => Promise<{
  approved: boolean;
  unanswered?: boolean;
  remember?: boolean;
  backend?: string;
  model?: string;
}>;

/**
 * Options supplied during task preparation.
 */
export interface PrepareTaskOptions {
  config?: ConfigSnapshot | CoAgent8Config;
  abortSignal?: AbortSignal | null;
  /** Complete-call execution budget (`EXEC-001-T07`). */
  budget?: ExecutionBudget;
  /** Optional read context for observation reads (`EXEC-001-T08`). */
  context?: BackendReadContext;
  /**
   * A self-contained request, such as a review, that may start a fresh native thread in a session
   * whose earlier turn left none (FEEDBACK-061j).
   */
  allowFreshNativeThread?: boolean;
  /** Execution profile of the call; a session started with the other profile is refused. */
  profile?: ExecutionProfile;
}

/**
 * Options for executing consent confirmation against a prepared task.
 */
export interface ConfirmConsentOptions {
  config?: ConfigSnapshot | CoAgent8Config;
  askConsent?: ConsentPrompt;
  abortSignal?: AbortSignal | null;
  /** Complete-call execution budget (`EXEC-001-T07`). */
  budget?: ExecutionBudget;
  /** Optional read context for observation reads (`EXEC-001-T08`). */
  context?: BackendReadContext;
}

/**
 * Result of confirming consent and price limit re-validation.
 */
export interface ConfirmConsentResult {
  priceNote?: string;
  listPrice?: ListPrice;
  warnings: string[];
}

/**
 * Cohesive prepared task model ready for session acquisition and execution.
 */
export interface PreparedTask {
  readonly backend: ResolvedBackend;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly previousSession: SessionRecord | null;
  readonly configSnapshot: ConfigSnapshot;
  readonly outputPriceBelow?: number;
  /** Pre-observed backend default model as the relative-price governance reference (`EXEC-001-T05b`). */
  readonly defaultModel?: string | null;
  readonly assertPriceLimit: () => Promise<string>;
  readonly confirmConsent: (options?: ConfirmConsentOptions) => Promise<ConfirmConsentResult>;
}

/**
 * Result of early task context validation.
 */
export interface ValidatedTaskContext {
  previousSession: SessionRecord | null;
}

/**
 * Normalizes input configuration or loads a fresh configuration snapshot.
 */
function asConfigSnapshot(config?: CoAgent8Config | ConfigSnapshot): ConfigSnapshot {
  if (config && 'provenance' in config && 'config' in config) {
    return config as ConfigSnapshot;
  }
  const snapshot = loadConfigSnapshot();
  if (config) {
    return {
      ...snapshot,
      config: config as CoAgent8Config,
    };
  }
  return snapshot;
}

/**
 * Validates request arguments, nested turn boundaries, and session continuation prerequisites.
 *
 * @param args - Execution request parameters.
 * @param cwd - Canonical working directory.
 * @param options - Optional cancellation signal and whether a fresh native thread may replace a missing one.
 * @returns Validated session context if resuming an existing conversation.
 * @throws `ToolError` on invalid model identifier, invalid session, provider switch, or nested turn.
 */
export function validateTaskContext(
  args: ExecutionRequest,
  cwd: string,
  options: { abortSignal?: AbortSignal | null; allowFreshNativeThread?: boolean; profile?: ExecutionProfile } = {}
): ValidatedTaskContext {
  // A server started by a backend inside a turn never starts another one (CUR-002).
  assertNotNestedTurn();
  if (options.abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled before provider resolution.');

  // The model reaches CLI argv; option-like or whitespace values are rejected before any backend runs.
  if (args.model !== undefined && !isValidModelIdentifier(args.model)) {
    throw new ToolError('INPUT_LIMIT', 'Invalid model identifier.');
  }

  const previous = args.session_handle ? getSession(args.session_handle, { workspace: cwd }) : null;
  if (args.session_handle && !previous) {
    const state = unavailableSessionState(args.session_handle, cwd);
    throw new ToolError('SESSION_INVALID', state === 'closed'
      ? 'Session is closed; its history stays readable through the session tool. Omit session_handle to start a new session.'
      : state
        ? `Session is ${state}. Omit session_handle to start a new session.`
        : 'Session is expired, invalidated, closed or belongs to another workspace.');
  }
  if (previous && args.backend && !['auto', 'smart_quota', previous.backend].includes(args.backend)) {
    throw new ToolError('SESSION_INVALID', 'A session cannot switch provider.');
  }
  const profile = options.profile ?? 'read-only';
  if (previous && sessionProfile(previous) !== profile) {
    throw new ToolError('POLICY_DENIED', profile === 'workspace-write'
      ? 'This session is read-only; omit session_handle to start a delegate session.'
      : 'This session belongs to delegate and can change files; continue it with delegate, or omit session_handle.');
  }
  if (previous && !previous.threadId && !options.allowFreshNativeThread) {
    throw new ToolError('SESSION_INVALID', 'Native continuation is unavailable for this session; history remains accessible.');
  }

  return { previousSession: previous };
}

/**
 * Prepares a task for execution by resolving backend routing, selecting the concrete model,
 * validating against backend catalog capabilities, and asserting price limits.
 *
 * @param args - Task execution request.
 * @param cwd - Workspace root directory.
 * @param options - Configuration snapshot and abort signal.
 * @returns Fully prepared task ready for consent and session acquisition.
 */
export async function prepareTask(
  args: ExecutionRequest,
  cwd: string,
  options: PrepareTaskOptions = {}
): Promise<PreparedTask> {
  const { previousSession } = validateTaskContext(args, cwd, { abortSignal: options.abortSignal, allowFreshNativeThread: options.allowFreshNativeThread, profile: options.profile });

  const configSnapshot = asConfigSnapshot(options.config);
  const abortSignal = options.abortSignal;
  const effectiveBudget = options.budget ?? options.context?.budget;
  const callerSignal = abortSignal;
  const effectiveSignal = combineSignals(callerSignal, options.context?.abortSignal, effectiveBudget?.executionSignal);

  const assertNotCancelledOrExpired = (step: string) => {
    if (effectiveSignal?.aborted) {
      if (isBudgetExpired(effectiveBudget)) {
        throw new ToolError('TIMEOUT', `Execution budget expired during ${step}.`);
      }
      throw new ToolError('ABORTED', `Request cancelled during ${step}.`);
    }
    if (isBudgetExpired(effectiveBudget)) {
      throw new ToolError('TIMEOUT', `Execution budget expired during ${step}.`);
    }
  };

  const withTimeoutClassification = async <T>(promise: Promise<T>, step: string, budget = effectiveBudget): Promise<T> => {
    try {
      return await promise;
    } catch (err) {
      if (isBudgetExpired(budget)) {
        throw new ToolError('TIMEOUT', `Execution budget expired during ${step}.`);
      }
      throw err;
    }
  };

  assertNotCancelledOrExpired('task preparation');

  const readContext: BackendReadContext | undefined = options.context
    ? {
        ...options.context,
        abortSignal: effectiveSignal ?? options.context.abortSignal,
        budget: effectiveBudget ?? options.context.budget,
        timeoutMs: effectiveBudget ? effectiveBudget.remainingExecutionMs() : options.context.timeoutMs,
      }
    : ((abortSignal || effectiveBudget)
    ? {
        abortSignal: effectiveSignal ?? undefined,
        budget: effectiveBudget,
        timeoutMs: effectiveBudget ? effectiveBudget.remainingExecutionMs() : undefined,
      }
    : undefined);

  const below = args.output_price_below;
  const constraint: PriceConstraint | undefined = below === undefined ? undefined : { below, effort: args.reasoning_effort };
  // Without a named model, only backends with a model below the limit are chosen from.
  const choosing = constraint && args.model === undefined && !previousSession ? constraint : undefined;

  const choosingSelections = new Map<ProviderId, ModelSelection>();

  const backend = await withTimeoutClassification(
    previousSession
      ? resolveBackend(previousSession.backend, { config: configSnapshot, context: readContext })
      : args.model !== undefined
      ? resolveBackendForModel(args.backend, args.model, { config: configSnapshot, context: readContext })
      : resolveBackend(args.backend, {
          config: configSnapshot,
          context: readContext,
          ...(choosing
            ? {
                eligible: async (id, probe) => {
                  try {
                    const sel = await selectModel(id, probe, {}, { constraint: choosing, config: configSnapshot, context: readContext });
                    choosingSelections.set(id, sel);
                    return undefined;
                  } catch (err) {
                    if (err instanceof ToolError && (err.code === 'PRICE_LIMIT' || err.code === 'MODEL_UNAVAILABLE')) {
                      return err;
                    }
                    throw err;
                  }
                },
              }
            : {}),
        }),
    'backend resolution'
  );

  assertNotCancelledOrExpired('backend resolution');

  // The model comes from the call, the session, the configuration or the CLI, never from the
  // bridge; a name the CLI resolves itself becomes the model it reports, so consent (asked on
  // every turn) and the turn name the same model.
  let selection: ModelSelection;
  if (choosing && choosingSelections.has(backend.id)) {
    selection = choosingSelections.get(backend.id)!;
  } else {
    selection = await withTimeoutClassification(
      selectModel(backend.id, backend.probe, { model: args.model, session: previousSession?.model }, {
        config: configSnapshot,
        catalog: backend.catalog,
        context: readContext,
        ...(choosing ? { constraint: choosing } : {}),
      }),
      'model selection'
    );
  }
  assertNotCancelledOrExpired('model selection');

  // A continuation keeps its session's selection: the effort follows the model it was chosen for.
  const reasoningEffort = args.reasoning_effort ?? (args.model === undefined || args.model === previousSession?.model ? previousSession?.reasoningEffort : undefined);
  const run = effortRun(backend.id, reasoningEffort);
  // A CLI that replaces effort suffixes (agy) runs the passed effort's variant: the rules, the
  // approval, a remembered approval, the price and the session name that variant.
  const model = run.replacesSuffix && run.effort !== undefined ? effortVariant(selection.model, run.effort) : selection.model;

  // The user's deny list is final: no catalog read, price check or approval request follows.
  // The rules see the effort too, which makes the turn run an effort variant.
  if (findModelRule(model, configSnapshot.config.governance.models, run) === 'deny') {
    throw new ToolError('POLICY_DENIED', modelDeniedMessage(model, run));
  }

  // An explicit model or effort is checked against the CLI's own catalog before the user is
  // asked for consent and before a model call.
  if (args.model !== undefined || args.reasoning_effort !== undefined) {
    const catalog = await withTimeoutClassification(
      readModelCatalog(backend.id, { probe: backend.probe, catalog: backend.catalog, context: readContext }),
      'reading model catalog'
    );
    const rejected = checkModelSelection(backend.id, catalog, selection.model, args.reasoning_effort);
    if (rejected) throw new ToolError(rejected.code, rejected.message);
    assertNotCancelledOrExpired('reading model catalog');
  }

  // Observe and retain the backend's default model as the relative-price governance reference (`EXEC-001-T05b`).
  let defaultModel: string | null = null;
  if (args.model === undefined && !previousSession && !choosing) {
    // When no specific model or price constraint was requested, the selection itself is the default model.
    defaultModel = model;
  } else {
    try {
      const def = await withTimeoutClassification(
        selectModel(backend.id, backend.probe, {}, {
          config: configSnapshot,
          catalog: backend.catalog,
          context: readContext,
        }),
        'default model selection'
      );
      defaultModel = def.model;
    } catch (err) {
      if (errorCodeOf(err) === 'MODEL_UNAVAILABLE') {
        defaultModel = null;
      } else {
        throw err;
      }
    }
  }

  // The limit is the user's, not governance's: models.allow or an approval cannot satisfy it.
  const assertPriceLimit = async (): Promise<string> => {
    // A limit needs a current price list: a week-old one is read again first.
    const prices = await withTimeoutClassification(
      readPrices({ current: true, models: [model], context: readContext }),
      'price limit verification'
    );
    const evidence = priceEvidence(prices, model);
    const rejected = checkPriceLimit(model, evidence, below!);
    if (rejected) {
      throw new ToolError(
        'PRICE_LIMIT',
        choosing
          ? `${rejected} The price list changed after the model was chosen; retry to choose again.`
          : `${rejected} It was not replaced by another model; name one below the limit (doctor lists prices)${
              previousSession ? ' or start a new session' : ' or omit model'
            }.`
      );
    }
    return `${Number(evidence.outputUsdPerMTok!.toFixed(4))} USD per million output tokens (${evidence.source} ${evidence.fetchedAt!.slice(0, 10)}, exact), below the limit of ${Number(below!.toFixed(4))} USD`;
  };

  if (below !== undefined) {
    await assertPriceLimit();
    assertNotCancelledOrExpired('price limit verification');
  }

  const confirmConsent = async (consentOptions: ConfirmConsentOptions = {}): Promise<ConfirmConsentResult> => {
    const effectiveBudget = consentOptions.budget ?? options.budget ?? options.context?.budget ?? consentOptions.context?.budget;
    const callerSignal = consentOptions.abortSignal !== undefined ? consentOptions.abortSignal : abortSignal;
    const effectiveSignal = combineSignals(callerSignal, consentOptions.context?.abortSignal, effectiveBudget?.executionSignal);

    const assertNotCancelledOrExpired = (phase: string) => {
      if (effectiveSignal?.aborted) {
        if (isBudgetExpired(effectiveBudget)) {
          throw new ToolError('TIMEOUT', `Execution budget expired during ${phase}.`);
        }
        throw new ToolError('ABORTED', `Request cancelled during ${phase}.`);
      }
      if (isBudgetExpired(effectiveBudget)) {
        throw new ToolError('TIMEOUT', `Execution budget expired during ${phase}.`);
      }
    };

    assertNotCancelledOrExpired('consent confirmation');

    const initialPrices = await withTimeoutClassification(
      readPrices({
        models: defaultModel ? [model, defaultModel] : [model],
        context: readContext,
      }),
      'consent confirmation',
      effectiveBudget
    );
    const initialPrice = initialPrices ? findPrice(initialPrices, model) : undefined;
    const initialDefaultPrice = (defaultModel && initialPrices) ? findPrice(initialPrices, defaultModel) : undefined;

    const decision = decideConsent(
      model,
      defaultModel ?? undefined,
      initialPrices,
      configSnapshot.config.governance,
      run
    );
    const consentWarnings: string[] = [];

    assertNotCancelledOrExpired('consent confirmation');

    let userRememberRequested = false;

    if (decision.deny) throw new ToolError('POLICY_DENIED', modelDeniedMessage(model, run));
    if (decision.ask) {
      if (!consentOptions.askConsent) {
        throw new ToolError('POLICY_DENIED', consentRequiredMessage(model, decision.reason));
      }
      const promptPromise = consentOptions.askConsent({
        backend: backend.id,
        model,
        reason: decision.reason,
        offerRemember: decision.offerRemember,
        budget: effectiveBudget,
        abortSignal: effectiveSignal,
      });

      let abortListener: (() => void) | undefined;
      let timer: NodeJS.Timeout | undefined;

      const cancellationPromise = new Promise<never>((_, reject) => {
        if (effectiveSignal?.aborted) {
          if (isBudgetExpired(effectiveBudget)) {
            reject(new ToolError('TIMEOUT', 'Execution budget expired during waiting for user consent.'));
          } else {
            reject(new ToolError('ABORTED', 'Request cancelled during waiting for user consent.'));
          }
          return;
        }
        abortListener = () => {
          if (isBudgetExpired(effectiveBudget)) {
            reject(new ToolError('TIMEOUT', 'Execution budget expired during waiting for user consent.'));
          } else {
            reject(new ToolError('ABORTED', 'Request cancelled during waiting for user consent.'));
          }
        };
        effectiveSignal?.addEventListener('abort', abortListener, { once: true });

        if (effectiveBudget) {
          const remaining = effectiveBudget.remainingExecutionMs();
          if (remaining <= 0) {
            reject(new ToolError('TIMEOUT', 'Execution budget expired during waiting for user consent.'));
            return;
          }
          timer = setTimeout(() => {
            reject(new ToolError('TIMEOUT', 'Execution budget expired during waiting for user consent.'));
          }, remaining);
          if (typeof timer.unref === 'function') {
            timer.unref();
          }
        }
      });

      let answer: Awaited<ReturnType<typeof consentOptions.askConsent>>;
      try {
        answer = await Promise.race([promptPromise, cancellationPromise]);
      } finally {
        if (abortListener && effectiveSignal) {
          effectiveSignal.removeEventListener('abort', abortListener);
        }
        if (timer) {
          clearTimeout(timer);
        }
      }

      // Bound response to this request/backend/model and T07 deadline:
      // 1. Any cancellation or budget deadline expiration must reject immediately
      assertNotCancelledOrExpired('waiting for user consent');

      // 2. Response must match the requested backend and model if specified
      if (
        (answer.backend !== undefined && answer.backend !== backend.id) ||
        (answer.model !== undefined && answer.model !== model)
      ) {
        throw new ToolError('POLICY_DENIED', `Consent response mismatch: expected approval for model '${model}' on ${backend.id}.`);
      }

      // 3. Unanswered/cancelled form or user decline must throw POLICY_DENIED
      // Even if approved is true, unanswered indicates a cancelled/unanswered form (CUR-003)
      if (answer.unanswered || !answer.approved) {
        throw new ToolError(
          'POLICY_DENIED',
          answer.unanswered ? consentUnansweredMessage(model, decision.reason) : consentDeclinedMessage(model)
        );
      }

      userRememberRequested = Boolean(decision.offerRemember && answer.remember);
    }

    // Revalidate just before acquisition (EXEC-001-T10b):
    // Rechecks changed identity/policy/price evidence and fails closed with retry guidance.
    assertNotCancelledOrExpired('consent revalidation');

    const revalidation = await withTimeoutClassification(
      revalidateConsent(backend.id, backend.probe, model, configSnapshot, {
        currentConfig: consentOptions.config,
        defaultModel,
        initialPrice,
        initialDefaultPrice,
        initialDecision: decision,
        outputPriceBelow: below,
        choosing: Boolean(choosing),
        continuing: Boolean(previousSession),
        effortRun: run,
        context: readContext,
      }),
      'consent revalidation',
      effectiveBudget
    );

    assertNotCancelledOrExpired('recording remembered approval');

    if (userRememberRequested) {
      // The approval stands even when it cannot be stored; the next turn asks again.
      try {
        await rememberApprovedModel(model, {
          abortSignal: effectiveSignal ?? undefined,
          budget: effectiveBudget,
          context: readContext,
        });
      } catch (err) {
        assertNotCancelledOrExpired('recording remembered approval');
        if (err instanceof ToolError && (err.code === 'ABORTED' || err.code === 'TIMEOUT')) {
          throw err;
        }
        consentWarnings.push(
          `The approval of '${model}' was not remembered: ${redactDiagnostic(err instanceof Error ? err.message : String(err), 256)}`
        );
      }
    }

    return { priceNote: revalidation.priceNote, listPrice: revalidation.listPrice, warnings: consentWarnings };
  };

  return {
    backend,
    model,
    reasoningEffort,
    previousSession,
    configSnapshot,
    outputPriceBelow: below,
    defaultModel,
    assertPriceLimit,
    confirmConsent,
  };
}

/**
 * Confirms user consent and re-validates the price limit for a prepared task.
 *
 * @param prepared - The prepared task object.
 * @param options - Consent callback and abort signal.
 * @returns Consent warnings and optional validated price evidence notice.
 */
export async function confirmTaskConsent(
  prepared: PreparedTask,
  options: ConfirmConsentOptions = {}
): Promise<ConfirmConsentResult> {
  return prepared.confirmConsent(options);
}
