const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-presentation-'));
process.env.coagent8_DIR = dir;
const { formatExecutionResult } = require('../src/tools/common.ts');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
test('response formatting has no cooldown/storage writes and carries execution-owned warnings', async () => {
  const formatted = await formatExecutionResult('codex', { status: 'failed', isError: true, output: '', error: { code: 'RATE_LIMITED', message: 'synthetic limit', retryable: true }, truncated: false, continuationAvailable: false }, '', null,
    { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false }, { warnings: ['token=synthetic-secret'] });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(formatted.structuredContent.warnings[0].includes('REDACTED'));
});
