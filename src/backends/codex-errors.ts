/** Typed native Codex failures; independent of execution and parsing. @packageDocumentation */
import { redactDiagnostic } from '../redaction.js';
import type { ExecutionError } from '../types/adapter.types.js';

export function classifyCodexError(message: string): ExecutionError {
  const code = /429|rate.?limit|quota|too many requests|usage\s*limit|spend\s*cap/i.test(message) ? 'RATE_LIMITED'
    : /auth|credential|api.?key|log.?in|401|403/i.test(message) ? 'AUTH_REQUIRED'
    : /model.*(?:not found|unavailable|unsupported|does not exist)/i.test(message) ? 'MODEL_UNAVAILABLE'
    : /(?:session|thread).*(?:not found|invalid|does not exist)/i.test(message) ? 'SESSION_INVALID' : 'PROCESS_ERROR';
  return { code, message: redactDiagnostic(message), retryable: code === 'RATE_LIMITED' };
}

export function extractStructuredCodexError(errorPayload: unknown, fallbackMessage?: string): ExecutionError {
  if (errorPayload && typeof errorPayload === 'object' && !Array.isArray(errorPayload)) {
    const errObj = errorPayload as Record<string, unknown>;
    const inner = (typeof errObj.error === 'object' && errObj.error !== null) ? (errObj.error as Record<string, unknown>) : null;
    const codeVal = errObj.code ?? errObj.status_code ?? errObj.statusCode ?? errObj.http_status ?? errObj.status ?? inner?.code ?? inner?.status;
    const typeVal = String(errObj.type || inner?.type || '').toLowerCase();
    const rawMsg = String(errObj.message || errObj.detail || inner?.message || inner?.detail || fallbackMessage || '');

    const httpCode = [errObj.status_code, errObj.statusCode, errObj.http_status, errObj.code, errObj.status, inner?.code, inner?.status]
      .map(v => typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number.parseInt(v.trim(), 10) : undefined))
      .find(v => v !== undefined && v >= 100 && v <= 599);

    const rawCodes = [errObj.code, errObj.status, errObj.type, errObj.error_code, errObj.reason, inner?.code, inner?.status, inner?.type]
      .filter(v => v != null)
      .map(v => String(v).toLowerCase().trim());

    const hasRateLimit = httpCode === 429 ||
      rawCodes.some(c => c === '429' || c === '8' || c === 'resource_exhausted' || c === 'rate_limit_exceeded' || c === 'insufficient_quota' || c === 'too_many_requests' || c.includes('rate_limit') || c.includes('quota') || c.includes('usage_limit') || c.includes('spend_cap'));
    if (hasRateLimit) {
      return { code: 'RATE_LIMITED', message: redactDiagnostic(rawMsg || 'Rate limit or quota exceeded (429)'), retryable: true };
    }

    const hasAuth = httpCode === 401 || httpCode === 403 ||
      rawCodes.some(c => ['401', '403', 'invalid_api_key', 'authentication_error', 'unauthenticated', 'permission_denied', 'unauthorized'].includes(c) || c.includes('auth') || c.includes('permission'));
    if (hasAuth) {
      return { code: 'AUTH_REQUIRED', message: redactDiagnostic(rawMsg || 'Authentication required'), retryable: false };
    }

    const hasNotFound = httpCode === 404 ||
      rawCodes.some(c => c === '404' || c === 'model_not_found' || c.includes('not_found'));
    if (hasNotFound) {
      if (/session|thread/i.test(rawMsg)) {
        return { code: 'SESSION_INVALID', message: redactDiagnostic(rawMsg || 'Session not found'), retryable: false };
      }
      return { code: 'MODEL_UNAVAILABLE', message: redactDiagnostic(rawMsg || 'Model not found (404)'), retryable: false };
    }

    const hasStructuredError = (httpCode !== undefined && httpCode >= 400 && httpCode <= 599) ||
      rawCodes.some(c => c.length > 0 && !['unknown', 'error'].includes(c));
    if (hasStructuredError) {
      const errName = rawCodes[0] || String(httpCode);
      return { code: 'PROCESS_ERROR', message: redactDiagnostic(rawMsg || `Codex error (${errName})`), retryable: httpCode === 503 };
    }

    if (rawMsg) {
      return classifyCodexError(rawMsg);
    }
  }
  const text = typeof errorPayload === 'string' ? errorPayload : fallbackMessage || 'Codex reported an error.';
  return classifyCodexError(text);
}
