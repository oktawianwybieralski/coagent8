'use strict';

/**
 * #211: no model turn starts before the user accepts host execution.
 *
 * Verifies:
 * - Without consent and without a form, the runner refuses before the controller runs.
 * - A declined, closed or refused form refuses and records nothing.
 * - An approved form records `hostExecution: "accepted"`, and later turns ask nothing.
 * - The configuration and the process environment each count as consent.
 * - An invalid `hostExecution` value is a configuration error.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-host-consent-'));
process.env.coagent8_DIR = tempDir;
delete process.env.COAGENT8_HOST_EXECUTION;

const { runTask } = require('../../src/execution/task.ts');
const { ensureHostConsent, hostExecutionAccepted } = require('../../src/execution/host-consent.ts');
const { loadConfig, saveConfig, getConfigFile } = require('../../src/config.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

async function reset() {
  fs.rmSync(getConfigFile(), { force: true });
  delete process.env.COAGENT8_HOST_EXECUTION;
}

function recorder() {
  const calls = [];
  return { calls, execute: async (...args) => (calls.push(args), { isError: false }) };
}

const request = extra => ({ prompt: 'p', publicInput: 'p', args: {}, cwd: tempDir, ...extra });

test('without consent and without a form the runner refuses before any turn', async () => {
  await reset();
  for (const role of ['consult', 'review', 'delegate']) {
    const { calls, execute } = recorder();
    await assert.rejects(
      runTask(role, request(), execute),
      err => err.code === 'POLICY_DENIED' && /hostExecution/.test(err.message) && /No model turn started/.test(err.message),
    );
    assert.equal(calls.length, 0, role);
  }
  assert.equal(loadConfig().hostExecution, undefined);
});

test('a declined, closed or refused form refuses and records nothing', async () => {
  await reset();
  for (const answer of [{ approved: false, declined: true }, { approved: false, unanswered: true }, { approved: false }]) {
    const { calls, execute } = recorder();
    let asked = 0;
    await assert.rejects(
      runTask('consult', request({ askHostConsent: async () => (asked++, answer) }), execute),
      err => err.code === 'POLICY_DENIED',
    );
    assert.equal(asked, 1);
    assert.equal(calls.length, 0);
    assert.equal(loadConfig().hostExecution, undefined);
  }
});

test('an approved form records the consent, and later turns ask nothing', async () => {
  await reset();
  const { calls, execute } = recorder();
  let asked = 0;
  const askHostConsent = async () => (asked++, { approved: true });
  await runTask('review', request({ askHostConsent }), execute);
  assert.equal(asked, 1);
  assert.equal(calls.length, 1);
  assert.equal(loadConfig().hostExecution, 'accepted');
  await runTask('delegate', request({ askHostConsent }), execute);
  await runTask('consult', request(), execute);
  assert.equal(asked, 1, 'asked once');
  assert.equal(calls.length, 3);
});

test('the configuration and the process environment each count as consent', async () => {
  await reset();
  assert.equal(hostExecutionAccepted(), false);
  await saveConfig({ hostExecution: 'accepted' });
  assert.equal(hostExecutionAccepted(), true);
  await ensureHostConsent();
  await reset();
  process.env.COAGENT8_HOST_EXECUTION = 'accepted';
  try {
    assert.equal(hostExecutionAccepted(), true);
    await ensureHostConsent();
    assert.equal(hostExecutionAccepted({ COAGENT8_HOST_EXECUTION: 'yes' }), false, 'only the exact value counts');
  } finally {
    delete process.env.COAGENT8_HOST_EXECUTION;
  }
});

test('an invalid configuration is reported as such, not as missing consent', async () => {
  await reset();
  fs.mkdirSync(path.dirname(getConfigFile()), { recursive: true });
  fs.writeFileSync(getConfigFile(), JSON.stringify({ schemaVersion: 1, hostExecution: true }));
  assert.throws(() => loadConfig(), /Invalid hostExecution/);
  // The configuration error reaches the caller instead of a request for consent (#211 review).
  assert.throws(() => hostExecutionAccepted(), /Invalid hostExecution/);
  await assert.rejects(ensureHostConsent(), /Invalid hostExecution/);
  await reset();
});
