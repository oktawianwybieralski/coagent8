'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-diagnostics-doctor-'));
process.env.coagent8_DIR = tempDir;

const { runDoctor } = require('../../src/diagnostics/doctor.ts');
const { recordQuotaCooldown } = require('../../src/backends/availability.ts');
const { saveConfig } = require('../../src/config.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');

process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('runDoctor returns structured diagnostic report for all three CLIs', async () => {
  const report = await runDoctor();

  assert.ok(report);
  assert.ok(['operational', 'partially_configured', 'degraded_no_active_backends'].includes(report.status));
  assert.ok(Array.isArray(report.active_backends));
  assert.equal(report.security_policy, undefined, 'no hardcoded policy claims (AUD-P2-8)');

  // Backends
  assert.ok(report.backends.codex);
  assert.ok(report.backends.claude);
  assert.ok(report.backends.agy);

  assert.equal(report.backends.codex.id, 'codex');
  assert.equal(report.backends.claude.id, 'claude');
  assert.equal(report.backends.agy.id, 'agy');

  // Verify recommendations exist if any backend is missing
  if (!report.backends.codex.installed || !report.backends.claude.installed || !report.backends.agy.installed) {
    assert.ok(report.recommendations.length > 0);
  }
});

test('doctor does not classify installation and unverified authentication evidence as ready', async () => {
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = { ...original[id], inspectQuota: async () => undefined, probe: async () => ({ id, installed: true, executionSupported: true,
        authStatus: 'unknown', authEvidence: ['Synthetic auth file present (not verified)'],
        capabilities: { readOnlyVerified: true, resume: false, streaming: false, reasoningEffort: false } }) };
    }
    const report = await runDoctor();
    assert.deepEqual(report.ready_backends, []);
    assert.equal(report.status, 'partially_configured');
    // A quota the CLI itself measured (agy and Claude `/usage`) proves a signed-in CLI.
    adapterRegistry.agy.inspectQuota = async () => ({ measured: true, headroomPercent: 40, usedPercent: 60, window: 'weekly', resetsAt: null });
    assert.deepEqual((await runDoctor()).ready_backends, ['agy']);
  } finally { Object.assign(adapterRegistry, original); }
});

