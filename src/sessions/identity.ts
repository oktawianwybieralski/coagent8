/**
 * Session identity primitives independent of storage and execution lifecycles.
 * Canonical workspace identity moved to `src/workspace/identity.ts` (SIMPLIFY-001 S1).
 *
 * @packageDocumentation
 */

export { canonicalPath } from '../workspace/identity.js';

/** Validates a public session handle before it becomes a storage filename. */
export function sanitizeHandle(handle?: string | null): string | null {
  return typeof handle === 'string' && /^syn_sess_[A-Za-z0-9_-]{6,80}$/.test(handle) ? handle : null;
}
