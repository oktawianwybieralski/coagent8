'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-price-limit-'));
process.env.coagent8_DIR = tempDir;

const { checkPriceLimit, isPriceListStale, matchPrices, parsePriceList, priceEvidence, readPrices, refreshPrices, boundReadTimeout, settlePriceReads, PRICE_STALE_MS } = require('../../src/models/prices.ts');
const { recordPrices, readStoredPrices } = require('../../src/models/store.ts');
const { choosePricedModel, listModelCandidates } = require('../../src/models/selection.ts');
const { ToolError } = require('../../src/contracts/index.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const now = Date.now();
const listed = [['openai/gpt-6-sol', 10], ['openai/gpt-6-luna', 0.5], ['openai/gpt-5.6-luna', 1.2], ['openai/gpt-6-terra', 4.9999],
  ['google/gemini-3.8-flash', 3.75], ['google/gemini-3.1-pro-preview', 12], ['anthropic/claude-haiku-4.5', 5], ['other/gpt-6-luna', 0.7]]
  .map(([id, output]) => ({ id, output, input: null, cachedInput: null }));
const offered = ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-6-terra', 'gpt-6-astra', 'mystery', 'gemini-3.1-pro-low', 'claude-haiku-4-5[1m]', 'claude-haiku-4-5',
  'gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-max', 'claude-haiku-4-5-20251001'];
const list = { fetchedAt: now, source: 'openrouter', models: matchPrices(listed, offered) };
const settings = { priceMultiplier: 2, askAbovePrice: 20, models: { allow: [], ask: [], deny: [] } };

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

test('a denied effort variant is never chosen when the call passes that effort separately', () => {
  const sol = { model: 'gpt-6-sol', source: 'catalog' };
  assert.deepEqual(choosePricedModel('codex', codexCatalog, sol, { below: 20, effort: 'high' }, list, ['gpt-6-sol-high']), { model: 'gpt-5.6-luna', source: 'price-limit' }, 'the default runs as the denied variant');
  assert.deepEqual(choosePricedModel('codex', codexCatalog, sol, { below: 5, effort: 'high' }, list, ['gpt-5.6-luna-high']), { model: 'gpt-6-luna', source: 'price-limit' });
  assert.deepEqual(choosePricedModel('codex', codexCatalog, sol, { below: 5, effort: 'low' }, list, ['gpt-5.6-luna-high']), { model: 'gpt-5.6-luna', source: 'price-limit' }, 'another effort of the model is not denied');
  const agy = { source: 'agy models', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] };
  assert.throws(() => choosePricedModel('agy', agy, undefined, { below: 5, effort: 'LOW' }, list, ['gemini-3.8-flash-low'], true), { code: 'PRICE_LIMIT' });
  assert.throws(() => choosePricedModel('agy', agy, { model: 'gemini-3.8-flash-high', source: 'catalog' }, { below: 5, effort: 'low' }, list, ['gemini-3.8-flash-low'], true), { code: 'PRICE_LIMIT' }, 'agy runs a default variant with another effort as that other variant');
});

test('no qualifying model is a PRICE_LIMIT error with the reasons, never a substitute', () => {
  assert.throws(() => choosePricedModel('codex', codexCatalog, { model: 'gpt-6-sol', source: 'catalog' }, { below: 0.5 }, list),
    { code: 'PRICE_LIMIT', message: /^No codex model has a verified price below 0\.5 USD per million output tokens\. Default: 'gpt-6-sol' costs 10 USD.*None of its 5 listed models has a verified price below the limit; doctor lists their prices\.$/ });
  assert.throws(() => choosePricedModel('claude', undefined, { model: 'claude-opus-5-5', source: 'observed' }, { below: 5 }, list),
    { code: 'PRICE_LIMIT', message: /claude lists no models, so only its default or a named model can be checked/ });
  assert.throws(() => choosePricedModel('codex', codexCatalog, undefined, { below: 5 }, undefined), { code: 'PRICE_LIMIT' });
});

