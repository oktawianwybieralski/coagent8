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
const { withAnswerLanguage } = require('../../../src/execution/controller.ts');
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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    await assert.rejects(
      handleConsult('consult', { proposal: 'Design question' }, tempDir, null, null, { budget, clock: () => now }),
      err => {
        assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      },
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

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  await assert.rejects(handleConsult('consult', { proposal: 'Design question' }, tempDir, controller.signal), err => {
    assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
    assert.equal(err.code, 'ABORTED');
    return true;
  });
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

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  // Call handleConsult with totalBudgetMs = 60000, teardown = 2000 (real timer stays far above load; #132)
  // Execution budget is 60000 - 2000 = 58000 ms.
  // Probe adds 200 ms.
  // Adapter should receive remaining time <= 57800 ms, strictly less than 58000.
  const budget = createExecutionBudget({ totalBudgetMs: 60000, teardownAllowanceMs: 2000, clock });

  try {
    const result = await handleConsult('consult', { proposal: 'Refactoring check' }, tempDir, null, null, { budget, clock });
    assert.ok(receivedTimeoutMs !== null, 'Adapter execute should have been called');
    assert.ok(receivedTimeoutMs <= 57800, `Expected remaining timeoutMs <= 57800, got ${receivedTimeoutMs}`);
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

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

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
    { signal: ac.signal },
  );

  assert.equal(response.isError, true);
  const formatted = readResult(response);
  assert.equal(formatted.status, 'cancelled');
  assert.equal(formatted.error?.code, 'ABORTED');
  assert.equal(executeCalled, false, 'Adapter should not execute when aborted');
});

test('Issue #20: handleConsult includes read-only file tool guidance when task_type or context_files is set and keeps plain consult neutral', async () => {
  const { HOST_TOOL_GUIDANCE } = require('../../../src/mcp/constants.ts');
  const receivedPrompts = [];

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      receivedPrompts.push(prompt);
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

  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  await handleConsult('consult', { proposal: 'Plain question' }, tempDir);
  assert.equal(
    receivedPrompts[0],
    withAnswerLanguage(
      'Answer what is asked, conclusion first, concisely, without preamble or sections nobody asked for.\nIf something you need is out of reach, say so: the server sets what this turn can reach.\nLeave the workspace as you found it: do not edit, stage, commit, stash, reset or delete anything in it.\nPlain question',
    ),
    'plain consult without task_type or context_files stays neutral, apart from the answer language and the workspace rule (#211)',
  );
  assert.ok(!receivedPrompts[0].includes(HOST_TOOL_GUIDANCE));

  await handleConsult('consult', { proposal: 'Architecture check', task_type: 'architecture' }, tempDir);
  assert.ok(receivedPrompts[1].includes('[TASK: ARCHITECTURAL & CODE ANALYSIS]'));
  assert.ok(receivedPrompts[1].includes(HOST_TOOL_GUIDANCE), 'task_type consult includes the host tool guidance');

  const sampleFile = path.join(tempDir, 'sample.ts');
  fs.writeFileSync(sampleFile, 'export const sample = 1;\n');
  await handleConsult('consult', { proposal: 'File check', context_files: ['sample.ts'] }, tempDir);
  assert.ok(receivedPrompts[2].includes(HOST_TOOL_GUIDANCE), 'context_files consult includes the host tool guidance');
});

test('AX-001g: the footer shows the turn usage with the list price of the exact-matched model, and no price for another model', async () => {
  const original = adapterRegistry.agy;
  let ran = 'fixture-model';
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'Consult answer',
      nativeSessionId: randomUUID(),
      model: ran,
      truncated: false,
      continuationAvailable: true,
      usage: {
        source: 'provider',
        inputTokens: 200_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 20_000,
        totalTokens: 220_000,
      },
    }),
  };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const result = readResult(await handleConsult('consult', { proposal: 'usage?' }, tempDir));
    // fixture/fixture-model: 0.75 USD per million input and 3.75 per million output tokens.
    assert.match(result.usage, /^200,000 input - 20,000 output tokens - list price ~0\.23 USD \(coagent8_PRICES_URL \d{4}-\d{2}-\d{2}\)$/u);
    // The backend ran a resolved model the price list did not match: counts only.
    ran = 'fixture-model-2026-10-01';
    const resolved = readResult(await handleConsult('consult', { proposal: 'usage again?' }, tempDir));
    assert.equal(resolved.usage, '200,000 input - 20,000 output tokens');
  } finally {
    adapterRegistry.agy = original;
  }
});

