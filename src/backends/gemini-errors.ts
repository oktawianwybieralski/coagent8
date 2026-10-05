/** Public Gemini terminal/error classification. @packageDocumentation */
import { redactDiagnostic } from '../redaction.js';
import { isRateLimitError } from './rate-limit.js';
import type { ExecutionError } from '../types/adapter.types.js';
export function classifyGeminiError(text: string): ExecutionError {
  const message = redactDiagnostic(text);
  const code = isRateLimitError(text) || /\bRESOURCE_EXHAUSTED\b|\bquota(?: limit)? (?:exceeded|exhausted)\b/i.test(text)
    ? 'RATE_LIMITED'
    : /session.*(?:not found|invalid|does not exist)|failed.*resume|conversation.*not found/i.test(text)
    ? 'SESSION_INVALID'
    : /auth|login|log\.in|credential|api\.key.*(?:missing|required|invalid)|ineligibletiererror|401|403/i.test(text)
    ? 'AUTH_REQUIRED'
    : /model.*(?:not found|unavailable|unsupported|not recognized)|404/i.test(text)
    ? 'MODEL_UNAVAILABLE'
    : /SANDBOX_UNAVAILABLE|auto-denied|jetski:/i.test(text)
    ? 'SANDBOX_UNAVAILABLE'
    : 'PROCESS_ERROR';
  return { code, message, retryable: code === 'RATE_LIMITED' };
}

export function extractStructuredGeminiError(errorPayload: unknown, fallbackMessage?: string): ExecutionError {
  if (errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)) {
    const errObj = errorPayload as Record<string, unknown>;
    const codeVal = errObj.code ?? errObj.status_code ?? errObj.statusCode ?? errObj.http_status ?? errObj.httpCode;
    const statusVal = String(errObj.status || '').toUpperCase();
    const rawMsg = String(errObj.message || errObj.detail || fallbackMessage || '');

    const httpCode = [errObj.status_code, errObj.statusCode, errObj.http_status, errObj.httpCode, errObj.code]
      .map(v => typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number.parseInt(v.trim(), 10) : undefined))
      .find(v => v !== undefined && v >= 100 && v <= 599);

    const rawCodes = [errObj.code, errObj.status, errObj.type, errObj.error_code, errObj.reason]
      .filter(v => v != null)
      .map(v => String(v).toLowerCase().trim());

    const hasRateLimit = httpCode === 429 ||
      rawCodes.some(c => c === '429' || c === '8' || c === 'resource_exhausted' || c === 'too_many_requests' || c === 'insufficient_quota' || c === 'rate_limit_exceeded' || c.includes('rate_limit') || c.includes('quota'));
    if (hasRateLimit) {
      return { code: 'RATE_LIMITED', message: redactDiagnostic(rawMsg || 'Rate limit or quota exhausted (429)'), retryable: true };
    }

    const hasAuth = httpCode === 401 || httpCode === 403 ||
      rawCodes.some(c => ['401', '403', '7', '16', 'unauthenticated', 'permission_denied', 'unauthorized', 'authentication_error', 'invalid_api_key'].includes(c) || c.includes('auth') || c.includes('permission'));
    if (hasAuth) {
      return { code: 'AUTH_REQUIRED', message: redactDiagnostic(rawMsg || 'Authentication required'), retryable: false };
    }

    const hasNotFound = httpCode === 404 ||
      rawCodes.some(c => c === '404' || c === '5' || c === 'not_found' || c === 'model_not_found' || c.includes('not_found'));
    if (hasNotFound) {
      if (/session|conversation/i.test(rawMsg)) {
        return { code: 'SESSION_INVALID', message: redactDiagnostic(rawMsg || 'Session not found'), retryable: false };
      }
      return { code: 'MODEL_UNAVAILABLE', message: redactDiagnostic(rawMsg || 'Model unavailable (404)'), retryable: false };
    }

    const hasStructuredError = (httpCode !== undefined && httpCode >= 400 && httpCode <= 599) ||
      rawCodes.some(c => c.length > 0 && !['unknown', 'error'].includes(c));
    if (hasStructuredError) {
      const isUnavailable = httpCode === 503 || rawCodes.some(c => c === 'unavailable');
      const errName = rawCodes[0] || String(httpCode);
      return { code: 'PROCESS_ERROR', message: redactDiagnostic(rawMsg || `Gemini error (${errName})`), retryable: isUnavailable };
    }

    if (rawMsg) {
      return classifyGeminiError(rawMsg);
    }
  }
  const text = typeof errorPayload === 'string' ? errorPayload : fallbackMessage || 'Gemini returned an error.';
  return classifyGeminiError(text);
}
