const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-probe-cache-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { probeBackend } = require('../../src/backends/probe-cache.ts');
const { resolveBackend } = require('../../src/backends/routing.ts');
const { saveConfig } = require('../../src/config.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('routing reuses one probe per backend until its executable, configuration or environment changes (AUD-P1-4)', async () => {
  const original = adapterRegistry.gemini;
  const executable = path.join(tempDir, 'agy-fixture.cjs');
  const config = path.join(tempDir, 'agy-config.toml');
  fs.writeFileSync(executable, 'console.log("1.0.0")\n');
  fs.writeFileSync(config, '');
  let probes = 0;
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', execute: async () => { throw new Error('must not run'); },
    probe: async () => { probes++; return { installed: true, executionSupported: true, command: executable, configPath: config }; } };
  const savedKey = process.env.GEMINI_API_KEY;
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    for (let i = 0; i < 5; i++) assert.equal((await resolveBackend()).id, 'gemini');
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

    await probeBackend('gemini', { fresh: true });
    assert.equal(probes, 5, 'doctor always probes afresh');
    await resolveBackend();
    assert.equal(probes, 5, 'and refreshes the cached probe');
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    adapterRegistry.gemini = original;
  }
});
