'use strict';

/**
 * EXEC-001-T06: Guaranteed finalization after resource acquisition and failure isolation.
 *
 * Verifies:
 * - T06a: Guard acquisition and registration: injected writer/registration failure releases
 *   owned turn lease, cleans activeSessionAborts, and notifies settled waiters.
 * - T06b: Isolate finalization failures: metadata failure preserves continuation invalidation,
 *   archive failure preserves valid answer (Primary Task Supremacy), lease failure remains
 *   fail-closed (SESSION_INVALID), cooldown is recorded at most once, and failed snapshot
 *   recheck cannot yield READY.
 * - T06c: Cancellation settlement: cancelSessionExecution and waitForActiveExecutionTasks
 *   wait until timers, listeners, and child processes have completed cleanup.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-controller-finalization-'));
process.env.coagent8_DIR = tempDir;
const quotaCache = path.join(tempDir, 'quota-cache.json');
process.env.coagent8_QUOTA_CACHE = quotaCache;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const {
  executeTask,
  composeExecutionCancellation,
  waitForActiveExecutionTasks,
} = require('../../src/execution/controller.ts');
const {
  createSession,
  getSession,
  updateSession,
  acquireSessionTurn,
  releaseSessionTurn,
  cancelSession,
} = require('../../src/sessions/session.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

const originalRegistry = {
  codex: adapterRegistry.codex,
  agy: adapterRegistry.agy,
  claude: adapterRegistry.claude,
};

test.before(() => {
  composeExecutionCancellation();
  saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
});

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setupMockAdapter(executeImpl) {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'agy-fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      authStatus: 'authenticated',
      config: { defaultModel: 'gemini-3.8-flash' },
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'agy-fixture',
      models: [{ id: 'gemini-3.8-flash', displayName: 'Flash', default: true, reasoningEffort: false }],
    }),
    execute: executeImpl,
  };
}

async function createTestSession() {
  const s = createSession('agy', tempDir);
  await updateSession(s.sessionHandle, { threadId: randomUUID() });
  return s;
}

// ---------------------------------------------------------------------------
// T06a: Guard acquisition and registration
// ---------------------------------------------------------------------------

test('T06a: injected writer creation failure releases turn lease and settles waiters', async () => {
  setupMockAdapter(async () => {
    throw new Error('Adapter must not execute if writer creation fails');
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  // Verify session is initially idle
  assert.equal(getSession(handle).activePid, null);

  // Injected writer creation failure
  await assert.rejects(
    async () => {
      await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
        createHistoryWriter: () => {
          throw new Error('Injected writer creation failure');
        },
      });
    },
    /Injected writer creation failure/
  );

  // Assert that turn lease was released immediately (activePid is null, turn can be acquired)
  const sessionAfter = getSession(handle);
  assert.equal(sessionAfter.activePid, null, 'Session activePid must be null after writer creation failure');

  const acquireCheck = await acquireSessionTurn(handle);
  assert.equal(acquireCheck.ok, true, 'Subsequent turn acquisition must succeed immediately');
  await releaseSessionTurn(handle, acquireCheck.data.token);
});

test('T06a: injected registration failure releases turn lease and settles waiters', async () => {
  setupMockAdapter(async () => {
    throw new Error('Adapter must not execute if registration fails');
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  await assert.rejects(
    async () => {
      await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
        simulateRegistrationFault: () => {
          throw new Error('Injected registration fault');
        },
      });
    },
    /Injected registration fault/
  );

  const sessionAfter = getSession(handle);
  assert.equal(sessionAfter.activePid, null, 'Session activePid must be null after registration fault');

  const acquireCheck = await acquireSessionTurn(handle);
  assert.equal(acquireCheck.ok, true, 'Subsequent turn acquisition must succeed immediately');
  await releaseSessionTurn(handle, acquireCheck.data.token);
});

// ---------------------------------------------------------------------------
// T06b: Isolate finalization failures
// ---------------------------------------------------------------------------

test('T06b: session metadata failure during finalization invalidates continuation and preserves cleanup', async () => {
  let executed = false;
  setupMockAdapter(async () => {
    executed = true;
    return {
      status: 'completed',
      isError: false,
      output: 'Successful response',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  const result = await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    updateSession: async () => {
      throw new Error('Disk error during updateSession');
    },
  });

  assert.equal(executed, true);
  // Primary answer is preserved
  assert.equal(result.isError, false);
  assert.equal(result.result.output, 'Successful response');
  // Continuation is invalidated
  assert.equal(result.result.continuationAvailable, false, 'Continuation must be invalidated when updateSession fails');
  // Warning is recorded
  assert.ok(result.warnings.some(w => /Session update failed: Disk error during updateSession/.test(w)));

  // Turn lease must be released cleanly
  const sessionAfter = getSession(handle);
  assert.equal(sessionAfter.activePid, null, 'Turn lease must be released despite updateSession failure');
});

test('T06b: history archival failure preserves valid answer (Primary Task Supremacy)', async () => {
  setupMockAdapter(async () => {
    return {
      status: 'completed',
      isError: false,
      output: 'Important model answer',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  // Custom writer whose flush throws during finalization
  const failingWriter = {
    accept: () => {},
    flush: async () => {
      throw new Error('Disk full during archival flush');
    },
    disabled: false,
  };

  const res = await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    createHistoryWriter: () => failingWriter,
  });

  // Primary Task Supremacy: User's answer is NOT erased or failed!
  assert.equal(res.isError, false, 'Turn must not fail because secondary archival failed');
  assert.equal(res.result.status, 'completed');
  assert.equal(res.result.output, 'Important model answer');
  assert.equal(res.meta.historyAvailable, false, 'historyAvailable must be false');
  assert.ok(res.warnings.some(w => /History not saved: Disk full during archival flush/.test(w)));

  // Turn lease released
  assert.equal(getSession(handle).activePid, null);
});

test('T06b: lease release failure fails closed (SESSION_INVALID) and invalidates continuation', async () => {
  setupMockAdapter(async () => {
    return {
      status: 'completed',
      isError: false,
      output: 'Answer before lease failure',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  const res = await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    releaseSessionTurn: async () => {
      return { ok: false, error: 'Simulated lease conflict' };
    },
  });

  // Fail-closed invariant: lease release failure MUST mark turn as failed with SESSION_INVALID
  assert.equal(res.isError, true);
  assert.equal(res.result.status, 'failed');
  assert.equal(res.result.error?.code, 'SESSION_INVALID');
  assert.equal(res.result.continuationAvailable, false);
});

test('T06b: cooldown is recorded at most once per rate-limited turn, even with lease failure', async () => {
  fs.rmSync(quotaCache, { force: true });

  setupMockAdapter(async () => {
    return {
      status: 'failed',
      isError: true,
      output: '',
      error: { code: 'RATE_LIMITED', message: '429 Rate limited', retryable: true },
      truncated: false,
      continuationAvailable: false,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  // Turn with rate-limit and lease failure
  const res = await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    releaseSessionTurn: async () => {
      return { ok: false, error: 'Lease release error' };
    },
  });

  assert.equal(res.isError, true);
  assert.equal(res.result.error?.code, 'SESSION_INVALID');

  // Verify quota cache recorded cooldown exactly once (tier 0)
  assert.ok(fs.existsSync(quotaCache), 'Quota cache file must exist');
  const cacheData = JSON.parse(fs.readFileSync(quotaCache, 'utf8'));
  const entry = cacheData.data.agy;
  assert.ok(entry, 'agy entry must exist');
  assert.equal(entry.cooldownLevel, 0, 'Must remain on backoff level 0 (written exactly once)');
});

test('T06b: failed review snapshot recheck cannot yield READY', async () => {
  setupMockAdapter(async () => {
    return {
      status: 'completed',
      isError: false,
      output: 'REVIEW: ok\nSNAPSHOT: commit-1\nCOVERAGE: COMPLETE\nVERDICT: READY\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  // verifyReviewSnapshot returns an invalidated reason
  const res1 = await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    requireEnvelope: true,
    reviewContext: {
      expectedSnapshot: 'commit-1',
      requiredChecks: ['typecheck', 'tests'],
      inputComplete: true,
    },
    verifyReviewSnapshot: async () => 'Review workspace modified during turn',
  });

  assert.equal(res1.review?.verdict, 'BLOCKED', 'Review verdict must be BLOCKED when snapshot check fails');
  assert.match(res1.review?.reason || '', /Review workspace modified during turn/);

  // verifyReviewSnapshot throws an error
  const res2 = await executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    requireEnvelope: true,
    reviewContext: {
      expectedSnapshot: 'commit-1',
      requiredChecks: ['typecheck', 'tests'],
      inputComplete: true,
    },
    verifyReviewSnapshot: async () => {
      throw new Error('Git collection exploded');
    },
  });

  assert.equal(res2.review?.verdict, 'BLOCKED', 'Review verdict must be BLOCKED when snapshot check throws');
  assert.match(res2.review?.reason || '', /Git collection exploded/);
});

// ---------------------------------------------------------------------------
// T06c: Verify cancellation settlement
// ---------------------------------------------------------------------------

test('T06c: cancelSessionExecution during execution settles and releases turn lease', async () => {
  let executionAborted = false;
  let adapterEntered;
  const enteredPromise = new Promise(resolve => { adapterEntered = resolve; });

  setupMockAdapter(async (_prompt, options) => {
    adapterEntered();
    return new Promise((resolve) => {
      options.abortSignal?.addEventListener('abort', () => {
        executionAborted = true;
        resolve({
          status: 'cancelled',
          isError: true,
          output: '',
          error: { code: 'ABORTED', message: 'Operation cancelled.', retryable: false },
          truncated: false,
          continuationAvailable: false,
        });
      });
    });
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  const taskPromise = executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir);

  await enteredPromise;

  // Cancel via cancelSession (which calls cancelSessionExecution via executionCanceller)
  const cancelResult = await cancelSession(handle, tempDir);
  assert.equal(cancelResult.cancelled, true);

  const res = await taskPromise;
  assert.equal(res.result.status, 'cancelled');
  assert.equal(executionAborted, true);

  // Turn lease must be completely released
  const sessionAfter = getSession(handle);
  assert.equal(sessionAfter.activePid, null, 'Active pid must be null after cancellation');
});

test('T06c: waitForActiveExecutionTasks awaits background task completion', async () => {
  let finishTask;
  const blocker = new Promise(resolve => { finishTask = resolve; });

  setupMockAdapter(async () => {
    await blocker;
    return {
      status: 'completed',
      isError: false,
      output: 'Done waiting',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  let taskCompleted = false;
  executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir)
    .finally(() => { taskCompleted = true; });

  // Start waiting in the background
  let waitFinished = false;
  const waitPromise = waitForActiveExecutionTasks().then(() => { waitFinished = true; });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(waitFinished, false, 'waitForActiveExecutionTasks must not resolve while task is active');

  finishTask();
  await waitPromise;
  assert.equal(waitFinished, true, 'waitForActiveExecutionTasks must resolve after task completes');
  assert.equal(taskCompleted, true);
  assert.equal(getSession(handle).activePid, null);
});

test('T06c: cancelSessionExecution during finalization settles after cleanup and releases turn lease', async () => {
  let finalizationEntered;
  const enterPromise = new Promise(resolve => { finalizationEntered = resolve; });
  let continueFinalization;
  const continuePromise = new Promise(resolve => { continueFinalization = resolve; });

  setupMockAdapter(async () => {
    return {
      status: 'completed',
      isError: false,
      output: 'Finished execution, now entering finalization',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  const taskPromise = executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    updateSession: async (h, updates, token) => {
      finalizationEntered();
      await continuePromise;
      return updateSession(h, updates, token);
    },
  });

  await enterPromise;

  // Cancel while updateSession is suspended in finalization
  let cancelSettled = false;
  const cancelPromise = cancelSession(handle, tempDir).then(res => {
    cancelSettled = true;
    return res;
  });

  await new Promise(r => setTimeout(r, 20));
  assert.equal(cancelSettled, false, 'Cancellation must not settle until finalization finishes');

  // Allow finalization to proceed
  continueFinalization();

  const cancelResult = await cancelPromise;
  assert.equal(cancelResult.cancelled, true);

  await taskPromise;
  assert.equal(getSession(handle).activePid, null, 'Turn lease must be released');
});

test('T06c: finishing turn does not delete replacement turn registration in activeSessionAborts', async () => {
  let turn1Finalizing;
  const turn1FinalizingPromise = new Promise(resolve => { turn1Finalizing = resolve; });
  let allowTurn1Complete;
  const allowTurn1Promise = new Promise(resolve => { allowTurn1Complete = resolve; });

  setupMockAdapter(async () => {
    return {
      status: 'completed',
      isError: false,
      output: 'turn 1 output',
      nativeSessionId: randomUUID(),
      model: 'gemini-3.8-flash',
      truncated: false,
      continuationAvailable: true,
    };
  });

  const session = await createTestSession();
  const handle = session.sessionHandle;

  // Turn 1 releases lease then suspends during verifyReviewSnapshot in finalization
  const task1Promise = executeTask('prompt', 'public', { backend: 'agy', session_handle: handle }, tempDir, null, null, {
    verifyReviewSnapshot: async () => {
      turn1Finalizing();
      await allowTurn1Promise;
      return undefined;
    },
  });

  await turn1FinalizingPromise;

  // Turn 1 has released its lease, so Turn 2 can now execute and register its own abortEntry
  let turn2Entered;
  const turn2EnteredPromise = new Promise(resolve => { turn2Entered = resolve; });
  let turn2Cancelled = false;

  setupMockAdapter(async (_prompt, options) => {
    turn2Entered();
    return new Promise(resolve => {
      options.abortSignal?.addEventListener('abort', () => {
        turn2Cancelled = true;
        resolve({
          status: 'cancelled',
          isError: true,
          output: '',
          error: { code: 'ABORTED', message: 'Turn 2 cancelled', retryable: false },
          truncated: false,
          continuationAvailable: false,
        });
      });
    });
  });

  const task2Promise = executeTask('prompt 2', 'public 2', { backend: 'agy', session_handle: handle }, tempDir);
  await turn2EnteredPromise;

  // Now allow Turn 1 to complete its finally block
  allowTurn1Complete();
  await task1Promise;

  // Verify that Turn 2's registration was NOT deleted by Turn 1's finally block
  const cancelResult = await cancelSession(handle, tempDir);
  assert.equal(cancelResult.cancelled, true, 'Turn 2 must be cancellable via activeSessionAborts');

  const res2 = await task2Promise;
  assert.equal(res2.result.status, 'cancelled');
  assert.equal(turn2Cancelled, true, 'Turn 2 must have observed abort signal');
});


