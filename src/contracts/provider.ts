/**
 * Provider identity contracts.
 *
 * @packageDocumentation
 */

export const PROVIDERS = ['codex', 'agy', 'claude'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/**
 * Default timeout for probing CLI presence and version in milliseconds (5 seconds).
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Default timeout for reading CLI model catalog or capabilities in milliseconds (10 seconds).
 */
export const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;

