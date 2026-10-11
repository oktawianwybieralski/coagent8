/**
 * Model governance (`EXEC-001`, owner decisions of 2026-10-07 and 2026-10-11): whether a
 * model runs, runs after the user's approval, or never runs.
 *
 * @remarks
 * The user's own rules come first, in the allow/ask/deny convention: `models.deny` refuses a
 * model, `models.ask` asks for it on every turn whatever it costs, and `models.allow` runs it
 * without asking; `deny` wins over `ask` and `ask` over `allow`. An entry also covers the
 * model's effort variants (`<id>-<effort>`), and an entry naming a variant also applies when a
 * turn passes that effort separately (`model` plus `reasoning_effort`). Other models are asked for when no price list
 * is available; when their price is unknown or matched only approximately; when their output
 * price is at or above `askAbovePrice` (USD per million tokens, default 20, which also covers
 * an expensive default model); or when it is at least `priceMultiplier` (default 2) times the
 * price of their backend's default model. An approval with "remember" adds an unknown or
 * approximately priced model to `models.allow`. Consent itself is asked by the server through
 * MCP elicitation; a calling agent cannot grant it (AUD-P1-7).
 *
 * A user's price limit is a separate question (`checkPriceLimit` in prices.ts, `AX-002`): no
 * prompt does not show that a model meets it, and `models.allow` or an approval cannot
 * satisfy it.
 *
 * @packageDocumentation
 */
import { findPrice, type PriceList } from './prices.js';
import { namesModelRun, type EffortRun } from '../contracts/models.js';

import { MODEL_RULES, type GovernanceSettings, type ConsentBasis, type ModelRules } from '../contracts/governance.js';
export type { GovernanceSettings, ConsentBasis, ModelRules };

/** Whether a model runs, needs the user's approval first, or never runs, and why. */
export interface ConsentDecision {
  /** The user must approve the model before it runs. */
  ask: boolean;
  /** The model never runs (`models.deny`); `ask` is then false. */
  deny: boolean;
  basis: ConsentBasis;
  /** The approval may be remembered: the model has no price, or only an approximate one. */
  offerRemember: boolean;
  /** One or two sentences for the user and, on refusal, the caller; they name the price when one is known. */
  reason: string;
}

export const usd = (value: number): string => `${Number(value.toFixed(2))} USD`;

/** Where the user edits each rule list: `config.json` and the VS Code setting. */
export const MODEL_RULE_SETTINGS: Record<keyof ModelRules, string> = {
  allow: 'governance.models.allow (VS Code: CoAgent8: Manage Model Approvals)',
  ask: 'governance.models.ask (VS Code: CoAgent8: Manage Model Approvals)',
  deny: 'governance.models.deny (VS Code: CoAgent8: Manage Model Approvals)',
};

/**
 * Returns the first rule list, in `deny`, `ask`, `allow` order, with an entry naming `model`,
 * the model an effort variant `model` belongs to, or the effort variant a turn passing its
 * effort separately runs ({@link namesModelRun}).
 */
export function findModelRule(model: string, rules: ModelRules, run?: EffortRun): keyof ModelRules | undefined {
  return findModelRuleEntry(model, rules, run)?.rule;
}

/**
 * Returns the rule that decides `model` as {@link findModelRule} does, with the entry that
 * names it: the id, or the effort variant the turn runs, which is the entry to change.
 */
export function findModelRuleEntry(model: string, rules: ModelRules, run?: EffortRun): { rule: keyof ModelRules; entry: string } | undefined {
  for (const rule of MODEL_RULES) {
    const entry = rules[rule].find(listed => namesModelRun(listed, model, run));
    if (entry !== undefined) return { rule, entry };
  }
  return undefined;
}

/** Names a model in a message, with the effort a turn passes beside it. */
function modelLabel(model: string, run?: EffortRun): string {
  // A CLI that replaces effort suffixes runs a variant whose name already states the effort.
  return run?.effort === undefined || run.replacesSuffix ? `'${model}'` : `'${model}' with reasoning effort '${run.effort}'`;
}

/** States what the price list knows about a model's output price. */
function priceSentence(model: string, prices: PriceList | undefined): string {
  if (!prices) return 'No price list is available, so its cost is unknown.';
  const price = findPrice(prices, model);
  if (!price) return `No price is known for '${model}'.`;
  if (!price.exact) return `Its price is known only approximately, as ${price.matched}: ${usd(price.output)} per million output tokens.`;
  return `Its output costs ${usd(price.output)} per million tokens.`;
}

