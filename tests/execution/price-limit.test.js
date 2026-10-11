'use strict';

// AX-002: a user's price limit through the execution controller, with fixture CLIs and the
// recorded price list (gpt-6-sol 10, gpt-6-luna 0.5, gpt-5.6-luna 1.2, gpt-6-astra 50,
// gemini-3.8-flash 3.75 USD per million output tokens).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-execution-price-limit-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { saveConfig } = require('../../src/config.ts');
const { readStoredPrices, recordPrices } = require('../../src/models/store.ts');
const { readModelCatalog } = require('../../src/backends/probe-cache.ts');
const { readResult } = require('../helpers/result.cjs');

const original = { codex: adapterRegistry.codex, agy: adapterRegistry.agy };
const runs = [];
function fixture(id, models) {
  return {
    id, name: 'fixture',
    probe: async () => ({ id, installed: true, executionSupported: true, version: 'fixture', authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true } }),
    listModels: async () => ({ source: `${id} fixture`, models }),
    inspectQuota: async () => undefined,
    execute: async (_prompt, options) => {
      runs.push({ backend: id, model: options.model, effort: options.reasoningEffort });
      return { status: 'completed', isError: false, output: 'answer', nativeSessionId: `${id}-native`, model: options.model, truncated: false, continuationAvailable: true };
    },
  };
}
const codexModels = ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol-preview', 'gpt-7-nova']
  .map((id, index) => ({ id, efforts: ['low', 'high'], ...(index === 0 ? { isDefault: true } : {}) }));
adapterRegistry.codex = fixture('codex', codexModels);
adapterRegistry.agy = fixture('agy', [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }]);
const config = (changes = {}) => saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'agy'] }, backends: { codex: {}, agy: {} }, ...changes });
const run = args => executeTask('x', 'x', args, tempDir);
const approve = { askConsent: async () => ({ approved: true }) };

