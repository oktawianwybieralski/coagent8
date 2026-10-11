/**
 * One extractor for structured provider error payloads (AUD-P2-4).
 *
 * @remarks
 * Codex and agy report failures as objects with an HTTP status, a code, a type or a
 * reason. Each backend passes its {@link ErrorDialect}: the fields it reads, the codes
 * specific to its API and its text classifier for payloads without a structured code.
 *
 * @packageDocumentation
 */

import { redactDiagnostic } from '../security/redaction.js';
import type { ExecutionError } from '../contracts/index.js';

/** Where and how one backend reports structured errors. */
export interface ErrorDialect {
  /** Provider name in messages built from a bare code, such as "Codex error (500)". */
  name: string;
  /** Fields read as an HTTP status, first match wins. */
  httpFields: readonly string[];
  /** Fields read as error codes. */
  codeFields: readonly string[];
  /** Fields of a nested `error` object, read after the top-level ones. */
  nested?: { httpFields: readonly string[]; codeFields: readonly string[]; messageFields: readonly string[] };
  /** Codes, besides the shared ones, that mean a rate limit, missing authentication or not found. */
  rateLimitCodes: readonly string[];
  rateLimitParts: readonly string[];
  authCodes: readonly string[];
  notFoundCodes: readonly string[];
  /** Message pattern that turns a not-found error into `SESSION_INVALID`. */
  sessionPattern: RegExp;
  /** Codes, besides HTTP 503, that make a generic structured error retryable. */
  retryableCodes: readonly string[];
  /** Classifies a message when the payload carries no structured code. */
  classifyText(text: string): ExecutionError;
  /** Message when there is neither a payload message nor a fallback. */
  defaultMessage: string;
}

const RATE_LIMIT_CODES = ['429', '8', 'resource_exhausted', 'too_many_requests', 'insufficient_quota', 'rate_limit_exceeded'];
const RATE_LIMIT_PARTS = ['rate_limit', 'quota'];
const AUTH_CODES = ['401', '403', 'unauthenticated', 'permission_denied', 'unauthorized', 'authentication_error', 'invalid_api_key'];
const AUTH_PARTS = ['auth', 'permission'];
const NOT_FOUND_CODES = ['404', 'model_not_found'];

function asHttpStatus(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : undefined;
  return parsed !== undefined && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/**
 * Maps a structured error payload to a typed error.
 * @param payload - The provider's error object, a message string or anything else.
 * @param fallbackMessage - Message used when the payload carries none.
 * @param dialect - The backend's fields, codes and text classifier.
 */
export function extractStructuredError(payload: unknown, fallbackMessage: string | undefined, dialect: ErrorDialect): ExecutionError {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const outer = payload as Record<string, unknown>;
    const inner = dialect.nested && typeof outer.error === 'object' && outer.error !== null ? outer.error as Record<string, unknown> : null;
    const read = (fields: readonly string[], innerFields: readonly string[] = []) => [...fields.map(f => outer[f]), ...(inner ? innerFields.map(f => inner[f]) : [])];
    const message = String(read(['message', 'detail'], dialect.nested?.messageFields).find(Boolean) || fallbackMessage || '');
    const httpCode = read(dialect.httpFields, dialect.nested?.httpFields).map(asHttpStatus).find(v => v !== undefined);
    const codes = read(dialect.codeFields, dialect.nested?.codeFields).filter(v => v != null).map(v => String(v).toLowerCase().trim());
    const has = (exact: readonly string[], parts: readonly string[] = []) => codes.some(c => exact.includes(c) || parts.some(part => c.includes(part)));

    if (httpCode === 429 || has([...RATE_LIMIT_CODES, ...dialect.rateLimitCodes], [...RATE_LIMIT_PARTS, ...dialect.rateLimitParts])) {
      return { code: 'RATE_LIMITED', message: redactDiagnostic(message || 'Rate limit or quota exhausted (429)'), retryable: true };
    }
    if (httpCode === 401 || httpCode === 403 || has([...AUTH_CODES, ...dialect.authCodes], AUTH_PARTS)) {
      return { code: 'AUTH_REQUIRED', message: redactDiagnostic(message || 'Authentication required'), retryable: false };
    }
    if (httpCode === 404 || has([...NOT_FOUND_CODES, ...dialect.notFoundCodes], ['not_found'])) {
      return dialect.sessionPattern.test(message)
        ? { code: 'SESSION_INVALID', message: redactDiagnostic(message || 'Session not found'), retryable: false }
        : { code: 'MODEL_UNAVAILABLE', message: redactDiagnostic(message || 'Model unavailable (404)'), retryable: false };
    }
    if (httpCode !== undefined && httpCode >= 400 && httpCode < 500 && message) {
      // A bare client error (400, 422) names no cause; the message may, for example an
      // unsupported model. Rate limits and authentication have their own statuses, so a
      // message that only mentions them never turns a 400 into one.
      const fromText = dialect.classifyText(message);
      if (fromText.code === 'MODEL_UNAVAILABLE' || fromText.code === 'SESSION_INVALID') return fromText;
    }
    if ((httpCode !== undefined && httpCode >= 400) || codes.some(c => c.length > 0 && c !== 'unknown' && c !== 'error')) {
      const retryable = httpCode === 503 || codes.some(c => dialect.retryableCodes.includes(c));
      return { code: 'PROCESS_ERROR', message: redactDiagnostic(message || `${dialect.name} error (${codes[0] || httpCode})`), retryable };
    }
    if (message) return dialect.classifyText(message);
  }
  return dialect.classifyText(typeof payload === 'string' ? payload : fallbackMessage || dialect.defaultMessage);
}