test('doctor: runDoctor excludes exhausted/rate-limited providers from ready_backends', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        inspectQuota: async () => undefined,
        probe: async () => ({
          id,
          installed: true,
          executionSupported: true,
          authStatus: 'authenticated',
          capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
        }),
      };
    }

    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'agy'] } });

    // Mark codex as rate limited
    await recordQuotaCooldown('codex', 60000, 'Usage limit reached');

    const report = await runDoctor();
    assert.ok(!report.ready_backends.includes('codex'));
    assert.ok(report.ready_backends.includes('claude'));
    assert.ok(report.ready_backends.includes('agy'));
    assert.ok(report.recommendations.some(r => r.includes('codex: usage limit reached or rate limited')));
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('doctor summary is a few lines, backend filter keeps other cached quotas, full report has quotas once', async () => {
  const { formatDoctorSummary, DOCTOR_SUMMARY_MAX_BYTES } = require('../../src/diagnostics/doctor.ts');
  const { inspectQuotas } = require('../../src/backends/availability.ts');
  const { handleDoctor } = require('../../src/mcp/tools/doctor.tool.ts');
  const original = { ...adapterRegistry };
  const quotaReads = [];
  const quotaCache = process.env.coagent8_QUOTA_CACHE;
  process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'doctor-summary-quota-cache.json');
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        inspectQuota: async () => { quotaReads.push(id); return { measured: true, window: '5h', usedPercent: 40, headroomPercent: 60, resetsAt: '2026-10-07T12:00:00Z' }; },
        listModels: id === 'agy' ? async () => ({ source: 'agy models', models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }] }) : undefined,
        observeModel: id === 'claude' ? async requested => requested : undefined,
        probe: async () => ({
          id, installed: true, version: `${id} 1.0.0`, executionSupported: true, authStatus: 'authenticated',
          config: { defaultModel: `${id}-model` }, availableModels: Array.from({ length: 14 }, (_, i) => `${id}-model-${i}`),
          capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
          ...(id === 'agy' ? { quota: { measured: true, window: 'weekly', usedPercent: 25, headroomPercent: 75, resetsAt: '2026-10-12T18:00:00Z',
            buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-10-12T18:00:00Z' }] } } : {}),
        }),
      };
    }
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'agy'] }, backends: { codex: {}, claude: {}, agy: {} } });

    const report = await runDoctor();
    const summary = formatDoctorSummary(report);
    assert.equal(summary.split('\n').length, 9, summary);
    assert.match(summary, /\nagy: ready[^\n]*\n {2}models, USD per million output tokens: agy-model \? \[default, ask: no price\], gemini-3\.8-flash \(high\|low required\) 3\.75(\n|$)/,
      'the default and the catalog the CLI lists, with prices and the efforts a model needs');
    assert.match(summary, /\n {2}also accepted: claude-model-0, [^\n]*claude-model-13, or a full model id/, 'without a catalog, the aliases the probe knows');
    assert.match(summary, /^CoAgent8 doctor: operational · default backend: auto · prices coagent8_PRICES_URL \d{4}-\d{2}-\d{2} \(\d+ models priced\)\n/);
    // The fixture models have no price, so the policy asks before each turn and doctor says so.
    assert.match(summary, /claude: ready · claude 1\.0\.0 · model claude-model \(CLI config, asks each turn\) · 5h 60% left, resets 2026-10-07T12:00:00Z/);
    assert.match(summary, /agy: ready · agy 1\.0\.0 · model agy-model \(CLI config, asks each turn\) · weekly 75% left/);
    assert.ok(Buffer.byteLength(summary) <= DOCTOR_SUMMARY_MAX_BYTES, 'within the bound agy shows inline');
    // Summary and full report state the same rows (AX-001).
    assert.deepEqual(report.selection.map(row => [row.backend, row.model, row.price.outputUsdPerMTok, row.price.match, row.approval.required, row.defaultSource]), [
      ['codex', 'codex-model', null, 'unknown', true, 'cli-config'],
      ['agy', 'agy-model', null, 'unknown', true, 'cli-config'],
      ['agy', 'gemini-3.8-flash', 3.75, 'exact', false, undefined],
      ['claude', 'claude-model', null, 'unknown', true, 'cli-config'],
    ]);
    const flash = report.selection.find(row => row.model === 'gemini-3.8-flash');
    assert.deepEqual({ ...flash.price, fetchedAt: undefined }, { outputUsdPerMTok: 3.75, inputUsdPerMTok: 0.75, cachedInputUsdPerMTok: null, matched: 'google/gemini-3.8-flash', match: 'exact', source: 'coagent8_PRICES_URL', fetchedAt: undefined, stale: false });
    assert.deepEqual(flash.approval, { required: false, denied: false, basis: 'priced', reason: 'Its output costs 3.75 USD per million tokens.', rememberable: false });
    assert.equal(report.prices.stale, false);

    assert.equal(report.backends.agy.quota, undefined, 'quota reported once, under quotas');
    assert.deepEqual(report.backends.agy.models, [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true }], 'doctor reports the models the CLI lists');
    assert.equal(report.backends.agy.modelSource, 'agy models');
    assert.equal(report.backends.codex.models, undefined, 'no catalog, no models field');
    assert.equal(report.quotas.agy.buckets.length, 1);

    quotaReads.length = 0;
    const claudeOnly = await runDoctor({ backend: 'claude', quota: false });
    assert.deepEqual(Object.keys(claudeOnly.backends), ['claude']);
    assert.deepEqual(quotaReads, [], 'quota: false skips native quota reads');
    const cache = await inspectQuotas(false);
    assert.equal(cache.codex.installed, true, 'a filtered doctor keeps the other providers cached');
    assert.equal(cache.agy.installed, true);

    const summaryResult = await handleDoctor({});
    assert.equal(summaryResult.structuredContent, undefined);
    const full = await handleDoctor({ detail: 'full', backend: 'agy' });
    assert.deepEqual(JSON.parse(full.content[0].text), full.structuredContent);
    assert.deepEqual(Object.keys(full.structuredContent.backends), ['agy']);
    assert.deepEqual(full.structuredContent.selection.map(row => row.model), ['agy-model', 'gemini-3.8-flash'], 'a backend filter narrows the rows');
  } finally {
    process.env.coagent8_QUOTA_CACHE = quotaCache;
    Object.assign(adapterRegistry, original);
  }
});

