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
const { ToolError } = require('../../src/contracts/index.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');

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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
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

test('EXEC-001-T08a: probeBackend, readModelCatalog and readObservedModel forward neutral BackendReadContext to adapters', async () => {
  const { readModelCatalog, readObservedModel } = require('../../src/backends/probe-cache.ts');
  const original = adapterRegistry.codex;
  const captured = { probeCtx: null, catalogCtx: null, observeCtx: null };

  const dummyController = new AbortController();
  const testContext = {
    abortSignal: dummyController.signal,
    timeoutMs: 2500,
  };

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async (context) => {
      captured.probeCtx = context;
      return { installed: true, executionSupported: true };
    },
    listModels: async (_probe, context) => {
      captured.catalogCtx = context;
      return { models: [{ id: 'test-model' }], source: 'fixture' };
    },
    observeModel: async (_requested, _probe, context) => {
      captured.observeCtx = context;
      return 'test-observed-model';
    },
  };

  try {
    const probe = await probeBackend('codex', { fresh: true, context: testContext });
    assert.ok(probe.installed);
    assert.equal(captured.probeCtx?.timeoutMs, undefined, 'waiter timeout is isolated and not forwarded to shared task');
    assert.ok(captured.probeCtx?.abortSignal);
    assert.equal(captured.probeCtx?.abortSignal.aborted, false);
    assert.notEqual(captured.probeCtx?.abortSignal, dummyController.signal, 'adapter receives shared coordinator signal, isolating caller signal');

    const catalog = await readModelCatalog('codex', { fresh: true, context: testContext });
    assert.ok(catalog);
    assert.equal(captured.catalogCtx?.timeoutMs, undefined);
    assert.ok(captured.catalogCtx?.abortSignal);
    assert.equal(captured.catalogCtx?.abortSignal.aborted, false);
    assert.notEqual(captured.catalogCtx?.abortSignal, dummyController.signal);

    const observed = await readObservedModel('codex', 'test-model', { fresh: true, context: testContext });
    assert.equal(observed, 'test-observed-model');
    assert.equal(captured.observeCtx?.timeoutMs, undefined);
    assert.ok(captured.observeCtx?.abortSignal);
    assert.equal(captured.observeCtx?.abortSignal.aborted, false);
    assert.notEqual(captured.observeCtx?.abortSignal, dummyController.signal);

    // Also verify backward compatibility when context is omitted
    captured.probeCtx = null;
    await probeBackend('codex', { fresh: true });
    assert.ok(captured.probeCtx?.abortSignal);
    assert.equal(captured.probeCtx?.timeoutMs, undefined);
  } finally {
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08b: two waiters on shared read - cancelling first waiter does not abort second waiter (per-waiter isolation)', async () => {
  const original = adapterRegistry.codex;
  let probeStarted = 0;
  let probeCompleted = 0;
  let capturedContext = null;
  let resolveProbe;

  const probePromise = new Promise((resolve) => {
    resolveProbe = resolve;
  });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async (context) => {
      probeStarted++;
      capturedContext = context;
      await probePromise;
      probeCompleted++;
      return { installed: true, executionSupported: true };
    },
  };

  try {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    // Both waiters initiate probe on 'codex'
    const waiter1Promise = probeBackend('codex', { fresh: true, context: { abortSignal: controller1.signal } });
    const waiter2Promise = probeBackend('codex', { context: { abortSignal: controller2.signal } });

    assert.equal(probeStarted, 1, 'underlying probe started once');
    assert.equal(capturedContext.abortSignal.aborted, false, 'shared abort signal is not aborted');

    // Abort waiter 1
    controller1.abort(new Error('waiter 1 cancelled'));

    // Waiter 1 must reject immediately with ABORTED
    await assert.rejects(
      waiter1Promise,
      (err) => err instanceof ToolError && err.code === 'ABORTED',
      'waiter 1 rejects with ABORTED immediately'
    );

    // Shared abort signal is STILL NOT aborted because waiter 2 is active
    assert.equal(capturedContext.abortSignal.aborted, false, 'shared signal remains active after waiter 1 cancellation');
    assert.equal(probeCompleted, 0, 'probe has not completed yet');

    // Now underlying probe completes successfully
    resolveProbe();

    // Waiter 2 receives the result successfully
    const result2 = await waiter2Promise;
    assert.deepEqual(result2, { installed: true, executionSupported: true });
    assert.equal(probeCompleted, 1, 'probe completed once');
  } finally {
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08b: all waiters cancelled - last waiter aborts underlying task and evicts inflight entry immediately', async () => {
  const original = adapterRegistry.codex;
  let probeStarted = 0;
  let capturedContext = null;
  let finishProbe;

  const probeGate = new Promise((resolve) => {
    finishProbe = resolve;
  });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async (context) => {
      probeStarted++;
      capturedContext = context;
      await probeGate;
      return { installed: true, executionSupported: true };
    },
  };

  try {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const waiter1Promise = probeBackend('codex', { fresh: true, context: { abortSignal: controller1.signal } });
    const waiter2Promise = probeBackend('codex', { context: { abortSignal: controller2.signal } });

    assert.equal(probeStarted, 1);
    assert.equal(capturedContext.abortSignal.aborted, false);

    // Cancel waiter 1
    controller1.abort();
    await assert.rejects(waiter1Promise, (err) => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(capturedContext.abortSignal.aborted, false, 'shared read still running for waiter 2');

    // Cancel waiter 2 (last remaining waiter)
    controller2.abort();
    await assert.rejects(waiter2Promise, (err) => err instanceof ToolError && err.code === 'ABORTED');

    // Shared abort controller must be aborted immediately upon 0 active waiters
    assert.equal(capturedContext.abortSignal.aborted, true, 'shared abort controller aborted by last waiter');

    // New incoming caller must NOT join the aborted/evicted inflight entry
    let probe2Started = 0;
    adapterRegistry.codex.probe = async () => {
      probe2Started++;
      return { installed: true, executionSupported: true, second: true };
    };

    const newCallerPromise = probeBackend('codex');
    const newResult = await newCallerPromise;
    assert.equal(probe2Started, 1, 'new caller started fresh read rather than joining aborted inflight read');
    assert.equal(newResult.second, true);

    // Release the first stalled probe fixture
    finishProbe();
  } finally {
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08b: fresh: true replacement race - late settlement of old read does not delete new inflight entry', async () => {
  const original = adapterRegistry.codex;
  let probeCount = 0;
  let finishOldProbe;
  let finishNewProbe;

  const oldProbeGate = new Promise((resolve) => { finishOldProbe = resolve; });
  const newProbeGate = new Promise((resolve) => { finishNewProbe = resolve; });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async () => {
      probeCount++;
      const current = probeCount;
      if (current === 1) {
        await oldProbeGate;
        return { installed: true, executionSupported: true, version: '1.0.0' };
      } else {
        await newProbeGate;
        return { installed: true, executionSupported: true, version: '2.0.0' };
      }
    },
  };

  try {
    // 1. Start old read (inflight entry 1)
    const oldPromise = probeBackend('codex', { fresh: true });
    assert.equal(probeCount, 1);

    // 2. Start fresh read while old read is still inflight (replaces inflight with entry 2)
    const freshPromise = probeBackend('codex', { fresh: true });
    assert.equal(probeCount, 2);

    // 3. A concurrent third caller joins without fresh: true -> must coalesce onto fresh read (entry 2)
    const joinedPromise = probeBackend('codex');

    // 4. Old probe settles FIRST (late settlement of replaced entry)
    finishOldProbe();
    const oldResult = await oldPromise;
    assert.equal(oldResult.version, '1.0.0');

    // 5. A fourth caller arrives after old probe settled, but before fresh probe settles
    // Because old probe settlement did NOT delete entry 2 from inflight, caller 4 must coalesce onto entry 2
    const fourthPromise = probeBackend('codex');
    assert.equal(probeCount, 2, 'fourth caller coalesced onto fresh read, did not start a third read');

    // 6. Now fresh probe settles
    finishNewProbe();
    const freshResult = await freshPromise;
    const joinedResult = await joinedPromise;
    const fourthResult = await fourthPromise;

    assert.equal(freshResult.version, '2.0.0');
    assert.equal(joinedResult.version, '2.0.0');
    assert.equal(fourthResult.version, '2.0.0');
    assert.equal(probeCount, 2, 'only two probe calls executed in total');
  } finally {
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08b: per-waiter timeout via timeoutMs isolates from other waiters', async () => {
  const original = adapterRegistry.codex;
  let probeStarted = 0;
  let resolveProbe;

  const probeGate = new Promise((resolve) => { resolveProbe = resolve; });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async () => {
      probeStarted++;
      await probeGate;
      return { installed: true, executionSupported: true };
    },
  };

  try {
    // Waiter 1 has a very short timeout (30 ms)
    const waiter1Promise = probeBackend('codex', { fresh: true, context: { timeoutMs: 30 } });
    // Waiter 2 has no timeout
    const waiter2Promise = probeBackend('codex');

    assert.equal(probeStarted, 1);

    // Waiter 1 should time out with ToolError('TIMEOUT')
    await assert.rejects(
      waiter1Promise,
      (err) => err instanceof ToolError && err.code === 'TIMEOUT',
      'waiter 1 rejected with TIMEOUT error'
    );

    // Waiter 2 is still awaiting and resolves when probe finishes
    resolveProbe();
    const result2 = await waiter2Promise;
    assert.deepEqual(result2, { installed: true, executionSupported: true });
  } finally {
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08b: pre-aborted signal rejects immediately without starting probe', async () => {
  const original = adapterRegistry.codex;
  let probeStarted = 0;

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async () => {
      probeStarted++;
      return { installed: true, executionSupported: true };
    },
  };

  try {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    await assert.rejects(
      probeBackend('codex', { fresh: true, context: { abortSignal: controller.signal } }),
      (err) => err instanceof ToolError && err.code === 'ABORTED'
    );

    assert.equal(probeStarted, 0, 'probe was never launched for pre-aborted caller');
  } finally {
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08b: initiating waiter timeout/budget is not passed to shared context, protecting concurrent waiters', async () => {
  const original = adapterRegistry.codex;
  let sharedContext = null;
  let finishProbe;

  const probeGate = new Promise((resolve) => { finishProbe = resolve; });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async (context) => {
      sharedContext = context;
      await probeGate;
      return { installed: true, executionSupported: true };
    },
  };

  let testBudget;
  try {
    testBudget = createExecutionBudget({ totalBudgetMs: 50_000 });
    const waiter1Promise = probeBackend('codex', {
      fresh: true,
      context: { timeoutMs: 20, budget: testBudget },
    });
    const waiter2Promise = probeBackend('codex');

    // Waiter 1 must time out
    await assert.rejects(
      waiter1Promise,
      (err) => err instanceof ToolError && err.code === 'TIMEOUT'
    );

    // Shared context given to probe did NOT receive waiter 1's timeoutMs or budget
    assert.equal(sharedContext?.timeoutMs, undefined, 'shared task has no caller timeoutMs');
    assert.equal(sharedContext?.budget, undefined, 'shared task has no caller budget');
    assert.equal(sharedContext?.abortSignal?.aborted, false, 'shared task was not aborted by waiter 1 timeout');

    // Waiter 2 finishes successfully when probe resolves
    finishProbe();
    const result2 = await waiter2Promise;
    assert.deepEqual(result2, { installed: true, executionSupported: true });
  } finally {
    if (testBudget) testBudget.dispose();
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08f: probeBackend waiter detaches with TIMEOUT when budget executionSignal expires', async () => {
  const original = adapterRegistry.codex;
  let finishProbe;
  const probeGate = new Promise(resolve => { finishProbe = resolve; });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    execute: async () => { throw new Error('must not run'); },
    probe: async () => {
      await probeGate;
      return { installed: true, executionSupported: true };
    },
  };

  let testBudget;
  try {
    testBudget = createExecutionBudget({ totalBudgetMs: 40, teardownAllowanceMs: 10 });
    const waiterPromise = probeBackend('codex', {
      fresh: true,
      context: { budget: testBudget },
    });

    await assert.rejects(
      waiterPromise,
      (err) => err instanceof ToolError && err.code === 'TIMEOUT'
    );
    finishProbe();
  } finally {
    if (testBudget) testBudget.dispose();
    adapterRegistry.codex = original;
  }
});

