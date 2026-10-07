/** Typed native Codex failures; independent of execution and parsing. @packageDocumentation */
import { redactDiagnostic } from '../../redaction.js';
import { isRateLimitError } from '../rate-limit.js';
import { isAuthError } from '../auth-error.js';
import type { ExecutionError } from '../../conversation.js';
import { extractStructuredError, type ErrorDialect } from '../structured-error.js';

export function classifyCodexError(message: string): ExecutionError {
  // Anchored provider phrases only: a bare "429", "quota" or "auth" also occurs in file
  // names, line numbers and ordinary words ("line 429", "disk quota check", "author").
  const code = isRateLimitError(message) ? 'RATE_LIMITED'
    : isAuthError(message) ? 'AUTH_REQUIRED'
    : /model.*(?:not found|unavailable|unsupported|not supported|does not exist)/i.test(message) ? 'MODEL_UNAVAILABLE'
    : /(?:session|thread).*(?:not found|invalid|does not exist)/i.test(message) ? 'SESSION_INVALID' : 'PROCESS_ERROR';
  return { code, message: redactDiagnostic(message), retryable: code === 'RATE_LIMITED' };
}

const CODEX_ERRORS: ErrorDialect = {
  name: 'Codex',
  httpFields: ['status_code', 'statusCode', 'http_status', 'code', 'status'],
  codeFields: ['code', 'status', 'type', 'error_code', 'reason'],
  nested: { httpFields: ['code', 'status'], codeFields: ['code', 'status', 'type'], messageFields: ['message', 'detail'] },
  rateLimitCodes: [], rateLimitParts: ['usage_limit', 'spend_cap'], authCodes: [], notFoundCodes: [],
  sessionPattern: /session|thread/i,
  retryableCodes: [],
  classifyText: classifyCodexError,
  defaultMessage: 'Codex reported an error.',
};

export function extractStructuredCodexError(errorPayload: unknown, fallbackMessage?: string): ExecutionError {
  return extractStructuredError(errorPayload, fallbackMessage, CODEX_ERRORS);
}

/** `codexErrorInfo` values of the app-server protocol (0.160) with a dedicated error code. */
const TURN_ERROR_CODES: Record<string, ExecutionError['code']> = {
  unauthorized: 'AUTH_REQUIRED', usageLimitExceeded: 'RATE_LIMITED', rateLimitExceeded: 'RATE_LIMITED',
};

/**
 * Classifies an app-server `TurnError` (`{ message, codexErrorInfo, additionalDetails }`).
 * @param error - The `error` of a failed turn or `error` notification.
 * @param fallbackMessage - Message used when the payload carries none.
 * @returns A typed error; HTTP failures use their status code, other kinds their message.
 */
export function classifyCodexTurnError(error: unknown, fallbackMessage: string): ExecutionError {
  const data = error !== null && typeof error === 'object' && !Array.isArray(error) ? error as Record<string, unknown> : {};
  const message = typeof data.message === 'string' && data.message ? data.message : fallbackMessage;
  const info = data.codexErrorInfo;
  if (typeof info === 'string' && TURN_ERROR_CODES[info]) {
    const code = TURN_ERROR_CODES[info];
    return { code, message: redactDiagnostic(message), retryable: code === 'RATE_LIMITED' };
  }
  const body = parseProviderErrorBody(message);
  if (body) return extractStructuredCodexError(body, message);
  const http = info !== null && typeof info === 'object' && !Array.isArray(info)
    ? Object.values(info as Record<string, unknown>).map(value => (value as { httpStatusCode?: unknown } | null)?.httpStatusCode).find(value => typeof value === 'number')
    : undefined;
  return typeof http === 'number' ? extractStructuredCodexError({ status_code: http, message }) : classifyCodexError(message);
}

/**
 * Codex passes some provider rejections on as the raw response body, for example
 * `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"..."}}`.
 * @returns The parsed body when the message is such an object with a nested error message.
 */
function parseProviderErrorBody(message: string): Record<string, unknown> | null {
  if (!message.trimStart().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const inner = (parsed as { error?: unknown }).error;
    return inner !== null && typeof inner === 'object' && typeof (inner as { message?: unknown }).message === 'string'
      ? parsed as Record<string, unknown> : null;
  } catch {
    // Not JSON: the message is ordinary text and is classified as such.
    return null;
  }
}