test('doctor names the MCP servers and plugins agy turns inherit, without changing the status (CUR-002)', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        inspectQuota: async () => undefined,
        listModels: undefined,
        observeModel: id === 'claude' ? async requested => requested : undefined,
        inheritedTools: id === 'agy' ? async () => ({ mcpServers: ['context7', 'coagent8'], plugins: ['team-kit'] }) : undefined,
        probe: async () => ({ id, installed: true, version: '1.0.0', executionSupported: true, authStatus: 'authenticated',
          config: { defaultModel: `${id}-model` }, capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true } }),
      };
    }
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'agy'] }, backends: { codex: {}, claude: {}, agy: {} } });
    const report = await runDoctor({ quota: false });
    assert.deepEqual(report.inheritedTools, { agy: { mcpServers: ['context7', 'coagent8'], plugins: ['team-kit'] } });
    const note = report.recommendations.find(text => text.startsWith('agy: turns run'));
    assert.match(note, /MCP servers context7, coagent8 and plugins team-kit from your agy configuration; CoAgent8 cannot disable them/);
    const withoutNote = report.recommendations.filter(text => text !== note);
    assert.equal(report.status, withoutNote.length ? 'partially_configured' : 'operational', 'the note alone does not change the status');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('doctor reports an unwritable quota cache as a recommendation instead of failing (CUR-004)', async t => {
  const cacheFile = process.env.coagent8_QUOTA_CACHE;
  const blocker = path.join(tempDir, 'quota-parent-is-a-file');
  fs.writeFileSync(blocker, 'not a directory');
  t.after(() => { process.env.coagent8_QUOTA_CACHE = cacheFile; });
  process.env.coagent8_QUOTA_CACHE = path.join(blocker, 'quota-cache.json');
  const report = await runDoctor({ quota: false });
  assert.ok(report.backends.codex && report.backends.claude && report.backends.agy);
  assert.equal(report.recommendations.filter(text => text.startsWith('Quota cache not updated: ')).length, 1);
});

