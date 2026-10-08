/**
 * Compatibility forwarding shim for model-selection.
 * Pure decisions live in `src/models/selection.ts`.
 * Observation orchestration lives in `src/execution/selection.ts`.
 *
 * @packageDocumentation
 */

export * from '../models/selection.js';
export { selectModel } from '../execution/selection.js';
