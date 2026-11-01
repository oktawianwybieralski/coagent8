'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-backends-routing-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { resolveBackend } = require('../../src/execution/routing.ts');
const { saveConfig, loadConfig } = require('../../src/config.ts');

process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('auto and smart_quota ignore an installed but unsupported provider; explicit/default choice fails visibly without fallback', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy'])
      adapterRegistry[id] = {
        id,
        name: id,
        probe: async () => ({ installed: id !== 'codex', executionSupported: id === 'claude' }),
        execute: async () => {
          throw new Error('Routing test must not generate');
        },
      };
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'agy'] } });
    assert.equal((await resolveBackend('auto')).id, 'claude');
    assert.equal(loadConfig().defaultBackend, null);
    assert.equal((await resolveBackend('smart_quota')).id, 'claude');
    await assert.rejects(resolveBackend('agy'), { code: 'CLI_UNSUPPORTED' });
    await saveConfig({ defaultBackend: 'agy' });
    await assert.rejects(resolveBackend(), { code: 'CLI_UNSUPPORTED' });
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
    await assert.rejects(resolveBackend(), { code: 'CLI_NOT_FOUND' });
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'agy'] } });
    adapterRegistry.agy.probe = async () => ({ installed: true, executionSupported: true });
    const chosen = await resolveBackend();
    assert.equal(chosen.id, 'agy', 'without a default, auto chooses like smart_quota in provider order');
    assert.equal(chosen.isSmartQuota, true);
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('routing: resolveBackend auto mode is strictly read-only and does not mutate config', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        id,
        name: id,
        probe: async () => ({ installed: id === 'agy', executionSupported: id === 'agy' }),
        execute: async () => {
          throw new Error('Not executed');
        },
      };
    }

    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const resolved = await resolveBackend('auto');
    assert.equal(resolved.id, 'agy');
    assert.equal(loadConfig().defaultBackend, null); // Strictly read-only; no silent mutation!
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('routing: auto prefers another CLI than the calling client and measured headroom, falling back to the caller', async () => {
  const { setCallerProvider, providerForClient } = require('../../src/execution/routing.ts');
  const { selectSmartQuotaBackend } = require('../../src/backends/availability.ts');
  const original = { ...adapterRegistry };
  try {
    assert.equal(providerForClient('claude-code'), 'claude');
    assert.equal(providerForClient('codex-mcp-client'), 'codex');
    assert.equal(providerForClient('Antigravity'), 'agy');
    assert.equal(providerForClient('antigravity-client'), 'agy');
    assert.equal(providerForClient('cursor-vscode'), null);
    assert.equal(providerForClient(undefined), null);
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        id,
        name: id,
        inspectQuota: async () => undefined,
        probe: async () => ({ installed: true, executionSupported: true }),
        execute: async () => {
          throw new Error('Not executed');
        },
      };
    }
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'agy'] } });
    setCallerProvider('agy');
    assert.equal((await resolveBackend()).id, 'claude', 'agy as client gets Claude');
    setCallerProvider('claude');
    assert.equal((await resolveBackend('auto')).id, 'agy', 'Claude Code as client gets agy');
    await saveConfig({ defaultBackend: 'claude' });
    assert.equal((await resolveBackend()).id, 'claude', 'a configured default wins over the caller preference');
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude'] } });
    assert.equal((await resolveBackend()).id, 'claude', 'the caller CLI remains the last resort');

    const config = { routing: { allowedBackends: ['codex', 'claude', 'agy'] } };
    const quotasOverride = {
      codex: { installed: true, status: 'operational', measured: true, headroomPercent: 10 },
      agy: { installed: true, status: 'operational', measured: true, headroomPercent: 80 },
      claude: { installed: true, status: 'operational', measured: false, headroomPercent: 99 },
    };
    assert.equal(
      await selectSmartQuotaBackend(['codex', 'agy', 'claude'], { config, quotasOverride, callerProvider: null }),
      'agy',
      'measured headroom ranks',
    );
    assert.equal(
      await selectSmartQuotaBackend(['codex', 'agy', 'claude'], { config, quotasOverride, callerProvider: 'agy' }),
      'claude',
      'unmeasured counts as 50%, above a measured 10%',
    );
    const limited = {
      ...quotasOverride,
      codex: { ...quotasOverride.codex, status: 'rate_limited' },
      claude: { ...quotasOverride.claude, status: 'rate_limited' },
    };
    assert.equal(
      await selectSmartQuotaBackend(['codex', 'agy', 'claude'], { config, quotasOverride: limited, callerProvider: 'agy' }),
      'agy',
      'caller chosen when the others are rate limited',
    );
  } finally {
    setCallerProvider(null);
    Object.assign(adapterRegistry, original);
  }
});

