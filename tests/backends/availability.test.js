const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  recordQuotaCooldown,
  resetQuotaCooldown,
  readQuotaCache,
  writeQuotaCache,
  inspectQuotas,
} = require('../../src/backends/availability.ts');

test('Phase 0 Task 0.3: Adaptive cooldown backoff escalates on retry failure and resets on success', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-backoff-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.coagent8_DIR = dir;
  process.env.coagent8_QUOTA_CACHE = path.join(dir, 'quota-cache.json');

  // Step 1: First rate limit hit -> 15s (level 0)
  const before1 = Date.now();
  await recordQuotaCooldown('codex');
  let cache = readQuotaCache();
  assert.ok(cache);
  assert.equal(cache.data.codex.status, 'rate_limited');
  assert.equal(cache.data.codex.cooldownLevel, 0);
  const diff1 = Date.parse(cache.data.codex.cooldownUntil) - before1;
  assert.ok(diff1 >= 14000 && diff1 <= 16000, `Expected ~15s diff, got ${diff1}ms`);

  // Simulate cooldown expiry: status resets to operational for probe, lastCooldownAt is preserved
  cache.data.codex.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await writeQuotaCache(cache.data);
  await inspectQuotas(true, { codex: { installed: true, executionSupported: true } });
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'operational');
  assert.equal(cache.data.codex.cooldownUntil, null);
  assert.equal(cache.data.codex.cooldownLevel, 0);
  assert.ok(cache.data.codex.lastCooldownAt);

  // Step 2: Probe fails with rate limit -> escalates to level 1 (45s) despite cooldownUntil having been null!
  const before2 = Date.now();
  await recordQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'rate_limited');
  assert.equal(cache.data.codex.cooldownLevel, 1);
  const diff2 = Date.parse(cache.data.codex.cooldownUntil) - before2;
  assert.ok(diff2 >= 44000 && diff2 <= 46000, `Expected ~45s diff, got ${diff2}ms`);

  // Simulate second cooldown expiry
  cache.data.codex.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await writeQuotaCache(cache.data);
  await inspectQuotas(true, { codex: { installed: true, executionSupported: true } });

  // Step 3: Second retry probe fails -> escalates to level 2 (180s)
  const before3 = Date.now();
  await recordQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.cooldownLevel, 2);
  const diff3 = Date.parse(cache.data.codex.cooldownUntil) - before3;
  assert.ok(diff3 >= 179000 && diff3 <= 181000, `Expected ~180s diff, got ${diff3}ms`);

  // Simulate cooldown expiry: status becomes operational, but backoff level is still 2
  cache.data.codex.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await writeQuotaCache(cache.data);
  await inspectQuotas(true, { codex: { installed: true, executionSupported: true } });
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'operational');
  assert.equal(cache.data.codex.cooldownLevel, 2);

  // Step 4: Successful turn resets backoff level to 0 and clears lastCooldownAt
  await resetQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'operational');
  assert.equal(cache.data.codex.cooldownUntil, null);
  assert.equal(cache.data.codex.cooldownLevel, 0);
  assert.equal(cache.data.codex.lastCooldownAt, null);

  // Subsequent rate limit starts fresh at 15s (level 0)
  const before4 = Date.now();
  await recordQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.cooldownLevel, 0);
  const diff4 = Date.parse(cache.data.codex.cooldownUntil) - before4;
  assert.ok(diff4 >= 14000 && diff4 <= 16000, `Expected reset to ~15s diff, got ${diff4}ms`);

  // Active rate limit must NOT be reset by a concurrent/stale success
  await resetQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'rate_limited');
  assert.ok(cache.data.codex.cooldownUntil);
});
