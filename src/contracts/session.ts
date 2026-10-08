/**
 * Session activity and lease evidence contracts.
 *
 * @remarks
 * Narrow interface allowing background storage eviction, history maintenance,
 * and external supervisors to query active session leases without binding
 * directly to the concrete session service implementation.
 *
 * @packageDocumentation
 */

/**
 * Predicate checking whether a session currently has an active turn or running process.
 *
 * @param handle - Session handle string to check.
 * @returns True if the session has an active running execution turn.
 */
export type SessionActivityChecker = (handle: string) => boolean;

