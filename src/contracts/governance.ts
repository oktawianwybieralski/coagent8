/**
 * Model governance configuration and consent basis contracts.
 *
 * @packageDocumentation
 */

/** The user's governance settings (`config.json` `governance`). */
export interface GovernanceSettings {
  /** A model at least this many times the default's output price is asked for. */
  priceMultiplier: number;
  /** A model whose output price in USD per million tokens is at least this is asked for; null disables. */
  askAbovePrice: number | null;
  /** Models asked for on every turn whatever they cost. */
  alwaysAsk: string[];
  /** Models never asked for (unless also on `alwaysAsk`). */
  neverAsk: string[];
}

/**
 * Which governance rule decided: `alwaysAsk`/`neverAsk` list, no price list, no price, an
 * approximate price, a price at or above `askAbovePrice`, a price at least `priceMultiplier`
 * times the default's, or a price below both.
 */
export type ConsentBasis = 'always-ask' | 'never-ask' | 'no-price-list' | 'unpriced' | 'approximate' | 'above-limit' | 'relative' | 'priced';

