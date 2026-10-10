/**
 * Model governance (`EXEC-001`, owner decisions of 2026-10-07): whether the user must
 * approve a model before it runs, decided by its approximate price, not by its name.
 *
 * @remarks
 * A model is asked for when it is on `alwaysAsk`; when no price list is available; when its
 * price is unknown or matched only approximately; when its output price is at or above
 * `askAbovePrice` (USD per million tokens, default 20, which also covers an expensive
 * default model); or when it is at least `priceMultiplier` (default 2) times the price of its
 * backend's default model. `neverAsk` exempts a model, and an approval with "remember"
 * adds an unknown or approximate one to it. Consent itself is asked by the server through
 * MCP elicitation; a calling agent cannot grant it (AUD-P1-7).
 *
 * A user's price limit is a separate question (`checkPriceLimit` in prices.ts, `AX-002`): no
 * prompt does not show that a model meets it, and `neverAsk` or an approval cannot satisfy it.
 *
 * @packageDocumentation
 */
import { findPrice, type PriceList } from './prices.js';

import type { GovernanceSettings, ConsentBasis } from '../contracts/governance.js';
export type { GovernanceSettings, ConsentBasis };

/** Whether to ask the user before a model runs, and why. */
export interface ConsentDecision {
  ask: boolean;
  basis: ConsentBasis;
  /** The approval may be remembered: the model has no price, or only an approximate one. */
  offerRemember: boolean;
  /** One sentence for the user and, on refusal, the caller. */
  reason: string;
}

export const usd = (value: number): string => `${Number(value.toFixed(2))} USD`;

/**
 * Decides whether the user must approve a model before it runs.
 * @param model - The concrete model the turn would run.
 * @param defaultModel - The backend's default model, the price reference; undefined when none is known.
 * @param prices - The price list, or undefined when none could be read.
 * @param settings - The user's governance settings.
 */
export function decideConsent(model: string, defaultModel: string | undefined, prices: PriceList | undefined, settings: GovernanceSettings): ConsentDecision {
  if (settings.alwaysAsk.includes(model)) return { ask: true, basis: 'always-ask', offerRemember: false, reason: `'${model}' is on the governance.alwaysAsk list.` };
  if (settings.neverAsk.includes(model)) return { ask: false, basis: 'never-ask', offerRemember: false, reason: `'${model}' is on the governance.neverAsk list.` };
  if (!prices) return { ask: true, basis: 'no-price-list', offerRemember: true, reason: `No price list is available, so its cost is unknown.` };
  const price = findPrice(prices, model);
  if (!price) return { ask: true, basis: 'unpriced', offerRemember: true, reason: `No price is known for '${model}'.` };
  if (!price.exact) return { ask: true, basis: 'approximate', offerRemember: true, reason: `Its price is known only approximately, as ${price.matched}: ${usd(price.output)} per million output tokens.` };
  if (settings.askAbovePrice !== null && price.output >= settings.askAbovePrice) {
    return { ask: true, basis: 'above-limit', offerRemember: false, reason: `Its output costs ${usd(price.output)} per million tokens, at or above the ${usd(settings.askAbovePrice)} limit.` };
  }
  const reference = defaultModel && defaultModel !== model ? findPrice(prices, defaultModel) : undefined;
  if (reference && reference.output > 0 && price.output >= settings.priceMultiplier * reference.output) {
    return { ask: true, basis: 'relative', offerRemember: false,
      reason: `Its output costs ${usd(price.output)} per million tokens, ${Number((price.output / reference.output).toFixed(1))} times the default ${defaultModel}'s ${usd(reference.output)}.` };
  }
  return { ask: false, basis: 'priced', offerRemember: false, reason: `Its output costs ${usd(price.output)} per million tokens.` };
}

/**
 * The caller's next step after a refusal: the user chose or accepted this model, so another
 * one is the user's decision (`AX-003`; a calling agent switched models after an unanswered
 * request in the 2026-10-08 trials).
 */
export const NO_SUBSTITUTE = 'Tell the user; switch to another model only if the user asks.';

/** One-line refusal when the user's approval cannot be requested. */
export function consentRequiredMessage(model: string, reason: string): string {
  return `Model '${model}' needs the user's approval, which this client cannot ask for (no MCP elicitation). ${reason} ${NO_SUBSTITUTE}`;
}

/** One-line refusal when the user declined the approval request or left the box unchecked. */
export function consentDeclinedMessage(model: string): string {
  return `The user did not approve model '${model}'. Ask the user before using another model.`;
}

/**
 * One-line refusal when the client cancelled the approval request.
 * @remarks A cancel is not the user's decision: Codex 0.160.1 declares form elicitation but
 * cancels every request without showing it (measured 2026-10-07).
 */
export function consentUnansweredMessage(model: string, reason: string): string {
  return `The client closed the approval request for model '${model}' without an answer, possibly without showing it to the user. ${reason} ${NO_SUBSTITUTE}`;
}

/**
 * One-line refusal with fail-closed retry guidance when approval was invalidated by changed conditions (`EXEC-001-T10b`).
 * @param model - Target model identifier.
 * @param reason - Explanation of the invalidated condition (price increase, governance policy change).
 */
export function consentInvalidatedMessage(model: string, reason: string): string {
  return `The approval for model '${model}' was invalidated because conditions changed while awaiting consent: ${reason} Retry the request to approve under current conditions. ${NO_SUBSTITUTE}`;
}

/**
 * Compares two governance settings to detect whether policy rules changed (`EXEC-001-T10b`).
 *
 * @param previous - Initial governance settings snapshot.
 * @param current - Current governance settings snapshot.
 * @param model - Optional target model identifier to check specific list membership changes.
 * @returns A description of the change, or undefined if identical.
 */
export function describeGovernanceChange(
  previous: GovernanceSettings,
  current: GovernanceSettings,
  model?: string
): string | undefined {
  if (model) {
    if (!previous.alwaysAsk.includes(model) && current.alwaysAsk.includes(model)) {
      return `'${model}' was added to the governance.alwaysAsk list.`;
    }
    if (previous.neverAsk.includes(model) && !current.neverAsk.includes(model)) {
      return `'${model}' was removed from the governance.neverAsk list.`;
    }
    // If model is explicitly on neverAsk or alwaysAsk, price thresholds do not apply to it
    if (current.neverAsk.includes(model) || current.alwaysAsk.includes(model)) {
      return undefined;
    }
  }

  // Threshold changes that make policy stricter
  if (
    current.askAbovePrice !== null &&
    (previous.askAbovePrice === null || current.askAbovePrice < previous.askAbovePrice)
  ) {
    const prevStr = previous.askAbovePrice === null ? 'none' : `${previous.askAbovePrice} USD`;
    const currStr = `${current.askAbovePrice} USD`;
    return `governance.askAbovePrice was lowered from ${prevStr} to ${currStr}.`;
  }

  if (current.priceMultiplier < previous.priceMultiplier) {
    return `governance.priceMultiplier was lowered from ${previous.priceMultiplier} to ${current.priceMultiplier}.`;
  }

  return undefined;
}

