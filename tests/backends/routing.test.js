'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-backends-routing-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { resolveBackend } = require('../../src/backends/routing.ts');
const { saveConfig, loadConfig } = require('../../src/config.ts');

process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('auto and smart_quota ignore an installed but unsupported provider; explicit/default choice fails visibly without fallback',async()=>{
  const original={...adapterRegistry};
  try {
    for(const id of ['codex','claude','gemini'])adapterRegistry[id]={id,name:id,probe:async()=>({installed:id!=='codex',executionSupported:id==='claude'}),execute:async()=>{throw new Error('Routing test must not generate');}};
    saveConfig({defaultBackend:null,routing:{strategy:'fixed',allowedBackends:['claude','gemini']}});
    assert.equal((await resolveBackend('auto')).id,'claude');assert.equal(loadConfig().defaultBackend,null);
    assert.equal((await resolveBackend('smart_quota')).id,'claude');
    await assert.rejects(resolveBackend('gemini'),/CLI_UNSUPPORTED/);
    saveConfig({defaultBackend:'gemini'});await assert.rejects(resolveBackend(),/CLI_UNSUPPORTED/);
    saveConfig({defaultBackend:null,routing:{strategy:'fixed',allowedBackends:['codex']}});await assert.rejects(resolveBackend(),/CLI_NOT_FOUND/);
    saveConfig({defaultBackend:null,routing:{strategy:'fixed',allowedBackends:['claude','gemini']}});
    adapterRegistry.gemini.probe=async()=>({installed:true,executionSupported:true});
    const chosen=await resolveBackend();assert.equal(chosen.id,'gemini','without a default, auto chooses like smart_quota in provider order');assert.equal(chosen.isSmartQuota,true);
  }finally{Object.assign(adapterRegistry,original);}
});

test('routing: resolveBackend auto mode is strictly read-only and does not mutate config', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = {
        id,
        name: id,
        probe: async () => ({ installed: id === 'gemini', executionSupported: id === 'gemini' }),
        execute: async () => { throw new Error('Not executed'); },
      };
    }

    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const resolved = await resolveBackend('auto');
    assert.equal(resolved.id, 'gemini');
    assert.equal(loadConfig().defaultBackend, null); // Strictly read-only; no silent mutation!
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('routing: auto prefers another CLI than the calling client and measured headroom, falling back to the caller', async () => {
  const { setCallerProvider, providerForClient } = require('../../src/backends/routing.ts');
  const { selectSmartQuotaBackend } = require('../../src/backends/availability.ts');
  const original = { ...adapterRegistry };
  try {
    assert.equal(providerForClient('claude-code'), 'claude');
    assert.equal(providerForClient('codex-mcp-client'), 'codex');
    assert.equal(providerForClient('Antigravity'), 'gemini');
    assert.equal(providerForClient('antigravity-client'), 'gemini');
    assert.equal(providerForClient('cursor-vscode'), null);
    assert.equal(providerForClient(undefined), null);
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = { id, name: id, inspectQuota: async () => undefined,
        probe: async () => ({ installed: true, executionSupported: true }), execute: async () => { throw new Error('Not executed'); } };
    }
    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'gemini'] } });
    setCallerProvider('gemini');
    assert.equal((await resolveBackend()).id, 'claude', 'agy as client gets Claude');
    setCallerProvider('claude');
    assert.equal((await resolveBackend('auto')).id, 'gemini', 'Claude Code as client gets agy');
    saveConfig({ defaultBackend: 'claude' });
    assert.equal((await resolveBackend()).id, 'claude', 'a configured default wins over the caller preference');
    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude'] } });
    assert.equal((await resolveBackend()).id, 'claude', 'the caller CLI remains the last resort');

    const config = { routing: { allowedBackends: ['codex', 'claude', 'gemini'] } };
    const quotasOverride = {
      codex: { installed: true, status: 'operational', measured: true, headroomPercent: 10 },
      gemini: { installed: true, status: 'operational', measured: true, headroomPercent: 80 },
      claude: { installed: true, status: 'operational', measured: false, headroomPercent: 99 },
    };
    assert.equal(await selectSmartQuotaBackend(['codex', 'gemini', 'claude'], { config, quotasOverride, callerProvider: null }), 'gemini', 'measured headroom ranks');
    assert.equal(await selectSmartQuotaBackend(['codex', 'gemini', 'claude'], { config, quotasOverride, callerProvider: 'gemini' }), 'claude', 'unmeasured counts as 50%, above a measured 10%');
    const limited = { ...quotasOverride, codex: { ...quotasOverride.codex, status: 'rate_limited' }, claude: { ...quotasOverride.claude, status: 'rate_limited' } };
    assert.equal(await selectSmartQuotaBackend(['codex', 'gemini', 'claude'], { config, quotasOverride: limited, callerProvider: 'gemini' }), 'gemini', 'caller chosen when the others are rate limited');
  } finally {
    setCallerProvider(null);
    Object.assign(adapterRegistry, original);
  }
});
