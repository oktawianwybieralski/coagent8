/**
 * Gathers what the governance decision needs for one turn: the user's settings, the price
 * list and the backend's default model as the price reference.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import { errorCodeOf, ToolError, type ListPrice, type ProviderId } from '../contracts/index.js';
import { loadConfig, loadConfigSnapshot, type CoAgent8Config, type ConfigSnapshot } from '../config.js';
import {
  decideConsent,
  describeGovernanceChange,
  consentInvalidatedMessage,
  findModelRule,
  modelDeniedMessage,
  usd,
  NO_SUBSTITUTE,
  type ConsentDecision,
} from '../models/governance.js';
import { readPrices, findPrice, checkPriceLimit, priceEvidence, type PriceList, type ModelPrice } from '../models/prices.js';
import { selectModel } from './selection.js';
import type { AdapterProbeResult, BackendReadContext } from '../backends/types.js';
import type { EffortRun } from '../contracts/models.js';

export type { ConsentDecision };

/**
 * Checks whether the configuration file on disk changed since the snapshot was loaded (`EXEC-001-T03`, `EXEC-001-T10b`).
 */
function isConfigModified(snapshot: ConfigSnapshot): boolean {
  try {
    const file = snapshot.provenance.configFile;
    const exists = fs.existsSync(file);
    if (exists !== snapshot.provenance.fileExisted) return true;
    if (!exists) return false;
    const stat = fs.statSync(file);
    if (!snapshot.provenance.fileStat) return true;
    if (stat.mtimeMs !== snapshot.provenance.fileStat.mtimeMs || stat.size !== snapshot.provenance.fileStat.size) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Options for evaluating consent policy against a model execution (`EXEC-001-T05b`).
 */
export interface ConsentForOptions {
  config?: CoAgent8Config | ConfigSnapshot;
  /**
   * Pre-observed backend default model name, or null if the backend has no default model.
   * When supplied, avoids redundant default model selection and error handling (`EXEC-001-T05b`).
   */
  defaultModel?: string | null;
  /** Optional read context for observation reads (`EXEC-001-T08`). */
  context?: BackendReadContext;
}

/**
 * Decides whether the user must approve `model` on this backend before the turn runs.
 * @param id - Backend of the turn.
 * @param probe - Its current probe, for the default model.
 * @param model - The concrete model the turn would run.
 * @param options - `config` supplies an existing snapshot; `defaultModel` reuses pre-observed default.
 */
export async function consentFor(
  id: ProviderId,
  probe: AdapterProbeResult,
  model: string,
  options: ConsentForOptions = {}
): Promise<ConsentDecision> {
  const configObj = options.config
    ? ('config' in options.config ? options.config.config : options.config)
    : loadConfig();
  const settings = configObj.governance;
  let defaultModel: string | undefined;
  if (options.defaultModel !== undefined) {
    defaultModel = options.defaultModel === null ? undefined : options.defaultModel;
  } else {
    try { defaultModel = (await selectModel(id, probe, {}, { config: options.config, context: options.context })).model; }
    catch (err) {
      // Without a known default there is no price reference; the other rules still apply.
      if (errorCodeOf(err) !== 'MODEL_UNAVAILABLE') throw err;
    }
  }
  return decideConsent(model, defaultModel, await readPrices({ models: defaultModel ? [model, defaultModel] : [model], context: options.context }), settings);
}

/**
 * Options for re-validating consent policy, price limits, and model identity right before acquisition (`EXEC-001-T10b`).
 */
export interface RevalidateConsentOptions {
  currentConfig?: CoAgent8Config | ConfigSnapshot;
  defaultModel?: string | null;
  initialPrice?: ModelPrice;
  initialDefaultPrice?: ModelPrice;
  initialDecision?: ConsentDecision;
  outputPriceBelow?: number;
  choosing?: boolean;
  continuing?: boolean;
  /** The reasoning effort the turn passes separately and how its CLI applies it. */
  effortRun?: EffortRun;
  context?: BackendReadContext;
}

/** The model's list price when the list matched it exactly; nothing for an approximate or no match. */
function listPriceOf(list: PriceList | undefined, model: string): { listPrice?: ListPrice } {
  const evidence = priceEvidence(list, model);
  if (evidence.match !== 'exact' || !evidence.source || !evidence.fetchedAt) return {};
  return { listPrice: {
    model,
    inputUsdPerMTok: evidence.inputUsdPerMTok,
    cachedInputUsdPerMTok: evidence.cachedInputUsdPerMTok,
    cacheWriteUsdPerMTok: evidence.cacheWriteUsdPerMTok,
    cacheWriteLongUsdPerMTok: evidence.cacheWriteLongUsdPerMTok,
    tieredFromInputTokens: evidence.tieredFromInputTokens,
    outputUsdPerMTok: evidence.outputUsdPerMTok,
    source: `${evidence.source} ${evidence.fetchedAt.slice(0, 10)}`,
  } };
}

/**
 * Result of successful consent and price re-validation (`EXEC-001-T10b`).
 */
export interface RevalidateConsentResult {
  freshDecision: ConsentDecision;
  freshSnapshot: ConfigSnapshot;
  freshPrices: PriceList;
  priceNote?: string;
  /** The model's list price from an exact match in the fresh list (`AX-001g`). */
  listPrice?: ListPrice;
}

/**
 * Re-validates consent policy, governance configuration, price evidence, and price limits
 * directly before session acquisition (`EXEC-001-T10b`).
 *
 * @remarks
 * Protects against condition shifts while waiting for user consent:
 * - A model now on `models.deny` is refused; if governance configuration changed (`models.ask`, `models.allow`, `askAbovePrice`, `priceMultiplier`), approval is invalidated.
 * - If model price increased or exceeded price limits (`output_price_below` or relative multiplier), approval is invalidated.
 * - Fail-closed: throws `ToolError('POLICY_DENIED')` or `ToolError('PRICE_LIMIT')` with retry guidance without substituting models.
 *
 * @param id - Backend of the turn.
 * @param probe - Current backend probe.
 * @param model - Target model identifier.
 * @param initialSnapshot - Initial configuration snapshot at task preparation time.
 * @param options - Revalidation options including initial prices, decisions, and constraints.
 * @returns Revalidation result with fresh decision, snapshot, prices, and price note.
 * @throws `ToolError` (`POLICY_DENIED`) if governance or price conditions shifted, with retry guidance.
 * @throws `ToolError` (`PRICE_LIMIT`) if user-specified price limit was exceeded.
 */
export async function revalidateConsent(
  id: ProviderId,
  probe: AdapterProbeResult,
  model: string,
  initialSnapshot: ConfigSnapshot,
  options: RevalidateConsentOptions = {}
): Promise<RevalidateConsentResult> {
  const currentSnapshot = options.currentConfig
    ? ('provenance' in options.currentConfig && 'changeIdentity' in options.currentConfig
        ? (options.currentConfig as ConfigSnapshot)
        : { ...loadConfigSnapshot(), config: options.currentConfig as CoAgent8Config })
    : isConfigModified(initialSnapshot)
    ? loadConfigSnapshot()
    : initialSnapshot;

  const run = options.effortRun;
  // A model the user denied while the approval was pending never runs, whatever was approved.
  if (findModelRule(model, currentSnapshot.config.governance.models, run) === 'deny') {
    throw new ToolError('POLICY_DENIED', modelDeniedMessage(model, run));
  }

  const governanceChange = describeGovernanceChange(
    initialSnapshot.config.governance,
    currentSnapshot.config.governance,
    model,
    run
  );
  if (governanceChange !== undefined) {
    throw new ToolError(
      'POLICY_DENIED',
      options.initialDecision?.ask
        ? consentInvalidatedMessage(model, governanceChange)
        : `Execution requires approval for model '${model}' because policy changed before acquisition: ${governanceChange} Retry the request to approve under current conditions. ${NO_SUBSTITUTE}`
    );
  }

  let defaultModel: string | undefined;
  if (options.defaultModel !== undefined) {
    defaultModel = options.defaultModel === null ? undefined : options.defaultModel;
  } else {
    try {
      defaultModel = (await selectModel(id, probe, {}, { config: currentSnapshot, context: options.context })).model;
    } catch (err) {
      if (errorCodeOf(err) !== 'MODEL_UNAVAILABLE') throw err;
    }
  }

  const freshPrices = await readPrices({
    current: Boolean(options.initialDecision?.ask || options.outputPriceBelow !== undefined),
    models: defaultModel ? [model, defaultModel] : [model],
    context: options.context,
  });

  // 1. If output_price_below limit is set, check it first using fresh price evidence
  let priceNote: string | undefined;
  if (options.outputPriceBelow !== undefined) {
    const evidence = priceEvidence(freshPrices, model);
    const rejected = checkPriceLimit(model, evidence, options.outputPriceBelow);
    if (rejected) {
      const sessionHint = options.continuing ? ' or start a new session' : ' or omit model';
      throw new ToolError(
        'PRICE_LIMIT',
        options.choosing
          ? `${rejected} The price list changed after the model was chosen; retry to choose again.`
          : `${rejected} It was not replaced by another model; name one below the limit (doctor lists prices)${sessionHint}.`
      );
    }
    priceNote = `${Number(evidence.outputUsdPerMTok!.toFixed(4))} USD per million output tokens (${evidence.source} ${evidence.fetchedAt!.slice(0, 10)}, exact), below the limit of ${Number(options.outputPriceBelow.toFixed(4))} USD`;
  }

  // 2. Check for price increase (only when consent was asked and awaited)
  const initialPrice = options.initialPrice;
  const freshPrice = freshPrices ? findPrice(freshPrices, model) : undefined;

  if (options.initialDecision?.ask && initialPrice && freshPrice && freshPrice.output > initialPrice.output) {
    throw new ToolError(
      'POLICY_DENIED',
      consentInvalidatedMessage(
        model,
        `Its output price increased from ${usd(initialPrice.output)} to ${usd(freshPrice.output)} per million tokens.`
      )
    );
  }

  // 3. Re-evaluate consent decision under fresh prices and current settings
  const freshDecision = decideConsent(
    model,
    defaultModel,
    freshPrices,
    currentSnapshot.config.governance,
    run
  );

  if (options.initialDecision) {
    if (!options.initialDecision.ask && freshDecision.ask) {
      throw new ToolError(
        'POLICY_DENIED',
        `Execution requires approval for model '${model}' because conditions changed before acquisition: ${freshDecision.reason} Retry the request to approve under current conditions. ${NO_SUBSTITUTE}`
      );
    }
    if (options.initialDecision.ask) {
      if (freshDecision.basis !== options.initialDecision.basis) {
        throw new ToolError(
          'POLICY_DENIED',
          consentInvalidatedMessage(
            model,
            `Governance basis changed from '${options.initialDecision.basis}' to '${freshDecision.basis}'. ${freshDecision.reason}`
          )
        );
      }
      if (freshDecision.basis === 'relative') {
        const refPrice = (defaultModel && freshPrices) ? findPrice(freshPrices, defaultModel) : undefined;
        if (
          refPrice &&
          freshPrice &&
          initialPrice &&
          options.initialDefaultPrice &&
          refPrice.output > 0 &&
          options.initialDefaultPrice.output > 0
        ) {
          const initialRatio = initialPrice.output / options.initialDefaultPrice.output;
          const freshRatio = freshPrice.output / refPrice.output;
          if (freshRatio > initialRatio) {
            throw new ToolError(
              'POLICY_DENIED',
              consentInvalidatedMessage(
                model,
                `Relative price ratio increased from ${Number(initialRatio.toFixed(1))}x to ${Number(freshRatio.toFixed(1))}x.`
              )
            );
          }
        }
      }
    }
  }

  return {
    freshDecision,
    freshSnapshot: currentSnapshot,
    freshPrices: freshPrices ?? { fetchedAt: 0, source: 'none', models: {} },
    priceNote,
    ...listPriceOf(freshPrices, model),
  };
}
