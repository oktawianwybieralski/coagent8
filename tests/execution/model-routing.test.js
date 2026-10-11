'use strict';

// A named model with backend auto runs on a backend whose CLI lists it (fixture CLIs; agy
// lists claude-sonnet-4-6 too, as agy 1.3.1 does).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-model-routing-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

const original = { codex: adapterRegistry.codex, agy: adapterRegistry.agy, claude: adapterRegistry.claude };
const runs = [];
function fixture(id, catalog, extra = {}) {
  return {
    id, name: 'fixture',
    probe: async () => ({ id, installed: true, executionSupported: true, version: 'fixture', authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true } }),
    listModels: async () => catalog,
    inspectQuota: async () => undefined,
    execute: async (_prompt, options) => {
      runs.push({ backend: id, model: options.model });
      return { status: 'completed', isError: false, output: 'answer', nativeSessionId: `${id}-native`, model: options.model, truncated: false, continuationAvailable: true };
    },
    ...extra,
  };
}
adapterRegistry.codex = fixture('codex', { source: 'codex', models: [{ id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true }, { id: 'gpt-6-luna', efforts: ['low'] }] });
adapterRegistry.agy = fixture('agy', { source: 'agy', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }, { id: 'claude-sonnet-4-6', efforts: [] }] });
adapterRegistry.claude = fixture('claude', { source: 'claude', acceptsUnlisted: true, models: [{ id: 'claude-sonnet-4-6', efforts: [], aliases: ['sonnet', 'default'], isDefault: true }] },
  { observeModel: async requested => requested });
const config = (changes = {}) => saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'agy', 'claude'] }, backends: { codex: {}, agy: {}, claude: {} },
  governance: { models: { allow: ['gpt-6.1-sol', 'gpt-6-luna', 'gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-1'] } }, ...changes });
const run = args => executeTask('x', 'x', args, tempDir).then(readResult);

test.after(() => {
  Object.assign(adapterRegistry, original);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('auto runs a named model on the backend that lists it, in the exact listed form', async () => {
  await config();
  const agy = await run({ model: 'gemini-3.8-flash-high' });
  assert.deepEqual([agy.provider, agy.model], ['agy', 'gemini-3.8-flash-high']);
  const codex = await run({ model: 'GPT-6-1-SOL' });
  assert.deepEqual([codex.provider, codex.model], ['codex', 'gpt-6.1-sol'], 'case and dots do not matter; the listed id runs');
  const alias = await run({ model: 'sonnet' });
  assert.deepEqual([alias.provider, alias.model], ['claude', 'claude-sonnet-4-6'], 'an alias only Claude lists runs on Claude as its concrete model');
});

test('a configured default backend is kept when it lists the model and does not block one it lacks', async () => {
  await config({ defaultBackend: 'codex' });
  assert.equal((await run({ model: 'gemini-3.8-flash-high' })).provider, 'agy');
  assert.equal((await run({})).provider, 'codex', 'without a model the default backend runs');
  await config({ defaultBackend: 'agy' });
  assert.equal((await run({ model: 'claude-sonnet-4-6' })).provider, 'agy', 'both list it; the configured default wins');
  await config({ defaultBackend: 'claude' });
  assert.equal((await run({ model: 'claude-sonnet-4-6' })).provider, 'claude');
});

test('an unlisted name goes to a CLI that runs unlisted models; otherwise each backend says it does not offer it', async () => {
  await config();
  const unlisted = await run({ model: 'claude-opus-4-1' });
  assert.deepEqual([unlisted.provider, unlisted.model], ['claude', 'claude-opus-4-1']);
  await config({ routing: { strategy: 'fixed', allowedBackends: ['codex', 'agy'] } });
  await assert.rejects(executeTask('x', 'x', { model: 'gpt-7-nova' }, tempDir),
    { code: 'MODEL_UNAVAILABLE', message: /^codex: does not list 'gpt-7-nova'; doctor lists its models\. agy: does not list 'gpt-7-nova'/ });
});

test('an explicit backend is never replaced; its catalog reports a model it does not offer', async () => {
  await config();
  runs.length = 0;
  await assert.rejects(executeTask('x', 'x', { backend: 'codex', model: 'gemini-3.8-flash-high' }, tempDir), { code: 'MODEL_UNAVAILABLE', message: /not offered by codex/ });
  assert.deepEqual(runs, []);
});
