/** Typed Claude Code failures from structured stream-json fields; independent of execution and parsing. @packageDocumentation */
import { redactDiagnostic } from '../redaction.js';
import type { ErrorCode, ExecutionError } from '../types/adapter.types.js';

export interface ClaudeErrorMapping { code: ErrorCode; retryable: boolean }

/**
 * Claude Code error categories, as reported in `assistant.error` and
 * `system/api_retry.error`, mapped to CoAgent error codes.
 * @remarks Extend this table when the CLI adds a category; unknown categories
 * map to `PROCESS_ERROR`. Observed with Claude Code 2.1.289:
 * `authentication_failed` and `model_not_found`. The remaining keys follow the
 * category list of the CLI headless documentation.
 */
export const CLAUDE_ERROR_CATEGORIES: Readonly<Record<string, ClaudeErrorMapping>> = Object.freeze({
  authentication_failed: { code: 'AUTH_REQUIRED', retryable: false },
  oauth_org_not_allowed: { code: 'AUTH_REQUIRED', retryable: false },
  account_on_hold: { code: 'AUTH_REQUIRED', retryable: false },
  cloud_credential_error: { code: 'AUTH_REQUIRED', retryable: false },
  rate_limit: { code: 'RATE_LIMITED', retryable: true },
  billing_error: { code: 'AUTH_REQUIRED', retryable: false },
  model_not_found: { code: 'MODEL_UNAVAILABLE', retryable: false },
  overloaded: { code: 'PROCESS_ERROR', retryable: true },
  server_error: { code: 'PROCESS_ERROR', retryable: true },
  invalid_request: { code: 'PROCESS_ERROR', retryable: false },
  max_output_tokens: { code: 'PROCESS_ERROR', retryable: false },
});

/** HTTP statuses from `result.api_error_status`, used when no category is present. */
export const CLAUDE_HTTP_STATUS_CODES: Readonly<Record<number, ClaudeErrorMapping>> = Object.freeze({
  401: { code: 'AUTH_REQUIRED', retryable: false },
  403: { code: 'AUTH_REQUIRED', retryable: false },
  404: { code: 'MODEL_UNAVAILABLE', retryable: false },
  429: { code: 'RATE_LIMITED', retryable: true },
});

/**
 * Entries of `result.errors` that the CLI emits without a category. Anchored to
 * the CLI's own message prefix (observed with 2.1.289 for `--resume` of an
 * unknown session ID).
 */
export const CLAUDE_EXECUTION_ERROR_PREFIXES: ReadonlyArray<readonly [string, ClaudeErrorMapping]> = Object.freeze([
  ['No conversation found with session ID', { code: 'SESSION_INVALID', retryable: false }],
] as const);

export interface ClaudeFailureEvidence {
  /** Last `assistant.error` category, if any. */
  category?: string | null;
  /** `result.api_error_status`. */
  apiErrorStatus?: number | null;
  /** `result.subtype`, e.g. `error_during_execution`. */
  subtype?: string | null;
  /** `result.errors`. */
  errors?: readonly string[];
  /** `result.result` or the last assistant text; a human-readable message. */
  message?: string | null;
  /** Provider reset time from a rejected `rate_limit_event`, in epoch seconds. */
  rateLimitResetsAt?: number | null;
}

function lookup(evidence: ClaudeFailureEvidence): ClaudeErrorMapping {
  if (evidence.category && Object.hasOwn(CLAUDE_ERROR_CATEGORIES, evidence.category)) return CLAUDE_ERROR_CATEGORIES[evidence.category];
  const status = evidence.apiErrorStatus;
  if (typeof status === 'number') {
    if (Object.hasOwn(CLAUDE_HTTP_STATUS_CODES, status)) return CLAUDE_HTTP_STATUS_CODES[status];
    if (status >= 500 && status <= 599) return { code: 'PROCESS_ERROR', retryable: true };
  }
  for (const entry of evidence.errors ?? []) {
    const match = CLAUDE_EXECUTION_ERROR_PREFIXES.find(([prefix]) => entry.startsWith(prefix));
    if (match) return match[1];
  }
  return { code: 'PROCESS_ERROR', retryable: false };
}

/**
 * Maps structured Claude Code failure fields to a typed error.
 * @param evidence - Fields read from the stream-json events of one run.
 * @returns A typed error whose message is a redacted diagnostic.
 * @remarks Classification never inspects stderr or free text, except the
 * anchored `result.errors` prefixes above. A rate limit includes the provider
 * reset in the "resets at" form that `parseResetTimestamp` reads.
 */
export function classifyClaudeFailure(evidence: ClaudeFailureEvidence): ExecutionError {
  const mapping = lookup(evidence);
  const detail = evidence.message?.trim() || evidence.errors?.join('; ') || evidence.subtype || 'Claude Code reported an error.';
  const reset = mapping.code === 'RATE_LIMITED' && typeof evidence.rateLimitResetsAt === 'number' && Number.isFinite(evidence.rateLimitResetsAt)
    ? ` Limit resets at ${new Date(evidence.rateLimitResetsAt * 1000).toISOString()}.` : '';
  // ERRORS-001 will replace ExecutionError with a ToolError type; this mapping table stays the single source.
  return { code: mapping.code, message: redactDiagnostic(detail + reset), retryable: mapping.retryable };
}