function fixtureAdapters() {
  for (const id of ['codex', 'claude', 'agy']) {
    adapterRegistry[id] = {
      id,
      name: id,
      inspectQuota: async () => {
        throw new Error('Routing reads no native quota');
      },
      probe: async () => ({ installed: true, executionSupported: true }),
      execute: async () => {
        throw new Error('Not executed');
      },
    };
  }
}

test('CUR-004: auto routing continues with a bounded warning when the quota cache cannot be written', async t => {
  const original = { ...adapterRegistry };
  const cacheFile = process.env.coagent8_QUOTA_CACHE;
  const blocker = path.join(tempDir, 'quota-parent-is-a-file');
  fs.writeFileSync(blocker, 'not a directory');
  t.after(() => {
    process.env.coagent8_QUOTA_CACHE = cacheFile;
    Object.assign(adapterRegistry, original);
  });
  fixtureAdapters();
  await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'agy'] } });
  process.env.coagent8_QUOTA_CACHE = path.join(blocker, 'quota-cache.json');
  const chosen = await resolveBackend('auto');
  assert.equal(chosen.id, 'agy', 'the provider order decides without cached data');
  assert.equal(chosen.warnings.length, 1);
  assert.match(chosen.warnings[0], /^Quota cache not updated; routing used the last readable data: /);
  assert.ok(chosen.warnings[0].length < 700, 'the warning is bounded');
  assert.equal((await resolveBackend('agy')).warnings, undefined, 'an explicit backend never touches the quota cache');
});

test('CUR-004: a stale or undated measurement ranks like an unmeasured one; a fresh one keeps its weight', async t => {
  const { readQuotaCache, QUOTA_MEASUREMENT_MAX_AGE_MS } = require('../../src/backends/availability.ts');
  const original = { ...adapterRegistry };
  t.after(() => Object.assign(adapterRegistry, original));
  fixtureAdapters();
  await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'agy'] } });
  const quota = (headroomPercent, measuredAt) => ({
    installed: true,
    status: 'operational',
    window: '5h',
    usedPercent: 100 - headroomPercent,
    headroomPercent,
    measured: true,
    resetsAt: null,
    cooldownUntil: null,
    ...(measuredAt === undefined ? {} : { measuredAt }),
  });
  const stale = new Date(Date.now() - QUOTA_MEASUREMENT_MAX_AGE_MS - 60000).toISOString();
  const fresh = new Date(Date.now() - 60000).toISOString();
  const write = data => fs.writeFileSync(process.env.coagent8_QUOTA_CACHE, JSON.stringify({ timestamp: Date.now(), data }));

  write({ codex: quota(95), claude: quota(90, stale), agy: quota(70, fresh) });
  assert.equal((await resolveBackend('auto')).id, 'agy', 'a fresh 70% outranks stale 90% and undated 95%, which count as 50%');
  const stored = readQuotaCache().data;
  assert.equal(stored.claude.measured, false, 'the rewritten cache drops the stale measurement');
  assert.equal(stored.claude.headroomPercent, null);
  assert.equal(stored.codex.measured, false);
  assert.equal(stored.agy.measuredAt, new Date(fresh).toISOString(), 'a carried-over measurement keeps its own time, not the rewrite time');

  write({ codex: quota(30, fresh), claude: quota(40, fresh), agy: quota(20, stale) });
  assert.equal((await resolveBackend('auto')).id, 'agy', 'a stale low measurement no longer penalizes its provider');
});