test('the doctor summary drops whole model rows to stay within the inline bound and flags a stale price list (AX-001)', () => {
  const { formatDoctorSummary, DOCTOR_SUMMARY_MAX_BYTES } = require('../../src/diagnostics/doctor.ts');
  const row = (backend, index, price) => ({ backend, model: `${backend}-catalog-model-${index}`, efforts: ['low', 'high'],
    price: { outputUsdPerMTok: price, matched: price === null ? null : `x/${backend}-${index}`, match: price === null ? 'unknown' : index % 7 === 0 ? 'approximate' : 'exact', source: 'openrouter', fetchedAt: '2026-09-01T00:00:00.000Z', stale: true },
    approval: { required: price === null, basis: price === null ? 'unpriced' : 'priced', reason: '', rememberable: price === null } });
  const probe = id => ({ id, installed: true, version: '1.0.0', models: [{ id: 'm', efforts: [] }] });
  const report = {
    status: 'operational', default_backend: 'auto', active_backends: ['codex', 'agy'], ready_backends: ['codex', 'agy'],
    backends: { codex: probe('codex'), agy: probe('agy') }, quotas: {}, defaultModels: {}, recommendations: [],
    prices: { source: 'openrouter', fetchedAt: '2026-09-01T00:00:00.000Z', models: 300, stale: true },
    selection: [...Array.from({ length: 200 }, (_, i) => row('codex', i, i % 5 ? i / 10 : null)), ...Array.from({ length: 20 }, (_, i) => row('agy', i, 1))],
  };
  const summary = formatDoctorSummary(report);
  assert.ok(Buffer.byteLength(summary) <= DOCTOR_SUMMARY_MAX_BYTES, `${Buffer.byteLength(summary)} B`);
  assert.match(summary, /^CoAgent8 doctor: operational · default backend: auto · prices openrouter 2026-09-01 \(300 models priced, stale: meets no price limit\)\n/);
  const codexLine = summary.split('\n').find(line => line.includes('codex-catalog-model-0'));
  const counted = Number(codexLine.match(/, \+(\d+) more \(detail: full\); reasoning_effort low\|high$/)[1]);
  const shown = codexLine.replace(/^ {2}models, USD per million output tokens: /, '').replace(/, \+\d+ more.*$/, '').split(', ');
  assert.equal(shown.length + counted, 200, 'every row is shown or counted');
  shown.forEach((text, i) => {
    const price = report.selection[i].price;
    const expected = price.outputUsdPerMTok === null ? '? [ask: no price]' : `${price.match === 'approximate' ? '~' : ''}${price.outputUsdPerMTok}`;
    assert.equal(text, `codex-catalog-model-${i} ${expected}`, 'a shown row is whole and states the full report\'s price');
  });
  assert.match(summary, /agy-catalog-model-19 1; reasoning_effort low\|high(\n|$)/, 'the shorter list stays complete while the longest is cut');
});