test('the selection view lists every model with price evidence, default and approval basis (AX-001)', () => {
  const rows = listModelCandidates('codex', codexCatalog, { model: 'gpt-6-sol', source: 'catalog' }, list, { ...settings, models: { allow: ['gpt-5.6-luna'], ask: ['gpt-6-luna'], deny: ['gpt-6-astra'] } });
  assert.deepEqual(rows.map(row => [row.model, row.price.outputUsdPerMTok, row.price.match, row.defaultSource, row.approval.required, row.approval.denied, row.approval.basis]), [
    ['gpt-6-sol', 10, 'exact', 'catalog', false, false, 'priced'],
    ['gpt-6-luna', 0.7, 'exact', undefined, true, false, 'ask'],
    ['gpt-5.6-luna', 1.2, 'exact', undefined, false, false, 'allow'],
    ['gpt-6-astra', null, 'unknown', undefined, false, true, 'deny'],
    ['gemini-3.1-pro-low', 12, 'approximate', undefined, true, false, 'approximate'],
  ]);
  const claude = listModelCandidates('claude', undefined, { model: 'claude-haiku-4-5-20251001', source: 'observed' }, list, settings);
  assert.deepEqual(claude.map(row => [row.model, row.efforts, row.defaultSource, row.price.outputUsdPerMTok]), [['claude-haiku-4-5-20251001', [], 'observed', 5]], 'without a catalog, the default alone');
  const agy = listModelCandidates('agy', { source: 'agy', models: [{ id: 'gemini-3.8-flash', efforts: ['high'], effortRequired: true }] }, { model: 'gemini-3.8-flash-high', source: 'first-listed' }, undefined, settings);
  assert.deepEqual(agy.map(row => [row.model, row.defaultSource, row.effortRequired, row.price.source, row.approval.basis]), [['gemini-3.8-flash', 'first-listed', true, null, 'no-price-list']], 'the default found in its catalog row');
});

test('boundReadTimeout bounds timeout with Math.min and handles edge cases (EXEC-001-T08f)', () => {
  assert.equal(boundReadTimeout(undefined, 10000), 10000);
  assert.equal(boundReadTimeout({}, 10000), 10000);
  assert.equal(boundReadTimeout({ timeoutMs: 5000 }, 10000), 5000);
  assert.equal(boundReadTimeout({ timeoutMs: 15000 }, 10000), 10000);
  assert.equal(boundReadTimeout({ timeoutMs: 0 }, 10000), 10000);
  assert.equal(boundReadTimeout({ timeoutMs: -1 }, 10000), 10000);
  assert.equal(boundReadTimeout({ timeoutMs: NaN }, 10000), 10000);
});

test('EXEC-001-T08f: pre-flight checks reject immediately on aborted signal or expired budget without I/O', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = 0;
  global.fetch = async () => { fetchCalled++; throw new Error('must not be called'); };
  let budget;

  try {
    const preAborted = new AbortController();
    preAborted.abort(new Error('caller-aborted'));

    await assert.rejects(
      readPrices({ fresh: true, context: { abortSignal: preAborted.signal } }),
      err => err instanceof ToolError && err.code === 'ABORTED'
    );

    await assert.rejects(
      refreshPrices(['gpt-6-sol'], { abortSignal: preAborted.signal }),
      err => err instanceof ToolError && err.code === 'ABORTED'
    );

    budget = createExecutionBudget({ totalBudgetMs: 100, teardownAllowanceMs: 100 });
    assert.equal(budget.isExecutionExpired(), true);

    await assert.rejects(
      readPrices({ fresh: true, context: { budget } }),
      err => err instanceof ToolError && err.code === 'TIMEOUT'
    );

    await assert.rejects(
      refreshPrices(['gpt-6-sol'], { budget }),
      err => err instanceof ToolError && err.code === 'TIMEOUT'
    );

    await assert.rejects(
      readPrices({ fresh: true, context: { timeoutMs: 0 } }),
      err => err instanceof ToolError && err.code === 'TIMEOUT'
    );

    await assert.rejects(
      readPrices({ fresh: true, context: { timeoutMs: -5 } }),
      err => err instanceof ToolError && err.code === 'TIMEOUT'
    );

    assert.equal(fetchCalled, 0, 'fetch was never invoked for pre-aborted/expired queries');
  } finally {
    if (budget) budget.dispose();
    global.fetch = originalFetch;
  }
});

