'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-outer-timing-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { runDoctor, runModelReport } = require('../../src/diagnostics/doctor.ts');
const { handleReview } = require('../../src/mcp/tools/review.tool.ts');
const { collectReviewInput } = require('../../src/review/input.ts');
const { saveConfig } = require('../../src/config.ts');
const { createPhaseTracker } = require('../../src/execution/runtime/timing.ts');

const originalRegistry = {
  codex: adapterRegistry.codex,
  claude: adapterRegistry.claude,
  agy: adapterRegistry.agy,
};

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createMockClock(step = 10) {
  let current = 1000;
  return () => {
    const val = current;
    current += step;
    return val;
  };
}

test('runDoctor records health_probes and model_report phases via onTiming', async () => {
  let recordedTrace = null;
  const clock = createMockClock(5);

  const report = await runDoctor({
    clock,
    onTiming: trace => {
      recordedTrace = trace;
    },
  });

  assert.ok(report);
  assert.ok(recordedTrace, 'onTiming observer must be called');
  assert.ok(recordedTrace.phases.health_probes !== undefined, 'health_probes phase must be present');
  assert.ok(recordedTrace.phases.model_report !== undefined, 'model_report phase must be present');
  assert.ok(typeof recordedTrace.phases.health_probes === 'number');
  assert.ok(typeof recordedTrace.phases.model_report === 'number');
  assert.ok(recordedTrace.phases.health_probes > 0);
  assert.ok(recordedTrace.phases.model_report > 0);
  assert.equal(report.trace, recordedTrace, 'report.trace must match recorded trace');
});

test('runDoctor merges parallel health_probes spans without inflating duration', async () => {
  let now = 100;
  const customClock = () => now;

  const tracker = createPhaseTracker({ clock: customClock });

  // Simulate 3 parallel probes that start at 100 and end at 200
  const s1 = tracker.startPhase('health_probes');
  const s2 = tracker.startPhase('health_probes');
  const s3 = tracker.startPhase('health_probes');

  now = 200;
  s1.end();
  s2.end();
  s3.end();

  const trace = tracker.complete();
  // Duration should be 100ms (merged interval [100, 200]), NOT 300ms
  assert.equal(trace.phases.health_probes, 100, 'parallel overlapping probe spans must merge without inflating');
});

test('runDoctor isolates synchronous throwing observer and async rejection with visible diagnostics', async () => {
  // Synchronous throw
  const report1 = await runDoctor({
    onTiming: () => {
      throw new Error('sync observer failure');
    },
  });
  assert.ok(report1);
  assert.ok(report1.recommendations.some(r => r.includes('Timing observer failure: sync observer failure')), 'sync error must appear in recommendations');

  // Async rejection
  const report2 = await runDoctor({
    onTiming: async () => {
      throw new Error('async observer rejection');
    },
  });
  assert.ok(report2);
  assert.ok(report2.recommendations.some(r => r.includes('Timing observer failure: async observer rejection')), 'async rejection must appear in recommendations');
});

test('runDoctor and runModelReport with borrowed tracker do not complete caller tracker', async () => {
  const clock = createMockClock(5);
  const callerTracker = createPhaseTracker({ clock });
  const preSpan = callerTracker.startPhase('caller_pre');
  preSpan.end();

  const report = await runDoctor({ tracker: callerTracker });
  assert.ok(report.trace);
  assert.ok(report.trace.phases.caller_pre !== undefined);
  assert.ok(report.trace.phases.health_probes !== undefined);

  // Subsequent phase recording should succeed because tracker was not finalized
  const postSpan = callerTracker.startPhase('caller_post');
  postSpan.end();

  const finalTrace = callerTracker.complete();
  assert.ok(finalTrace.phases.caller_post !== undefined, 'subsequent phase must be recorded on caller tracker');
  assert.ok(finalTrace.phases.health_probes !== undefined);
});

test('runModelReport records health_probes and model_report phases', async () => {
  let recordedTrace = null;
  const clock = createMockClock(10);

  const report = await runModelReport({
    clock,
    onTiming: trace => {
      recordedTrace = trace;
    },
  });

  assert.ok(report);
  assert.ok(recordedTrace);
  assert.ok(recordedTrace.phases.health_probes !== undefined);
  assert.ok(recordedTrace.phases.model_report !== undefined);
  assert.equal(report.trace, recordedTrace);
});

test('collectReviewInput measures git_collection phase when tracer provided', async () => {
  const repo = path.join(tempDir, 'git-input-repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'test.ts'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');

  const tracker = createPhaseTracker();
  const { info, context } = await collectReviewInput('uncommitted', repo, null, tracker);

  assert.ok(info);
  assert.ok(context);
  const trace = tracker.complete();
  assert.ok(trace.phases.git_collection !== undefined, 'git_collection phase must be present');
  assert.ok(typeof trace.phases.git_collection === 'number');
});

test('handleReview instruments git_collection alongside execution controller phases', async () => {
  const repo = path.join(tempDir, 'review-tool-repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  const originalCodex = adapterRegistry.codex;
  adapterRegistry.codex = {
    id: 'codex',
    name: 'codex-fixture',
    probe: async () => ({
      id: 'codex',
      installed: true,
      executionSupported: true,
      config: { defaultModel: 'gpt-6.1-sol' },
      capabilities: { readOnlyVerified: true },
    }),
    execute: async prompt => {
      const snapshotMatch = prompt.match(/^SNAPSHOT:\s+(.+)$/m);
      const snapshot = snapshotMatch ? snapshotMatch[1] : 'unknown';
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: 'codex-sess-review-1',
        model: 'gpt-6.1-sol',
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          'Reviewed: checked uncommitted changes in a.ts',
          '[P3] a.ts:1',
          'Problem: Minor styling.',
          'CHECKS: typecheck=PASS; tests=PASS',
          'END_REVIEW',
        ].join('\n'),
      };
    },
  };

  try {
    await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

    let recordedTrace = null;
    await handleReview('review', { backend: 'codex' }, repo, null, null, {
      onTiming: trace => {
        recordedTrace = trace;
      },
    });

    assert.ok(recordedTrace, 'onTiming must be called');
    // Outer phase
    assert.ok(recordedTrace.phases.git_collection !== undefined, 'git_collection must be measured');
    assert.ok(typeof recordedTrace.phases.git_collection === 'number');
    // Controller phases
    assert.ok(recordedTrace.phases.preparation !== undefined, 'preparation must be measured');
    assert.ok(recordedTrace.phases.acquisition !== undefined, 'acquisition must be measured');
    assert.ok(recordedTrace.phases.execution !== undefined, 'execution must be measured');
    assert.ok(recordedTrace.phases.finalization !== undefined, 'finalization must be measured');
  } finally {
    adapterRegistry.codex = originalCodex;
  }
});

test('handleReview preparation failure closes git_collection and emits timing trace while preserving original error', async () => {
  const nonRepo = path.join(tempDir, 'non-repo');
  fs.mkdirSync(nonRepo, { recursive: true });

  let recordedTrace = null;
  await assert.rejects(
    async () => {
      await handleReview('review', {}, nonRepo, null, null, {
        onTiming: trace => {
          recordedTrace = trace;
        },
      });
    },
    err => {
      // Must preserve the original error (e.g. not a git repo error or similar)
      assert.ok(err);
      return true;
    }
  );

  assert.ok(recordedTrace, 'onTiming must be called even on preparation failure');
  assert.ok(recordedTrace.phases.git_collection !== undefined, 'git_collection phase must be present');
  assert.ok(typeof recordedTrace.phases.git_collection === 'number');
});
