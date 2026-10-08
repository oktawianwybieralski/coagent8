'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-price-limit-'));
process.env.coagent8_DIR = tempDir;

const { checkPriceLimit, isPriceListStale, matchPrices, parsePriceList, priceEvidence, readPrices, PRICE_STALE_MS } = require('../../src/models/prices.ts');
const { recordPrices } = require('../../src/models/store.ts');
const { choosePricedModel, listModelCandidates } = require('../../src/models/selection.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const now = Date.now();
const listed = [['openai/gpt-6-sol', 10], ['openai/gpt-6-luna', 0.5], ['openai/gpt-5.6-luna', 1.2], ['openai/gpt-6-terra', 4.9999],
  ['google/gemini-3.8-flash', 3.75], ['google/gemini-3.1-pro-preview', 12], ['anthropic/claude-haiku-4.5', 5], ['other/gpt-6-luna', 0.7]]
  .map(([id, output]) => ({ id, output, input: null, cachedInput: null }));
const offered = ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-terra', 'gpt-6-astra', 'mystery', 'gemini-3.1-pro-low', 'claude-haiku-4-5[1m]', 'claude-haiku-4-5',
  'gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-max', 'claude-haiku-4-5-20251001'];
const list = { fetchedAt: now, source: 'openrouter', models: matchPrices(listed, offered) };
const settings = { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] };

test('the limit is strict: a model priced at exactly the limit does not meet it (AX-002)', () => {
  const luna = priceEvidence(list, 'gpt-6-luna', now);
  assert.equal(luna.outputUsdPerMTok, 0.7, 'among several exact entries the highest price counts');
  assert.match(checkPriceLimit('gpt-6-luna', luna, 0.7), /'gpt-6-luna' costs 0\.7 USD per million output tokens \(openrouter list of \d{4}-\d{2}-\d{2}\), not below 0\.7 USD/);
  assert.equal(checkPriceLimit('gpt-6-luna', luna, 0.7001), undefined);
  assert.equal(checkPriceLimit('gpt-6-terra', priceEvidence(list, 'gpt-6-terra', now), 5), undefined, '4.9999 is below 5');
  assert.ok(checkPriceLimit('claude-haiku-4-5', priceEvidence(list, 'claude-haiku-4-5', now), 5), '5 is not below 5');
  assert.ok(checkPriceLimit('gpt-6-luna', luna, 0), 'nothing is below 0');
});

test('unknown, approximate, missing and stale prices never meet a limit, however high', () => {
  assert.match(checkPriceLimit('mystery', priceEvidence(list, 'mystery', now), 1000), /has no price for 'mystery'/);
  const approximate = priceEvidence(list, 'gemini-3.1-pro-low', now);
  assert.equal(approximate.match, 'approximate');
  assert.match(checkPriceLimit('gemini-3.1-pro-low', approximate, 1000), /only approximately, as google\/gemini-3\.1-pro-preview at 12 USD/);
  const variant = priceEvidence(list, 'claude-haiku-4-5[1m]', now);
  assert.equal(variant.match, 'approximate', 'a context variant may be priced differently');
  assert.ok(checkPriceLimit('claude-haiku-4-5[1m]', variant, 1000));
  assert.match(checkPriceLimit('gpt-6-luna', priceEvidence(undefined, 'gpt-6-luna', now), 1000), /No price list is available/);
  const old = { ...list, fetchedAt: now - PRICE_STALE_MS };
  assert.equal(isPriceListStale(old, now), true);
  assert.equal(isPriceListStale({ ...list, fetchedAt: now - PRICE_STALE_MS + 1000 }, now), false);
  assert.match(checkPriceLimit('gpt-6-luna', priceEvidence(old, 'gpt-6-luna', now), 1000), /older than seven days/);
});

test('aliases match exactly through effort and date suffixes; the evidence names the list entry', () => {
  assert.deepEqual({ ...priceEvidence(list, 'gemini-3.8-flash-high', now), fetchedAt: undefined },
    { outputUsdPerMTok: 3.75, inputUsdPerMTok: null, cachedInputUsdPerMTok: null, matched: 'google/gemini-3.8-flash', match: 'exact', source: 'openrouter', fetchedAt: undefined, stale: false });
  assert.equal(priceEvidence(list, 'claude-haiku-4-5-20251001', now).match, 'exact');
  assert.equal(priceEvidence(list, 'claude-haiku-4-5-20251001', now).outputUsdPerMTok, 5);
});

test('invalid price fields are left out of a list, never read as a price', () => {
  const entries = parsePriceList({ data: [
    { id: 'a/ok', pricing: { completion: '0.000002' } },
    { id: 'a/text', pricing: { completion: 'abc' } },
    { id: 'a/negative', pricing: { completion: '-0.000001' } },
    { id: 'a/missing', pricing: {} },
    { id: 'a/null', pricing: { completion: null } },
    { id: 'a/empty', pricing: { completion: ' ' } },
    { id: 'a/object', pricing: { completion: {} } },
    { id: 'a/numeric', pricing: { completion: 0.0000001 } },
    { id: '-option-like', pricing: { completion: '0.000001' } },
  ] });
  assert.deepEqual(entries.map(entry => [entry.id, entry.output]), [['a/ok', 2], ['a/numeric', 0.1]], 'null or empty is no price, not a free model');
  assert.deepEqual(parsePriceList({ data: [{ id: 'a/x', pricing: { completion: '0.000004', prompt: '', input_cache_read: '0.0000001' } }] }),
    [{ id: 'a/x', output: 4, input: null, cachedInput: 0.1 }], 'an empty input price is unknown, not free');
});

