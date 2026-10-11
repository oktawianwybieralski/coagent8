'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  describeModels,
  lookupName,
  findCatalogEntry,
  checkModelSelection,
} = require('../src/models/catalog.ts');
const { isValidModelIdentifier } = require('../src/models/identifier.ts');
const {
  parsePriceList,
  priceKey,
  matchPrices,
  findPrice,
  checkPriceLimit,
  priceEvidence,
  isPriceListStale,
  PRICE_REFRESH_MS,
  PRICE_STALE_MS,
} = require('../src/models/prices.ts');
const {
  decideConsent,
  consentRequiredMessage,
  consentDeclinedMessage,
  consentUnansweredMessage,
  modelDeniedMessage,
} = require('../src/models/governance.ts');
const {
  catalogDefault,
  catalogNames,
  choosePricedModel,
  listModelCandidates,
} = require('../src/models/selection.ts');
const { selectModel } = require('../src/execution/selection.ts');
const { consentFor } = require('../src/execution/consent.ts');
const {
  resolveBackend,
  resolveBackendForModel,
  providerForClient,
  setCallerProvider,
} = require('../src/execution/routing.ts');

test('S3 models: catalog and identifier rules', () => {
  assert.equal(isValidModelIdentifier('gpt-4o'), true);
  assert.equal(isValidModelIdentifier('-bad'), false);

  assert.equal(lookupName('Anthropic/Claude-3.5-Sonnet'), 'claude-3-5-sonnet');

  const catalog = {
    source: 'test',
    models: [
      { id: 'model-a', efforts: ['low', 'high'], isDefault: true },
      { id: 'model-b', efforts: [], aliases: ['b-alias'] },
      { id: 'model-c', efforts: ['medium'], effortRequired: true },
    ],
  };

  assert.equal(describeModels(catalog.models), 'model-a (low|high), model-b, model-c (medium)');

  const foundA = findCatalogEntry(catalog, 'model-a');
  assert.ok(foundA);
  assert.equal(foundA.name, 'model-a');

  const foundAlias = findCatalogEntry(catalog, 'b-alias');
  assert.ok(foundAlias);
  assert.equal(foundAlias.name, 'model-b');

  const foundSuffixed = findCatalogEntry(catalog, 'model-c-medium');
  assert.ok(foundSuffixed);
  assert.equal(foundSuffixed.name, 'model-c-medium');
  assert.equal(foundSuffixed.suffixEffort, 'medium');

  assert.equal(checkModelSelection('test', catalog, 'model-a', 'low'), null);
  const badEffort = checkModelSelection('test', catalog, 'model-a', 'ultra');
  assert.equal(badEffort?.code, 'INPUT_LIMIT');

  const badModel = checkModelSelection('test', catalog, 'unknown', undefined);
  assert.equal(badModel?.code, 'MODEL_UNAVAILABLE');
});

