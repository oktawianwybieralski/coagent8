/**
 * Provider identity contracts.
 *
 * @packageDocumentation
 */

export const PROVIDERS = ['codex', 'agy', 'claude'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

