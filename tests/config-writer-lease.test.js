'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// AUDIT-001-A04: every configuration writer must respect the configuration file lease.
// An owned helper process holds the lease across a slow read-modify-write; the parent
// coordinates with explicit IPC messages, never with timing.

const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-lease-'));
process.env.coagent8_CONFIG = path.join(testTempDir, 'config.json');
const { saveConfig, setBackendExecutable, validateConfig } = require('../src/config.ts');
const lockModule = path.resolve(__dirname, '..', 'src/storage/lock.ts');
test.after(() => fs.rmSync(testTempDir, { recursive: true, force: true }));

/** Holds the lease, reports what it read, then writes its stale copy plus one remembered model. */
const helperScript = `
  const fs = require('node:fs');
  const { withFileLock } = require(process.argv[1]);
  const file = process.argv[2];
  const next = () => new Promise(resolve => process.once('message', resolve));
  withFileLock(file, async () => {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.send('read');
    await next();
    current.governance.models.allow = [...current.governance.models.allow, 'helper-model'];
    fs.writeFileSync(file, JSON.stringify(current, null, 2));
  }, 10000).then(() => process.send('released', () => process.disconnect()), error => {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
    process.disconnect();
  });
`;

function startHelper(t, file) {
  const child = spawn(process.execPath, ['--require', 'tsx/cjs', '-e', helperScript, lockModule, file], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  });
  const message = expected =>
    new Promise((resolve, reject) => {
      const onMessage = value => {
        if (value === expected) {
          cleanup();
          resolve();
        }
      };
      const onExit = code => {
        cleanup();
        reject(new Error(`helper exited (${code}) before '${expected}': ${stderr}`));
      };
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  return { child, message, exited, stderr: () => stderr };
}

function seed(file) {
  fs.writeFileSync(file, JSON.stringify(validateConfig({}), null, 2));
}

test("saveConfig waits for the configuration lease and keeps the other writer's field", async t => {
  const file = process.env.coagent8_CONFIG;
  seed(file);
  const helper = startHelper(t, file);
  await helper.message('read');
  // The call starts synchronously before the helper may write: an unlocked writer completes
  // here while the helper holds the lease; a locked writer is still waiting for it.
  const saving = (async () => saveConfig({ defaultBackend: 'claude' }))();
  helper.child.send('write');
  await helper.message('released');
  await saving;
  assert.equal(await helper.exited, 0, helper.stderr());
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(final.defaultBackend, 'claude', 'the saveConfig update survives');
  assert.deepEqual(final.governance.models.allow, ['helper-model'], "the lease holder's update survives");
});

test('control: a lease-respecting writer keeps both updates', async t => {
  const file = process.env.coagent8_CONFIG;
  seed(file);
  const helper = startHelper(t, file);
  await helper.message('read');
  const setting = setBackendExecutable('codex', '/fixture/codex');
  helper.child.send('write');
  await helper.message('released');
  await setting;
  assert.equal(await helper.exited, 0, helper.stderr());
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(final.backends.codex.executable, '/fixture/codex');
  assert.deepEqual(final.governance.models.allow, ['helper-model']);
});

test('saveConfig still fails closed on a malformed configuration and leaves its bytes', async () => {
  const file = process.env.coagent8_CONFIG;
  const malformed = '{"routing": {"allowedBackends": ["claude"]';
  fs.writeFileSync(file, malformed);
  await assert.rejects(
    saveConfig({ defaultBackend: 'codex' }),
    error => error.code === 'POLICY_DENIED' && /Configuration Error/.test(error.message),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
  assert.equal(fs.existsSync(`${file}.lease`), false, 'the lease is released after the refusal');
});