const withMockFetch = async (fetchMock, fn) => {
  const originalFetch = global.fetch;
  const savedPricesUrl = process.env.coagent8_PRICES_URL;
  process.env.coagent8_PRICES_URL = 'https://openrouter.ai/api/v1/models';
  global.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
    if (savedPricesUrl === undefined) delete process.env.coagent8_PRICES_URL;
    else process.env.coagent8_PRICES_URL = savedPricesUrl;
  }
};

test('EXEC-001-T08f: two waiters on shared price read - cancelling first waiter does not abort second waiter (isolation)', async () => {
  let fetchStarted = 0;
  let finishFetch;
  let capturedSignal;

  const fetchGate = new Promise(resolve => { finishFetch = resolve; });

  await withMockFetch(async (url, options) => {
    fetchStarted++;
    capturedSignal = options?.signal;
    await fetchGate;
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [{ id: 'openai/isolated-model', pricing: { completion: '0.000010' } }]
        }));
      })()
    };
  }, async () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();

    const waiter1Promise = readPrices({ fresh: true, context: { abortSignal: ctrl1.signal }, models: ['isolated-model'] });
    const waiter2Promise = readPrices({ context: { abortSignal: ctrl2.signal }, models: ['isolated-model'] });

    assert.equal(fetchStarted, 1, 'underlying fetch started once');
    assert.equal(capturedSignal.aborted, false);

    // Cancel waiter 1
    ctrl1.abort();
    await assert.rejects(
      waiter1Promise,
      err => err instanceof ToolError && err.code === 'ABORTED'
    );

    // Shared fetch signal must NOT be aborted because waiter 2 is active
    assert.equal(capturedSignal.aborted, false);

    // Finish fetch
    finishFetch();

    const res2 = await waiter2Promise;
    assert.ok(res2);
    assert.equal(res2.models['isolated-model']?.output, 10);
  });
});

test('EXEC-001-T08f: last waiter cancellation aborts underlying fetch and evicts inflight entry immediately', async () => {
  let fetchCount = 0;
  let finishFetch1;
  let capturedSignal1;

  const gate1 = new Promise(resolve => { finishFetch1 = resolve; });

  await withMockFetch(async (url, options) => {
    fetchCount++;
    if (fetchCount === 1) {
      capturedSignal1 = options?.signal;
      await gate1;
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({
            data: [{ id: 'openai/evicted-model', pricing: { completion: '0.000015' } }]
          }));
        })()
      };
    } else {
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({
            data: [{ id: 'openai/evicted-model', pricing: { completion: '0.000015' } }]
          }));
        })()
      };
    }
  }, async () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();

    const waiter1Promise = readPrices({ fresh: true, context: { abortSignal: ctrl1.signal }, models: ['evicted-model'] });
    const waiter2Promise = readPrices({ context: { abortSignal: ctrl2.signal }, models: ['evicted-model'] });

    assert.equal(fetchCount, 1);
    assert.equal(capturedSignal1.aborted, false);

    // Cancel waiter 1
    ctrl1.abort();
    await assert.rejects(waiter1Promise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(capturedSignal1.aborted, false, 'still active for waiter 2');

    // Cancel waiter 2 (last remaining waiter)
    ctrl2.abort();
    await assert.rejects(waiter2Promise, err => err instanceof ToolError && err.code === 'ABORTED');

    // Last waiter cancellation immediately aborts the underlying fetch signal
    assert.equal(capturedSignal1.aborted, true, 'shared coordinator signal aborted when last waiter cancelled');

    finishFetch1();

    // A new incoming caller must NOT join the aborted/evicted inflight entry
    const newResult = await readPrices({ fresh: true, models: ['evicted-model'] });
    assert.equal(fetchCount, 2, 'second fetch started fresh instead of joining aborted inflight entry');
    assert.equal(newResult.models['evicted-model']?.output, 15);
  });
});

