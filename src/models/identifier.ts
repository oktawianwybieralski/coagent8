/**
 * Model identifier validation (AUD-P1-6): a model name reaches CLI argv and stored state only
 * when it cannot be read as an option and contains no whitespace.
 *
 * @packageDocumentation
 */

export { isValidModelIdentifier } from '../contracts/models.js';

