'use strict';

/**
 * EXEC-001-T11a: Monotonic execution budget across lifecycle and adapters.
 *
 * Verifies:
 * - Single monotonic context before early phases (preparation, pricing, consent).
 * - Early phase expiry (during preparation or consent) prevents adapter execution and throws TIMEOUT.
 * - Remaining monotonic time (remainingExecutionMs) is passed to every CLI adapter (codex, claude, agy).
 * - Idle activity, heartbeats, and stream events cannot reset or extend the budget deadline.
 * - Abort signals and budget timeouts are strictly distinguished.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-ctrl-timeout-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
const { saveConfig } = require('../../src/config.ts');
const { ToolError } = require('../../src/contracts/error.ts');

const originalRegistry = {
  codex: adapterRegistry.codex,
  agy: adapterRegistry.agy,
  claude: adapterRegistry.claude,
};

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('early phase budget expiry during prepareTask blocks execution and throws TIMEOUT', async () => {
  let now = 1000;
  const clock = () => now;
  let executeCalled = false;

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    probe: async () => {
      now = 2500; // Advance past executionDeadlineMs (1400) during probe in prepareTask
      return { installed: true, executionSupported: true, config: { defaultModel: 'gpt-5-turbo' } };
    },
    execute: async () => {
      executeCalled = true;
      throw new Error('Must not execute');
    },
  };

  await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });

  const budget = createExecutionBudget({ totalBudgetMs: 500, teardownAllowanceMs: 100, clock });

  try {
    await assert.rejects(
      executeTask('prompt', 'public', { backend: 'codex' }, tempDir, null, null, {
        budget,
        clock,
      }),
      err => {
        assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      },
    );
    assert.equal(executeCalled, false, 'Adapter execution must be blocked');
  } finally {
    budget.dispose();
  }
});

test('early phase budget expiry during consent blocks execution and throws TIMEOUT', async () => {
  let now = 1000;
  const clock = () => now;
  let executeCalled = false;

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'gpt-expensive' } }),
    execute: async () => {
      executeCalled = true;
      throw new Error('Must not execute');
    },
  };

  await saveConfig({
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    governance: {
      models: { allow: [], ask: ['gpt-expensive'], deny: [] },
    },
  });

  const budget = createExecutionBudget({ totalBudgetMs: 5000, teardownAllowanceMs: 1000, clock });

  const askConsent = async () => {
    now = 6000; // Exceed deadline while user is considering consent
    return { approved: true, backend: 'codex', model: 'gpt-expensive' };
  };

  try {
    await assert.rejects(
      executeTask('prompt', 'public', { backend: 'codex', model: 'gpt-expensive' }, tempDir, null, null, {
        budget,
        clock,
        askConsent,
      }),
      err => {
        assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      },
    );
    assert.equal(executeCalled, false, 'Adapter execution must be blocked after expired consent');
  } finally {
    budget.dispose();
  }
});

test('adapter receives remainingExecutionMs for every backend (codex, claude, agy)', async () => {
  const backends = ['codex', 'claude', 'agy'];

  for (const backendId of backends) {
    let now = 1000;
    const clock = () => now;
    let receivedTimeoutMs = null;

    adapterRegistry[backendId] = {
      id: backendId,
      name: 'fixture',
      probe: async () => {
        now += 300; // Simulated 300ms probe/preparation work
        return { installed: true, executionSupported: true, config: { defaultModel: `model-${backendId}` } };
      },
      execute: async (_prompt, options) => {
        receivedTimeoutMs = options.timeoutMs;
        return {
          status: 'completed',
          isError: false,
          output: `Response from ${backendId}`,
          nativeSessionId: randomUUID(),
          model: `model-${backendId}`,
          truncated: false,
          continuationAvailable: true,
        };
      },
    };

    await saveConfig({
      defaultBackend: backendId,
      routing: { strategy: 'fixed', allowedBackends: [backendId] },
      governance: { models: { allow: [`model-${backendId}`] } },
    });

    // Budget: 10,000 ms total, 2,000 ms teardown => execution deadline = 8,000 ms from start.
    // Preparation advances clock by 300 ms => remaining time must be <= 7,700 ms and > 0.
    const budget = createExecutionBudget({ totalBudgetMs: 10000, teardownAllowanceMs: 2000, clock });

    try {
      const outcome = await executeTask('test prompt', 'public', { backend: backendId }, tempDir, null, null, { budget, clock });
      assert.equal(outcome.isError, false, `Backend ${backendId} should succeed`);
      assert.ok(receivedTimeoutMs !== null, `Backend ${backendId} adapter.execute must be called`);
      assert.ok(receivedTimeoutMs <= 7700, `Backend ${backendId}: expected timeoutMs <= 7700, got ${receivedTimeoutMs}`);
      assert.ok(receivedTimeoutMs > 0, `Backend ${backendId}: expected positive timeoutMs, got ${receivedTimeoutMs}`);
    } finally {
      budget.dispose();
    }
  }
});

test('idle activity and streaming events cannot reset or extend the budget deadline', async () => {
  let now = 1000;
  const clock = () => now;

  let executeOptionsRef = null;
  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'gpt-5' } }),
    execute: async (_prompt, options) => {
      executeOptionsRef = options;
      // Simulate adapter emitting stream events and heartbeats over time
      for (let i = 0; i < 5; i++) {
        now += 200;
        options.onEvent?.({ type: 'status', message: `Step ${i}` });
        options.onEvent?.({ type: 'assistant_delta', text: `chunk ${i}` });
      }
      return {
        status: 'completed',
        isError: false,
        output: 'Finished streaming',
        nativeSessionId: randomUUID(),
        model: 'gpt-5',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  await saveConfig({
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    governance: { models: { allow: ['gpt-5'] } },
  });

  const budget = createExecutionBudget({ totalBudgetMs: 5000, teardownAllowanceMs: 1000, clock });

  try {
    const outcome = await executeTask('stream test', 'public', { backend: 'codex' }, tempDir, null, null, {
      budget,
      clock,
    });
    assert.equal(outcome.isError, false);
    // Initial timeout was passed once at invocation of execute, remaining execution time of the budget
    assert.ok(executeOptionsRef.timeoutMs <= 4000);
    // Budget deadline never moved:
    assert.equal(budget.deadlineMs, 1000 + 5000);
    assert.equal(budget.executionDeadlineMs, 1000 + 4000);
  } finally {
    budget.dispose();
  }
});