test('EXEC-001-T08f: per-waiter timeout via timeoutMs isolates from concurrent waiters', async () => {
  let finishFetch;
  let capturedSignal;

  const gate = new Promise(resolve => { finishFetch = resolve; });

  await withMockFetch(async (url, options) => {
    capturedSignal = options?.signal;
    await gate;
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [{ id: 'openai/timeout-isolated-model', pricing: { completion: '0.000010' } }]
        }));
      })()
    };
  }, async () => {
    // Waiter 1 has a short timeout (30ms)
    const waiter1Promise = readPrices({ fresh: true, context: { timeoutMs: 30 }, models: ['timeout-isolated-model'] });
    // Waiter 2 has no timeout and needs timeout-isolated-model (so it joins)
    const waiter2Promise = readPrices({ models: ['timeout-isolated-model'] });

    // Waiter 1 times out
    await assert.rejects(waiter1Promise, err => err instanceof ToolError && err.code === 'TIMEOUT');

    // Underlying fetch is NOT aborted because waiter 2 is active
    assert.equal(capturedSignal.aborted, false);

    finishFetch();

    const res2 = await waiter2Promise;
    assert.ok(res2);
    assert.equal(res2.models['timeout-isolated-model']?.output, 10);
  });
});

test('EXEC-001-T08f: budget executionSignal expiration cancels waiter with TIMEOUT', async () => {
  let finishFetch;
  const gate = new Promise(resolve => { finishFetch = resolve; });

  await withMockFetch(async () => {
    await gate;
    return { ok: true, headers: { get: () => null }, body: (async function* () {})() };
  }, async () => {
    let budget;
    try {
      budget = createExecutionBudget({ totalBudgetMs: 40, teardownAllowanceMs: 10 });
      const waiterPromise = readPrices({ fresh: true, context: { budget } });

      await assert.rejects(waiterPromise, err => err instanceof ToolError && err.code === 'TIMEOUT');
      finishFetch();
    } finally {
      if (budget) budget.dispose();
    }
  });
});

test('EXEC-001-T08f: fresh replacement race - late settlement of old read does not delete new inflight entry nor poison store', async () => {
  let fetchCount = 0;
  let finishOldFetch;
  let finishNewFetch;

  const oldGate = new Promise(resolve => { finishOldFetch = resolve; });
  const newGate = new Promise(resolve => { finishNewFetch = resolve; });

  await withMockFetch(async () => {
    fetchCount++;
    const current = fetchCount;
    if (current === 1) {
      await oldGate;
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({
            data: [{ id: 'openai/replacement-model', pricing: { completion: '0.000099' } }]
          }));
        })()
      };
    } else {
      await newGate;
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({
            data: [{ id: 'openai/replacement-model', pricing: { completion: '0.000010' } }]
          }));
        })()
      };
    }
  }, async () => {
    // 1. Old read starts (inflight entry 1)
    const oldPromise = readPrices({ fresh: true, models: ['replacement-model'] });
    assert.equal(fetchCount, 1);

    // 2. New read starts with fresh: true while old read is in flight (replaces inflight with entry 2)
    const freshPromise = readPrices({ fresh: true, models: ['replacement-model'] });
    assert.equal(fetchCount, 2);

    // 3. A concurrent third caller joins without fresh: true -> must coalesce onto fresh read (entry 2)
    const joinedPromise = readPrices({ models: ['replacement-model'] });

    // 4. Old fetch settles FIRST (late settlement of replaced entry)
    finishOldFetch();
    const oldResult = await oldPromise;
    assert.equal(oldResult.models['replacement-model']?.output, 99);

    // 5. A fourth caller arrives after old fetch settled, but before fresh fetch settles
    // Because old fetch settlement did NOT delete entry 2 from activeInflight, caller 4 coalesces onto entry 2
    const fourthPromise = readPrices({ models: ['replacement-model'] });
    assert.equal(fetchCount, 2, 'fourth caller coalesced onto fresh read, did not start a third fetch');

    // 6. Now fresh fetch settles
    finishNewFetch();
    const freshResult = await freshPromise;
    const joinedResult = await joinedPromise;
    const fourthResult = await fourthPromise;

    assert.equal(freshResult.models['replacement-model']?.output, 10);
    assert.equal(joinedResult.models['replacement-model']?.output, 10);
    assert.equal(fourthResult.models['replacement-model']?.output, 10);
    assert.equal(fetchCount, 2);

    // 7. Verify stored prices: late old fetch did NOT poison stored prices
    const stored = readStoredPrices();
    assert.equal(stored.models['replacement-model']?.output, 10, 'stored price is 10 (from fresh read), not 99 (from late old read)');
  });
});

