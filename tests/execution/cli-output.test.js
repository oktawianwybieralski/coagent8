const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripAnsi, cleanCliOutput } = require('../../src/execution/cli-output.ts');

test('stripAnsi deterministically strips colors, cursor moves, and formatting sequences', () => {
  const coloredText = '\u001b[31mError:\u001b[0m \u001b[1;33mHigh severity\u001b[0m in \u001b[4;36mserver.ts\u001b[0m\u001b[2K\r';
  const stripped = stripAnsi(coloredText);
  assert.equal(stripped, 'Error: High severity in server.ts\r');
});

test('stripCliBanners deterministically strips npm notices and update box banners', () => {
  const noisyOutput = [
    'npm notice New minor version of npm available! 10.8.0 -> 10.9.0',
    'npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.9.0',
    'npm notice Run npm install -g npm to update!',
    '┌──────────────────────────────────────────────┐',
    '│  A new version of codex CLI is available!    │',
    '│  Run npm i -g @openai/codex to update        │',
    '└──────────────────────────────────────────────┘',
    'REVIEW: 1',
    'SNAPSHOT: abc1234',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
  ].join('\n');

  const cleaned = cleanCliOutput(noisyOutput);
  assert.ok(!cleaned.includes('npm notice'));
  assert.ok(!cleaned.includes('A new version of codex'));
  assert.ok(cleaned.startsWith('REVIEW: 1'));
  assert.ok(cleaned.includes('VERDICT: READY'));
});

test('cleanCliOutput preserves Markdown table lines even with pipes and version keywords', () => {
  const tableInput = '| [P2] src/version.ts:10 | Missing version validation |';
  const cleaned = cleanCliOutput(tableInput);
  assert.equal(cleaned, '| [P2] src/version.ts:10 | Missing version validation |');
});
