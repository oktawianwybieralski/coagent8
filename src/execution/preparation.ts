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

import { ToolError, errorCodeOf, type ProviderId } from '../contracts/index.js';
import { isValidModelIdentifier } from '../models/identifier.js';
import { getSession } from '../sessions/session.js';
import type { SessionRecord } from '../sessions/types.js';
import { assertNotNestedTurn } from './nested-turn.js';
import { loadConfigSnapshot, rememberApprovedModel, type CoAgent8Config, type ConfigSnapshot } from '../config.js';
import { resolveBackend, resolveBackendForModel, type ResolvedBackend } from './routing.js';
import { selectModel, type ModelSelection, type PriceConstraint } from './selection.js';
import { readModelCatalog } from '../backends/probe-cache.js';
import { checkModelSelection } from '../models/catalog.js';
import { checkPriceLimit, priceEvidence, readPrices } from '../models/prices.js';
import { consentFor } from './consent.js';
import { consentDeclinedMessage, consentRequiredMessage, consentUnansweredMessage } from '../models/governance.js';
import { redactDiagnostic } from '../security/redaction.js';

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
export type ConsentPrompt = (request: {
  backend: string;
  model: string;
  reason: string;
  offerRemember: boolean;
}) => Promise<{ approved: boolean; unanswered?: boolean; remember?: boolean }>;

/**
 * Options supplied during task preparation.
 */
export interface PrepareTaskOptions {
  config?: ConfigSnapshot | CoAgent8Config;
  abortSignal?: AbortSignal | null;
}

/**
 * Options for executing consent confirmation against a prepared task.
 */
export interface ConfirmConsentOptions {
  askConsent?: ConsentPrompt;
  abortSignal?: AbortSignal | null;
}

/**
 * Result of confirming consent and price limit re-validation.
 */
