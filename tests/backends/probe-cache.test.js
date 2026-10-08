const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-probe-cache-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { probeBackend } = require('../../src/backends/probe-cache.ts');
const { resolveBackend } = require('../../src/execution/routing.ts');
const { saveConfig } = require('../../src/config.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('routing reuses one probe per backend until its executable, configuration or environment changes (AUD-P1-4)', async () => {
  const original = adapterRegistry.agy;
  const executable = path.join(tempDir, 'agy-fixture.cjs');
  const config = path.join(tempDir, 'agy-config.toml');
  fs.writeFileSync(executable, 'console.log("1.0.0")\n');
  fs.writeFileSync(config, '');
  let probes = 0;
  adapterRegistry.agy = { id: 'agy', name: 'fixture', execute: async () => { throw new Error('must not run'); },
    probe: async () => { probes++; return { installed: true, executionSupported: true, command: executable, configPath: config }; } };
  const savedKey = process.env.GEMINI_API_KEY;
  try {
    saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    for (let i = 0; i < 5; i++) assert.equal((await resolveBackend()).id, 'agy');
    assert.equal(probes, 1, 'five requests, one probe');

    const later = new Date(Date.now() + 5000);
    fs.utimesSync(executable, later, later);
    await resolveBackend();
    assert.equal(probes, 2, 'an updated executable is probed again');

    fs.writeFileSync(config, 'model = "x"\n');
    await resolveBackend();
    assert.equal(probes, 3, 'a changed configuration is probed again');

    process.env.GEMINI_API_KEY = 'changed-for-test';
    await resolveBackend();
    assert.equal(probes, 4, 'a changed credential variable is probed again');

    await probeBackend('agy', { fresh: true });
    assert.equal(probes, 5, 'doctor always probes afresh');
    await resolveBackend();
    assert.equal(probes, 5, 'and refreshes the cached probe');
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    adapterRegistry.agy = original;
  }
});

test('CUR-006: concurrent misses share one probe, catalog read and model observation; failures are not cached', async () => {
  const { readModelCatalog, readObservedModel } = require('../../src/backends/probe-cache.ts');
  const original = adapterRegistry.codex;
  const counts = { probe: 0, catalog: 0, observe: 0 };
  let failProbe = false;
  const later = value => new Promise(resolve => setTimeout(() => resolve(value), 30));
  adapterRegistry.codex = { id: 'codex', name: 'fixture', execute: async () => { throw new Error('must not run'); },
    probe: async () => { counts.probe++; if (failProbe) { await later(); throw new Error('probe failed'); } return later({ installed: true, executionSupported: true }); },
    listModels: async () => { counts.catalog++; return later({ models: [{ id: `model-${counts.catalog}` }], source: 'fixture' }); },
    observeModel: async requested => { counts.observe++; return later(`${requested || 'default'}-${counts.observe}`); } };
  try {
    const probes = await Promise.all(Array.from({ length: 8 }, () => probeBackend('codex')));
    assert.equal(counts.probe, 1, 'eight concurrent misses, one probe');
    assert.ok(probes.every(probe => probe === probes[0]));

    const catalogs = await Promise.all(Array.from({ length: 8 }, () => readModelCatalog('codex')));
    assert.equal(counts.catalog, 1, 'eight concurrent catalog misses, one read');
    assert.ok(catalogs.every(catalog => catalog.models[0].id === 'model-1'));

    const models = await Promise.all([...Array.from({ length: 4 }, () => readObservedModel('codex', 'alias')), readObservedModel('codex')]);
    assert.equal(counts.observe, 2, 'one request per requested name');
    assert.deepEqual(models, ['alias-1', 'alias-1', 'alias-1', 'alias-1', 'default-2']);

    await Promise.all([probeBackend('codex', { fresh: true }), probeBackend('codex', { fresh: true })]);
    assert.equal(counts.probe, 3, 'a fresh probe starts its own read');

    // A replaced probe function misses the cache, so these calls start and join one read.
    const succeed = adapterRegistry.codex.probe;
    failProbe = true;
    adapterRegistry.codex.probe = async () => succeed();
    const failed = await Promise.allSettled(Array.from({ length: 3 }, () => probeBackend('codex')));
    assert.equal(counts.probe, 4, 'waiters share the failing probe');
    assert.ok(failed.every(result => result.status === 'rejected' && result.reason.message === 'probe failed'));
    failProbe = false;
    await probeBackend('codex');
    assert.equal(counts.probe, 5, 'the failure was not cached; the next call probes again');
  } finally {
    adapterRegistry.codex = original;
  }
});

test('CUR-006: probes stamp the Codex home configuration and the Claude settings file', async () => {
  const { execFileSync } = require('node:child_process');
  const codexHome = path.join(tempDir, 'codex-home');
  const env = { ...process.env, CODEX_HOME: codexHome };
  delete env.CODEX_CONFIG_PATH;
  const printed = execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', "process.stdout.write(require('./src/backends/codex/adapter.ts').CODEX_CONFIG_PATH)"],
    { cwd: path.resolve(__dirname, '../..'), env, windowsHide: true, encoding: 'utf8' });
  assert.equal(printed, path.join(codexHome, 'config.toml'));

  const claude = require('../../src/backends/claude/adapter.ts');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-home');
  try {
    assert.equal((await claude.probe()).configPath, path.join(tempDir, 'claude-home', 'settings.json'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
