'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-model-catalog-'));
process.env.coagent8_DIR = directory;
process.env.CODEX_PATH = path.resolve(__dirname, '../fixtures/codex-cli/codex.cjs');
process.env.CODEX_CONFIG_PATH = path.join(directory, 'config.toml');
process.env.AGY_PATH = path.resolve(__dirname, '../fixtures/agy-cli/agy.cjs');
process.env.GEMINI_CLI_HOME = path.join(directory, 'gemini-home');

const { checkModelSelection } = require('../../src/models/catalog.ts');
const { listCodexModels, parseCodexModelPage } = require('../../src/backends/codex/models.ts');
const { VALID_REASONING_EFFORTS: CODEX_EFFORTS } = require('../../src/backends/codex/adapter.ts');
const { listModels: listAgyModels, parseAgyModels } = require('../../src/backends/agy/adapter.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('agy models are grouped by effort, as agy accepts them', () => {
  const models = parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
  assert.deepEqual(models, [
    { id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true },
    { id: 'claude-sonnet-4-6', efforts: [] },
  ]);
});

test('Codex model/list keeps visible models with the efforts the bridge passes on, and the default', () => {
  const page = parseCodexModelPage({ nextCursor: 'next', data: [
    { id: 'gpt-6.1-sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
    { id: 'gpt-internal', hidden: true, supportedReasoningEfforts: [] },
  ] }, CODEX_EFFORTS);
  assert.deepEqual(page, { models: [{ id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true }], nextCursor: 'next' }, 'an effort the bridge does not pass on is not offered');
});

test('the catalog is read from the CLI itself: Codex app-server model/list and agy models', async () => {
  const codex = await listCodexModels(process.env.CODEX_PATH, CODEX_EFFORTS);
  assert.equal(codex.source, 'codex app-server model/list');
  assert.deepEqual(codex.models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna'], 'hidden models are not offered');
  const agy = await listAgyModels();
  assert.equal(agy.source, 'agy models');
  assert.deepEqual(agy.models.find(model => model.id === 'gemini-3.8-flash'), { id: 'gemini-3.8-flash', efforts: ['high', 'medium', 'low'], effortRequired: true });
});

test('a model or effort the CLI does not offer is refused with the accepted values (live failures of 2026-10-07)', async () => {
  const codex = await listCodexModels(process.env.CODEX_PATH, CODEX_EFFORTS);
  const agy = await listAgyModels();

  const luna = checkModelSelection('codex', codex, 'luna', undefined);
  assert.equal(luna.code, 'MODEL_UNAVAILABLE');
  assert.match(luna.message, /Model 'luna' is not offered by codex\. Use one of: .*gpt-5\.6-luna \(low\|medium\|high\|xhigh\|max\)/);
  assert.equal(checkModelSelection('codex', codex, 'gpt-5.6-luna', 'low'), null);
  const minimal = checkModelSelection('codex', codex, 'gpt-5.6-luna', 'minimal');
  assert.equal(minimal.code, 'INPUT_LIMIT');
  assert.match(minimal.message, /accepts reasoning_effort low, medium, high, xhigh, max, not 'minimal'/);

  const flash = checkModelSelection('agy', agy, 'gemini-3.8-flash', undefined);
  assert.equal(flash.code, 'INPUT_LIMIT');
  assert.equal(flash.message, "agy model 'gemini-3.8-flash' needs reasoning_effort (high, medium, low), or name it with the effort, for example 'gemini-3.8-flash-high'.");
  assert.equal(checkModelSelection('agy', agy, 'gemini-3.8-flash', 'low'), null);
  assert.equal(checkModelSelection('agy', agy, 'gemini-3.8-flash-high', undefined), null, 'the listed identifier carries its effort');
  assert.equal(checkModelSelection('agy', agy, 'gemini-3.8-flash-high', 'low'), null, 'an explicit effort replaces the suffix');
  assert.equal(checkModelSelection('agy', agy, 'gemini-3.1-pro', 'medium').code, 'INPUT_LIMIT', 'Pro offers high and low only');
  assert.equal(checkModelSelection('agy', agy, 'claude-sonnet-4-6', 'high').code, 'INPUT_LIMIT', 'a model without effort variants takes none');
  assert.equal(checkModelSelection('agy', agy, 'claude-sonnet-4-6', undefined), null);

  assert.equal(checkModelSelection('codex', undefined, 'gpt-7-new', 'low'), null, 'without a catalog nothing is refused');
});

test('the controller refuses an unoffered model before any model call, and the default selection reads no catalog', async () => {
  const original = adapterRegistry.agy;
  let executed = 0, listed = 0;
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'gemini-3.8-flash-high' } }),
    listModels: async () => { listed++; return { source: 'fixture', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] }; },
    execute: async () => { executed++; return { status: 'completed', isError: false, output: 'ok', model: 'gemini-3.8-flash-high', truncated: false, continuationAvailable: false }; } };
  try {
    saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    await assert.rejects(executeTask('x', 'x', { model: 'gemini-3.8-flash' }, directory), error => error.code === 'INPUT_LIMIT' && /needs reasoning_effort \(high, low\)/.test(error.message));
    await assert.rejects(executeTask('x', 'x', { model: 'luna' }, directory), error => error.code === 'MODEL_UNAVAILABLE');
    assert.equal(executed, 0, 'no backend ran');
    assert.equal(readResult(await executeTask('x', 'x', { model: 'gemini-3.8-flash', reasoning_effort: 'low' }, directory)).answer, 'ok');
    const reads = listed;
    assert.equal(readResult(await executeTask('x', 'x', {}, directory)).answer, 'ok');
    assert.equal(listed, reads, 'the default selection needs no catalog');
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a catalog finds a model by id or alias in lookup form and returns the exact listed name, never an approximation', () => {
  const { findCatalogEntry, checkModelSelection } = require('../../src/models/catalog.ts');
  const catalog = { source: 'x', models: [{ id: 'gpt-6.1-sol', efforts: ['low'] }, { id: 'claude-sonnet-5-5', efforts: ['low'], aliases: ['sonnet', 'default'] }, { id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] };
  assert.equal(findCatalogEntry(catalog, 'gpt-6-1-sol').name, 'gpt-6.1-sol', 'dots and dashes are one name');
  assert.equal(findCatalogEntry(catalog, 'openai/GPT-6.1-Sol').name, 'gpt-6.1-sol', 'case and a provider prefix do not matter');
  assert.equal(findCatalogEntry(catalog, 'Sonnet').name, 'claude-sonnet-5-5', 'an alias names its concrete model');
  assert.deepEqual(findCatalogEntry(catalog, 'gemini-3.8-flash-HIGH'), { entry: catalog.models[2], suffixEffort: 'high', name: 'gemini-3.8-flash-high' });
  assert.equal(findCatalogEntry(catalog, 'gpt-6.1'), undefined, 'a prefix is not a match');
  assert.equal(findCatalogEntry(catalog, 'gpt-6.1-sol-preview'), undefined, 'an extension is not a match');
  assert.equal(checkModelSelection('codex', catalog, 'gpt-7', undefined).code, 'MODEL_UNAVAILABLE');
  assert.equal(checkModelSelection('claude', { ...catalog, acceptsUnlisted: true }, 'claude-opus-4-1', undefined), null, 'a CLI that runs unlisted models decides itself');
});
