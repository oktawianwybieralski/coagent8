'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// AUDIT-001-A06: a configuration write meets a transient or permanent failure replacing
// the destination. Failures are simulated for the fixture destination only, through both
// the synchronous and asynchronous rename bindings; this is not a native Windows sharing
// violation.

const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-write-'));
process.env.coagent8_CONFIG = path.join(testTempDir, 'config.json');
const { saveConfig, validateConfig } = require('../src/config.ts');
test.after(() => fs.rmSync(testTempDir, { recursive: true, force: true }));

/** Fails renames onto the fixture configuration while `shouldFail(attempt)` is true. */
function failRenames(t, shouldFail, code) {
  const target = path.resolve(process.env.coagent8_CONFIG);
  const attempts = { count: 0 };
  const failure = to => Object.assign(new Error(`${code}: simulated sharing violation, rename -> '${to}'`), { code });
  const originalSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (path.resolve(String(to)) === target && shouldFail(++attempts.count)) throw failure(to);
    return originalSync.call(this, from, to);
  });
  const originalAsync = fsPromises.rename;
  t.mock.method(fsPromises, 'rename', function (from, to) {
    if (path.resolve(String(to)) === target && shouldFail(++attempts.count)) return Promise.reject(failure(to));
    return originalAsync.call(this, from, to);
  });
  return attempts;
}

function seed() {
  const file = process.env.coagent8_CONFIG;
  const bytes = JSON.stringify(validateConfig({ defaultBackend: 'agy' }), null, 2);
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

const leftovers = () => fs.readdirSync(testTempDir).filter(name => name !== 'config.json');

test('a transient sharing failure replacing the configuration is retried', async t => {
  const { file } = seed();
  const attempts = failRenames(t, attempt => attempt <= 3, 'EPERM');
  await saveConfig({ defaultBackend: 'claude' });
  t.mock.restoreAll();
  assert.equal(attempts.count, 4, 'three failed attempts, then success');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).defaultBackend, 'claude');
  assert.deepEqual(leftovers(), [], 'no temporary or lease file remains');
});

test('a permanent failure is surfaced and preserves the previous bytes', async t => {
  const { file, bytes } = seed();
  failRenames(t, () => true, 'EBUSY');
  await assert.rejects(saveConfig({ defaultBackend: 'claude' }), error => error.code === 'EBUSY');
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(leftovers(), [], 'no temporary or lease file remains');
});

test('a non-transient failure is not retried', async t => {
  const { file, bytes } = seed();
  const attempts = failRenames(t, () => true, 'EXDEV');
  await assert.rejects(saveConfig({ defaultBackend: 'claude' }), error => error.code === 'EXDEV');
  t.mock.restoreAll();
  assert.equal(attempts.count, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(leftovers(), []);
});
