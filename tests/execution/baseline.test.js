'use strict';

/**
 * EXEC-001-T01b: Fixture-only execution baseline harness.
 *
 * Measures observation counts (probes, catalogs, model checks) and adapter launches
 * across all core execution scenarios (plain cold/warm, explicit model/effort,
 * priced auto, continuation, review, and concurrent runs) using existing injection seams.
 * Counters and phase timings that cannot yet be observed are recorded as NOT_MEASURED.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-baseline-harness-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { handleReview } = require('../../src/mcp/tools/review.tool.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

const NOT_MEASURED = 'NOT_MEASURED';

const originalRegistry = {
  codex: adapterRegistry.codex,
  agy: adapterRegistry.agy,
  claude: adapterRegistry.claude,
};

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createInstrumentedFixture(id, models = [], options = {}) {
  const counters = {
    probes: 0,
    catalogReads: 0,
    adapterLaunches: 0,
    launches: [],
  };

  const adapter = {
    id,
    name: `${id}-fixture`,
    counters,
    probe: async () => {
      counters.probes++;
      return {
        id,
        installed: true,
        executionSupported: true,
        version: '1.0.0-fixture',
        authStatus: 'authenticated',
        capabilities: {
          readOnlyVerified: true,
          resume: true,
          streaming: true,
          reasoningEffort: true,
        },
      };
    },
    listModels: async () => {
      counters.catalogReads++;
      return { source: `${id} fixture`, models };
    },
    inspectQuota: async () => undefined,
    execute: async (prompt, opts) => {
      counters.adapterLaunches++;
      counters.launches.push({ prompt, options: opts });
      if (options.onExecute) {
        return await options.onExecute(prompt, opts, counters);
      }
      return {
        status: 'completed',
        isError: false,
        output: options.output || 'baseline fixture answer',
        nativeSessionId: `${id}-native-${counters.adapterLaunches}`,
        model: opts.model || models[0]?.id || 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  return { adapter, counters };
}

function snapshotCounters(counters) {
  return {
    probes: counters.probes,
    catalogReads: counters.catalogReads,
    adapterLaunches: counters.adapterLaunches,
  };
}

function counterDeltas(counters, before) {
  return {
    probes: counters.probes - before.probes,
    catalogReads: counters.catalogReads - before.catalogReads,
    adapterLaunches: counters.adapterLaunches - before.adapterLaunches,
  };
}

function recordObservation(scenario, measuredCounters, extra = {}) {
  const record = {
    scenario,
    probes: measuredCounters.probes,
    catalogReads: measuredCounters.catalogReads,
    adapterLaunches: measuredCounters.adapterLaunches,
    durationMs: measuredCounters.durationMs ?? NOT_MEASURED,
    preparationDurationMs: measuredCounters.phases?.preparation ?? NOT_MEASURED,
    consentDurationMs: measuredCounters.phases?.consent ?? NOT_MEASURED,
    acquisitionDurationMs: measuredCounters.phases?.acquisition ?? NOT_MEASURED,
    finalizationDurationMs: measuredCounters.phases?.finalization ?? NOT_MEASURED,
    gitCollectionDurationMs: measuredCounters.phases?.git_collection ?? NOT_MEASURED,
    nativeProcessLaunchOverhead: NOT_MEASURED,
    clientTransportLatency: NOT_MEASURED,
    ...extra,
  };
  console.log('OBSERVATION:', JSON.stringify(record));
  return record;
}

const codexModels = [
  { id: 'gpt-6-sol', efforts: ['low', 'high'], isDefault: true },
  { id: 'gpt-6-luna', efforts: ['low', 'high'] },
  { id: 'gpt-5.6-luna', efforts: ['low', 'high'] },
  { id: 'gpt-6-astra', efforts: ['low', 'high'] },
];

test('baseline: plain cold execution performs initial probe and launches adapter once', async () => {
  const { adapter, counters } = createInstrumentedFixture('codex', codexModels);
  adapterRegistry.codex = adapter;
  saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  const before = snapshotCounters(counters);
  const start = Date.now();
  const outcome = await executeTask('plain cold prompt', 'plain cold input', { backend: 'codex' }, tempDir);
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(deltas.probes, 1, 'cold run must probe backend exactly once');
  assert.equal(deltas.catalogReads, 1, 'cold run must read catalog exactly once');
  assert.equal(deltas.adapterLaunches, 1, 'cold run must launch adapter exactly once');
  assert.equal(outcome.isError, false);

  const observation = recordObservation('plain_cold', { ...deltas, durationMs, phases: outcome.meta.phases });
  assert.equal(observation.probes, 1);
  assert.equal(observation.catalogReads, 1);
  assert.equal(observation.adapterLaunches, 1);
  assert.ok(typeof observation.preparationDurationMs === 'number', 'preparation phase must be measured');
  assert.ok(typeof outcome.meta.phases.execution === 'number', 'execution phase must be measured');
  assert.ok(typeof outcome.meta.phases.finalization === 'number', 'finalization phase must be measured');
  assert.equal(observation.nativeProcessLaunchOverhead, NOT_MEASURED);
});

test('baseline: plain warm execution reuses probe cache and avoids redundant probes', async () => {
  const { adapter, counters } = createInstrumentedFixture('codex', codexModels);
  adapterRegistry.codex = adapter;
  saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  // First run (warmup)
  await executeTask('warmup', 'warmup', { backend: 'codex' }, tempDir);
  assert.equal(counters.probes, 1);
  assert.equal(counters.catalogReads, 0);
  assert.equal(counters.adapterLaunches, 1);

  // Second run (warm)
  const before = snapshotCounters(counters);
  const start = Date.now();
  const outcome = await executeTask('plain warm prompt', 'plain warm input', { backend: 'codex' }, tempDir);
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(deltas.probes, 0, 'warm run must reuse probe without reprobing');
  assert.equal(deltas.catalogReads, 0, 'warm run must reuse catalog without re-reading');
  assert.equal(deltas.adapterLaunches, 1, 'warm run launches adapter exactly once');
  assert.equal(outcome.isError, false);

  const observation = recordObservation('plain_warm', { ...deltas, durationMs, phases: outcome.meta.phases });
  assert.equal(observation.probes, 0);
  assert.equal(observation.catalogReads, 0);
  assert.equal(observation.adapterLaunches, 1);
  assert.ok(typeof observation.acquisitionDurationMs === 'number', 'acquisition phase must be measured');
});

test('baseline: explicit model and effort passes validated selection to adapter', async () => {
  const { adapter, counters } = createInstrumentedFixture('codex', codexModels);
  adapterRegistry.codex = adapter;
  saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  const before = snapshotCounters(counters);
  const start = Date.now();
  const outcome = await executeTask(
    'explicit model prompt',
    'explicit model input',
    { backend: 'codex', model: 'gpt-6-sol', reasoning_effort: 'high' },
    tempDir
  );
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(deltas.catalogReads, 0, 'explicit model must reuse catalog without re-reading');
  assert.equal(deltas.adapterLaunches, 1);
  const last = counters.launches[counters.launches.length - 1];
  assert.equal(last.options.model, 'gpt-6-sol');
  assert.equal(last.options.reasoningEffort, 'high');
  assert.equal(outcome.isError, false);

  const observation = recordObservation('explicit_model_effort', { ...deltas, durationMs }, {
    model: 'gpt-6-sol',
    reasoningEffort: 'high',
  });
  assert.equal(observation.adapterLaunches, 1);
  assert.equal(observation.catalogReads, 0);
  assert.equal(observation.clientTransportLatency, NOT_MEASURED);
});

test('baseline: priced auto resolves highest qualifying model below ceiling', async () => {
  const { adapter, counters } = createInstrumentedFixture('codex', codexModels);
  adapterRegistry.codex = adapter;
  saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  const before = snapshotCounters(counters);
  const start = Date.now();
  // gpt-6-sol is 10 USD, gpt-5.6-luna is 1.2 USD, gpt-6-luna is 0.5 USD. Ceiling = 5 USD -> gpt-5.6-luna
  const outcome = await executeTask(
    'priced prompt',
    'priced input',
    { backend: 'codex', output_price_below: 5 },
    tempDir
  );
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(deltas.catalogReads, 0, 'priced auto must reuse catalog without re-reading');
  assert.equal(deltas.adapterLaunches, 1);
  const parsed = readResult(outcome);
  assert.equal(parsed.model, 'gpt-5.6-luna');
  assert.match(outcome.price || '', /below the limit of 5 USD/);

  const observation = recordObservation('priced_auto', { ...deltas, durationMs, phases: outcome.meta.phases }, {
    selectedModel: parsed.model,
    priceLimit: 5,
  });
  assert.equal(observation.adapterLaunches, 1);
  assert.equal(observation.catalogReads, 0);
  assert.ok(typeof observation.consentDurationMs === 'number', 'consent phase must be measured');
});

test('baseline: continuation reuses session lease and propagates native session identity', async () => {
  const { adapter, counters } = createInstrumentedFixture('codex', codexModels);
  adapterRegistry.codex = adapter;
  saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  // Turn 1
  const turn1 = await executeTask('turn 1', 'turn 1', { backend: 'codex' }, tempDir);
  assert.ok(turn1.sessionHandle);
  assert.equal(counters.adapterLaunches, 1);

  // Turn 2
  const before = snapshotCounters(counters);
  const start = Date.now();
  const turn2 = await executeTask(
    'turn 2 continuation',
    'turn 2 continuation',
    { backend: 'codex', session_handle: turn1.sessionHandle },
    tempDir
  );
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(deltas.adapterLaunches, 1, 'continuation turn launches adapter once');
  assert.equal(deltas.probes, 0, 'continuation reuses probed session backend');
  assert.equal(deltas.catalogReads, 0, 'continuation reuses session catalog');
  assert.equal(turn2.meta.turn, 2, 'continuation turn number must advance to 2');
  assert.equal(turn2.sessionHandle, turn1.sessionHandle, 'continuation must keep identical session handle');

  const lastLaunch = counters.launches[counters.launches.length - 1];
  assert.equal(lastLaunch.options.nativeSessionId, 'codex-native-1', 'continuation must pass native thread/session ID');

  const observation = recordObservation('continuation', {
    ...deltas,
    durationMs,
    phases: turn2.meta.phases,
  }, { turn: 2, handle: turn1.sessionHandle });
  assert.equal(observation.adapterLaunches, 1);
  assert.ok(typeof observation.finalizationDurationMs === 'number', 'finalization phase must be measured');
});

test('baseline: review workflow collects git diff, evaluates state envelope, and passes gate', async () => {
  const repoDir = path.join(tempDir, 'review-baseline-repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Baseline Fixture');
  git('config', 'user.email', 'baseline@example.invalid');
  fs.writeFileSync(path.join(repoDir, 'code.ts'), 'export const val = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'initial commit');

  // Introduce an uncommitted change
  fs.writeFileSync(path.join(repoDir, 'code.ts'), 'export const val = 2;\n');

  let reviewPrompt = '';
  const { adapter, counters } = createInstrumentedFixture('codex', codexModels, {
    onExecute: async (prompt, opts, c) => {
      reviewPrompt = prompt;
      const snapshotMatch = prompt.match(/^SNAPSHOT:\s+(.+)$/m);
      const snapshot = snapshotMatch ? snapshotMatch[1] : 'unknown';
      return {
        status: 'completed',
        isError: false,
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          'Reviewed: inspected uncommitted diff in code.ts',
          '[P3] code.ts:1',
          'Problem: Value updated cleanly.',
          'CHECKS: typecheck=PASS; tests=PASS',
          'END_REVIEW',
        ].join('\n'),
        nativeSessionId: `codex-native-review-${c.adapterLaunches}`,
        model: opts.model || 'gpt-6-sol',
        truncated: false,
        continuationAvailable: true,
      };
    },
  });

  adapterRegistry.codex = adapter;
  saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  const before = snapshotCounters(counters);
  const start = Date.now();
  let reviewTrace = null;
  const reviewResult = await handleReview('review', {}, repoDir, null, null, {
    onTiming: trace => {
      reviewTrace = trace;
    },
  });
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(deltas.adapterLaunches, 1);
  assert.ok(reviewPrompt.includes('+export const val = 2;'), 'review prompt must contain git diff');
  const parsed = readResult(reviewResult);
  assert.equal(parsed.verdict, 'READY', 'state envelope verdict must evaluate to READY');

  const observation = recordObservation('review', { ...deltas, durationMs, phases: reviewTrace?.phases }, {
    verdict: 'READY',
    diffObserved: true,
  });
  assert.equal(observation.adapterLaunches, 1);
  assert.ok(typeof observation.preparationDurationMs === 'number', 'preparation phase must be measured');
  assert.ok(typeof observation.gitCollectionDurationMs === 'number', 'git_collection phase must be measured');
});

test('baseline: concurrent runs coalesce probes and execute tasks concurrently behind barrier', async () => {
  const concurrency = 4;
  let activeExecutions = 0;
  let maxActiveExecutions = 0;
  let releaseBarrier;
  let barrierTimeout;
  const barrierPromise = new Promise(resolve => {
    releaseBarrier = resolve;
    barrierTimeout = setTimeout(() => {
      resolve();
    }, 5000);
  });

  const { adapter, counters } = createInstrumentedFixture('agy', [
    { id: 'gemini-3.8-flash', efforts: ['low', 'high'], isDefault: true },
  ], {
    onExecute: async (_prompt, opts, c) => {
      activeExecutions++;
      if (activeExecutions > maxActiveExecutions) {
        maxActiveExecutions = activeExecutions;
      }
      if (activeExecutions === concurrency) {
        clearTimeout(barrierTimeout);
        releaseBarrier();
      }
      try {
        await barrierPromise;
      } finally {
        activeExecutions--;
      }
      return {
        status: 'completed',
        isError: false,
        output: `concurrent answer ${c.adapterLaunches}`,
        nativeSessionId: `agy-native-concurrent-${c.adapterLaunches}`,
        model: opts.model || 'gemini-3.8-flash',
        truncated: false,
        continuationAvailable: true,
      };
    },
  });
  adapterRegistry.agy = adapter;
  saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  const before = snapshotCounters(counters);
  const start = Date.now();
  const taskPromises = Array.from({ length: concurrency }, (_, i) =>
    executeTask(`concurrent prompt ${i}`, `concurrent input ${i}`, { backend: 'agy' }, tempDir)
  );

  let results;
  try {
    results = await Promise.all(taskPromises);
  } finally {
    clearTimeout(barrierTimeout);
    releaseBarrier();
    await Promise.allSettled(taskPromises);
  }
  const durationMs = Date.now() - start;
  const deltas = counterDeltas(counters, before);

  assert.equal(results.length, concurrency);
  assert.ok(results.every(r => !r.isError));
  assert.equal(deltas.adapterLaunches, concurrency, `all ${concurrency} tasks must launch adapter`);
  assert.equal(deltas.probes, 1, 'concurrent tasks must share single coalesced probe');
  assert.equal(maxActiveExecutions, concurrency, 'all tasks must execute concurrently behind synchronization barrier');

  const distinctHandles = new Set(results.map(r => r.sessionHandle));
  assert.equal(distinctHandles.size, concurrency, 'concurrent tasks must have distinct session handles');

  const observation = recordObservation('concurrent_coalesced', {
    ...deltas,
    durationMs,
  }, { concurrency, maxActiveExecutions });
  assert.equal(observation.probes, 1);
  assert.equal(observation.adapterLaunches, concurrency);
  assert.equal(observation.clientTransportLatency, NOT_MEASURED);
});

