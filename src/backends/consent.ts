/**
 * Gathers what the governance decision needs for one turn: the user's settings, the price
 * list and the backend's default model as the price reference.
 *
 * @packageDocumentation
 */
import { errorCodeOf, type ProviderId } from '../conversation.js';
import { loadConfig } from '../config.js';
import { decideConsent, type ConsentDecision } from './governance.js';
import { readPrices } from './prices.js';
import { selectModel } from './model-selection.js';
import type { AdapterProbeResult } from './types.js';

/**
 * Decides whether the user must approve `model` on this backend before the turn runs.
 * @param id - Backend of the turn.
 * @param probe - Its current probe, for the default model.
 * @param model - The concrete model the turn would run.
 */
export async function consentFor(id: ProviderId, probe: AdapterProbeResult, model: string): Promise<ConsentDecision> {
  const settings = loadConfig().governance;
  let defaultModel: string | undefined;
  try { defaultModel = (await selectModel(id, probe)).model; }
  catch (err) {
    // Without a known default there is no price reference; the other rules still apply.
    if (errorCodeOf(err) !== 'MODEL_UNAVAILABLE') throw err;
  }
  return decideConsent(model, defaultModel, await readPrices({ models: defaultModel ? [model, defaultModel] : [model] }), settings);
}