test('EXEC-001-T08f: inspectQuotas forwards BackendReadContext and enforces pre-flight abort and timeout', async () => {
  const { inspectQuotas } = require('../../src/backends/availability.ts');
  const preAborted = new AbortController();
  preAborted.abort(new Error('caller-abort'));

  await assert.rejects(
    inspectQuotas(false, null, { context: { abortSignal: preAborted.signal } }),
    (err) => err instanceof ToolError && err.code === 'ABORTED'
  );

  let budget;
  try {
    budget = createExecutionBudget({ totalBudgetMs: 50, teardownAllowanceMs: 50 });
    assert.equal(budget.isExecutionExpired(), true);

    await assert.rejects(
      inspectQuotas(false, null, { context: { budget } }),
      (err) => err instanceof ToolError && err.code === 'TIMEOUT'
    );
  } finally {
    if (budget) budget.dispose();
  }
});

test('a probe without a command (an unresolved configured executable) is not reused, so a CLI that appears is seen (FEEDBACK-060c, #4)', async () => {
  const original = adapterRegistry.agy;
  const executable = path.join(tempDir, 'agy-appears.cjs');
  let probes = 0, available = false;
  adapterRegistry.agy = { id: 'agy', name: 'fixture', execute: async () => { throw new Error('must not run'); },
    probe: async () => {
      probes++;
      // As `probeCommand` reports `backends.agy.executable: "vscode-extension"` before the extension provides agy.
      return available ? { id: 'agy', name: 'fixture', installed: true, executionSupported: true, command: executable }
        : { id: 'agy', name: 'fixture', installed: false, executionSupported: false, authStatus: 'unknown', authEvidence: ['no copy yet'] };
    } };
  try {
    assert.equal((await probeBackend('agy')).installed, false);
    fs.writeFileSync(executable, 'console.log("1.3.3")\n');
    available = true;
    assert.equal((await probeBackend('agy')).installed, true, 'the models view sees the CLI once it exists');
    assert.equal(probes, 2);
    await probeBackend('agy');
    assert.equal(probes, 2, 'a resolved probe is still reused');
  } finally {
    adapterRegistry.agy = original;
  }
});
