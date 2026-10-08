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

const { formatExecutionResult } = require('../../src/mcp/result.ts');
const { readResult } = require('../helpers/result.cjs');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('response formatting has no cooldown/storage writes and carries execution-owned warnings', async () => {
  const formatted = await formatExecutionResult('codex', { status: 'failed', isError: true, output: '', error: { code: 'RATE_LIMITED', message: 'synthetic limit', retryable: true }, truncated: false, continuationAvailable: false }, '', null,
    { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false }, { warnings: ['token=synthetic-secret'] });
  assert.deepEqual(fs.readdirSync(tempDir), []);
  assert.ok(readResult(formatted).warnings[0].includes('REDACTED'));
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
  assert.ok(text.endsWith('> CoAgent8: codex · gpt-6.1-sol · 4.5s · 3 ops · syn_sess_1234567890abcdef (turn 2, ready)'), 'one footer line');
  assert.deepEqual(Object.keys(formatted), ['isError', 'content'], 'markdown is the only channel');
});

test('formatExecutionResult omits a zero operation count and the first turn, and keeps footer lines apart', async () => {
  const formatted = await formatExecutionResult('claude', {
    status: 'completed', isError: false, output: 'answer', model: 'claude-haiku-4-5-20251001',
    truncated: true, continuationAvailable: true,
  }, '', 'syn_sess_first', { turn: 1, toolCount: 0, durationMs: 7500, historyAvailable: true }, { warnings: ['slow backend'] });
  assert.ok(formatted.content[0].text.endsWith([
    '> CoAgent8: claude · claude-haiku-4-5-20251001 · 7.5s · syn_sess_first (ready)',
    '> Notice: Output reached buffer limit.',
    '> Warning: slow backend',
  ].join('\n>\n')), 'each footer line is its own quoted paragraph');
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
  assert.ok(text.startsWith('> Error [RATE_LIMITED, retryable]: Provider quota exhausted.'), 'the error line says the same request may succeed later');
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
    'agy',
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

test('withWorkspace adds a line only for the server-directory fallback', () => {
  const { withWorkspace } = require('../../src/mcp/result.ts');
  const base = { isError: false, content: [{ type: 'text', text: 'answer' }] };
  assert.equal(withWorkspace(base, { path: tempDir, source: 'client_root' }), base, 'a client root costs no text');
  assert.equal(withWorkspace(base, { path: tempDir, source: 'argument' }), base, 'an explicit path costs no text');
  const fallback = withWorkspace(base, { path: tempDir, source: 'server_directory' });
  assert.match(fallback.content[0].text, /^answer\n>\n> Workspace: .+ \(server directory\)$/, 'the note is its own quoted paragraph');
});

test('CONTEXT-001: an execution result is markdown only and its footer carries every field a caller acts on', async () => {
  const meta = { turn: 2, toolCount: 1, durationMs: 1200, historyAvailable: false };
  const review = await formatExecutionResult('claude', {
    status: 'completed', isError: false, output: 'Summary without an envelope.', model: 'claude-haiku-4-5-20251001',
    truncated: false, continuationAvailable: true,
  }, '', 'syn_sess_review', meta, { requireEnvelope: true });
  assert.equal(review.structuredContent, undefined, 'Claude Code would show the model only structuredContent');
  const read = readResult(review);
  assert.equal(read.provider, 'claude');
  assert.equal(read.model, 'claude-haiku-4-5-20251001');
  assert.equal(read.durationSec, 1.2);
  assert.equal(read.ops, 1);
  assert.equal(read.sessionHandle, 'syn_sess_review');
  assert.equal(read.turn, 2);
  assert.equal(read.state, 'ready');
  assert.equal(read.historyAvailable, false, 'a turn without history says so');
  assert.equal(read.verdict, 'BLOCKED', 'the gate verdict is in the footer, not only in the answer');
  assert.ok(read.reason, 'a blocked verdict states its reason');

  const failed = readResult(await formatExecutionResult('codex', {
    status: 'failed', isError: true, output: '', error: { code: 'AUTH_REQUIRED', message: 'Sign in to Codex.', retryable: false },
    truncated: false, continuationAvailable: false,
  }, '', null, { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false }, { requireEnvelope: true }));
  assert.deepEqual(failed.error, { code: 'AUTH_REQUIRED', retryable: false, message: 'Sign in to Codex.' });
  assert.equal(failed.verdict, 'BLOCKED');
  assert.equal(failed.reason, null, 'the error line already states why');

  const consult = readResult(await formatExecutionResult('agy', {
    status: 'completed', isError: false, output: 'answer', truncated: false, continuationAvailable: false,
  }, '', null, { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: true }));
  assert.equal(consult.verdict, 'NOT_APPLICABLE', 'consult has no verdict line');
  assert.equal(consult.model, 'provider default');
  assert.equal(consult.text, 'answer\n\n> CoAgent8: agy · provider default · 0.0s');
});