test('S3 models: prices and governance decisions', () => {
  assert.equal(typeof PRICE_REFRESH_MS, 'number');
  assert.equal(typeof PRICE_STALE_MS, 'number');
  assert.equal(priceKey('GPT-4O'), 'gpt-4o');

  const rawPayload = {
    data: [
      { id: 'model-x', pricing: { completion: '0.000005', prompt: '0.000002', input_cache_read: '0.000001' } },
    ],
  };
  const parsed = parsePriceList(rawPayload);
  assert.ok(parsed && parsed.length === 1);
  assert.equal(parsed[0].id, 'model-x');
  assert.equal(parsed[0].output, 5); // 0.000005 * 1e6

  const matched = matchPrices(parsed, ['model-x']);
  assert.ok(matched['model-x']);
  assert.equal(matched['model-x'].output, 5);

  const priceList = {
    fetchedAt: Date.now(),
    source: 'openrouter',
    models: matched,
  };

  assert.equal(isPriceListStale(priceList), false);
  const evidence = priceEvidence(priceList, 'model-x');
  assert.equal(evidence.outputUsdPerMTok, 5);
  assert.equal(evidence.match, 'exact');

  assert.equal(checkPriceLimit('model-x', evidence, 10), undefined);
  assert.match(checkPriceLimit('model-x', evidence, 4) || '', /costs 5 USD per million output tokens/);

  // Governance decision
  const settings = {
    models: { allow: ['model-never'], ask: ['model-always'], deny: ['model-denied'] },
    askAbovePrice: 20,
    priceMultiplier: 2,
  };

  const decisionPriced = decideConsent('model-x', 'model-x', priceList, settings);
  assert.equal(decisionPriced.ask, false);

  const decisionAlways = decideConsent('model-always', 'model-x', priceList, settings);
  assert.equal(decisionAlways.ask, true);
  assert.equal(decisionAlways.basis, 'ask');

  const decisionNever = decideConsent('model-never', 'model-x', priceList, settings);
  assert.equal(decisionNever.ask, false);
  assert.equal(decisionNever.basis, 'allow');

  const decisionDenied = decideConsent('model-denied', 'model-x', priceList, settings);
  assert.deepEqual([decisionDenied.deny, decisionDenied.ask, decisionDenied.basis], [true, false, 'deny']);
  assert.match(modelDeniedMessage('model-denied'), /^Model 'model-denied' did not run: the user denied it in governance\.models\.deny \(VS Code: coagent8\.approval\.denyModels\)\. Only the user can remove it from that list\. Tell the user; switch to another model only if the user asks\.$/);

  assert.match(consentRequiredMessage('m', 'reason'), /needs the user's approval/);
  assert.match(consentDeclinedMessage('m'), /did not approve/);
  assert.match(consentUnansweredMessage('m', 'reason'), /without an answer/);
  // No form reached the user: name the user's own ways out and forbid the agent from taking them.
  for (const message of [consentRequiredMessage('m', 'reason'), consentUnansweredMessage('m', 'reason')]) {
    assert.match(message, /client that shows MCP forms, or allow it in governance\.models\.allow \(VS Code: coagent8\.approval\.allowModels\); never change that setting yourself\./);
  }
  assert.doesNotMatch(consentDeclinedMessage('m'), /models\.allow/, 'a refusal by the user is not an invitation to allow the model');
});

test('S3 models: pure selection decisions', () => {
  const catalog = {
    source: 'test',
    models: [
      { id: 'default-model', efforts: [], isDefault: true },
      { id: 'other-model', efforts: ['low', 'high'], effortRequired: true },
    ],
  };

  assert.deepEqual(catalogDefault(catalog), { model: 'default-model', source: 'catalog' });
  assert.deepEqual(catalogNames(catalog), ['default-model', 'other-model', 'other-model-low', 'other-model-high']);

  const priceList = {
    fetchedAt: Date.now(),
    source: 'openrouter',
    models: {
      'default-model': { output: 15, input: null, cachedInput: null, matched: 'default-model', exact: true },
      'other-model': { output: 8, input: null, cachedInput: null, matched: 'other-model', exact: true },
    },
  };

  const chosenBelow10 = choosePricedModel(
    'codex',
    catalog,
    { model: 'default-model', source: 'config' },
    { below: 10 },
    priceList
  );
  assert.equal(chosenBelow10.model, 'other-model-low');
  assert.equal(chosenBelow10.source, 'price-limit');
  // A denied model is never chosen for a limit, by id or by the variant it would run as.
  assert.throws(() => choosePricedModel('codex', catalog, { model: 'default-model', source: 'config' }, { below: 10 }, priceList, ['other-model']),
    { code: 'PRICE_LIMIT', message: /and not denied by the user has a verified price below the limit/ });
  assert.throws(() => choosePricedModel('codex', catalog, { model: 'default-model', source: 'config' }, { below: 10 }, priceList, ['other-model-low']), { code: 'PRICE_LIMIT' });
  assert.throws(() => choosePricedModel('codex', catalog, { model: 'default-model', source: 'config' }, { below: 20 }, priceList, ['default-model', 'other-model']),
    { code: 'PRICE_LIMIT', message: /Default: 'default-model' is denied by the user\./ });

  const settings = { models: { allow: [], ask: [], deny: [] }, askAbovePrice: 20, priceMultiplier: 2 };
  const candidates = listModelCandidates('codex', catalog, { model: 'default-model', source: 'config' }, priceList, settings);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].model, 'default-model');
  assert.equal(candidates[0].defaultSource, 'config');
  assert.equal(candidates[1].model, 'other-model');
});

test('S3 execution routing: client mapping and caller preservation', () => {
  assert.equal(providerForClient('claude-desktop'), 'claude');
  assert.equal(providerForClient('codex-app'), 'codex');
  assert.equal(providerForClient('antigravity'), 'agy');
  assert.equal(providerForClient('unknown-client'), null);

  setCallerProvider('claude');
  setCallerProvider(null);
  assert.equal(typeof resolveBackend, 'function');
  assert.equal(typeof resolveBackendForModel, 'function');
});

test('S3 boundaries: models/ has zero dependencies on backends/ or execution/', () => {
  const root = path.resolve(__dirname, '..');
  const modelsDir = path.join(root, 'src', 'models');
  const files = fs.readdirSync(modelsDir, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.ts'))
    .map(f => path.join(modelsDir, f));

  assert.ok(files.length >= 6, `Expected at least 6 models files, found ${files.length}`);

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
    for (const match of importMatches) {
      const specifier = match[1];
      assert.ok(
        !specifier.includes('backends') && !specifier.includes('execution') && !specifier.includes('mcp'),
        `Forbidden dependency in ${path.relative(root, file)}: ${specifier}`
      );
    }
  }

  // Ensure backends has zero imports from application routing or selection orchestration
  const backendsDir = path.join(root, 'src', 'backends');
  const backendFiles = fs.readdirSync(backendsDir, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.ts'))
    // Exclude compatibility shims which deliberately forward to canonical execution files
    .filter(f => !['routing.ts', 'consent.ts', 'model-selection.ts'].includes(path.basename(f)))
    .map(f => path.join(backendsDir, f));

  for (const file of backendFiles) {
    const code = fs.readFileSync(file, 'utf8');
    const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
    for (const match of importMatches) {
      const specifier = match[1];
      assert.ok(
        !specifier.includes('execution/routing') &&
        !specifier.includes('execution/selection') &&
        !specifier.includes('execution/consent') &&
        !specifier.includes('execution/controller'),
        `Forbidden execution orchestration import in ${path.relative(root, file)}: ${specifier}`
      );
    }
  }
});
