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

test('EXEC-001-T05: catalog observations expire on key mismatch, replaced adapter, and fresh requests', async () => {
  const { readModelCatalog } = require('../../src/backends/probe-cache.ts');
  const original = adapterRegistry.agy;
  const executable = path.join(tempDir, 'agy-catalog-fixture.cjs');
  const config = path.join(tempDir, 'agy-catalog-config.toml');
  fs.writeFileSync(executable, 'console.log("1.0.0")\n');
  fs.writeFileSync(config, '');
  let catalogReads = 0;
  const catalogData = { source: 'fixture', models: [{ id: 'gemini-3.8-flash', isDefault: true, efforts: ['low'] }] };
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async () => ({
      installed: true,
      executionSupported: true,
      command: executable,
      configPath: config,
    }),
    listModels: async () => {
      catalogReads++;
      return { ...catalogData, readIndex: catalogReads };
    },
  };
  const savedKey = process.env.GEMINI_API_KEY;
  try {
    // 1. Initial read
    const cat1 = await readModelCatalog('agy');
    assert.equal(catalogReads, 1, 'initial read calls listModels');
    assert.equal(cat1.readIndex, 1);

    // 2. Immediate reuse (same probe, key, adapter, and fresh=false)
    const cat2 = await readModelCatalog('agy');
    assert.equal(catalogReads, 1, 'subsequent read reuses cached catalog');

    // 3. Passing catalog observation with matching key reuses without reading adapter
    const cat3 = await readModelCatalog('agy', { catalog: cat1 });
    assert.equal(catalogReads, 1, 'passing valid catalog observation reuses it');

    // 4. Executable change causes probe and catalog invalidation
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(executable, later, later);
    const cat4 = await readModelCatalog('agy');
    assert.equal(catalogReads, 2, 'updated executable invalidates catalog and re-reads');

    // 5. Config change causes invalidation
    fs.writeFileSync(config, 'model = "new"\n');
    const cat5 = await readModelCatalog('agy');
    assert.equal(catalogReads, 3, 'updated config invalidates catalog and re-reads');

    // 6. Environment credential change causes invalidation
    process.env.GEMINI_API_KEY = 'changed-env-key';
    const cat6 = await readModelCatalog('agy');
    assert.equal(catalogReads, 4, 'updated environment invalidates catalog and re-reads');

    // 7. Explicit fresh read (doctor) bypasses cache
    const cat7 = await readModelCatalog('agy', { fresh: true });
    assert.equal(catalogReads, 5, 'fresh: true forces new catalog read');

    // 8. Replaced adapter function misses in-memory listFn, falling back to stored models.json
    const prevList = adapterRegistry.agy.listModels;
    adapterRegistry.agy.listModels = async () => prevList();
    const cat8 = await readModelCatalog('agy');
    assert.equal(catalogReads, 5, 'stored models.json answers when in-memory cache misses');
    assert.equal(cat8.source, 'fixture');

    // 9. Replaced adapter with fresh: true bypasses disk store and calls the new function
    const cat9 = await readModelCatalog('agy', { fresh: true });
    assert.equal(catalogReads, 6, 'fresh read calls the replaced adapter function');
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    adapterRegistry.agy = original;
  }
});
