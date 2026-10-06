const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { discoverTests, resolveTestTargets } = require('./helpers/discovery.cjs');

test('portable discovery supports nested tests, excludes executable fixtures/reports, and fails when empty', t => {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-discovery-'));
  } catch (err) {
    const code = err && err.code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
      t.skip('Temporary directory creation restricted by read-only sandbox');
      return;
    }
    throw err;
  }
  t.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => discoverTests(dir), /No.*discovered/);
  for (const name of ['nested/real.test.js', 'fixtures/fixture.test.js', 'helpers/helper.test.js', 'consumer/smoke.test.js', 'artifacts/report.test.js', 'other.js']) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
  }
  assert.deepEqual(discoverTests(dir), [path.join(dir, 'nested/real.test.js')]);
});

test('resolveTestTargets falls back to discoverTests when no test files are specified', () => {
  const root = path.resolve(__dirname, '..');
  const result = resolveTestTargets([], root);
  assert.deepEqual(result.flags, ['--test-concurrency=2']);
  assert.ok(result.testFiles.length > 0);
  assert.ok(result.testFiles.includes(path.normalize(path.resolve(__dirname, 'discovery.test.js'))));
});

test('resolveTestTargets filters down to explicitly passed test files with path normalization', () => {
  const root = path.resolve(__dirname, '..');
  const target = 'tests/discovery.test.js';
  const result = resolveTestTargets([target], root);
  assert.deepEqual(result.flags, ['--test-concurrency=2']);
  assert.deepEqual(result.testFiles, [path.normalize(path.resolve(root, target))]);

  // Also resolves when passed without tests/ prefix
  const resultWithoutPrefix = resolveTestTargets(['discovery.test.js'], root);
  assert.deepEqual(resultWithoutPrefix.testFiles, [path.normalize(path.resolve(__dirname, 'discovery.test.js'))]);
});

test('resolveTestTargets respects CLI concurrency overrides and options parsing', () => {
  const root = path.resolve(__dirname, '..');
  const result = resolveTestTargets(['--test-concurrency=4', '--test-name-pattern=portable', 'tests/discovery.test.js'], root);
  assert.deepEqual(result.flags, ['--test-concurrency=4', '--test-name-pattern=portable']);
  assert.deepEqual(result.testFiles, [path.normalize(path.resolve(root, 'tests/discovery.test.js'))]);

  // Support separate argument for flag with value
  const resultSeparate = resolveTestTargets(['--test-concurrency', '1', 'tests/discovery.test.js'], root);
  assert.deepEqual(resultSeparate.flags, ['--test-concurrency', '1']);
  assert.deepEqual(resultSeparate.testFiles, [path.normalize(path.resolve(root, 'tests/discovery.test.js'))]);

  // Regressions: --test-skip-pattern and --test-shard must not treat values as test file paths
  const resultSkip = resolveTestTargets(['--test-skip-pattern', 'portable', 'tests/discovery.test.js'], root);
  assert.deepEqual(resultSkip.flags, ['--test-concurrency=2', '--test-skip-pattern', 'portable']);
  assert.deepEqual(resultSkip.testFiles, [path.normalize(path.resolve(root, 'tests/discovery.test.js'))]);

  const resultShard = resolveTestTargets(['--test-shard', '1/2', 'tests/discovery.test.js'], root);
  assert.deepEqual(resultShard.flags, ['--test-concurrency=2', '--test-shard', '1/2']);
  assert.deepEqual(resultShard.testFiles, [path.normalize(path.resolve(root, 'tests/discovery.test.js'))]);
});
