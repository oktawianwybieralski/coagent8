/**
 * Model identifier validation (AUD-P1-6): a model name reaches CLI argv and stored state only
 * when it cannot be read as an option and contains no whitespace.
 *
 * @packageDocumentation
 */

/** Model identifier pattern from the audit; rejects option-like and whitespace values. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;

/** Returns whether a requested or backend-reported model identifier is safe to pass on and record. */
export function isValidModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}
