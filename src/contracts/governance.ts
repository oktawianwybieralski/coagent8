/**
 * Model governance configuration and consent basis contracts.
 *
 * @packageDocumentation
 */

/**
 * The user's own rule for named models, in the allow/ask/deny convention of permission
 * settings: `deny` wins over `ask`, and `ask` over `allow` (owner decision of 2026-10-11).
 */
export interface ModelRules {
  /** Models that run without asking whatever they cost: the user's standing approval. */
  allow: string[];
  /** Models asked for on every turn whatever they cost. */
  ask: string[];
  /** Models that never run; a call naming one is refused with this reason. */
  deny: string[];
}

/** The user's governance settings (`config.json` `governance`). */
export interface GovernanceSettings {
  /** A model at least this many times the default's output price is asked for. */
  priceMultiplier: number;
  /** A model whose output price in USD per million tokens is at least this is asked for; null disables. */
  askAbovePrice: number | null;
  /** Named models the user allows, always asks for, or denies; price rules apply to the rest. */
  models: ModelRules;
}

/** The rule lists of {@link ModelRules}, in the order they are checked. */
export const MODEL_RULES = ['deny', 'ask', 'allow'] as const satisfies readonly (keyof ModelRules)[];

/**
 * Which governance rule decided: a `models.deny`, `models.ask` or `models.allow` entry, no
 * price list, no price, an approximate price, a price at or above `askAbovePrice`, a price at
 * least `priceMultiplier` times the default's, or a price below both.
 */
export type ConsentBasis = 'deny' | 'ask' | 'allow' | 'no-price-list' | 'unpriced' | 'approximate' | 'above-limit' | 'relative' | 'priced';
