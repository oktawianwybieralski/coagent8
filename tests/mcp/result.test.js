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

test('formatExecutionResult enforces strict No-Emoji standard and a framed footer', async () => {
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

  assert.equal(text, '```plaintext\nSystem analysis successful.\n```\n\n```plaintext\nCoAgent8: codex · gpt-6.1-sol · 4.5s · 3 ops · syn_sess_1234567890abcdef (turn 2, ready)\n```', 'answer and footer each in a plaintext frame');
  assert.deepEqual(Object.keys(formatted), ['isError', 'content'], 'markdown is the only channel');
});

test('formatExecutionResult omits a zero operation count and the first turn, and keeps footer lines apart', async () => {
  const formatted = await formatExecutionResult('claude', {
    status: 'completed', isError: false, output: 'answer', model: 'claude-haiku-4-5-20251001',
    truncated: true, continuationAvailable: true,
  }, '', 'syn_sess_first', { turn: 1, toolCount: 0, durationMs: 7500, historyAvailable: true }, { warnings: ['slow backend'] });
  assert.ok(formatted.content[0].text.endsWith([
    '```plaintext',
    'CoAgent8: claude · claude-haiku-4-5-20251001 · 7.5s · syn_sess_first (ready)',
    'Notice: Output reached buffer limit.',
    'Warning: slow backend',
    '```',
  ].join('\n')), 'each footer field is its own line');
});

test('error formatting states the error first without warning emojis', async () => {
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
  assert.ok(text.startsWith('Error [RATE_LIMITED, retryable]: Provider quota exhausted.'), 'the error line says the same request may succeed later');
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
  assert.ok(textProcessErr.includes('Report this issue: https://github.com/oktawianwybieralski/coagent8/issues/new?'));
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
  assert.ok(resCliErr.content[0].text.includes('Report this issue: https://github.com/oktawianwybieralski/coagent8/issues/new?'));

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
  assert.ok(resProtoErr.content[0].text.includes('Report this issue: https://github.com/oktawianwybieralski/coagent8/issues/new?'));

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
  assert.ok(!resRateLimited.content[0].text.includes('Report this issue:'));

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
  assert.ok(!resAborted.content[0].text.includes('Report this issue:'));
});

test('withWorkspace adds a line only for the server-directory fallback', () => {
  const { withWorkspace } = require('../../src/mcp/result.ts');
  const base = { isError: false, content: [{ type: 'text', text: '```plaintext\nanswer\n```\n\n```plaintext\nCoAgent8: agy · m · 0.0s\n```' }] };
  assert.equal(withWorkspace(base, { path: tempDir, source: 'client_root' }), base, 'a client root costs no text');
  assert.equal(withWorkspace(base, { path: tempDir, source: 'argument' }), base, 'an explicit path costs no text');
  const fallback = withWorkspace(base, { path: tempDir, source: 'server_directory' });
  assert.match(fallback.content[0].text, /\n\n```plaintext\nCoAgent8: agy · m · 0\.0s\nWorkspace: .+ \(server directory\)\n```$/, 'the note is a line of the framed footer');
  assert.ok(fallback.content[0].text.startsWith('```plaintext\nanswer\n```\n\n'), 'the answer frame is unchanged');
});

test('CONTEXT-001: an execution result is text only and its footer carries every field a caller acts on', async () => {
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
  assert.equal(consult.text, '```plaintext\nanswer\n```\n\n```plaintext\nCoAgent8: agy · provider default · 0.0s\n```');
});

test('a Codex client gets raw lines, which it frames itself; other clients get plaintext frames', () => {
  const { setResultStyle, withWorkspace } = require('../../src/mcp/result.ts');
  const run = () => formatExecutionResult('agy', { status: 'completed', isError: false, output: 'REVIEW: 1\nVERDICT: READY', truncated: false, continuationAvailable: false },
    '', 'syn_sess_raw', { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: true }, { warnings: ['multi\nline warning'] });
  try {
    setResultStyle('codex-mcp-client');
    const raw = withWorkspace(run(), { path: tempDir, source: 'server_directory' });
    assert.match(raw.content[0].text, /^REVIEW: 1\nVERDICT: READY\n\nCoAgent8: agy · provider default · 0\.0s · syn_sess_raw \(finished\)\nWarning: multi line warning\nWorkspace: .+ \(server directory\)$/);
    assert.ok(!raw.content[0].text.includes('```'), 'no frame inside the frame Codex draws');
    const read = readResult(raw);
    assert.equal(read.style, 'raw');
    assert.equal(read.answer, 'REVIEW: 1\nVERDICT: READY');
    assert.deepEqual(read.warnings, ['multi line warning'], 'a field with a line break stays one footer line');
    for (const client of ['claude-code', 'antigravity', 'Visual Studio Code', undefined]) {
      setResultStyle(client);
      assert.equal(readResult(run()).style, 'framed', String(client));
    }
  } finally { setResultStyle(undefined); }
});

test('EXEC-001-T11c: formatExecutionResult retains plaintext frame structure and bounded footer lines across error states and metadata', async () => {
  const cases = [
    {
      meta: { turn: 1, toolCount: 0, durationMs: 0, totalMs: 0, historyAvailable: false },
      error: { code: 'TIMEOUT', message: 'Execution deadline exceeded (900000 ms).\nDetailed stack trace and multiline error message', retryable: false },
    },
    {
      meta: { turn: 3, toolCount: 5, durationMs: 4567, totalMs: 4567, historyAvailable: true, phases: { preparation: 200, execution: 4000, finalization: 367 } },
      error: { code: 'ABORTED', message: 'User cancelled turn with newline\nand extra commentary', retryable: false },
    },
    {
      meta: { turn: 0, toolCount: 0, durationMs: 1250, totalMs: 1250, historyAvailable: false },
      error: { code: 'POLICY_DENIED', message: 'Consent declined.\nAnother line here', retryable: false },
    },
  ];

  for (const { meta, error } of cases) {
    const formatted = formatExecutionResult(
      'codex',
      {
        status: 'failed',
        isError: true,
        output: '',
        model: 'gpt-6.1-sol',
        truncated: false,
        continuationAvailable: false,
        error,
      },
      '',
      'syn_sess_bounded',
      meta,
      {
        warnings: ['Warning with\nline break', 'Another normal warning'],
      }
    );

    const parsed = readResult(formatted);
    assert.equal(parsed.provider, 'codex');
    assert.equal(parsed.model, 'gpt-6.1-sol');
    assert.equal(parsed.durationSec, Number((meta.totalMs / 1000).toFixed(1)));
    assert.equal(parsed.style, 'framed');

    // Verify absence of emojis
    const text = formatted.content[0].text;
    const emojiRegex = /[\u2300-\u23FF\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/;
    assert.ok(!emojiRegex.test(text), 'no emoji in formatted result');

    // Extract footer lines from the framed footer
    const footerMatch = /```plaintext\n([\s\S]+?)\n```$/.exec(text);
    assert.ok(footerMatch, 'must have framed footer at end of text');
    const footerLines = footerMatch[1].split('\n');

    // Ensure every footer line is single line and doesn't contain unescaped line breaks
    for (const line of footerLines) {
      assert.ok(!line.includes('\r'), 'no carriage returns in footer line');
      assert.ok(line.length < 2048, `footer line length (${line.length}) within transport bounds`);
    }
  }
});