test.after(() => {
  Object.assign(adapterRegistry, original);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('an explicit model must have a verified price below the limit; it is never replaced', async () => {
  await config();
  runs.length = 0;
  await assert.rejects(run({ backend: 'codex', model: 'gpt-6-sol', output_price_below: 5 }),
    { code: 'PRICE_LIMIT', message: /^'gpt-6-sol' costs 10 USD per million output tokens \(coagent8_PRICES_URL list of \d{4}-\d{2}-\d{2}\), not below 5 USD per million output tokens\. It was not replaced by another model/ });
  await assert.rejects(run({ backend: 'codex', model: 'gpt-6-sol-preview', output_price_below: 100 }), { code: 'PRICE_LIMIT', message: /only approximately/ });
  await assert.rejects(run({ backend: 'codex', model: 'gpt-7-nova', output_price_below: 100 }), { code: 'PRICE_LIMIT', message: /has no price for 'gpt-7-nova'/ });
  // models.allow exempts a model from approval, not from the user's limit.
  await config({ governance: { models: { allow: ['gpt-6-sol', 'gpt-7-nova'] } } });
  await assert.rejects(run({ backend: 'codex', model: 'gpt-6-sol', output_price_below: 5 }), { code: 'PRICE_LIMIT' });
  await assert.rejects(run({ backend: 'codex', model: 'gpt-7-nova', output_price_below: 5 }), { code: 'PRICE_LIMIT' });
  assert.deepEqual(runs, [], 'no turn ran');
});

test('the boundary is strict, and the footer states the price evidence', async () => {
  await config();
  runs.length = 0;
  await assert.rejects(run({ backend: 'codex', model: 'gpt-6-luna', output_price_below: 0.5 }), { code: 'PRICE_LIMIT', message: /not below 0\.5 USD/ });
  const result = readResult(await run({ backend: 'codex', model: 'gpt-6-luna', output_price_below: 0.51 }));
  assert.equal(result.model, 'gpt-6-luna');
  assert.match(result.price, /^0\.5 USD per million output tokens \(coagent8_PRICES_URL \d{4}-\d{2}-\d{2}, exact\), below the limit of 0\.51 USD$/);
  assert.equal(readResult(await run({ backend: 'codex', model: 'gpt-6-luna' })).price, null, 'an unconstrained call stays as it was');
  assert.equal(runs.length, 2);
});

test('without a model, auto takes the highest-priced qualifying model of the backend and keeps a qualifying default', async () => {
  await config();
  runs.length = 0;
  const cheaper = readResult(await run({ backend: 'codex', output_price_below: 5 }));
  assert.equal(cheaper.model, 'gpt-5.6-luna', '1.2 is the highest price below 5; the default costs 10');
  assert.equal(readResult(await run({ backend: 'codex', output_price_below: 1 })).model, 'gpt-6-luna');
  assert.equal(readResult(await run({ backend: 'codex', output_price_below: 20 })).model, 'gpt-6-sol', 'the default meets the limit');
  // A config change between discovery and execution is read again: the new default qualifies.
  await config({ backends: { codex: { defaultModel: 'gpt-6-luna' }, agy: {} } });
  assert.equal(readResult(await run({ backend: 'codex', output_price_below: 5 })).model, 'gpt-6-luna');
});

test('auto routing chooses only among backends with a qualifying model and says why none has one', async () => {
  // The catalog changes as doctor would observe it: read afresh, replacing the cached one.
  adapterRegistry.codex = fixture('codex', [codexModels[0]]);
  await readModelCatalog('codex', { fresh: true });
  try {
    await config();
    runs.length = 0;
    const result = readResult(await run({ output_price_below: 5 }));
    assert.deepEqual([result.provider, result.model], ['agy', 'gemini-3.8-flash-high'], 'codex offers only its 10 USD default');
    await assert.rejects(run({ output_price_below: 0.1 }), { code: 'PRICE_LIMIT', message: /^codex: No codex model has a verified price below 0\.1 .* agy: No agy model has a verified price below 0\.1 / });
    await assert.rejects(run({ backend: 'codex', output_price_below: 5 }), { code: 'PRICE_LIMIT', message: /^No codex model/ }, 'an explicit backend is not left for another');
    assert.equal(runs.length, 1);
  } finally {
    adapterRegistry.codex = fixture('codex', codexModels);
    await readModelCatalog('codex', { fresh: true });
  }
});

test('a continuation is checked for the model it runs, the session\'s or a newly named one', async () => {
  await config();
  const first = readResult(await run({ backend: 'codex', model: 'gpt-6-luna', output_price_below: 1 }));
  await assert.rejects(run({ session_handle: first.sessionHandle, model: 'gpt-6-sol', output_price_below: 1 }), { code: 'PRICE_LIMIT', message: /'gpt-6-sol' costs 10/ });
  const resumed = readResult(await run({ session_handle: first.sessionHandle, output_price_below: 1 }));
  assert.deepEqual([resumed.model, resumed.turn], ['gpt-6-luna', 2]);
  await assert.rejects(run({ session_handle: first.sessionHandle, output_price_below: 0.5 }), { code: 'PRICE_LIMIT' }, 'the session\'s model is not swapped for a cheaper one');
});

test('the price is checked again after the user approves, right before the turn', async () => {
  await config({ governance: { models: { ask: ['gpt-6-luna'] } } });
  runs.length = 0;
  const stored = readStoredPrices();
  try {
    let asked = 0;
    const ok = await executeTask('x', 'x', { backend: 'codex', model: 'gpt-6-luna', output_price_below: 1 }, tempDir, null, null, { askConsent: async () => { asked++; return { approved: true }; } });
    assert.equal(readResult(ok).model, 'gpt-6-luna');
    assert.equal(asked, 1, 'an approval rule still applies to a model within the limit');
    const raised = { askConsent: async () => {
      await recordPrices({ ...stored, fetchedAt: Date.now(), models: { ...stored.models, 'gpt-6-luna': { ...stored.models['gpt-6-luna'], output: 2 } } });
      return { approved: true };
    } };
    await assert.rejects(executeTask('x', 'x', { backend: 'codex', model: 'gpt-6-luna', output_price_below: 1 }, tempDir, null, null, raised), { code: 'PRICE_LIMIT', message: /costs 2 USD/ });
    assert.equal(runs.length, 1, 'the second turn did not run');
    await assert.rejects(executeTask('x', 'x', { backend: 'codex', model: 'gpt-6-sol', output_price_below: 5 }, tempDir, null, null, approve), { code: 'PRICE_LIMIT' }, 'approval cannot satisfy a limit');
  } finally {
    await recordPrices(stored);
  }
});
