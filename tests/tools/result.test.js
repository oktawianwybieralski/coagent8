'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tools-result-'));
process.env.coagent8_DIR = tempDir;
const tempSessionsFile = path.join(tempDir, 'sessions.json');
process.env.coagent8_SESSIONS = tempSessionsFile;

const { formatExecutionResult } = require('../../src/tools/result.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('response formatting has no cooldown/storage writes and carries execution-owned warnings', async () => {
  const formatted = await formatExecutionResult('codex', { status: 'failed', isError: true, output: '', error: { code: 'RATE_LIMITED', message: 'synthetic limit', retryable: true }, truncated: false, continuationAvailable: false }, '', null,
    { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false }, { warnings: ['token=synthetic-secret'] });
  assert.deepEqual(fs.readdirSync(tempDir), []);
  assert.ok(formatted.structuredContent.warnings[0].includes('REDACTED'));
});

test('formatExecutionResult enforces strict No-Emoji standard and clean blockquotes', async () => {
  const result = {
    status: 'completed',
    isError: false,
    output: 'System analysis successful.',
    model: 'gpt-6.1-sol',
    truncated: false,
    continuationAvailable: true,
  };

  const formatted = await formatExecutionResult('codex', result, '', 'syn_sess_1234567890abcdef', {
    turn: 2,
    toolCount: 3,
    durationMs: 4500,
    historyAvailable: true,
  });

  const text = formatted.content[0].text;

  // Verify absence of emojis
  const emojiRegex = /[\u2300-\u23FF\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/;
  assert.ok(!emojiRegex.test(text), `Output should not contain any emojis: ${text}`);

  // Verify clean blockquotes
  assert.ok(text.includes('> CoAgent8: codex (gpt-6.1-sol) · 4.5s · 3 ops'));
  assert.ok(text.includes('> Session: syn_sess_1234567890abcdef (turn 2 · ready)'));
});

test('error formatting uses enterprise-grade blockquote without warning emojis', async () => {
  const errorResult = {
    status: 'failed',
    isError: true,
    output: '',
    model: 'gpt-6.1-sol',
    truncated: false,
    continuationAvailable: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Provider quota exhausted.',
      retryable: true,
    },
  };

  const formatted = await formatExecutionResult('codex', errorResult, '', null, {
    turn: 1,
    toolCount: 0,
    durationMs: 500,
    historyAvailable: false,
  });

  const text = formatted.content[0].text;
  const emojiRegex = /[\u2300-\u23FF\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/;
  assert.ok(!emojiRegex.test(text), `Error output should not contain any emojis: ${text}`);
  assert.ok(text.includes('> Error [RATE_LIMITED]: Provider quota exhausted.'));
});

test('formatExecutionResult appends issue reporting link strictly on fatal unrecoverable system errors', async () => {
  // 1. Fatal PROCESS_ERROR
  const resProcessErr = await formatExecutionResult(
    'codex',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'PROCESS_ERROR', message: 'Failed to spawn powershell supervisor', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 100, historyAvailable: false }
  );
  const textProcessErr = resProcessErr.content[0].text;
  assert.ok(textProcessErr.includes('> Report this issue: [Open pre-filled GitHub Issue](https://github.com/oktawianwybieralski/coagent8/issues/new?'));
  assert.ok(textProcessErr.includes('PROCESS_ERROR'));

  // 2. Fatal CLI_UNSUPPORTED
  const resCliErr = await formatExecutionResult(
    'gemini',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'CLI_UNSUPPORTED', message: 'Version 0.50.0 is below required 0.62.0', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 50, historyAvailable: false }
  );
  assert.ok(resCliErr.content[0].text.includes('> Report this issue: [Open pre-filled GitHub Issue](https://github.com/oktawianwybieralski/coagent8/issues/new?'));

  // 3. Fatal PROTOCOL_ERROR
  const resProtoErr = await formatExecutionResult(
    'claude',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'PROTOCOL_ERROR', message: 'Received corrupt JSON streaming frame', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 80, historyAvailable: false }
  );
  assert.ok(resProtoErr.content[0].text.includes('> Report this issue: [Open pre-filled GitHub Issue](https://github.com/oktawianwybieralski/coagent8/issues/new?'));

  // 4. Non-fatal RATE_LIMITED: must NOT append issue link
  const resRateLimited = await formatExecutionResult(
    'codex',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'RATE_LIMITED', message: 'Quota exhausted for this window', retryable: true },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 30, historyAvailable: false }
  );
  assert.ok(!resRateLimited.content[0].text.includes('> Report this issue:'));

  // 5. Non-fatal ABORTED: must NOT append issue link
  const resAborted = await formatExecutionResult(
    'codex',
    {
      status: 'cancelled',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'ABORTED', message: 'User cancelled turn', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 10, historyAvailable: false }
  );
  assert.ok(!resAborted.content[0].text.includes('> Report this issue:'));
});