test('a turn with a limit reads a stale list again and keeps it stale when the source fails', async () => {
  const previous = process.env.coagent8_PRICES_URL;
  try {
    await recordPrices({ fetchedAt: now - PRICE_STALE_MS - 1000, source: 'openrouter', models: { 'gpt-6-luna': { output: 0.5, input: null, cachedInput: null, matched: 'openai/gpt-6-luna', exact: true } } });
    process.env.coagent8_PRICES_URL = path.join(tempDir, 'missing-price-list.json');
    const stale = await readPrices({ current: true, models: ['gpt-6-luna'] });
    assert.equal(isPriceListStale(stale), true, 'the failed read leaves the stale list, which meets no limit');
    assert.match(checkPriceLimit('gpt-6-luna', priceEvidence(stale, 'gpt-6-luna'), 5), /older than seven days and could not be read again/);
  } finally {
    process.env.coagent8_PRICES_URL = previous;
  }
});

const codexCatalog = { source: 'model/list', models: [
  { id: 'gpt-6-sol', efforts: ['low', 'high'], isDefault: true }, { id: 'gpt-6-luna', efforts: ['low', 'high'] },
  { id: 'gpt-5.6-luna', efforts: ['low', 'high'] }, { id: 'gpt-6-astra', efforts: ['low', 'high'] }, { id: 'gemini-3.1-pro-low', efforts: [] },
] };

test('auto under a limit keeps a qualifying default, else takes the highest-priced qualifying catalog model', () => {
  const sol = { model: 'gpt-6-sol', source: 'catalog' };
  assert.deepEqual(choosePricedModel('codex', codexCatalog, sol, { below: 20 }, list), sol);
  assert.deepEqual(choosePricedModel('codex', codexCatalog, sol, { below: 5 }, list), { model: 'gpt-5.6-luna', source: 'price-limit' });
  assert.deepEqual(choosePricedModel('codex', codexCatalog, sol, { below: 1 }, list), { model: 'gpt-6-luna', source: 'price-limit' });
  assert.deepEqual(choosePricedModel('codex', codexCatalog, undefined, { below: 5 }, list), { model: 'gpt-5.6-luna', source: 'price-limit' }, 'without a default the catalog still offers one');
  const agy = { source: 'agy models', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] };
  assert.deepEqual(choosePricedModel('agy', agy, undefined, { below: 5 }, list), { model: 'gemini-3.8-flash-high', source: 'price-limit' }, 'a required effort as the CLI accepts it');
  assert.deepEqual(choosePricedModel('agy', agy, undefined, { below: 5, effort: 'LOW' }, list), { model: 'gemini-3.8-flash', source: 'price-limit' }, 'the call\'s effort is passed separately');
  assert.throws(() => choosePricedModel('agy', agy, undefined, { below: 5, effort: 'max' }, list), { code: 'PRICE_LIMIT', message: /accepting reasoning_effort 'max'/ });
});

test('no qualifying model is a PRICE_LIMIT error with the reasons, never a substitute', () => {
  assert.throws(() => choosePricedModel('codex', codexCatalog, { model: 'gpt-6-sol', source: 'catalog' }, { below: 0.5 }, list),
    { code: 'PRICE_LIMIT', message: /^No codex model has a verified price below 0\.5 USD per million output tokens\. Default: 'gpt-6-sol' costs 10 USD.*None of its 5 listed models has a verified price below the limit; doctor lists their prices\.$/ });
  assert.throws(() => choosePricedModel('claude', undefined, { model: 'claude-opus-5-5', source: 'observed' }, { below: 5 }, list),
    { code: 'PRICE_LIMIT', message: /claude lists no models, so only its default or a named model can be checked/ });
  assert.throws(() => choosePricedModel('codex', codexCatalog, undefined, { below: 5 }, undefined), { code: 'PRICE_LIMIT' });
});

test('the selection view lists every model with price evidence, default and approval basis (AX-001)', () => {
  const rows = listModelCandidates('codex', codexCatalog, { model: 'gpt-6-sol', source: 'catalog' }, list, { ...settings, alwaysAsk: ['gpt-6-luna'] });
  assert.deepEqual(rows.map(row => [row.model, row.price.outputUsdPerMTok, row.price.match, row.defaultSource, row.approval.required, row.approval.basis]), [
    ['gpt-6-sol', 10, 'exact', 'catalog', false, 'priced'],
    ['gpt-6-luna', 0.7, 'exact', undefined, true, 'always-ask'],
    ['gpt-5.6-luna', 1.2, 'exact', undefined, false, 'priced'],
    ['gpt-6-astra', null, 'unknown', undefined, true, 'unpriced'],
    ['gemini-3.1-pro-low', 12, 'approximate', undefined, true, 'approximate'],
  ]);
  const claude = listModelCandidates('claude', undefined, { model: 'claude-haiku-4-5-20251001', source: 'observed' }, list, settings);
  assert.deepEqual(claude.map(row => [row.model, row.efforts, row.defaultSource, row.price.outputUsdPerMTok]), [['claude-haiku-4-5-20251001', [], 'observed', 5]], 'without a catalog, the default alone');
  const agy = listModelCandidates('agy', { source: 'agy', models: [{ id: 'gemini-3.8-flash', efforts: ['high'], effortRequired: true }] }, { model: 'gemini-3.8-flash-high', source: 'first-listed' }, undefined, settings);
  assert.deepEqual(agy.map(row => [row.model, row.defaultSource, row.effortRequired, row.price.source, row.approval.basis]), [['gemini-3.8-flash', 'first-listed', true, null, 'no-price-list']], 'the default found in its catalog row');
});
