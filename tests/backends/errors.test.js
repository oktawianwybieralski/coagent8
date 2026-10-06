'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractStructuredGeminiError } = require('../../src/backends/gemini/errors.ts');
const { extractStructuredCodexError, classifyCodexError } = require('../../src/backends/codex/errors.ts');

test('Structured error extraction handles typed envelopes and prevents false 429 lockouts', () => {
  // Gemini typed envelopes
  const gemini429 = extractStructuredGeminiError({ code: 429, message: 'Resource exhausted' });
  assert.equal(gemini429.code, 'RATE_LIMITED');
  assert.equal(gemini429.retryable, true);

  const geminiExhausted = extractStructuredGeminiError({ status: 'RESOURCE_EXHAUSTED', message: 'Quota limit exceeded' });
  assert.equal(geminiExhausted.code, 'RATE_LIMITED');
  assert.equal(geminiExhausted.retryable, true);

  const geminiGrpc8 = extractStructuredGeminiError({ code: 8, status: 'RESOURCE_EXHAUSTED' });
  assert.equal(geminiGrpc8.code, 'RATE_LIMITED');
  assert.equal(geminiGrpc8.retryable, true);

  const geminiGeneric429 = extractStructuredGeminiError({ code: 'generic_failure', status_code: 429, type: 'rate_limit_error' });
  assert.equal(geminiGeneric429.code, 'RATE_LIMITED');
  assert.equal(geminiGeneric429.retryable, true);

  const geminiAuth = extractStructuredGeminiError({ code: 401, message: 'Invalid credentials' });
  assert.equal(geminiAuth.code, 'AUTH_REQUIRED');
  assert.equal(geminiAuth.retryable, false);

  const geminiModel = extractStructuredGeminiError({ code: 404, message: 'Model not found' });
  assert.equal(geminiModel.code, 'MODEL_UNAVAILABLE');

  const geminiSession = extractStructuredGeminiError({ code: 404, message: 'Session conversation not found' });
  assert.equal(geminiSession.code, 'SESSION_INVALID');

  // Gemini 400 with message mentioning 429 in user code must NOT be RATE_LIMITED
  const gemini400With429Msg = extractStructuredGeminiError({ code: 400, message: 'Invalid parameter: port_429 is not allowed' });
  assert.equal(gemini400With429Msg.code, 'PROCESS_ERROR');
  assert.equal(gemini400With429Msg.retryable, false);

  // Gemini string-coded 500 with message mentioning 429 must NOT be RATE_LIMITED
  const gemini500With429 = extractStructuredGeminiError({ code: '500', message: 'Internal server error while evaluating code with 429' });
  assert.equal(gemini500With429.code, 'PROCESS_ERROR');
  assert.equal(gemini500With429.retryable, false);

  // Gemini symbolic codes
  const geminiSym429 = extractStructuredGeminiError({ code: 'insufficient_quota', message: 'Request rejected' });
  assert.equal(geminiSym429.code, 'RATE_LIMITED');
  assert.equal(geminiSym429.retryable, true);

  const geminiSymNon429 = extractStructuredGeminiError({ code: 'invalid_request_error', message: 'HTTP 429 fixture' });
  assert.equal(geminiSymNon429.code, 'PROCESS_ERROR');
  assert.equal(geminiSymNon429.retryable, false);

  // Codex typed envelopes
  const codex429 = extractStructuredCodexError({ code: 'rate_limit_exceeded', message: 'Too many requests' });
  assert.equal(codex429.code, 'RATE_LIMITED');
  assert.equal(codex429.retryable, true);

  const codexQuota = extractStructuredCodexError({ type: 'insufficient_quota', message: 'Out of quota' });
  assert.equal(codexQuota.code, 'RATE_LIMITED');

  const codexGrpc8 = extractStructuredCodexError({ code: 8, status: 'RESOURCE_EXHAUSTED' });
  assert.equal(codexGrpc8.code, 'RATE_LIMITED');
  assert.equal(codexGrpc8.retryable, true);

  const codexGeneric429 = extractStructuredCodexError({ code: 'generic_failure', status_code: 429, type: 'rate_limit_error' });
  assert.equal(codexGeneric429.code, 'RATE_LIMITED');
  assert.equal(codexGeneric429.retryable, true);

  const codexAuth = extractStructuredCodexError({ code: 401, message: 'Unauthorized' });
  assert.equal(codexAuth.code, 'AUTH_REQUIRED');

  const codexModel = extractStructuredCodexError({ code: 'model_not_found', message: 'Model does not exist' });
  assert.equal(codexModel.code, 'MODEL_UNAVAILABLE');

  // Codex 400/invalid_request_error with message mentioning 429 must NOT be RATE_LIMITED
  const codex400With429Msg = extractStructuredCodexError({ code: 400, type: 'invalid_request_error', message: 'Parameter check failed for status 429' });
  assert.equal(codex400With429Msg.code, 'PROCESS_ERROR');
  assert.equal(codex400With429Msg.retryable, false);

  // Codex string-coded 500 with message mentioning 429 must NOT be RATE_LIMITED
  const codex500With429 = extractStructuredCodexError({ code: '500', message: 'Server error: prompt mentions 429 rate limit' });
  assert.equal(codex500With429.code, 'PROCESS_ERROR');
  assert.equal(codex500With429.retryable, false);

  // Codex symbolic codes
  const codexSym429 = extractStructuredCodexError({ code: 'insufficient_quota', message: 'Request rejected' });
  assert.equal(codexSym429.code, 'RATE_LIMITED');
  assert.equal(codexSym429.retryable, true);

  const codexSymNon429 = extractStructuredCodexError({ code: 'invalid_request_error', message: 'HTTP 429 fixture' });
  assert.equal(codexSymNon429.code, 'PROCESS_ERROR');
  assert.equal(codexSymNon429.retryable, false);

  // Normal text messages not containing error patterns are process errors
  const normalError = extractStructuredGeminiError('Syntax error in line 42');
  assert.equal(normalError.code, 'PROCESS_ERROR');
  assert.equal(normalError.retryable, false);
});

test('codex-errors: classifies usage limit and spend cap as RATE_LIMITED', () => {
  const err1 = classifyCodexError("You've hit your usage limit. Try again later.");
  assert.equal(err1.code, 'RATE_LIMITED');
  assert.equal(err1.retryable, true);

  const err2 = classifyCodexError('Account spend cap reached.');
  assert.equal(err2.code, 'RATE_LIMITED');
  assert.equal(err2.retryable, true);

  const structErr = extractStructuredCodexError({
    error: { message: 'Daily usage limit exceeded for codex-pro' },
  });
  assert.equal(structErr.code, 'RATE_LIMITED');
});