export interface ConfirmConsentResult {
  priceNote?: string;
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
 * @param options - Optional cancellation signal.
 * @returns Validated session context if resuming an existing conversation.
 * @throws `ToolError` on invalid model identifier, invalid session, provider switch, or nested turn.
 */
export function validateTaskContext(
  args: ExecutionRequest,
  cwd: string,
  options: { abortSignal?: AbortSignal | null } = {}
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
    throw new ToolError('SESSION_INVALID', 'Session is expired, invalidated, closed or belongs to another workspace.');
  }
  if (previous && args.backend && !['auto', 'smart_quota', previous.backend].includes(args.backend)) {
    throw new ToolError('SESSION_INVALID', 'A session cannot switch provider.');
  }
  if (previous && !previous.threadId) {
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
  const { previousSession } = validateTaskContext(args, cwd, { abortSignal: options.abortSignal });

  const configSnapshot = asConfigSnapshot(options.config);
  const abortSignal = options.abortSignal;

  const below = args.output_price_below;
  const constraint: PriceConstraint | undefined = below === undefined ? undefined : { below, effort: args.reasoning_effort };
  // Without a named model, only backends with a model below the limit are chosen from.
  const choosing = constraint && args.model === undefined && !previousSession ? constraint : undefined;

  const choosingSelections = new Map<ProviderId, ModelSelection>();

  const backend = previousSession
    ? await resolveBackend(previousSession.backend, { config: configSnapshot })
    : args.model !== undefined
    ? await resolveBackendForModel(args.backend, args.model, { config: configSnapshot })
    : await resolveBackend(args.backend, {
        config: configSnapshot,
        ...(choosing
          ? {
              eligible: async (id, probe) => {
                try {
                  const sel = await selectModel(id, probe, {}, { constraint: choosing, config: configSnapshot });
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
      });

  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled before acquiring the session.');

  // The model comes from the call, the session, the configuration or the CLI, never from the
  // bridge; a name the CLI resolves itself becomes the model it reports, so consent (asked on
  // every turn) and the turn name the same model.
  let selection: ModelSelection;
  if (choosing && choosingSelections.has(backend.id)) {
    selection = choosingSelections.get(backend.id)!;
  } else {
    selection = await selectModel(backend.id, backend.probe, { model: args.model, session: previousSession?.model }, {
      config: configSnapshot,
      catalog: backend.catalog,
      ...(choosing ? { constraint: choosing } : {}),
    });
  }
  const model = selection.model;

  if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while selecting the model.');

  // A continuation keeps its session's selection: the effort follows the model it was chosen for.
  const reasoningEffort = args.reasoning_effort ?? (args.model === undefined || args.model === previousSession?.model ? previousSession?.reasoningEffort : undefined);

  // An explicit model or effort is checked against the CLI's own catalog before the user is
  // asked for consent and before a model call.
  if (args.model !== undefined || args.reasoning_effort !== undefined) {
    const catalog = await readModelCatalog(backend.id, { probe: backend.probe, catalog: backend.catalog });
    const rejected = checkModelSelection(backend.id, catalog, model, args.reasoning_effort);
    if (rejected) throw new ToolError(rejected.code, rejected.message);
    if (abortSignal?.aborted) throw new ToolError('ABORTED', 'Request cancelled while reading the model catalog.');
  }

  // Observe and retain the backend's default model as the relative-price governance reference (`EXEC-001-T05b`).
  let defaultModel: string | null = null;
  if (args.model === undefined && !previousSession && !choosing) {
    // When no specific model or price constraint was requested, the selection itself is the default model.
    defaultModel = model;
  } else {
    try {
      const def = await selectModel(backend.id, backend.probe, {}, {
        config: configSnapshot,
        catalog: backend.catalog,
      });
      defaultModel = def.model;
    } catch (err) {
      if (errorCodeOf(err) === 'MODEL_UNAVAILABLE') {
        defaultModel = null;
      } else {
        throw err;
      }
    }
  }

  // The limit is the user's, not governance's: neverAsk or an approval cannot satisfy it.
  const assertPriceLimit = async (): Promise<string> => {
    // A limit needs a current price list: a week-old one is read again first.
    const prices = await readPrices({ current: true, models: [model] });
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

  if (below !== undefined) await assertPriceLimit();

  const confirmConsent = async (consentOptions: ConfirmConsentOptions = {}): Promise<ConfirmConsentResult> => {
    const sig = consentOptions.abortSignal ?? abortSignal;
    const decision = await consentFor(backend.id, backend.probe, model, {
      config: configSnapshot,
      defaultModel,
    });
    const consentWarnings: string[] = [];

    if (decision.ask) {
      if (!consentOptions.askConsent) {
        throw new ToolError('POLICY_DENIED', consentRequiredMessage(model, decision.reason));
      }
      const answer = await consentOptions.askConsent({
        backend: backend.id,
        model,
        reason: decision.reason,
        offerRemember: decision.offerRemember,
      });
      if (!answer.approved) {
        throw new ToolError(
          'POLICY_DENIED',
          answer.unanswered ? consentUnansweredMessage(model, decision.reason) : consentDeclinedMessage(model)
        );
      }
      if (sig?.aborted) throw new ToolError('ABORTED', 'Request cancelled while waiting for the user.');
      if (decision.offerRemember && answer.remember) {
        // The approval stands even when it cannot be stored; the next turn asks again.
        try {
          await rememberApprovedModel(model);
        } catch (err) {
          consentWarnings.push(
            `The approval of '${model}' was not remembered: ${redactDiagnostic((err as Error).message, 256)}`
          );
        }
      }
    }

    // Rechecked right before the turn: the list or the limit's evidence may have changed while the user decided.
    const priceNote = below === undefined ? undefined : await assertPriceLimit();
    if (sig?.aborted) throw new ToolError('ABORTED', 'Request cancelled while checking the price limit.');

    return { priceNote, warnings: consentWarnings };
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