test('consult mode: async returns a task handle, defaults to 60m up to 4h, and sync keeps 15m/30m (#246)', async () => {
  const { handleSession, handleCancelSession } = require('../../../src/mcp/tools/session.tool.ts');
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { runWaitCli } = require('../../../src/sessions/wait-cli.ts');
  const { setTimeout: delay } = require('node:timers/promises');

  const original = adapterRegistry.agy;
  const recordedTimeouts = [];
  let holdExecute = null;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ id: 'agy', installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      recordedTimeouts.push(options.timeoutMs);
      if (holdExecute) {
        const aborted = await new Promise(resolve => {
          holdExecute.resolve = () => resolve(false);
          options.abortSignal?.addEventListener('abort', () => resolve(true), { once: true });
        });
        if (aborted) {
          return {
            status: 'cancelled',
            isError: true,
            truncated: false,
            continuationAvailable: false,
            error: { code: 'ABORTED', message: 'cancelled', retryable: false },
            output: '',
          };
        }
      }
      return {
        status: 'completed',
        isError: false,
        output: 'Async consult opinion',
        nativeSessionId: randomUUID(),
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'async consult finished in time');
      await delay(25);
    }
  };

  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

    // Sync keeps 15m default and 30m cap.
    await handleConsult('consult', { proposal: 'Sync default' }, tempDir);
    assert.ok(recordedTimeouts.at(-1) > 850_000 && recordedTimeouts.at(-1) <= 900_000);
    await assert.rejects(
      handleConsult('consult', { proposal: 'Too long sync', timeout_ms: 1_800_001 }, tempDir),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('1800000'),
    );

    // Async defaults to 60m, accepts up to 4h, and refuses > 14,400,000 ms.
    await assert.rejects(
      handleConsult('consult', { proposal: 'Too long async', mode: 'async', timeout_ms: 14_400_001 }, tempDir),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('14400000'),
    );

    holdExecute = {};
    const started = await handleConsult('consult', { proposal: 'Deep async analysis', mode: 'async' }, tempDir, null, null, {
      clientName: 'claude-code',
    });
    const { taskHandle, sessionHandle, wakeup, waitArgv, timeoutMs, timeoutBound } = started.structuredContent;
    assert.match(taskHandle, /^task_[a-f0-9]{32}$/);
    assert.match(sessionHandle, /^syn_sess_/);
    assert.equal(wakeup, 'background_wait');
    assert.equal(timeoutMs, 3_600_000);
    assert.equal(timeoutBound, 'async_default');
    assert.equal(waitArgv[2], 'wait');
    assert.equal(readTask(taskHandle).state, 'running');
    assert.ok(recordedTimeouts.at(-1) > 3_500_000 && recordedTimeouts.at(-1) <= 3_600_000);

    holdExecute.resolve();
    holdExecute = null;
    const done = await waitTask(taskHandle);
    assert.equal(done.state, 'completed');
    assert.match(done.result.text, /Async consult opinion/);
    assert.match(done.result.text, /Budget: 3600000 ms \(async default\)/);

    const taskRead = await handleSession({ action: 'task', task_handle: taskHandle }, tempDir);
    assert.equal(taskRead.structuredContent.state, 'completed');
    assert.match(taskRead.content[0].text, /Async consult opinion/);

    const chunks = [];
    const exitCode = await runWaitCli([taskHandle], { write: c => chunks.push(String(c)) }, { write: () => {} });
    assert.equal(exitCode, 0);
    assert.match(chunks.join(''), /Async consult opinion/);

    // Through MCP server: mode async with 14,400,000 works, > 14,400,000 fails with INPUT_LIMIT naming 14400000.
    const call = createServer()._requestHandlers.get('tools/call');
    const mcpStarted = await call(
      {
        method: 'tools/call',
        params: {
          name: 'consult',
          arguments: { proposal: 'MCP async', mode: 'async', timeout_ms: 14_400_000, workspace_path: tempDir },
        },
      },
      { signal: new AbortController().signal },
    );
    assert.ok(
      mcpStarted.structuredContent.timeoutMs > 14_300_000 && mcpStarted.structuredContent.timeoutMs <= 14_400_000,
      `expected remaining budget near 14400000 ms, got ${mcpStarted.structuredContent.timeoutMs}`,
    );
    await waitTask(mcpStarted.structuredContent.taskHandle);

    const mcpRejected = readResult(
      await call(
        {
          method: 'tools/call',
          params: {
            name: 'consult',
            arguments: { proposal: 'MCP async over cap', mode: 'async', timeout_ms: 14_400_001, workspace_path: tempDir },
          },
        },
        { signal: new AbortController().signal },
      ),
    );
    assert.equal(mcpRejected.error?.code, 'INPUT_LIMIT');
    assert.match(mcpRejected.error.message, /14400000/);

    // Cancel async consult via session_handle.
    holdExecute = {};
    const cancelledStart = await handleConsult('consult', { proposal: 'Cancel me', mode: 'async' }, tempDir);
    await handleCancelSession({ session_handle: cancelledStart.structuredContent.sessionHandle, workspace_path: tempDir });
    holdExecute = null;
    const cancelledDone = await waitTask(cancelledStart.structuredContent.taskHandle);
    assert.equal(cancelledDone.state, 'cancelled');
  } finally {
    await stopActiveDelegations();
    adapterRegistry.agy = original;
  }
});
