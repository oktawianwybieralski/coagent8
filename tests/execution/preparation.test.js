'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-task-prep-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { saveConfig, loadConfigSnapshot } = require('../../src/config.ts');
const {
  validateTaskContext,
  prepareTask,
  confirmTaskConsent,
} = require('../../src/execution/preparation.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function createMockSession(handle, workspace, backend = 'codex', threadId = 'thread_123', model = 'gpt-6-luna') {
  const file = path.join(tempDir, 'sessions', `${handle}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    sessionHandle: handle,
    backend,
    threadId,
    workspace,
    model,
    reasoningEffort: 'low',
    activePid: null,
    activeTurnAt: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  }));
}

test('validateTaskContext: rejects invalid model identifiers before any backend or probe run', () => {
  const cwd = tempDir;
  assert.throws(
    () => validateTaskContext({ model: '--malicious-flag' }, cwd),
    { code: 'INPUT_LIMIT' }
  );
  assert.throws(
    () => validateTaskContext({ model: 'gpt 4 with spaces' }, cwd),
    { code: 'INPUT_LIMIT' }
  );
  assert.throws(
    () => validateTaskContext({ model: '' }, cwd),
    { code: 'INPUT_LIMIT' }
  );
  assert.doesNotThrow(
    () => validateTaskContext({ model: 'gpt-6-luna' }, cwd)
  );
});

test('validateTaskContext: rejects pre-aborted caller signals', () => {
  const cwd = tempDir;
  const ac = new AbortController();
  ac.abort();
  assert.throws(
    () => validateTaskContext({}, cwd, { abortSignal: ac.signal }),
    { code: 'ABORTED' }
  );
});

test('validateTaskContext: validates session existence, workspace binding, and provider lock', () => {
  const cwd = tempDir;
  const foreignWorkspace = path.join(tempDir, 'foreign');
  fs.mkdirSync(foreignWorkspace, { recursive: true });

  // Missing session
  assert.throws(
    () => validateTaskContext({ session_handle: 'syn_sess_missing' }, cwd),
    { code: 'SESSION_INVALID' }
  );

  // Foreign workspace session
  createMockSession('syn_sess_foreign', foreignWorkspace, 'codex', 'thread_foreign');
  assert.throws(
    () => validateTaskContext({ session_handle: 'syn_sess_foreign' }, cwd),
    { code: 'SESSION_INVALID' }
  );

  // Valid session in local workspace
  createMockSession('syn_sess_valid_abc', cwd, 'codex', 'thread_valid');
  const validated = validateTaskContext({ session_handle: 'syn_sess_valid_abc' }, cwd);
  assert.ok(validated.previousSession);
  assert.equal(validated.previousSession.sessionHandle, 'syn_sess_valid_abc');

  // Attempting provider switch
  assert.throws(
    () => validateTaskContext({ session_handle: 'syn_sess_valid_abc', backend: 'claude' }, cwd),
    { code: 'SESSION_INVALID' }
  );

  // Permitted provider specifications (auto, smart_quota, or same provider)
  assert.doesNotThrow(
    () => validateTaskContext({ session_handle: 'syn_sess_valid_abc', backend: 'auto' }, cwd)
  );
  assert.doesNotThrow(
    () => validateTaskContext({ session_handle: 'syn_sess_valid_abc', backend: 'codex' }, cwd)
  );

  // Session without native continuation (threadId null)
  createMockSession('syn_sess_no_thread', cwd, 'codex', null);
  assert.throws(
    () => validateTaskContext({ session_handle: 'syn_sess_no_thread' }, cwd),
    { code: 'SESSION_INVALID' }
  );
});

test('prepareTask: prepares auto execution with single configuration snapshot', async () => {
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6-luna' },
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    });

    const snapshot = loadConfigSnapshot();
    const cwd = tempDir;

    const prepared = await prepareTask({}, cwd, { config: snapshot });
    assert.equal(prepared.backend.id, 'codex');
    assert.equal(prepared.model, 'gpt-6-luna');
    assert.equal(prepared.previousSession, null);
    assert.equal(prepared.configSnapshot.changeIdentity, snapshot.changeIdentity);
    assert.equal(typeof prepared.assertPriceLimit, 'function');
    assert.equal(typeof prepared.confirmConsent, 'function');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('prepareTask: respects continuation session model and reasoning effort inheritance', async () => {
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6-luna' },
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    const cwd = tempDir;
    createMockSession('syn_sess_cont_abc', cwd, 'codex', 'thread_cont', 'gpt-6-luna');

    const prepared = await prepareTask({ session_handle: 'syn_sess_cont_abc' }, cwd);
    assert.equal(prepared.backend.id, 'codex');
    assert.equal(prepared.model, 'gpt-6-luna');
    assert.equal(prepared.reasoningEffort, 'low');
    assert.ok(prepared.previousSession);
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('prepareTask & confirmConsent: handles consent verification and price limits', async () => {
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6-luna' },
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    const cwd = tempDir;

    // Price limit passes for gpt-6-luna (< 1.00; listed at 0.50)
    const prepLuna = await prepareTask({ model: 'gpt-6-luna', output_price_below: 1.0 }, cwd);
    assert.equal(prepLuna.model, 'gpt-6-luna');
    const note = await prepLuna.assertPriceLimit();
    assert.ok(note.includes('0.5 USD per million output tokens'));

    // Price limit rejects for gpt-6-luna if limit is 0.20
    await assert.rejects(
      prepareTask({ model: 'gpt-6-luna', output_price_below: 0.2 }, cwd),
      { code: 'PRICE_LIMIT' }
    );

    // gpt-6-astra (50.00 USD) requires consent because askAbovePrice is 20
    const prepAstra = await prepareTask({ model: 'gpt-6-astra' }, cwd);

    // Consent denied when askConsent is missing
    await assert.rejects(
      prepAstra.confirmConsent(),
      { code: 'POLICY_DENIED' }
    );

    // Consent denied when user rejects
    await assert.rejects(
      prepAstra.confirmConsent({
        askConsent: async () => ({ approved: false }),
      }),
      { code: 'POLICY_DENIED' }
    );

    // Consent granted
    const consentResult = await confirmTaskConsent(prepAstra, {
      askConsent: async () => ({ approved: true }),
    });
    assert.deepEqual(consentResult.warnings, []);
  } finally {
    Object.assign(adapterRegistry, original);
  }
});
