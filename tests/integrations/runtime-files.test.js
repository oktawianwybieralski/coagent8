const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyJobHelperBeside, removeRuntimeDirectory } = require('../../src/integrations/runtime-files.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runtime-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the job helper for this machine follows the bundle to its runtime copy', t => {
  const root = fixture(t);
  const dist = path.join(root, 'dist');
  const helper = path.join(dist, 'win32-x64', 'coagent8-job.exe');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.mkdirSync(path.join(dist, 'win32-arm64'));
  fs.writeFileSync(helper, 'helper');
  fs.writeFileSync(path.join(dist, 'win32-arm64', 'coagent8-job.exe'), 'other architecture');
  const runtime = path.join(root, 'runtime', 'digest');

  copyJobHelperBeside(path.join(dist, 'index.cjs'), runtime, 'x64');
  assert.equal(fs.readFileSync(path.join(runtime, 'win32-x64', 'coagent8-job.exe'), 'utf8'), 'helper');
  assert.deepEqual(fs.readdirSync(runtime), ['win32-x64']);
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'win32-x64')), ['coagent8-job.exe'], 'no temporary file stays');

  // An existing copy can be in use, so it is left alone; the digest check judges it at launch.
  fs.writeFileSync(helper, 'changed');
  copyJobHelperBeside(path.join(dist, 'index.cjs'), runtime, 'x64');
  assert.equal(fs.readFileSync(path.join(runtime, 'win32-x64', 'coagent8-job.exe'), 'utf8'), 'helper');
});

test('a bundle without a helper copies nothing', t => {
  const root = fixture(t);
  const runtime = path.join(root, 'runtime');
  copyJobHelperBeside(path.join(root, 'dist', 'index.cjs'), runtime, 'x64');
  assert.equal(fs.existsSync(runtime), false);
});

test('a runtime copy in use stays for a later removal; other failures are reported', t => {
  const root = fixture(t);
  const directory = path.join(root, 'digest');
  fs.mkdirSync(directory);
  assert.equal(removeRuntimeDirectory(directory), true);
  assert.equal(fs.existsSync(directory), false);

  const rm = fs.rmSync;
  t.after(() => (fs.rmSync = rm));
  fs.rmSync = () => {
    throw Object.assign(new Error('in use'), { code: 'EPERM' });
  };
  assert.equal(removeRuntimeDirectory(directory), false);
  fs.rmSync = () => {
    throw Object.assign(new Error('disk'), { code: 'EIO' });
  };
  assert.throws(() => removeRuntimeDirectory(directory), /disk/);
  fs.rmSync = rm;
});
