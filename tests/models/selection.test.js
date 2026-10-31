const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-model-selection-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { readModelCatalog } = require('../../src/backends/probe-cache.ts');
const { selectModel } = require('../../src/execution/selection.ts');
const { saveConfig, loadConfig } = require('../../src/config.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { runDoctor, formatDoctorSummary } = require('../../src/diagnostics/doctor.ts');
const { readResult } = require('../helpers/result.cjs');

const storeFile = path.join(tempDir, 'models.json');
const original = { ...adapterRegistry };
const AGY_CATALOG = { source: 'agy models', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'medium', 'low'], effortRequired: true }, { id: 'gemini-3.1-pro', efforts: ['high', 'low'], effortRequired: true }] };
const CODEX_CATALOG = { source: 'codex app-server model/list', models: [{ id: 'gpt-5.6-luna', efforts: ['low'] }, { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true }] };

test.afterEach(() => { Object.assign(adapterRegistry, original); });
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function stub(id, fields = {}) {
  return { id, name: 'fixture', probe: async () => ({ installed: true, version: 'fixture', executionSupported: true, capabilities: { readOnlyVerified: true } }), execute: async () => { throw new Error('not executed'); }, ...fields };
}
const resetConfig = () => saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'agy'] }, backends: { codex: {}, claude: {}, agy: {} } });

