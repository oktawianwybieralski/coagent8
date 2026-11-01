'use strict';

/**
 * EXEC-001-T02b: Controller phase timing instrumentation tests.
 *
 * Verifies:
 * - All 5 execution phases (preparation, consent, acquisition, execution, finalization) are recorded.
 * - Deliberate fixture delays enter the corresponding phase spans.
 * - Existing meta.durationMs retains its meaning.
 * - Internal timing observer (onTiming) receives traces on early failures without altering public error shape.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-controller-timing-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { saveConfig } = require('../../src/config.ts');

const originalRegistry = {
  codex: adapterRegistry.codex,
  agy: adapterRegistry.agy,
  claude: adapterRegistry.claude,
};

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('controller records all 5 execution phases on normal run', async () => {
  let observedTrace;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false }],
    }),
    execute: async () => {
      // Deliberate adapter delay
      await new Promise(r => setTimeout(r, 40));
      return {
        status: 'completed',
        isError: false,
        output: 'timing response',
        nativeSessionId: 'agy-native-timing',
        model: 'gemini-3.8-flash',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  const result = await executeTask('test prompt', 'test input', { backend: 'agy' }, tempDir, null, null, {
    onTiming: trace => {
      observedTrace = trace;
    },
  });

  assert.equal(result.isError, false);
  assert.ok(result.meta.phases, 'meta.phases must be present');
  assert.equal(typeof result.meta.phases.preparation, 'number');
  assert.equal(typeof result.meta.phases.consent, 'number');
  assert.equal(typeof result.meta.phases.acquisition, 'number');
  assert.equal(typeof result.meta.phases.execution, 'number');
  assert.equal(typeof result.meta.phases.finalization, 'number');

  // Execution phase and durationMs should reflect adapter delay (at least 30ms)
  assert.ok(result.meta.phases.execution >= 30, `execution phase (${result.meta.phases.execution}ms) should reflect delay`);
  assert.ok(result.meta.durationMs >= 30, `durationMs (${result.meta.durationMs}ms) retains existing meaning`);

  // onTiming observer received trace
  assert.ok(observedTrace, 'internal onTiming observer must receive trace');
  assert.deepEqual(observedTrace.phases, result.meta.phases);
});

test('controller records deliberate consent phase delay', async () => {
  adapterRegistry.codex = {
    id: 'codex',
    name: 'codex-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'codex-fixture',
      models: [{ id: 'gpt-6-expensive', displayName: 'Expensive', default: true, reasoningEffort: false }],
    }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'consent answer',
      nativeSessionId: 'codex-native-consent',
      model: 'gpt-6-expensive',
      truncated: false,
      continuationAvailable: true,
    }),
  };

  await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  let consentTime = 0;
  const result = await executeTask(
    'expensive prompt',
    'expensive input',
    { backend: 'codex', model: 'gpt-6-expensive' },
    tempDir,
    null,
    null,
    {
      askConsent: async () => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, 50));
        consentTime = Date.now() - start;
        return { approved: true };
      },
    },
  );

  assert.equal(result.isError, false);
  assert.ok(result.meta.phases.consent >= 40, `consent phase (${result.meta.phases.consent}ms) must reflect prompt delay`);
});

test('controller onTiming observer captures early failure before session creation without changing error shape', async () => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-expensive', displayName: 'Exp', default: true, reasoningEffort: false }],
    }),
    execute: async () => {
      throw new Error('Should not reach execute');
    },
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  let observedTrace;
  await assert.rejects(
    async () => {
      await executeTask('fail prompt', 'fail input', { backend: 'agy', model: 'gemini-expensive' }, tempDir, null, null, {
        askConsent: async () => {
          await new Promise(r => setTimeout(r, 20));
          return { approved: false };
        },
        onTiming: trace => {
          observedTrace = trace;
        },
      });
    },
    err => {
      // Must preserve exact public error code and message
      assert.equal(err.code, 'POLICY_DENIED');
      return true;
    },
  );

  // onTiming must still have received the partial trace
  assert.ok(observedTrace, 'internal onTiming observer must receive trace on early failure');
  assert.equal(typeof observedTrace.phases.preparation, 'number');
  assert.equal(typeof observedTrace.phases.consent, 'number');
  assert.ok(observedTrace.phases.consent >= 15, 'consent phase in trace must capture delay before refusal');
  // acquisition and execution should NOT have run
  assert.equal(observedTrace.phases.acquisition, undefined);
  assert.equal(observedTrace.phases.execution, undefined);
});

test('controller isolates throwing onTiming observer on successful execution', async () => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false }],
    }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'success answer',
      nativeSessionId: 'agy-native-success',
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    }),
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  const result = await executeTask('test prompt', 'test input', { backend: 'agy' }, tempDir, null, null, {
    onTiming: () => {
      throw new Error('Exploding observer failure');
    },
  });

  assert.equal(result.isError, false, 'Execution must succeed despite observer throwing');
  assert.ok(result.warnings.some(w => w.includes('Timing observer failed') && w.includes('Exploding observer failure')));
});

test('controller isolates throwing onTiming observer during early failure and preserves original error', async () => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-expensive', displayName: 'Exp', default: true, reasoningEffort: false }],
    }),
    execute: async () => {
      throw new Error('Should not reach execute');
    },
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  await assert.rejects(
    async () => {
      await executeTask('fail prompt', 'fail input', { backend: 'agy', model: 'gemini-expensive' }, tempDir, null, null, {
        askConsent: async () => ({ approved: false }),
        onTiming: () => {
          throw new Error('Exploding observer on denial');
        },
      });
    },
    err => {
      // Must preserve original error code POLICY_DENIED, NOT observer error
      assert.equal(err.code, 'POLICY_DENIED');
      assert.ok(!err.message.includes('Exploding observer on denial'));
      return true;
    },
  );
});

test('controller isolates unstringifiable thrown values from onTiming observer', async () => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [
        { id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false },
        { id: 'gemini-expensive', displayName: 'Exp', default: false, reasoningEffort: false },
      ],
    }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'unstringifiable answer',
      nativeSessionId: 'agy-native-unstringifiable',
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    }),
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  // On success with unstringifiable throw
  const result = await executeTask('test prompt', 'test input', { backend: 'agy' }, tempDir, null, null, {
    onTiming: () => {
      // Object.create(null) has no prototype and cannot be converted by String()
      throw Object.create(null);
    },
  });

  assert.equal(result.isError, false);
  assert.ok(result.warnings.some(w => w.includes('Timing observer failed')));

  // On early denial with unstringifiable throw
  await assert.rejects(
    async () => {
      await executeTask('fail prompt', 'fail input', { backend: 'agy', model: 'gemini-expensive' }, tempDir, null, null, {
        askConsent: async () => ({ approved: false }),
        onTiming: () => {
          throw Object.create(null);
        },
      });
    },
    err => {
      assert.equal(err.code, 'POLICY_DENIED');
      return true;
    },
  );
});

test('controller isolates rejected asynchronous onTiming observers without unhandled rejections', async () => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [
        { id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false },
        { id: 'gemini-expensive', displayName: 'Exp', default: false, reasoningEffort: false },
      ],
    }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'async answer',
      nativeSessionId: 'agy-native-async',
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    }),
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  // Async observer rejecting on success
  const result = await executeTask('test prompt', 'test input', { backend: 'agy' }, tempDir, null, null, {
    onTiming: async () => {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('Async observer explosion');
    },
  });

  assert.equal(result.isError, false);
  assert.ok(
    result.warnings.some(w => w.includes('Timing observer failed') && w.includes('Async observer explosion')),
    'Async observer error must be visible in warnings',
  );

  // Async observer rejecting on early denial
  await assert.rejects(
    async () => {
      await executeTask('fail prompt', 'fail input', { backend: 'agy', model: 'gemini-expensive' }, tempDir, null, null, {
        askConsent: async () => ({ approved: false }),
        onTiming: async () => {
          await new Promise(r => setTimeout(r, 10));
          throw new Error('Async observer explosion on denial');
        },
      });
    },
    err => {
      assert.equal(err.code, 'POLICY_DENIED');
      return true;
    },
  );
});

test('controller bounds slow async observer and does not inflate meta.durationMs', async () => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false }],
    }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'fast answer',
      nativeSessionId: 'agy-native-fast',
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    }),
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  // Observer that takes 600ms (exceeding the 500ms bound) before rejecting
  const result = await executeTask('test prompt', 'test input', { backend: 'agy' }, tempDir, null, null, {
    clock: () => 1000,
    onTiming: async () => {
      await new Promise(r => setTimeout(r, 600));
      throw new Error('Late rejection after timeout');
    },
  });

  assert.equal(result.isError, false);
  // Must record timeout warning
  assert.ok(result.warnings.some(w => w.includes('Timing observer timed out after 500ms')));
  // meta.durationMs must NOT include the 500ms observer wait
  assert.ok(result.meta.durationMs < 500, `durationMs (${result.meta.durationMs}ms) must not be inflated by 500ms observer wait`);
});

test('early controller failure with borrowed tracker closes controller spans without completing caller tracker', async () => {
  const { createPhaseTracker } = require('../../src/execution/runtime/timing.ts');
  let now = 1000;
  const clock = () => now;
  const callerTracker = createPhaseTracker({ clock });

  const callerSpan1 = callerTracker.startPhase('caller_setup');
  now = 1050;
  callerSpan1.end();

  now = 1100;
  // Trigger early controller failure (invalid model identifier)
  let capturedTrace = null;
  await assert.rejects(
    async () => {
      await executeTask('prompt', 'input', { backend: 'agy', model: '--invalid-flag-model' }, tempDir, null, null, {
        tracker: callerTracker,
        onTiming: trace => {
          capturedTrace = trace;
        },
      });
    },
    err => {
      assert.equal(err.code, 'INPUT_LIMIT');
      return true;
    },
  );

  // Failure trace captured
  assert.ok(capturedTrace);
  assert.equal(capturedTrace.phases.preparation, 0);

  // Advance clock significantly
  now = 2000;

  // Caller continues recording on the same tracker
  const callerSpan2 = callerTracker.startPhase('caller_recovery');
  now = 2100;
  callerSpan2.end();

  const finalTrace = callerTracker.complete();
  // caller_recovery duration must be 100ms
  assert.equal(finalTrace.phases.caller_recovery, 100);
  // preparation phase MUST NOT have inflated
  assert.equal(finalTrace.phases.preparation, 0, 'preparation phase must not inflate after early controller failure');
});

test('EXEC-001-T11c: teardown and verification time are included in reported total duration', async () => {
  let now = 1000;
  const clock = () => now;

  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false }],
    }),
    execute: async () => {
      now = 2000; // 1000ms spent in execution
      return {
        status: 'completed',
        isError: false,
        output: 'teardown timing answer',
        nativeSessionId: 'agy-native-teardown-timing',
        model: 'gemini-3.8-flash',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  const result = await executeTask('test prompt', 'test input', { backend: 'agy' }, tempDir, null, null, {
    clock,
    releaseSessionTurn: async (handle, token) => {
      now += 300; // 300ms spent in session cleanup
      const { releaseSessionTurn: originalRelease } = require('../../src/sessions/session.ts');
      return originalRelease(handle, token);
    },
    verifyReviewSnapshot: async () => {
      now += 500; // 500ms spent in verification
      return undefined;
    },
  });

  assert.equal(result.isError, false);
  assert.equal(
    result.meta.durationMs,
    1800,
    `total duration (${result.meta.durationMs}ms) must include execution (1000ms), verification (500ms), and cleanup (300ms)`,
  );
  assert.equal(result.meta.totalMs, 1800);
  assert.ok(result.meta.phases.execution >= 1000);
  assert.ok(result.meta.phases.finalization >= 800);
});
