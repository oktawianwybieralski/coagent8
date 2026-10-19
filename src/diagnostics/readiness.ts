/**
 * Backend readiness from evidence (`AX-005a`): one decision table for doctor's report and
 * summary, so an unknown fact is never shown as a failed one.
 *
 * @remarks Rows are checked in order and the first that applies decides:
 *
 * | State | When |
 * | --- | --- |
 * | `not_installed` | The CLI was not found. |
 * | `not_allowed` | Routing does not allow the backend. |
 * | `profile_unverified` | The CLI cannot execute, or its read-only profile is not verified. |
 * | `signed_out` | The CLI reports that it is not signed in. |
 * | `rate_limited` | A cooldown from a rate-limited turn is still running. |
 * | `quota_exhausted` | The measured quota window has no headroom left. |
 * | `ready` | Sign-in is evidenced: reported by the CLI, proven by a quota measured now, or by a turn completed within a day on this installation. |
 * | `sign_in_unverified` | Nothing contradicts readiness, but nothing proves sign-in either (agy before its first turn). |
 *
 * A completed turn is evidence for the model it ran and for this installation only; it does
 * not prove that every model, or the read-only profile of every later run, works.
 *
 * @packageDocumentation
 */

/** One backend's readiness state. */
export type ReadinessState =
  | 'not_installed' | 'not_allowed' | 'profile_unverified' | 'signed_out'
  | 'rate_limited' | 'quota_exhausted' | 'ready' | 'sign_in_unverified';

/** A backend's readiness and the evidence it rests on. */
export interface BackendReadiness {
  state: ReadinessState;
  /** One sentence naming the deciding evidence. */
  evidence: string;
  /** The last turn this installation completed, when known. */
  lastSuccess?: { model: string; at: string };
}

/** The facts the decision reads, gathered by doctor. */
export interface ReadinessFacts {
  installed: boolean;
  allowed: boolean;
  executionSupported: boolean;
  readOnlyVerified: boolean;
  /** As the CLI reported it: `authenticated`, `unauthenticated` or anything else for unknown. */
  authStatus?: string;
  /** A quota the CLI measured during this diagnosis, which needs a signed-in CLI. */
  quotaMeasuredNow: boolean;
  quota?: { status: string; headroomPercent: number | null; cooldownUntil?: string | null; resetsAt?: string | null };
  lastSuccess?: { model: string; observedAt: number };
}

/** How long a completed turn counts as evidence of sign-in. */
export const SUCCESS_EVIDENCE_MS = 24 * 60 * 60 * 1000;

/** Decides a backend's readiness from its facts; see the module's decision table. */
export function decideReadiness(facts: ReadinessFacts, now = Date.now()): BackendReadiness {
  const success = facts.lastSuccess ? { model: facts.lastSuccess.model, at: new Date(facts.lastSuccess.observedAt).toISOString() } : undefined;
  const result = (state: ReadinessState, evidence: string): BackendReadiness => ({ state, evidence, ...(success ? { lastSuccess: success } : {}) });
  if (!facts.installed) return { state: 'not_installed', evidence: 'The CLI was not found.' };
  if (!facts.allowed) return result('not_allowed', 'Routing does not allow this backend.');
  if (!facts.executionSupported || !facts.readOnlyVerified) return result('profile_unverified', 'The CLI cannot run turns, or its read-only profile is not verified.');
  if (facts.authStatus === 'unauthenticated') return result('signed_out', 'The CLI reports that it is not signed in.');
  const cooldown = facts.quota?.cooldownUntil ? Date.parse(facts.quota.cooldownUntil) : NaN;
  if (facts.quota?.status === 'rate_limited' && (!Number.isFinite(cooldown) || cooldown > now)) {
    return result('rate_limited', facts.quota.cooldownUntil ? `Rate limited until ${facts.quota.cooldownUntil}.` : 'Rate limited.');
  }
  if (facts.quota?.headroomPercent === 0) return result('quota_exhausted', facts.quota.resetsAt ? `Quota exhausted until ${facts.quota.resetsAt}.` : 'Quota exhausted.');
  if (facts.authStatus === 'authenticated') return result('ready', 'The CLI reports a signed-in account.');
  if (facts.quotaMeasuredNow) return result('ready', 'The CLI measured its quota now, which needs a signed-in account.');
  if (facts.lastSuccess && now - facts.lastSuccess.observedAt < SUCCESS_EVIDENCE_MS) {
    return result('ready', `A turn on ${facts.lastSuccess.model} completed at ${success!.at} on this installation.`);
  }
  return result('sign_in_unverified', 'Nothing shows the CLI signed out, but nothing proves it signed in; a completed turn does.');
}

/** The short label of a state in doctor's summary. */
export const READINESS_LABEL: Record<ReadinessState, string> = {
  not_installed: 'not installed',
  not_allowed: 'not allowed',
  profile_unverified: 'read-only profile not verified',
  signed_out: 'signed out',
  rate_limited: 'rate limited',
  quota_exhausted: 'quota exhausted',
  ready: 'ready',
  sign_in_unverified: 'sign-in unverified',
};
