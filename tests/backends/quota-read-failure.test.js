const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  recordQuotaCooldown,
  inspectQuotas,
} = require('../../src/backends/availability.ts');

// AUDIT-001-A01: an I/O failure reading an existing quota cache inside the locked
// update must not replace other providers' persisted cooldowns.

function seedCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-quota-read-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'quota-cache.json');
  const previousDir = process.env.coagent8_DIR;
  const previousFile = process.env.coagent8_QUOTA_CACHE;
  process.env.coagent8_DIR = dir;
  process.env.coagent8_QUOTA_CACHE = file;
  t.after(() => {
    if (previousDir === undefined) delete process.env.coagent8_DIR; else process.env.coagent8_DIR = previousDir;
    if (previousFile === undefined) delete process.env.coagent8_QUOTA_CACHE; else process.env.coagent8_QUOTA_CACHE = previousFile;
  });
  const until = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const cooldown = reason => ({
    installed: true, status: 'rate_limited', window: 'unknown', usedPercent: null, headroomPercent: 0,
    measured: false, measuredAt: null, resetsAt: until, cooldownUntil: until, cooldownReason: reason,
    cooldownLevel: 0, lastCooldownAt: new Date().toISOString(),
  });
  const seeded = JSON.stringify({ timestamp: Date.now(), data: { codex: cooldown('codex seeded'), claude: cooldown('claude seeded') } });
  fs.writeFileSync(file, seeded);
  return { file, seeded };
}

/** Fails reads of the fixture cache file only; every other open is untouched. */
function failCacheReads(t, file, code) {
  const target = path.resolve(file);
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', function (candidate, ...rest) {
    if (typeof candidate === 'string' && path.resolve(candidate) === target) {
      throw Object.assign(new Error(`${code}: simulated read failure, open '${candidate}'`), { code });
    }
    return original.call(this, candidate, ...rest);
  });
}

for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`recordQuotaCooldown keeps other providers' cooldowns when reading the cache fails with ${code}`, async t => {
    const { file, seeded } = seedCache(t);
    failCacheReads(t, file, code);
    await assert.rejects(recordQuotaCooldown('agy'), error => error.code === code);
    t.mock.restoreAll();
    assert.equal(fs.readFileSync(file, 'utf8'), seeded, 'the existing cache bytes are unchanged');
  });
}

test('inspectQuotas for one provider keeps other providers when reading the cache fails', async t => {
  const { file, seeded } = seedCache(t);
  failCacheReads(t, file, 'EBUSY');
  const errors = [];
  const report = await inspectQuotas(true, { agy: { installed: true, executionSupported: true } },
    { only: ['agy'], nativeQuota: false, onCacheError: error => errors.push(error) });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), seeded, 'the existing cache bytes are unchanged');
  assert.equal(errors.length, 1, 'the skipped write is reported as a cache error');
  assert.match(errors[0].message, /EBUSY/);
  assert.equal(report.agy.status, 'operational', 'the primary answer is still produced');
});

test('inspectQuotas without onCacheError propagates a failed read of an existing cache', async t => {
  const { file, seeded } = seedCache(t);
  failCacheReads(t, file, 'EPERM');
  await assert.rejects(
    inspectQuotas(true, { agy: { installed: true, executionSupported: true } }, { only: ['agy'], nativeQuota: false }),
    error => error.code === 'EPERM');
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), seeded);
});

test('malformed or oversized cache content holds no state and is replaced by an update', async t => {
  const { file } = seedCache(t);
  for (const content of ['{"timestamp":', '{"data":{}}', 'x'.repeat(70 * 1024)]) {
    fs.writeFileSync(file, content);
    await recordQuotaCooldown('agy');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(written.data), ['agy']);
  }
});

test('a missing cache file is still created by a single-provider update', async t => {
  const { file } = seedCache(t);
  fs.rmSync(file);
  await recordQuotaCooldown('agy');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.data.agy.status, 'rate_limited');
  assert.deepEqual(Object.keys(written.data), ['agy']);
});