test('doctor defaults to the model view: cached catalogs, defaults and prices, no quota read and nothing recorded (AX-001)', async () => {
  const { handleDoctor } = require('../../src/mcp/tools/doctor.tool.ts');
  const { loadConfig } = require('../../src/config.ts');
  const original = { ...adapterRegistry };
  const quotaReads = [];
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        inspectQuota: async () => { quotaReads.push(id); return undefined; },
        listModels: id === 'codex' ? async () => ({ source: 'codex fixture', models: [{ id: 'gpt-6-luna', efforts: ['low', 'high'], isDefault: true }, { id: 'gpt-6-astra', efforts: ['low', 'high'] }] })
          : id === 'claude' ? async () => ({ source: 'claude fixture', acceptsUnlisted: true, models: [{ id: 'claude-haiku-4-5-20251001', efforts: [], aliases: ['haiku', 'default'], isDefault: true }] })
          : undefined,
        observeModel: undefined,
        probe: async () => ({ id, installed: id !== 'agy', version: `${id} 2.0.0`, executionSupported: true, authStatus: 'authenticated', capabilities: { readOnlyVerified: true } }),
      };
    }
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude'] }, backends: { codex: {}, claude: {}, agy: {} } });
    const summary = (await handleDoctor({})).content[0].text;
    assert.deepEqual(summary.split('\n'), [
      summary.split('\n')[0],
      'codex · codex 2.0.0 · model gpt-6-luna (CLI default)',
      '  models, USD per million output tokens: gpt-6-luna 0.5 [default], gpt-6-astra 50 [ask: askAbovePrice]; reasoning_effort low|high',
      'agy: not installed',
      'claude · claude 2.0.0 · model claude-haiku-4-5-20251001 (CLI default)',
      '  models, USD per million output tokens: claude-haiku-4-5-20251001 5 [default]',
      '  also accepted: unlisted names the CLI resolves itself',
    ]);
    assert.match(summary, /^CoAgent8 models · prices coagent8_PRICES_URL \d{4}-\d{2}-\d{2} \(\d+ models priced\) · scope "health" diagnoses sign-in and quota\n/);
    assert.deepEqual(quotaReads, [], 'the model view reads no quota');
    assert.deepEqual(loadConfig().backends.codex, {}, 'and records no default');
    const full = (await handleDoctor({ detail: 'full', backend: 'claude' })).structuredContent;
    assert.equal(full.scope, 'models');
    assert.deepEqual(full.backends, { claude: { installed: true, allowed: true, version: 'claude 2.0.0', defaultModel: { model: 'claude-haiku-4-5-20251001', source: 'catalog' }, catalogSource: 'claude fixture', acceptsUnlisted: true } });
    assert.deepEqual(full.selection.map(row => [row.model, row.price.outputUsdPerMTok, row.defaultSource]), [['claude-haiku-4-5-20251001', 5, 'catalog']]);
    const health = (await handleDoctor({ scope: 'health' })).content[0].text;
    assert.match(health, /^CoAgent8 doctor: /, 'scope health runs the full diagnosis');
    assert.ok(quotaReads.length > 0, 'with quota reads');
    // The user's own rules (owner decision of 2026-10-11): each model shows deny, ask or allow
    // before a call.
    fs.writeFileSync(require('../../src/config.ts').getConfigFile(), JSON.stringify({ routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude'] },
      governance: { models: { allow: ['claude-haiku-4-5-20251001'], ask: ['gpt-6-luna'], deny: ['gpt-6-astra'] } } }));
    const ruled = (await handleDoctor({})).content[0].text.split('\n');
    assert.ok(ruled.includes('codex · codex 2.0.0 · model gpt-6-luna (CLI default, asks each turn)'), ruled.join('\n'));
    assert.ok(ruled.includes('  models, USD per million output tokens: gpt-6-luna 0.5 [default, ask: user list], gpt-6-astra 50 [deny]; reasoning_effort low|high'), ruled.join('\n'));
    assert.ok(ruled.includes('  models, USD per million output tokens: claude-haiku-4-5-20251001 5 [default, allow]'), ruled.join('\n'));
    await saveConfig({ governance: { priceMultiplier: 2, askAbovePrice: 20, models: { allow: [], ask: [], deny: ['gpt-6-luna'] } } });
    assert.match((await handleDoctor({ backend: 'codex' })).content[0].text, /model gpt-6-luna \(CLI default, denied by the user\)/);
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T11b: pre-aborted signal rejects with code === ABORTED and starts no probe', async () => {
  const { runModelReport } = require('../../src/diagnostics/doctor.ts');
  const original = { ...adapterRegistry };
  let probeStarts = 0;
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async () => {
          probeStarts++;
          return { id, installed: true, version: '1.0.0', executionSupported: true, authStatus: 'authenticated', capabilities: { readOnlyVerified: true } };
        },
      };
    }
    const preAborted = new AbortController();
    preAborted.abort();

    await assert.rejects(
      runDoctor({ signal: preAborted.signal }),
      err => err && err.code === 'ABORTED'
    );
    assert.equal(probeStarts, 0, 'runDoctor started no probe on pre-aborted signal');

    await assert.rejects(
      runModelReport({ signal: preAborted.signal }),
      err => err && err.code === 'ABORTED'
    );
    assert.equal(probeStarts, 0, 'runModelReport started no probe on pre-aborted signal');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T11b: abort while read is pending rejects with ABORTED for probe and selectModel/catalog', async () => {
  const { runModelReport } = require('../../src/diagnostics/doctor.ts');
  const { ToolError } = require('../../src/contracts/error.ts');
  const original = { ...adapterRegistry };
  try {
    // 2a. Pending probe
    const ctrl1 = new AbortController();
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async (context) => {
          return new Promise((resolve, reject) => {
            const onAbort = () => reject(new ToolError('ABORTED', 'Probe aborted'));
            if (context?.abortSignal?.aborted) return onAbort();
            context?.abortSignal?.addEventListener('abort', onAbort);
          });
        },
      };
    }

    const doctorPromise1 = runDoctor({ signal: ctrl1.signal });
    await new Promise(r => setTimeout(r, 10));
    ctrl1.abort();

    await assert.rejects(
      doctorPromise1,
      err => err && err.code === 'ABORTED'
    );

    // 2b. Pending selectModel/catalog read (proves decision 6)
    const ctrl2 = new AbortController();
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async () => ({ id, installed: id === 'codex', version: '1.0.0', executionSupported: true, authStatus: 'authenticated', capabilities: { readOnlyVerified: true } }),
        listModels: async () => ({ source: 'fixture', models: [] }),
        observeModel: async (_m, _p, context) => {
          return new Promise((resolve, reject) => {
            const onAbort = () => reject(new ToolError('ABORTED', 'observeModel aborted'));
            if (context?.abortSignal?.aborted) return onAbort();
            context?.abortSignal?.addEventListener('abort', onAbort);
          });
        },
      };
    }

    const doctorPromise2 = runDoctor({ signal: ctrl2.signal, backend: 'codex' });
    await new Promise(r => setTimeout(r, 10));
    ctrl2.abort();

    await assert.rejects(
      doctorPromise2,
      err => err && err.code === 'ABORTED'
    );

    const ctrl3 = new AbortController();
    const modelPromise = runModelReport({ signal: ctrl3.signal, backend: 'codex' });
    await new Promise(r => setTimeout(r, 10));
    ctrl3.abort();

    await assert.rejects(
      modelPromise,
      err => err && err.code === 'ABORTED'
    );
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T11b: expired budget rejects with TIMEOUT and does not become a recommendation', async () => {
  const { runModelReport } = require('../../src/diagnostics/doctor.ts');
  const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async () => ({ id, installed: id === 'codex', version: '1.0.0', executionSupported: true, authStatus: 'authenticated', capabilities: { readOnlyVerified: true } }),
        listModels: async () => ({ source: 'fixture', models: [{ id: 'model-a', efforts: [] }] }),
      };
    }

    let fakeNow = 1000;
    const clock = () => fakeNow;
    const budget1 = createExecutionBudget({ totalBudgetMs: 5000, clock });
    fakeNow = 7000;
    budget1.remainingExecutionMs(); // synchronizes clock

    await assert.rejects(
      runDoctor({ budget: budget1, clock }),
      err => err && err.code === 'TIMEOUT'
    );

    const budget2 = createExecutionBudget({ totalBudgetMs: 5000, clock });
    fakeNow = 13000;
    budget2.remainingExecutionMs();

    await assert.rejects(
      runModelReport({ budget: budget2, clock }),
      err => err && err.code === 'TIMEOUT'
    );
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T11b: every read receives the context: probe, catalog, quota, inherited tools, selection and prices', async () => {
  const original = { ...adapterRegistry };
  const origFetch = global.fetch;
  const savedPricesUrl = process.env.coagent8_PRICES_URL;

  let recordedProbeContext;
  let recordedCatalogContext;
  let recordedQuotaContext;
  let recordedInheritedToolsContext;
  let recordedSelectionContext;
  let recordedFetchSignal;

  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async (context) => {
          if (id === 'codex') recordedProbeContext = context;
          return {
            id,
            installed: id === 'codex',
            version: '1.0.0',
            executionSupported: true,
            authStatus: 'authenticated',
            capabilities: { readOnlyVerified: true },
            config: { defaultModel: 'unpriced-test-model' },
          };
        },
        inspectQuota: async (_probe, context) => {
          if (id === 'codex') recordedQuotaContext = context;
          return { measured: true, headroomPercent: 80, usedPercent: 20, window: 'weekly', resetsAt: null };
        },
        listModels: async (_probe, context) => {
          if (id === 'codex') recordedCatalogContext = context;
          return { source: 'fixture', models: [] };
        },
        inheritedTools: async (context) => {
          if (id === 'codex') recordedInheritedToolsContext = context;
          return { mcpServers: [], plugins: [] };
        },
        observeModel: async (_model, _probe, context) => {
          if (id === 'codex') recordedSelectionContext = context;
          return 'model-x';
        },
      };
    }

    process.env.coagent8_PRICES_URL = 'http://prices.internal.test/api/v1/models';
    global.fetch = async (_url, options) => {
      recordedFetchSignal = options?.signal;
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ data: [{ id: 'x/model-x', pricing: { completion: '0.000001' } }] }));
        })(),
      };
    };

    const ctrl = new AbortController();
    const report = await runDoctor({ backend: 'codex', signal: ctrl.signal });
    assert.ok(report);

    // Verify probe received context with abortSignal
    assert.ok(recordedProbeContext?.abortSignal, 'probe received context with abortSignal');

    // Verify catalog received context with abortSignal
    assert.ok(recordedCatalogContext?.abortSignal, 'catalog received context with abortSignal');

    // Verify quota received context with budget
    assert.ok(recordedQuotaContext?.budget, 'quota received context with budget');
    assert.equal(typeof recordedQuotaContext?.timeoutMs, 'number');

    // Verify inherited tools received context with budget
    assert.ok(recordedInheritedToolsContext?.budget, 'inherited tools received context with budget');
    assert.equal(typeof recordedInheritedToolsContext?.timeoutMs, 'number');

    // Verify selection received context with abortSignal
    assert.ok(recordedSelectionContext?.abortSignal, 'selection received context with abortSignal');

    // Verify prices fetch received combined signal
    assert.ok(recordedFetchSignal, 'prices fetch received signal');
    assert.equal(recordedFetchSignal.aborted, false);

    // Abort controller and verify direct readContext signals reflect the abort
    ctrl.abort();
    assert.equal(recordedQuotaContext.abortSignal.aborted, true, 'quota signal aborted');
    assert.equal(recordedInheritedToolsContext.abortSignal.aborted, true, 'inherited tools signal aborted');
  } finally {
    Object.assign(adapterRegistry, original);
    global.fetch = origFetch;
    if (savedPricesUrl === undefined) delete process.env.coagent8_PRICES_URL;
    else process.env.coagent8_PRICES_URL = savedPricesUrl;
  }
});