test('EXEC-001-T08f: cancelled read does not set failedAt cooldown, allowing immediate subsequent retry', async () => {
  let fetchCount = 0;
  let finishFetch1;
  const gate1 = new Promise(resolve => { finishFetch1 = resolve; });

  await withMockFetch(async (_url, opts) => {
    fetchCount++;
    if (fetchCount === 1) {
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          finishFetch1();
        });
      }
      await gate1;
      if (opts?.signal?.aborted) {
        throw new ToolError('ABORTED', 'Fetch was aborted.');
      }
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({
            data: [{ id: 'openai/retry-model', pricing: { completion: '0.000010' } }]
          }));
        })()
      };
    }
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [{ id: 'openai/retry-model', pricing: { completion: '0.000010' } }]
        }));
      })()
    };
  }, async () => {
    const ctrl = new AbortController();
    const call1 = readPrices({ fresh: true, context: { abortSignal: ctrl.signal }, models: ['retry-model'] });
    ctrl.abort();
    await assert.rejects(call1, err => err instanceof ToolError && err.code === 'ABORTED');

    finishFetch1();
    await settlePriceReads();

    // Immediate next call without fresh: true must NOT be blocked by 5-minute cooldown
    const call2 = await readPrices({ models: ['retry-model'] });
    assert.equal(fetchCount, 2, 'second fetch proceeded immediately without waiting for retry cooldown');
    assert.equal(call2.models['retry-model']?.output, 10);
  });
});

test('EXEC-001-T08f: settlePriceReads awaits in-flight price reads', async () => {
  let finishFetch;
  let fetchDone = false;
  const gate = new Promise(resolve => { finishFetch = resolve; });

  await withMockFetch(async () => {
    await gate;
    fetchDone = true;
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [{ id: 'openai/settle-model', pricing: { completion: '0.000010' } }]
        }));
      })()
    };
  }, async () => {
    const readPromise = readPrices({ fresh: true, models: ['settle-model'] });
    assert.equal(fetchDone, false);

    const settlePromise = settlePriceReads();
    finishFetch();
    await settlePromise;
    assert.equal(fetchDone, true, 'settlePriceReads waited until fetch finished');
    await readPromise;
  });
});

test('EXEC-001-T08f: joined read missing caller models triggers follow-up read to cover them', async () => {
  let callCount = 0;
  let finishFirst;
  const firstGate = new Promise(resolve => { finishFirst = resolve; });

  await withMockFetch(async () => {
    callCount++;
    if (callCount === 1) {
      await firstGate;
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({
            data: [{ id: 'openai/uncovered-joiner-a', pricing: { completion: '0.000010' } }]
          }));
        })()
      };
    }
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [
            { id: 'openai/uncovered-joiner-a', pricing: { completion: '0.000010' } },
            { id: 'openai/uncovered-joiner-b', pricing: { completion: '0.000020' } }
          ]
        }));
      })()
    };
  }, async () => {
    const caller1 = readPrices({ fresh: true, models: ['uncovered-joiner-a'] });
    finishFirst();
    await new Promise(resolve => setImmediate(resolve));
    const caller2 = readPrices({ models: ['uncovered-joiner-b'] });

    const [res1, res2] = await Promise.all([caller1, caller2]);
    assert.ok(res1?.models['uncovered-joiner-a'], 'caller1 got model a');
    assert.ok(res2?.models['uncovered-joiner-b'], 'caller2 performed follow-up read and got model b');
    assert.equal(callCount, 2, 'two fetches occurred because joiner was not covered by first read');
  });
});

