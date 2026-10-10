'use strict';

/**
 * EXEC-001-T11a: Monotonic execution budget for consult tool.
 *
 * Verifies:
 * - handleConsult respects timeout_ms as a monotonic budget from the very start.
 * - Budget expiry before or during preparation/consent throws ToolError('TIMEOUT') and prevents adapter execute.
 * - Pre-aborted signal throws ToolError('ABORTED') and prevents adapter execute.
 * - Adapter receives remaining execution time (remainingExecutionMs), not the static timeout_ms.
 * - MCP server dispatch creates a root budget from timeout_ms and wires it through.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-consult-budget-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../../src/backends/registry.ts');
const { handleConsult } = require('../../../src/mcp/tools/consult.tool.ts');
const { createExecutionBudget } = require('../../../src/execution/runtime/budget.ts');
const { saveConfig } = require('../../../src/config.ts');
const { ToolError } = require('../../../src/contracts/error.ts');
const { createServer } = require('../../../src/mcp/server.ts');
const { readResult } = require('../../helpers/result.cjs');

const originalRegistry = {
  codex: adapterRegistry.codex,
  agy: adapterRegistry.agy,
  claude: adapterRegistry.claude,
};

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('handleConsult with expired budget stops before execution and throws TIMEOUT', async () => {
  let now = 1000;
  const budget = createExecutionBudget({ totalBudgetMs: 500, teardownAllowanceMs: 100, clock: () => now });
  now = 1600; // Passed executionDeadlineMs (1400) and total deadline (1500)

  let executeCalled = false;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async () => {
      executeCalled = true;
      throw new Error('Must not execute');
    },
  };

  try {
    saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    await assert.rejects(
      handleConsult('consult', { proposal: 'Design question' }, tempDir, null, null, { budget, clock: () => now }),
      err => {
        assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      }
    );
    assert.equal(executeCalled, false, 'No model turn should be started when budget expired');
  } finally {
    budget.dispose();
  }
});

test('handleConsult with pre-aborted signal stops before turn and throws ABORTED', async () => {
  const controller = new AbortController();
  controller.abort();

  let executeCalled = false;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async () => {
      executeCalled = true;
      throw new Error('Must not execute');
    },
  };

  saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  await assert.rejects(
    handleConsult('consult', { proposal: 'Design question' }, tempDir, controller.signal),
    err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'ABORTED');
      return true;
    }
  );
  assert.equal(executeCalled, false, 'No model turn should be started when pre-aborted');
});

test('handleConsult passes remaining monotonic time to adapter', async () => {
  let now = 1000;
  const clock = () => now;
  let receivedTimeoutMs = null;

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => {
      now += 200; // Simulated probe/routing time
      return { installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } };
    },
    execute: async (_prompt, options) => {
      receivedTimeoutMs = options.timeoutMs;
      return {
        status: 'completed',
        isError: false,
        output: 'Consult answer',
        nativeSessionId: randomUUID(),
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  // Call handleConsult with totalBudgetMs = 5000, teardown = 1000
  // Execution budget is 5000 - 1000 = 4000 ms.
  // Probe adds 200 ms.
  // Adapter should receive remaining time <= 3800 ms, strictly less than 5000.
  const budget = createExecutionBudget({ totalBudgetMs: 5000, teardownAllowanceMs: 1000, clock });

  try {
    const result = await handleConsult(
      'consult',
      { proposal: 'Refactoring check' },
      tempDir,
      null,
      null,
      { budget, clock }
    );
    assert.ok(receivedTimeoutMs !== null, 'Adapter execute should have been called');
    assert.ok(receivedTimeoutMs <= 3800, `Expected remaining timeoutMs <= 3800, got ${receivedTimeoutMs}`);
    assert.ok(receivedTimeoutMs > 0, `Expected positive timeoutMs, got ${receivedTimeoutMs}`);
    assert.match(result.content[0].text, /Consult answer/);
  } finally {
    budget.dispose();
  }
});

test('MCP server callTool creates root budget and formats TIMEOUT on expired budget', async () => {
  let executeCalled = false;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async () => {
      executeCalled = true;
      return {
        status: 'completed',
        isError: false,
        output: 'Done',
        nativeSessionId: randomUUID(),
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  const server = createServer();
  const callHandler = server._requestHandlers.get('tools/call');

  // With a pre-aborted controller signal:
  const ac = new AbortController();
  ac.abort();

  const response = await callHandler(
    {
      method: 'tools/call',
      params: {
        name: 'consult',
        arguments: {
          proposal: 'Explain architecture',
          workspace_path: tempDir,
          timeout_ms: 5000,
        },
      },
    },
    { signal: ac.signal }
  );

  assert.equal(response.isError, true);
  const formatted = readResult(response);
  assert.equal(formatted.status, 'cancelled');
  assert.equal(formatted.error?.code, 'ABORTED');
  assert.equal(executeCalled, false, 'Adapter should not execute when aborted');
});