test('EXEC-001-T11b: model view stays cheap: cached probes, catalogs, and prices are not refreshed', async () => {
  const { runModelReport } = require('../../src/diagnostics/doctor.ts');
  const { probeBackend, readModelCatalog } = require('../../src/backends/probe-cache.ts');
  const { readPrices } = require('../../src/models/prices.ts');
  const original = { ...adapterRegistry };
  const origFetch = global.fetch;
  const savedPricesUrl = process.env.coagent8_PRICES_URL;

  let probeCalls = 0;
  let catalogCalls = 0;
  let fetchCalls = 0;

  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async () => {
          probeCalls++;
          return { id, installed: id === 'codex', version: '1.0.0', executionSupported: true, authStatus: 'authenticated', capabilities: { readOnlyVerified: true } };
        },
        listModels: async () => {
          catalogCalls++;
          return { source: 'fixture', models: [{ id: 'model-cheap', efforts: [] }] };
        },
      };
    }

    process.env.coagent8_PRICES_URL = 'http://prices.cheap.test/api/v1/models';
    global.fetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ data: [{ id: 'x/model-cheap', pricing: { completion: '0.000001' } }] }));
        })(),
      };
    };

    // Warm probe and catalog cache
    await probeBackend('codex');
    await readModelCatalog('codex');

    // Warm prices with young prices
    await readPrices({ fresh: true, models: ['model-cheap'] });

    // Reset counters
    probeCalls = 0;
    catalogCalls = 0;
    fetchCalls = 0;

    // Call runModelReport
    const report = await runModelReport({ backend: 'codex' });
    assert.ok(report);
    assert.equal(report.scope, 'models');

    // Assert no fresh calls
    assert.equal(probeCalls, 0, 'no fresh probe during model report');
    assert.equal(catalogCalls, 0, 'no fresh catalog during model report');
    assert.equal(fetchCalls, 0, 'no price refresh during model report');
  } finally {
    Object.assign(adapterRegistry, original);
    global.fetch = origFetch;
    if (savedPricesUrl === undefined) delete process.env.coagent8_PRICES_URL;
    else process.env.coagent8_PRICES_URL = savedPricesUrl;
  }
});