test('EXEC-001-T08f: late error from replaced read does not overwrite retry cooldown when newer read succeeded', async () => {
  let finishOld;
  const oldGate = new Promise(resolve => { finishOld = resolve; });
  let fetchCount = 0;

  await withMockFetch(async () => {
    fetchCount++;
    if (fetchCount === 1) {
      await oldGate;
      // Replaced read fails after newer read has already finished
      throw new Error('network down on old read');
    }
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [{ id: 'openai/superseded-model', pricing: { completion: '0.000010' } }]
        }));
      })()
    };
  }, async () => {
    // 1. Old read starts and hangs
    const oldPromise = readPrices({ fresh: true, models: ['superseded-model'] }).catch(() => undefined);
    // 2. Fresh read replaces it and succeeds
    const freshResult = await readPrices({ fresh: true, models: ['superseded-model'] });
    assert.ok(freshResult?.models['superseded-model'], 'fresh read succeeded');

    // 3. Old read finishes with error
    finishOld();
    await oldPromise;

    // 4. Non-fresh read should not be blocked by retry cooldown
    const nonFreshResult = await readPrices({ models: ['superseded-model'] });
    assert.ok(nonFreshResult?.models['superseded-model'], 'non-fresh read was not blocked by cooldown');
  });
});

test('EXEC-001-T08f: readPrices with refresh: true coalesces with inflight read unlike fresh: true', async () => {
  let finishFetch;
  const gate = new Promise(resolve => { finishFetch = resolve; });
  let fetchCalls = 0;

  await withMockFetch(async () => {
    fetchCalls++;
    await gate;
    return {
      ok: true,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from(JSON.stringify({
          data: [{ id: 'openai/coalesce-refresh-model', pricing: { completion: '0.000010' } }]
        }));
      })()
    };
  }, async () => {
    const p1 = readPrices({ fresh: true, models: ['coalesce-refresh-model'] });
    const p2 = readPrices({ refresh: true, models: ['coalesce-refresh-model'] });

    assert.equal(fetchCalls, 1, 'refresh: true joined in-flight read instead of starting a new fetch');
    finishFetch();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1?.models['coalesce-refresh-model']);
    assert.ok(r2?.models['coalesce-refresh-model']);
  });
});

test('a model row names the rule entry that decides it, such as the variant its default runs as', () => {
  const agy = { source: 'agy models', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] };
  const fallback = { model: 'gemini-3.8-flash-low', source: 'catalog' };
  const rules = models => ({ ...settings, models: { allow: [], ask: [], deny: [], ...models } });
  const [variant] = listModelCandidates('agy', agy, fallback, list, rules({ allow: ['gemini-3.8-flash-low'] }));
  assert.deepEqual([variant.model, variant.approval.basis, variant.approval.ruleEntry], ['gemini-3.8-flash', 'allow', 'gemini-3.8-flash-low']);
  const [id] = listModelCandidates('agy', agy, fallback, list, rules({ deny: ['gemini-3.8-flash'], allow: ['gemini-3.8-flash-low'] }));
  assert.deepEqual([id.approval.basis, id.approval.ruleEntry], ['deny', 'gemini-3.8-flash'], 'deny wins, and its entry is the one to change');
  const [none] = listModelCandidates('agy', agy, fallback, list, rules({}));
  assert.equal(none.approval.ruleEntry, undefined);
});

test('a price limit takes the first permitted variant of an effort-required model, not only its first', () => {
  const agy = { source: 'agy models', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] };
  assert.deepEqual(choosePricedModel('agy', agy, undefined, { below: 5 }, list, ['gemini-3.8-flash-high'], true), { model: 'gemini-3.8-flash-low', source: 'price-limit' });
  assert.throws(() => choosePricedModel('agy', agy, undefined, { below: 5 }, list, ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'], true), { code: 'PRICE_LIMIT' });
});
