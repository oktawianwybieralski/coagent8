/** Public Gemini terminal/error classification. @packageDocumentation */
import { redactDiagnostic } from '../../security/redaction.js';
import { isRateLimitError } from '../rate-limit.js';
import { isAuthError } from '../auth-error.js';
import type { ExecutionError } from '../../contracts/index.js';
import { extractStructuredError, type ErrorDialect } from '../structured-error.js';
export function classifyGeminiError(text: string): ExecutionError {
  const message = redactDiagnostic(text);
  const code =
    isRateLimitError(text) || /\bRESOURCE_EXHAUSTED\b|\bquota(?: limit)? (?:exceeded|exhausted)\b/i.test(text)
      ? 'RATE_LIMITED'
      : /session.*(?:not found|invalid|does not exist)|failed.*resume|conversation.*not found/i.test(text)
        ? 'SESSION_INVALID'
        : isAuthError(text)
          ? 'AUTH_REQUIRED'
          : /model.*(?:not found|unavailable|unsupported|not supported|not recognized)|invalid model selection|404/i.test(text)
            ? 'MODEL_UNAVAILABLE'
            : /SANDBOX_UNAVAILABLE|auto-denied|jetski:/i.test(text)
              ? 'SANDBOX_UNAVAILABLE'
              : 'PROCESS_ERROR';
  return { code, message, retryable: code === 'RATE_LIMITED' };
}

/**
 * agy's error after its own continuation retries at the output token limit: "Your previous
 * response was cut off because it exceeded the output token limit ... Retries remaining: 3"
 * (agy 1.4.3, #89). The streamed answer before it is the partial answer.
 */
export function isOutputLimitError(text: string): boolean {
  return /exceeded the output token limit|\bMAX_TOKENS\b/i.test(text);
}

const GEMINI_ERRORS: ErrorDialect = {
  name: 'Gemini',
  httpFields: ['status_code', 'statusCode', 'http_status', 'httpCode', 'code'],
  codeFields: ['code', 'status', 'type', 'error_code', 'reason'],
  // gRPC status numbers: 7 PERMISSION_DENIED, 16 UNAUTHENTICATED, 5 NOT_FOUND.
  rateLimitCodes: [],
  rateLimitParts: [],
  authCodes: ['7', '16'],
  notFoundCodes: ['5'],
  sessionPattern: /session|conversation/i,
  retryableCodes: ['unavailable'],
  classifyText: classifyGeminiError,
  defaultMessage: 'Gemini returned an error.',
};

export function extractStructuredGeminiError(errorPayload: unknown, fallbackMessage?: string): ExecutionError {
  return extractStructuredError(errorPayload, fallbackMessage, GEMINI_ERRORS);
}