/**
 * Decides whether a model runs, runs after the user's approval, or never runs.
 * @param model - The concrete model the turn would run.
 * @param defaultModel - The backend's default model, the price reference; undefined when none is known.
 * @param prices - The price list, or undefined when none could be read.
 * @param settings - The user's governance settings.
 * @param run - The reasoning effort the turn passes separately and how the CLI applies it.
 */
export function decideConsent(model: string, defaultModel: string | undefined, prices: PriceList | undefined, settings: GovernanceSettings, run?: EffortRun): ConsentDecision {
  const rule = findModelRule(model, settings.models, run);
  if (rule) {
    // The user's own rule decides whatever the model costs; the price is still stated.
    const listed = `${modelLabel(model, run)} is on the user's ${rule} list, ${MODEL_RULE_SETTINGS[rule]}. ${priceSentence(model, prices)}`;
    return { ask: rule === 'ask', deny: rule === 'deny', basis: rule, offerRemember: false, reason: listed };
  }
  const decided = (ask: boolean, basis: ConsentBasis, reason: string, offerRemember = false): ConsentDecision => ({ ask, deny: false, basis, offerRemember, reason });
  if (!prices) return decided(true, 'no-price-list', priceSentence(model, prices), true);
  const price = findPrice(prices, model);
  if (!price) return decided(true, 'unpriced', priceSentence(model, prices), true);
  if (!price.exact) return decided(true, 'approximate', priceSentence(model, prices), true);
  if (settings.askAbovePrice !== null && price.output >= settings.askAbovePrice) {
    return decided(true, 'above-limit', `Its output costs ${usd(price.output)} per million tokens, at or above the ${usd(settings.askAbovePrice)} limit.`);
  }
  const reference = defaultModel && defaultModel !== model ? findPrice(prices, defaultModel) : undefined;
  if (reference && reference.output > 0 && price.output >= settings.priceMultiplier * reference.output) {
    return decided(true, 'relative',
      `Its output costs ${usd(price.output)} per million tokens, ${Number((price.output / reference.output).toFixed(1))} times the default ${defaultModel}'s ${usd(reference.output)}.`);
  }
  return decided(false, 'priced', priceSentence(model, prices));
}

/**
 * The caller's next step after a refusal: the user chose or accepted this model, so another
 * one is the user's decision (`AX-003`; a calling agent switched models after an unanswered
 * request in the 2026-10-08 trials).
 */
export const NO_SUBSTITUTE = 'Tell the user; switch to another model only if the user asks.';

/**
 * The user's own ways out when no form reaches them: a client that shows MCP forms, or a
 * standing approval the user sets. A calling agent cannot grant approval, so it must not set
 * it (`AX-003b`).
 */
export const APPROVAL_REMEDY = `The user can approve it in a client that shows MCP forms, or allow it in ${MODEL_RULE_SETTINGS.allow}; never change that setting yourself.`;

/**
 * One-line refusal of a model on the user's `models.deny` list: why it did not run, and that
 * lifting the rule is the user's decision.
 */
export function modelDeniedMessage(model: string, run?: EffortRun): string {
  return `Model ${modelLabel(model, run)} did not run: the user denied it in ${MODEL_RULE_SETTINGS.deny}. Only the user can remove it from that list. ${NO_SUBSTITUTE}`;
}

/** One-line refusal when the user's approval cannot be requested. */
export function consentRequiredMessage(model: string, reason: string): string {
  return `Model '${model}' needs the user's approval, which this client cannot ask for (no MCP elicitation). ${reason} ${NO_SUBSTITUTE} ${APPROVAL_REMEDY}`;
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
  return `The client closed the approval request for model '${model}' without an answer, possibly without showing it to the user. ${reason} ${NO_SUBSTITUTE} ${APPROVAL_REMEDY}`;
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
 * @param run - The reasoning effort the turn passes separately and how the CLI applies it.
 * @returns A description of the change, or undefined if identical.
 */
export function describeGovernanceChange(
  previous: GovernanceSettings,
  current: GovernanceSettings,
  model?: string,
  run?: EffortRun
): string | undefined {
  if (model) {
    const before = findModelRule(model, previous.models, run);
    const now = findModelRule(model, current.models, run);
    const label = modelLabel(model, run);
    if (now === 'deny' && before !== 'deny') return `${label} was added to ${MODEL_RULE_SETTINGS.deny}.`;
    if (now === 'ask' && before !== 'ask' && before !== 'deny') return `${label} was added to ${MODEL_RULE_SETTINGS.ask}.`;
    if (before === 'allow' && now !== 'allow') return `${label} was removed from ${MODEL_RULE_SETTINGS.allow}.`;
    // A model on one of the user's lists is decided by that list, not by price thresholds.
    if (now !== undefined) return undefined;
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

