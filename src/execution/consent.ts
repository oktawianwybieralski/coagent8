/**
 * Gathers what the governance decision needs for one turn: the user's settings, the price
 * list and the backend's default model as the price reference.
 *
 * @packageDocumentation
 */
import { errorCodeOf, type ProviderId } from '../contracts/index.js';
import { loadConfig, type CoAgent8Config, type ConfigSnapshot } from '../config.js';
import { decideConsent, type ConsentDecision } from '../models/governance.js';
import { readPrices } from '../models/prices.js';
import { selectModel } from './selection.js';
import type { AdapterProbeResult } from '../backends/types.js';

export type { ConsentDecision };

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
    try { defaultModel = (await selectModel(id, probe, {}, { config: options.config })).model; }
    catch (err) {
      // Without a known default there is no price reference; the other rules still apply.
      if (errorCodeOf(err) !== 'MODEL_UNAVAILABLE') throw err;
    }
  }
  return decideConsent(model, defaultModel, await readPrices({ models: defaultModel ? [model, defaultModel] : [model] }), settings);
}

