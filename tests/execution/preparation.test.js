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
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../src/contracts/error.ts');

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

test('EXEC-001-T05a: catalog observation obtained during routing is reused in model selection and check', async () => {
  const original = { ...adapterRegistry };
  try {
    let catalogReads = 0;
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => {
        catalogReads++;
        return {
          source: 'codex-catalog',
          models: [
            { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
            { id: 'gpt-6-astra', efforts: ['low'] },
          ],
        };
      },
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    const prepared = await prepareTask({ model: 'gpt-6-astra' }, tempDir);
    assert.equal(prepared.backend.id, 'codex');
    assert.equal(prepared.model, 'gpt-6-astra');
    assert.equal(prepared.defaultModel, 'gpt-6.1-sol', 'defaultModel is kept distinct from requested model');
    assert.ok(prepared.backend.catalog, 'catalog is attached to resolved backend');
    assert.equal(catalogReads, 1, 'routing reads catalog once; model selection and validation reuse it');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T05b: defaultModel is reused in consent and handles missing backend default', async () => {
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'] },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      backends: { codex: { defaultModel: undefined } },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    // 1. With declared first-listed catalog default
    const prep1 = await prepareTask({ model: 'gpt-6.1-sol' }, tempDir);
    assert.equal(prep1.defaultModel, 'gpt-6.1-sol');

    // 2. When backend has no catalog and no default model (unknown-default)
    adapterRegistry.codex.listModels = undefined;
    const prep2 = await prepareTask({ model: 'gpt-6.1-sol' }, tempDir);
    assert.equal(prep2.defaultModel, null, 'unknown-default backend yields defaultModel = null');

    // Confirming consent with defaultModel = null still runs governance cleanly
    const consentRes = await prep2.confirmConsent();
    assert.deepEqual(consentRes.warnings, []);
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T05c: price change while consent is pending triggers re-validation failure', async () => {
  const { recordPrices } = require('../../src/models/store.ts');
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 50, alwaysAsk: ['gpt-6.1-sol'], neverAsk: [] },
    });

    // Initial price for gpt-6.1-sol is 10 USD; output_price_below limit is 15 USD.
    const prepared = await prepareTask({ model: 'gpt-6.1-sol', output_price_below: 15 }, tempDir);
    assert.equal(prepared.model, 'gpt-6.1-sol');

    // While consent prompt is pending, price increases to 25 USD (above the 15 USD limit)
    await assert.rejects(
      prepared.confirmConsent({
        askConsent: async () => {
          await recordPrices({
            fetchedAt: Date.now(),
            source: 'openrouter',
            models: {
              'gpt-6.1-sol': { output: 25, input: 5, cachedInput: 2.5, matched: 'openai/gpt-6.1-sol', exact: true },
            },
          });
          return { approved: true };
        },
      }),
      {
        code: 'PRICE_LIMIT',
        message: /costs 25 USD per million output tokens.*not below 15 USD/,
      }
    );
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T10b: confirmConsent price increase without price limit throws POLICY_DENIED and leaves neverAsk untouched', async () => {
  const { recordPrices } = require('../../src/models/store.ts');
  const { loadConfig } = require('../../src/config.ts');
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 50, alwaysAsk: ['gpt-6.1-sol'], neverAsk: [] },
    });

    await recordPrices({
      fetchedAt: Date.now(),
      source: 'openrouter',
      models: {
        'gpt-6.1-sol': { output: 10, input: 2, cachedInput: 1, matched: 'openai/gpt-6.1-sol', exact: true },
      },
    });

    const prepared = await prepareTask({ model: 'gpt-6.1-sol' }, tempDir);

    await assert.rejects(
      prepared.confirmConsent({
        askConsent: async () => {
          // Price increased to 30 USD while waiting
          await recordPrices({
            fetchedAt: Date.now(),
            source: 'openrouter',
            models: {
              'gpt-6.1-sol': { output: 30, input: 5, cachedInput: 2.5, matched: 'openai/gpt-6.1-sol', exact: true },
            },
          });
          return { approved: true, remember: true };
        },
      }),
      err => {
        assert.equal(err.code, 'POLICY_DENIED');
        assert.match(err.message, /The approval for model 'gpt-6.1-sol' was invalidated because conditions changed while awaiting consent/i);
        assert.match(err.message, /Its output price increased from 10 USD to 30 USD per million tokens/i);
        assert.match(err.message, /Retry the request to approve under current conditions/i);
        return true;
      }
    );

    assert.ok(!loadConfig().governance.neverAsk.includes('gpt-6.1-sol'), 'neverAsk must remain untouched when consent invalidated');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T10b: confirmConsent governance config change invalidates approval and leaves neverAsk untouched', async () => {
  const { loadConfig } = require('../../src/config.ts');
  try { fs.unlinkSync(path.join(tempDir, 'models.json')); } catch {}
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '1.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
          { id: 'gpt-non-default', efforts: ['low'] },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 50, alwaysAsk: [], neverAsk: [] },
    });

    const prepared = await prepareTask({ model: 'gpt-non-default' }, tempDir);

    await assert.rejects(
      prepared.confirmConsent({
        askConsent: async () => {
          // Config changed: threshold lowered to 5 USD
          saveConfig({
            defaultBackend: 'codex',
            routing: { strategy: 'fixed', allowedBackends: ['codex'] },
            governance: { priceMultiplier: 2, askAbovePrice: 5, alwaysAsk: [], neverAsk: [] },
          });
          return { approved: true, remember: true };
        },
      }),
      err => {
        assert.equal(err.code, 'POLICY_DENIED');
        assert.match(err.message, /governance.askAbovePrice (was lowered|changed) from 50 USD to 5 USD/i);
        assert.match(err.message, /Retry the request to approve under current conditions/i);
        return true;
      }
    );

    assert.ok(!loadConfig().governance.neverAsk.includes('gpt-non-default'), 'neverAsk must remain untouched when consent invalidated');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T10b: confirmConsent unchanged conditions with remember: true succeeds and updates neverAsk', async () => {
  const { loadConfig } = require('../../src/config.ts');
  try { fs.unlinkSync(path.join(tempDir, 'models.json')); } catch {}
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '2.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
          { id: 'gpt-unpriced', efforts: ['low'] },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    const prepared = await prepareTask({ model: 'gpt-unpriced' }, tempDir);

    const res = await prepared.confirmConsent({
      askConsent: async () => ({ approved: true, remember: true }),
    });

    assert.deepEqual(res.warnings, []);
    assert.ok(loadConfig().governance.neverAsk.includes('gpt-unpriced'), 'Valid approval remembered in neverAsk');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T10c: confirmConsent preserves valid approval when storage fails, recording redacted warning (Primary Task Supremacy)', async () => {
  const { loadConfig } = require('../../src/config.ts');
  const original = { ...adapterRegistry };
  const originalRenameSync = fs.renameSync;
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '2.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
          { id: 'gpt-unpriced', efforts: ['low'] },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    const prepared = await prepareTask({ model: 'gpt-unpriced' }, tempDir);

    // Simulate disk/permissions failure with sensitive path and credential in error
    const userHome = os.homedir();
    const sensitiveErrorMsg = `EACCES: permission denied, open '${path.join(userHome, '.coagent8', 'config.json')}' with token=sk-ant-secret12345678901234567890`;
    fs.renameSync = function (from, to) {
      if (typeof to === 'string' && to.includes('config.json')) {
        throw new Error(sensitiveErrorMsg);
      }
      return originalRenameSync.apply(this, arguments);
    };

    const res = await prepared.confirmConsent({
      askConsent: async () => ({ approved: true, remember: true }),
    });

    // Primary Task Supremacy: approval preserved and valid turn ready
    assert.ok(res, 'Consent confirmation must resolve successfully despite secondary storage error');
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /The approval of 'gpt-unpriced' was not remembered:/);
    assert.ok(!res.warnings[0].includes('sk-ant-secret12345678901234567890'), 'Tokens/credentials must be redacted');
    assert.ok(!res.warnings[0].includes(userHome), 'User home paths must be redacted');
    assert.ok(res.warnings[0].length <= 350, 'Warning must respect bounded diagnostic length');

    // Next-call policy consistency: disk state does not contain the model
    assert.ok(!loadConfig().governance.neverAsk.includes('gpt-unpriced'), 'Model must NOT be persisted in neverAsk');
  } finally {
    fs.renameSync = originalRenameSync;
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T10c: confirmConsent cancellation before storage rejects with ABORTED and leaves neverAsk untouched', async () => {
  const { loadConfig } = require('../../src/config.ts');
  const { ToolError } = require('../../src/contracts/error.ts');
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '2.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
          { id: 'gpt-unpriced', efforts: ['low'] },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    const ac = new AbortController();
    const prepared = await prepareTask({ model: 'gpt-unpriced' }, tempDir, { abortSignal: ac.signal });

    await assert.rejects(
      prepared.confirmConsent({
        abortSignal: ac.signal,
        askConsent: async () => {
          // Abort during consent wait before storage
          ac.abort();
          return { approved: true, remember: true };
        },
      }),
      err => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'ABORTED');
        return true;
      }
    );

    assert.ok(!loadConfig().governance.neverAsk.includes('gpt-unpriced'), 'neverAsk must remain untouched when cancelled before storage');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T10c: confirmConsent budget timeout before storage rejects with TIMEOUT and leaves neverAsk untouched', async () => {
  const { loadConfig } = require('../../src/config.ts');
  const { ToolError } = require('../../src/contracts/error.ts');
  const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
  const original = { ...adapterRegistry };
  try {
    adapterRegistry.codex = {
      id: 'codex',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        executionSupported: true,
        version: '2.0.0',
        config: { defaultModel: 'gpt-6.1-sol' },
      }),
      listModels: async () => ({
        source: 'codex-catalog',
        models: [
          { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
          { id: 'gpt-unpriced', efforts: ['low'] },
        ],
      }),
      execute: async () => { throw new Error('Must not execute'); },
    };

    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
    });

    let simulatedTime = 0;
    const budget = createExecutionBudget({
      totalBudgetMs: 50,
      teardownAllowanceMs: 0,
      clock: () => simulatedTime,
    });

    const prepared = await prepareTask({ model: 'gpt-unpriced' }, tempDir, { budget });

    await assert.rejects(
      prepared.confirmConsent({
        budget,
        askConsent: async () => {
          // Advance clock to trigger monotonic deadline expiry before storage
          simulatedTime = 100;
          return { approved: true, remember: true };
        },
      }),
      err => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      }
    );

    assert.ok(!loadConfig().governance.neverAsk.includes('gpt-unpriced'), 'neverAsk must remain untouched when timed out before storage');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('prepareTask reclassifies probe abortion from budget expiration as TIMEOUT', async () => {
  const original = { ...adapterRegistry };
  let simulatedTime = 0;
  const budget = createExecutionBudget({
    totalBudgetMs: 50,
    teardownAllowanceMs: 0,
    clock: () => simulatedTime,
  });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'Codex CLI',
    probe: async (_config, options) => {
      simulatedTime = 60;
      if (options?.context?.abortSignal?.aborted) {
        throw new ToolError('ABORTED', 'Probe cancelled');
      }
      return { installed: true, executionSupported: true, config: { defaultModel: 'gpt-4o' } };
    },
    execute: async () => { throw new Error('Must not execute'); },
  };

  try {
    saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    });

    await assert.rejects(
      prepareTask({ backend: 'codex' }, tempDir, { budget }),
      err => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      }
    );
  } finally {
    budget.dispose();
    Object.assign(adapterRegistry, original);
  }
});
