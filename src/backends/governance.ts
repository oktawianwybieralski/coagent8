const GOVERNED_TOP_TIER_MODELS = new Set(['astra', 'claude-3-opus', 'claude-3-opus-20240229', 'opus']);
/** Model identifier pattern from the audit (AUD-P1-6); rejects option-like and whitespace values. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;

/** One-line, actionable refusal for a top-tier model without consent; the caller can fix it in one retry. */
export function consentRequiredMessage(model: string | undefined): string {
  return `Model '${model}' is top-tier: ask the user, then retry with user_confirmed: true.`;
}

/** Returns whether a requested or backend-reported model identifier is safe to pass on and record. */
export function isValidModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

export interface GovernanceCheckResult {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Validates whether top-tier expensive reasoning models have explicit user confirmation.
 */
export function checkModelGovernance(modelName?: string | null, userConfirmed = false): GovernanceCheckResult | null {
  if (typeof modelName !== 'string') return null;

  const normalized = modelName.trim().toLowerCase();
  if (GOVERNED_TOP_TIER_MODELS.has(normalized) || /(?:^|[-_/])(?:astra|opus(?:plan)?)(?:$|[-_/\d\[])/.test(normalized) || normalized === 'best') {
    if (userConfirmed !== true) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `[GOVERNANCE ERROR] The selected model '${modelName}' is a top-tier deep reasoning model. ` +
              `Execution strictly requires explicit user confirmation (user_confirmed: true). ` +
              `Please prompt the user before initiating requests with this tier.`,
          },
        ],
      };
    }
  }
  return null;
}
