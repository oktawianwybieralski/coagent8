'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-governance-'));
process.env.coagent8_DIR = tempDir;

const { decideConsent } = require('../../src/backends/governance.ts');
const { parsePriceList, findPrice, readPrices, refreshPrices } = require('../../src/backends/prices.ts');
const { resolveWorkspacePath } = require('../../src/paths.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// Recorded OpenRouter prices of 2026-10-07 (USD per million output tokens): gpt-6.1-sol 10,
// gpt-6-astra 50, gpt-5.6-luna 1.2, claude-opus-5.5 20, claude-fable-5.1 50, gemini-3.8-flash 3.75.
const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/prices/openrouter-models.json'), 'utf8'));
const prices = { fetchedAt: Date.now(), source: 'openrouter', entries: parsePriceList(recorded) };
const settings = (changes = {}) => ({ priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [], ...changes });
const asks = (model, defaultModel, list = prices, changes = {}) => decideConsent(model, defaultModel, list, settings(changes));

test('consent by relative price (owner decision of 2026-10-07): fable asks, luna does not, astra asks', () => {
  assert.equal(asks('claude-fable-5-1', 'claude-sonnet-5-5', prices, { askAbovePrice: null }).ask, true, 'fable: 50, five times the default');
  for (const luna of ['gpt-5.6-luna', 'gpt-6-luna']) assert.equal(asks(luna, 'gpt-6.1-sol').ask, false, luna);
  const astra = asks('gpt-6-astra', 'gpt-6.1-sol', prices, { askAbovePrice: null });
  assert.deepEqual([astra.ask, astra.offerRemember], [true, false], 'a known high price asks every turn');
  assert.match(astra.reason, /50 USD per million tokens, 5 times the default gpt-6\.1-sol's 10 USD/);
  assert.equal(asks('gpt-5.6-terra', 'gpt-6.1-sol').ask, false, 'terra: 12, under twice the default');
  // Through agy, whose default is a flash model, the Claude models ask and gpt-oss does not.
  assert.equal(asks('claude-sonnet-4-6', 'gemini-3.8-flash-high').ask, true);
  assert.equal(asks('gpt-oss-120b-medium', 'gemini-3.8-flash-high').ask, false);
  assert.equal(asks('gemini-3.7-flash-low', 'gemini-3.8-flash-high').ask, false);
});

test('an expensive model asks above the absolute limit, its backend default included, unless the user relaxes it', () => {
  const opus = asks('claude-opus-5-5', 'claude-opus-5-5');
  assert.deepEqual([opus.ask, opus.offerRemember], [true, false], 'the default asks too: 20 is at the limit');
  assert.match(opus.reason, /20 USD per million tokens, at or above the 20 USD limit/);
  assert.equal(asks('claude-fable-5-1', 'claude-opus-5-5').ask, true);
  assert.equal(asks('claude-sonnet-5-5', 'claude-opus-5-5').ask, false);
  assert.equal(asks('claude-opus-5-5', 'claude-opus-5-5', prices, { askAbovePrice: null }).ask, false, 'without the limit the default never asks');
  assert.equal(asks('claude-opus-5-5', 'claude-opus-5-5', prices, { neverAsk: ['claude-opus-5-5'] }).ask, false, 'neverAsk exempts a model');
  assert.equal(asks('gpt-6.1-sol', 'gpt-6.1-sol', prices, { alwaysAsk: ['gpt-6.1-sol'], neverAsk: ['gpt-6.1-sol'] }).ask, true, 'alwaysAsk wins');
  assert.equal(asks('gpt-6-astra', 'gpt-6.1-sol', prices, { priceMultiplier: 6, askAbovePrice: null }).ask, false, 'a higher multiplier relaxes the relative rule');
});

test('an unknown or approximately priced model asks with remember; without prices everything not remembered asks', () => {
  const unknown = asks('gpt-7-nova', 'gpt-6.1-sol');
  assert.deepEqual([unknown.ask, unknown.offerRemember], [true, true]);
  const approximate = asks('claude-opus-4-6-thinking', 'gemini-3.8-flash-high');
  assert.deepEqual([approximate.ask, approximate.offerRemember], [true, true]);
  assert.match(approximate.reason, /approximately, as anthropic\/claude-opus-4\.6: 25 USD/);
  for (const model of ['gpt-6.1-sol', 'gemini-3.8-flash-high', 'gpt-5.6-luna']) {
    const none = decideConsent(model, model, undefined, settings());
    assert.deepEqual([none.ask, none.offerRemember], [true, true], model);
  }
  assert.equal(decideConsent('gpt-5.6-luna', 'gpt-5.6-luna', undefined, settings({ neverAsk: ['gpt-5.6-luna'] })).ask, false, 'a remembered model runs without prices');
  assert.equal(asks('gpt-7-nova', 'gpt-6.1-sol', prices, { neverAsk: ['gpt-7-nova'] }).ask, false, 'a remembered unknown model runs');
});

test('a price is matched exactly, also without an effort or date suffix, and approximately otherwise', () => {
  assert.deepEqual(findPrice(prices, 'gemini-3.8-flash-high'), { output: 3.75, matched: 'google/gemini-3.8-flash', exact: true });
  assert.deepEqual(findPrice(prices, 'claude-haiku-4-5-20251001'), { output: 5, matched: 'anthropic/claude-haiku-4.5', exact: true });
  assert.deepEqual(findPrice(prices, 'claude-opus-5-5'), { output: 20, matched: 'anthropic/claude-opus-5.5', exact: true });
  assert.deepEqual(findPrice(prices, 'gpt-6-astra'), { output: 50, matched: 'openai/gpt-6-astra', exact: true }, 'the :batch variant is not a price');
  assert.deepEqual(findPrice(prices, 'gemini-3.1-pro-low'), { output: 12, matched: 'google/gemini-3.1-pro-preview', exact: false });
  assert.equal(findPrice(prices, 'claude-opus-5-5[1m]').exact, false, 'a context variant may cost more');
  assert.equal(findPrice(prices, 'gpt-7-nova'), undefined);
  assert.equal(parsePriceList({ data: [{ id: 'openrouter/auto', pricing: { completion: '-1' } }] }), undefined, 'no fixed price, no entry');
  assert.equal(parsePriceList('not a list'), undefined);
  assert.equal(parsePriceList({ data: [{ id: '--flag', pricing: { completion: '0.00001' } }] }), undefined);
});

test('the price list is read once when none is stored, bounded, and read again by doctor after a week', async () => {
  let requests = 0, mode = 'ok';
  const body = JSON.stringify(recorded);
  const server = http.createServer((request, response) => {
    requests++;
    if (mode === 'large') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(' '.repeat(5 * 1024 * 1024)); return; }
    if (mode === 'malformed') { response.writeHead(200); response.end('{"data": "nothing"}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.coagent8_PRICES_URL;
  process.env.coagent8_PRICES_URL = `http://127.0.0.1:${server.address().port}/api/v1/models`;
  const storeFile = path.join(tempDir, 'models.json');
  try {
    fs.rmSync(storeFile, { force: true });
    const first = await readPrices();
    assert.equal(first.entries.length, recorded.data.length - 1, 'the :batch variant is left out');
    assert.equal(first.source, 'coagent8_PRICES_URL');
    assert.equal((await readPrices()).fetchedAt, first.fetchedAt);
    assert.equal(requests, 1, 'a stored list is used whatever its age; a turn does not refresh it');
    assert.equal((await readPrices({ refresh: true })).fetchedAt, first.fetchedAt, 'doctor keeps a list younger than a week');
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    stored.prices.fetchedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(storeFile, JSON.stringify(stored));
    await readPrices({ refresh: true });
    assert.equal(requests, 2, 'doctor reads a list older than a week again');
    mode = 'large';
    assert.equal(await refreshPrices(), undefined, 'a list over the size limit is refused');
    mode = 'malformed';
    assert.equal(await refreshPrices(), undefined, 'a list without priced models is refused');
    assert.ok(readPrices(), 'the stored list survives a failed read');
  } finally {
    process.env.coagent8_PRICES_URL = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('resolveWorkspacePath validates directories strictly', () => {
  const cwd = resolveWorkspacePath(process.cwd());
  assert.equal(cwd, process.cwd());
  assert.equal(resolveWorkspacePath('.'),process.cwd());

  assert.throws(() => {
    resolveWorkspacePath('C:\\path\\that\\definitely\\does\\not\\exist_12345');
  }, /does not exist/);
});
