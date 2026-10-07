const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-controller-cooldown-'));
process.env.coagent8_DIR = tempDir;
const quotaCache = path.join(tempDir, 'quota-cache.json');
process.env.coagent8_QUOTA_CACHE = quotaCache;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

const MINUTE_MS = 60 * 1000;

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

async function rateLimitedTurn(message) {
  const original = adapterRegistry.gemini;
  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async () => ({
      status: 'failed', isError: true, output: '', model: 'gemini-test', truncated: false, continuationAvailable: false,
      error: { code: 'RATE_LIMITED', message, retryable: true },
    }),
  };
  try {
    fs.rmSync(quotaCache, { force: true });
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const started = Date.now();
    const res = await executeTask('User prompt', 'Public question', { backend: 'gemini' }, tempDir);
    assert.equal(readResult(res).error.code, 'RATE_LIMITED');
    const entry = JSON.parse(fs.readFileSync(quotaCache, 'utf8')).data.gemini;
    return { entry, cooldownMs: Date.parse(entry.cooldownUntil) - started };
  } finally {
    adapterRegistry.gemini = original;
  }
}

test('a parsed provider reset survives the controller sequence (AUD-P1-1)', async () => {
  const { entry, cooldownMs } = await rateLimitedTurn('You hit your usage limit. Try again in 3 days.');
  const threeDaysMs = 3 * 24 * 60 * MINUTE_MS;
  assert.ok(cooldownMs >= threeDaysMs - MINUTE_MS && cooldownMs <= threeDaysMs + MINUTE_MS, `cooldown is the parsed 3 days, got ${cooldownMs} ms`);
  assert.equal(entry.cooldownLevel, 0, 'a parsed reset does not advance the backoff tier');
});

test('a rate limit without a reset records exactly one first-tier cooldown (AUD-P1-1)', async () => {
  const { entry, cooldownMs } = await rateLimitedTurn('429 Too Many Requests');
  assert.equal(entry.cooldownLevel, 0, 'one write per turn stays on the first backoff tier');
  assert.ok(cooldownMs >= 14 * 1000 && cooldownMs <= 16 * 1000, `first-tier cooldown is 15 s, got ${cooldownMs} ms`);
});
