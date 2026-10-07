const GOVERNED_TOP_TIER_MODELS = new Set(['astra', 'claude-3-opus', 'claude-3-opus-20240229', 'opus', 'best']);
const GOVERNED_FAMILY = /(?:^|[-_/])(?:astra|opus(?:plan)?)(?:$|[-_/\d\[])/;
/** Model identifier pattern from the audit (AUD-P1-6); rejects option-like and whitespace values. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;

/**
 * Returns whether a model is top-tier and runs only after the user approves it.
 * @remarks Consent comes from the user through MCP elicitation, never from a tool
 * argument the calling agent sets (AUD-P1-7).
 */
export function isGovernedModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string') return false;
  const normalized = model.trim().toLowerCase();
  return GOVERNED_TOP_TIER_MODELS.has(normalized) || GOVERNED_FAMILY.test(normalized);
}

/** One-line refusal when the user's approval for a top-tier model cannot be requested. */
export function consentRequiredMessage(model: string | undefined): string {
  return `Model '${model}' is top-tier and needs the user's approval, which this client cannot ask for (no MCP elicitation); retry without it or with a non-top-tier model.`;
}

/** One-line refusal when the user declined or did not answer the approval request. */
export function consentDeclinedMessage(model: string | undefined): string {
  return `The user did not approve top-tier model '${model}'; retry without it or with a non-top-tier model.`;
}

/** Returns whether a requested or backend-reported model identifier is safe to pass on and record. */
export function isValidModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}
