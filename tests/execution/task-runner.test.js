'use strict';

/**
 * #209: one task runner for every role.
 *
 * Verifies:
 * - Each role sets exactly the options its path set before the runner existed.
 * - A caller cannot override what its role fixes, and everything else it passes reaches the controller.
 * - The runner passes prompt, public input, arguments, workspace, signal and progress unchanged.
 * - A call scope reports its trace once and frees only a budget it owns.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ROLE_POLICIES, runTask, openCallScope } = require('../../src/execution/task.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../src/contracts/error.ts');

function recorder() {
  const calls = [];
  const execute = async (...callArgs) => {
    calls.push(callArgs);
    return { isError: false };
  };
  return { calls, execute };
}

test('each role sets the options its path set before the runner', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ROLE_POLICIES)), {
    consult: { requireEnvelope: false },
    review: { requireEnvelope: true },
    delegate: { profile: 'workspace-write' },
    coordinate: { requireEnvelope: false, coordinatorTurn: true },
  });
  assert.ok(Object.isFrozen(ROLE_POLICIES));
  for (const policy of Object.values(ROLE_POLICIES)) assert.ok(Object.isFrozen(policy));
});

test('the runner passes the request unchanged and lets the role win', async () => {
  const signal = new AbortController().signal;
  const onProgress = () => {};
  const args = { proposal: 'q', backend: 'codex' };
  // Each value the opposite of some role's: a role that fixes an option replaces it, the others keep it.
  const forged = [
    { requireEnvelope: true, profile: 'read-only', coordinatorTurn: false },
    { requireEnvelope: false, profile: undefined, coordinatorTurn: true },
  ];
  for (const [role, policy] of Object.entries(ROLE_POLICIES))
    for (const fixed of forged) {
      const { calls, execute } = recorder();
      await runTask(
        role,
        {
          prompt: 'prompt',
          publicInput: 'public',
          args,
          cwd: '/work',
          abortSignal: signal,
          onProgress,
          options: { warnings: ['w'], writeScope: ['src'], ...fixed },
        },
        execute,
      );
      assert.equal(calls.length, 1);
      const options = calls[0][6];
      for (const key of Object.keys(fixed)) assert.equal(options[key], key in policy ? policy[key] : fixed[key], `${role} ${key}`);
    }
  // A delegate caller's requireEnvelope reaches the controller, as before the runner (#209 review).
  for (const requireEnvelope of [true, false]) {
    const { calls, execute } = recorder();
    await runTask('delegate', { prompt: 'p', publicInput: 'p', args, cwd: '/work', options: { requireEnvelope } }, execute);
    assert.equal(calls[0][6].requireEnvelope, requireEnvelope);
  }
  for (const role of Object.keys(ROLE_POLICIES)) {
    const { calls, execute } = recorder();
    await runTask(
      role,
      {
        prompt: 'prompt',
        publicInput: 'public',
        args,
        cwd: '/work',
        abortSignal: signal,
        onProgress,
        options: { warnings: ['w'], writeScope: ['src'] },
      },
      execute,
    );
    assert.equal(calls.length, 1);
    const [prompt, publicInput, passedArgs, cwd, passedSignal, passedProgress, options] = calls[0];
    assert.equal(prompt, 'prompt');
    assert.equal(publicInput, 'public');
    assert.equal(passedArgs, args);
    assert.equal(cwd, '/work');
    assert.equal(passedSignal, signal);
    assert.equal(passedProgress, onProgress);
    assert.deepEqual(options.warnings, ['w']);
    assert.deepEqual(options.writeScope, ['src']);
    for (const [key, value] of Object.entries(ROLE_POLICIES[role])) assert.equal(options[key], value);
  }
});

test('a call scope reports its trace once and frees only an owned budget', () => {
  const traces = [];
  const owned = openCallScope(1000, null, { onTiming: trace => traces.push(trace) });
  let ownedDisposals = 0;
  const ownDispose = owned.budget.dispose;
  owned.budget.dispose = () => {
    ownedDisposals++;
    ownDispose();
  };
  owned.close();
  assert.equal(traces.length, 1);
  assert.equal(ownedDisposals, 1);

  const shared = createExecutionBudget({ totalBudgetMs: 1000 });
  const sharedDispose = shared.dispose;
  let sharedDisposals = 0;
  shared.dispose = () => {
    sharedDisposals++;
  };
  try {
    for (const options of [{ budget: shared }, { context: { budget: shared } }]) {
      const borrowed = openCallScope(undefined, null, options);
      assert.equal(borrowed.budget, shared);
      borrowed.dispose();
      borrowed.close();
    }
    assert.equal(sharedDisposals, 0);
  } finally {
    sharedDispose();
  }
});

test('a call scope ends with TIMEOUT or ABORTED before a turn', () => {
  let now = 0;
  const traces = [];
  const expired = openCallScope(10, null, { clock: () => now, onTiming: trace => traces.push(trace) });
  expired.assertLive('cancelled');
  now = 1000;
  assert.throws(
    () => expired.assertLive('cancelled'),
    err => err instanceof ToolError && err.code === 'TIMEOUT',
  );
  assert.equal(traces.length, 1);

  const controller = new AbortController();
  const aborted = openCallScope(60_000, controller.signal, {});
  controller.abort();
  assert.throws(
    () => aborted.assertLive('cancelled before work'),
    err => err instanceof ToolError && err.code === 'ABORTED' && err.message === 'cancelled before work',
  );
});
