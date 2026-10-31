const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeChecked } = require('../../src/integrations/setup-storage.ts');

// AUDIT-001-A11/A12: a client that holds its configuration file open makes Windows refuse the
// replacement for a moment (EPERM/EBUSY); setup retries a bounded number of times, re-checks the
// content before every attempt and never overwrites an edit made meanwhile.
function withRenameFailures(failures, onFailure, run) {
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith('.tmp') && calls++ < failures) {
      onFailure?.(calls);
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename(from, to);
  };
  try {
    return run();
  } finally {
    fs.renameSync = rename;
  }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-setup-write-'));
  const file = path.join(dir, 'client.json');
  fs.writeFileSync(file, '{"manual":true}\n', { mode: 0o640 });
  const temps = () => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
  return { dir, file, temps };
}

test('AUDIT-001-A12: a transient sharing failure while replacing a client file is retried', () => {
  const { dir, file, temps } = fixture();
  try {
    withRenameFailures(3, null, () => writeChecked(file, '{"manual":true}\n', '{"manual":true,"coagent8":{}}\n'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"manual":true,"coagent8":{}}\n');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'existing mode bits are kept');
    assert.deepEqual(temps(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT-001-A12: an edit made while setup waits is never overwritten', () => {
  const { dir, file, temps } = fixture();
  try {
    assert.throws(
      () =>
        withRenameFailures(
          5,
          () => fs.writeFileSync(file, '{"edited":true}\n'),
          () => writeChecked(file, '{"manual":true}\n', '{"manual":true,"coagent8":{}}\n'),
        ),
      /changed concurrently/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), '{"edited":true}\n', 'the external edit survives');
    assert.deepEqual(temps(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT-001-A12: a lasting failure ends after a bounded wait with the original error', () => {
  const { dir, file, temps } = fixture();
  try {
    const started = Date.now();
    assert.throws(() => withRenameFailures(Infinity, null, () => writeChecked(file, '{"manual":true}\n', '{}\n')), /EPERM/);
    assert.ok(Date.now() - started < 3000, 'the wait is bounded');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"manual":true}\n', 'the file is unchanged');
    assert.deepEqual(temps(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT-001-A12: a non-transient failure is not retried', () => {
  const { dir, file } = fixture();
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith('.tmp')) {
      calls++;
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  };
  try {
    assert.throws(() => writeChecked(file, '{"manual":true}\n', '{}\n'), /ENOSPC/);
    assert.equal(calls, 1);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
