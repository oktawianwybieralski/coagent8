const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripAnsi } = require('../../src/execution/cli-output.ts');
const { formatExecutionResult } = require('../../src/mcp/result.ts');
const { readResult } = require('../helpers/result.cjs');

test('stripAnsi deterministically strips colors, cursor moves, and formatting sequences', () => {
  const coloredText = '\u001b[31mError:\u001b[0m \u001b[1;33mHigh severity\u001b[0m in \u001b[4;36mserver.ts\u001b[0m\u001b[2K\r';
  const stripped = stripAnsi(coloredText);
  assert.equal(stripped, 'Error: High severity in server.ts\r');
});

test('an answer that quotes npm notices or update banners reaches the caller unchanged (SIMPLIFY-001)', async () => {
  // Every backend returns its answer from JSON events, so CLI banners never reach it.
  const answer = [
    'Your log shows two npm messages:',
    'npm notice New minor version of npm available! 10.8.0 -> 10.9.0',
    '┌──────────────────────────────────────────────┐',
    '│  A new version of codex CLI is available!    │',
    '└──────────────────────────────────────────────┘',
    'A new version of npm is available; they are harmless.',
  ].join('\n');
  const formatted = await formatExecutionResult('codex', {
    status: 'completed',
    isError: false,
    output: answer,
    truncated: false,
    continuationAvailable: false,
  });
  assert.equal(readResult(formatted).answer, answer);
});
