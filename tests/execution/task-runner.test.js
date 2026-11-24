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
    delegate: {},
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
    { requireEnvelope: true, profile: 'read-only' },
    { requireEnvelope: false, profile: undefined },
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
    assert.equal(options.role, role);
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

test('a forged role does not reach the controller', async () => {
  const { calls, execute } = recorder();
  await runTask('review', { prompt: 'p', publicInput: 'p', args: {}, cwd: '/work', options: { role: 'delegate' } }, execute);
  assert.equal(calls[0][6].role, 'review');
});

test('an unconfirmed process tree reaches both the turn and the writer around it (#211 review)', async () => {
  const { requiredJobHelperObserver, withRequiredJobHelper } = require('../../src/execution/process.ts');
  let writerHeard = 0;
  const seen = [];
  // The fake controller reports what the helper would: a tree it could not confirm ended.
  const execute = async (...callArgs) => {
    const options = callArgs[6];
    seen.push(options.treeUnconfirmed());
    requiredJobHelperObserver()?.();
    seen.push(options.treeUnconfirmed());
    return { isError: false };
  };
  for (const role of ['review', 'consult', 'delegate']) {
    await withRequiredJobHelper(
      () => runTask(role, { prompt: 'p', publicInput: 'p', args: {}, cwd: '/work' }, execute),
      () => writerHeard++,
      () => 'helper.exe',
    );
  }
  assert.equal(writerHeard, 3, 'the writer keeps hearing about every unconfirmed tree');
  // Off Windows the runner adds no job of its own, so the turn learns of it only on Windows.
  assert.deepEqual(
    seen,
    process.platform === 'win32' ? [false, true, false, true, false, true] : [false, false, false, false, false, false],
  );
});

test('a review whose process tree was not confirmed ended is not READY and not remembered (#211 review)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { executeTask, UNCONFIRMED_TREE_WARNING } = require('../../src/execution/controller.ts');
  const { saveConfig } = require('../../src/config.ts');
  const { getSession } = require('../../src/sessions/session.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-unconfirmed-tree-'));
  const previousDir = process.env.coagent8_DIR;
  process.env.coagent8_DIR = path.join(dir, 'data');
  const original = adapterRegistry.agy;
  const envelope = [
    'REVIEW: 1',
    'SNAPSHOT: s',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'Reviewed: a.ts',
    'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN',
  ].join('\n');
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      options.onEvent({ type: 'assistant_message', messageId: 'm', text: envelope });
      return {
        status: 'completed',
        isError: false,
        output: envelope,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const outcome = await executeTask('p', 'p', { backend: 'agy' }, dir, null, null, {
      requireEnvelope: true,
      reviewContext: { expectedSnapshot: 's', inputComplete: true, requiredChecks: [] },
      reviewIdentity: { snapshot: 's', scope: 'uncommitted' },
      treeUnconfirmed: () => true,
    });
    assert.equal(outcome.review.verdict, 'BLOCKED');
    assert.ok(outcome.warnings.includes(UNCONFIRMED_TREE_WARNING));
    assert.equal(getSession(outcome.sessionHandle, { workspace: dir }).lastReview, undefined, 'no verdict to reuse');
  } finally {
    adapterRegistry.agy = original;
    process.env.coagent8_DIR = previousDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a timeout from any phase names the call budget (ACCEPT-001a2 N2)', async () => {
  const { withBudget } = require('../../src/execution/task.ts');
  const probe = new ToolError('TIMEOUT', 'Execution budget expired before probing Codex.');
  const named = withBudget(probe, 1000);
  assert.equal(named.code, 'TIMEOUT');
  assert.equal(named.message, "Execution budget expired before probing Codex. The call's budget was 1000 ms.");
  const already = new ToolError('TIMEOUT', 'Execution deadline exceeded (1000 ms).');
  assert.equal(withBudget(already, 1000), already);
  const other = new ToolError('ABORTED', 'x');
  assert.equal(withBudget(other, 1000), other);
  assert.equal(withBudget(probe, undefined), probe);
  const execute = async () => {
    throw probe;
  };
  await assert.rejects(
    runTask('consult', { prompt: 'p', publicInput: 'p', args: { timeout_ms: 750 }, cwd: '/work' }, execute),
    err => err.code === 'TIMEOUT' && err.message.includes('750 ms'),
  );
});
