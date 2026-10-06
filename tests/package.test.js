const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package.json has zero omniagent entry in bin and clean coagent8 release metadata', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, 'coagent8');
  assert.equal(typeof pkg.bin, 'object');
  assert.equal(pkg.bin.omniagent, undefined, 'omniagent entry must be completely purged from bin');
  assert.equal(pkg.bin.coagent8, './dist/index.cjs', 'coagent8 binary must point to dist/index.cjs');
});

test('package-lock.json has zero omniagent entry in bin', () => {
  const lockPath = path.resolve(__dirname, '..', 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  const rootPkg = lock.packages && lock.packages[''];
  if (rootPkg && rootPkg.bin) {
    assert.equal(rootPkg.bin.omniagent, undefined, 'omniagent entry must be purged from package-lock.json bin');
  }
});