test('a catalog read from the CLI is kept in models.json for later processes, keyed by installation and age', async () => {
  fs.rmSync(storeFile, { force: true });
  let reads = 0;
  const list = async () => { reads++; return AGY_CATALOG; };
  adapterRegistry.agy = stub('agy', { listModels: list });
  process.env.GEMINI_API_KEY = 'secret-credential-value';
  try {
    assert.deepEqual(await readModelCatalog('agy'), AGY_CATALOG);
    assert.equal(reads, 1);
    const stored = fs.readFileSync(storeFile, 'utf8');
    assert.ok(!stored.includes('secret-credential-value'), 'the store holds a hash of the environment, never its values');
    // A later server process: nothing in memory, the store answers without the CLI.
    adapterRegistry.agy = stub('agy', { listModels: async () => { reads++; return AGY_CATALOG; } });
    assert.deepEqual(await readModelCatalog('agy'), AGY_CATALOG);
    assert.equal(reads, 1, 'no second CLI read');
    // Another installation (a changed credential variable) reads the CLI again.
    process.env.GEMINI_API_KEY = 'another-credential';
    adapterRegistry.agy = stub('agy', { listModels: async () => { reads++; return AGY_CATALOG; } });
    await readModelCatalog('agy');
    assert.equal(reads, 2);
    // A catalog older than a day is read again.
    const old = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    old.backends.agy.catalog.observedAt = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(storeFile, JSON.stringify(old));
    adapterRegistry.agy = stub('agy', { listModels: async () => { reads++; return AGY_CATALOG; } });
    await readModelCatalog('agy');
    assert.equal(reads, 3);
    // An unreadable store is a miss and is rewritten.
    fs.writeFileSync(storeFile, '{not json');
    adapterRegistry.agy = stub('agy', { listModels: async () => { reads++; return AGY_CATALOG; } });
    await readModelCatalog('agy');
    assert.equal(reads, 4);
    assert.equal(JSON.parse(fs.readFileSync(storeFile, 'utf8')).schemaVersion, 3);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('the model comes from the call, the session, config.json, the CLI configuration, its catalog or what it reports; never from the bridge', async () => {
  await resetConfig();
  const probe = { installed: true, version: 'fixture' };
  adapterRegistry.codex = stub('codex', { listModels: async () => CODEX_CATALOG });
  adapterRegistry.agy = stub('agy', { listModels: async () => AGY_CATALOG });
  adapterRegistry.claude = stub('claude', { observeModel: async requested => ({ '': 'claude-observed-default', sonnet: 'claude-observed-sonnet' })[requested ?? ''] });
  assert.deepEqual(await selectModel('codex', probe, { model: 'gpt-5.6-luna', session: 'gpt-6.1-sol' }), { model: 'gpt-5.6-luna', source: 'request' });
  assert.deepEqual(await selectModel('codex', probe, { session: 'gpt-5.6-luna' }), { model: 'gpt-5.6-luna', source: 'session' });
  assert.deepEqual(await selectModel('codex', { ...probe, config: { defaultModel: 'gpt-from-config-toml' } }), { model: 'gpt-from-config-toml', source: 'cli-config' });
  assert.deepEqual(await selectModel('codex', probe), { model: 'gpt-6.1-sol', source: 'catalog' }, "the catalog's declared default");
  assert.deepEqual(await selectModel('agy', probe), { model: 'gemini-3.8-flash-high', source: 'first-listed' }, 'the first model agy lists, with its effort');
  assert.deepEqual(await selectModel('claude', probe), { model: 'claude-observed-default', source: 'observed' });
  assert.deepEqual(await selectModel('claude', probe, { model: 'sonnet' }), { model: 'claude-observed-sonnet', source: 'request' }, 'an alias becomes the model the CLI reports');
  await assert.rejects(selectModel('claude', probe, { model: 'unreported' }), { code: 'MODEL_UNAVAILABLE' }, 'an unresolved name is refused, not governed by its spelling');
  await saveConfig({ backends: { agy: { defaultModel: 'gemini-3.1-pro-low' } } });
  assert.deepEqual(await selectModel('agy', probe), { model: 'gemini-3.1-pro-low', source: 'config' });
  adapterRegistry.agy = stub('agy');
  await saveConfig({ backends: { agy: {} } });
  await assert.rejects(selectModel('agy', probe), { code: 'MODEL_UNAVAILABLE' }, 'no source, no model');
});

test('the first doctor records a default the CLI does not state itself in config.json and says so', async () => {
  await resetConfig();
  fs.rmSync(storeFile, { force: true });
  adapterRegistry.codex = stub('codex', { listModels: async () => CODEX_CATALOG });
  adapterRegistry.agy = stub('agy', { listModels: async () => AGY_CATALOG });
  adapterRegistry.claude = stub('claude', { observeModel: async requested => requested ?? 'claude-observed-default' });
  const first = await runDoctor({ quota: false });
  assert.deepEqual(first.defaultModels.agy, { model: 'gemini-3.8-flash-high', source: 'first-listed', recorded: true });
  assert.deepEqual(first.defaultModels.claude, { model: 'claude-observed-default', source: 'observed', recorded: true, asks: true });
  assert.deepEqual(first.defaultModels.codex, { model: 'gpt-6.1-sol', source: 'catalog' }, "Codex's declared default is not pinned");
  assert.match(formatDoctorSummary(first), /agy: [^\n]* - model gemini-3\.8-flash-high \(first listed, recorded in config\.json\)/);
  assert.deepEqual(loadConfig().backends, { codex: {}, claude: { defaultModel: 'claude-observed-default' }, agy: { defaultModel: 'gemini-3.8-flash-high' } });
  // A later catalog order no longer moves the default.
  adapterRegistry.agy = stub('agy', { listModels: async () => ({ ...AGY_CATALOG, models: [...AGY_CATALOG.models].reverse() }) });
  const second = await runDoctor({ quota: false });
  assert.deepEqual(second.defaultModels.agy, { model: 'gemini-3.8-flash-high', source: 'config' });
  assert.match(formatDoctorSummary(second), /model gemini-3\.8-flash-high \(config\.json\)/);
});

test('a Claude turn runs the model Claude Code reports for its name, so consent covers what actually runs', async () => {
  await resetConfig();
  const capture = path.join(tempDir, 'claude-capture.json');
  process.env.CLAUDE_FIXTURE_CAPTURE = capture;
  // As ANTHROPIC_DEFAULT_SONNET_MODEL does: the alias runs a top-tier model.
  process.env.CLAUDE_FIXTURE_MODELS = JSON.stringify({ sonnet: 'claude-opus-4-6' });
  try {
    await assert.rejects(executeTask('p', 'q', { backend: 'claude', model: 'sonnet' }, tempDir), { code: 'POLICY_DENIED', message: /claude-opus-4-6/ });
    fs.rmSync(capture, { force: true });
    const plain = readResult(await executeTask('p', 'q', { backend: 'claude' }, tempDir));
    assert.equal(plain.error, null, plain.text);
    const { argv } = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(argv[argv.indexOf('--model') + 1], 'claude-sonnet-4-6', "the account default Claude Code reported, passed explicitly");
  } finally {
    delete process.env.CLAUDE_FIXTURE_CAPTURE;
    delete process.env.CLAUDE_FIXTURE_MODELS;
  }
});
