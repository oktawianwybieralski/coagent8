const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-sessions-lock-'));
process.env.coagent8_DIR = tempDir;

const { withFileLock, inProcessLocks, LockTimeoutError } = require('../../src/storage/lock.ts');
const { ToolError } = require('../../src/contracts/error.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('inProcessLocks queue entries are deterministically deleted upon lock release', async () => {
  const resource1 = path.join(tempDir, 'lock-cleanup-1');
  const resource2 = path.join(tempDir, 'lock-cleanup-2');

  assert.equal(inProcessLocks.has(path.resolve(resource1)), false);
  await withFileLock(resource1, async () => {
    assert.equal(inProcessLocks.has(path.resolve(resource1)), true);
  });
  assert.equal(inProcessLocks.has(path.resolve(resource1)), false);

  await Promise.all([
    withFileLock(resource1, async () => {
      await new Promise(r => setTimeout(r, 20));
    }),
    withFileLock(resource2, async () => {
      await new Promise(r => setTimeout(r, 20));
    }),
  ]);
  assert.equal(inProcessLocks.has(path.resolve(resource1)), false);
  assert.equal(inProcessLocks.has(path.resolve(resource2)), false);
});

test('timed out waiters in inProcessLocks queue preserve FIFO ordering for subsequent waiters and cleanly delete tail', async () => {
  const resource = path.join(tempDir, 'lock-queue-timeout-test');
  const executionOrder = [];

  let acquiredA;
  let releaseA;
  const startedA = new Promise(resolve => {
    acquiredA = resolve;
  });
  const heldA = new Promise(resolve => {
    releaseA = resolve;
  });

  // Waiter A owns the lease until the queued timeout is observed.
  const pA = withFileLock(
    resource,
    async () => {
      executionOrder.push('A-start');
      acquiredA();
      await heldA;
      executionOrder.push('A-finish');
      return 'A';
    },
    1000,
  );

  // Queue only after acquisition, independent of filesystem or scheduler speed.
  await startedA;

  // Waiter B: queues behind A but times out after 40ms
  const pB = withFileLock(
    resource,
    async () => {
      executionOrder.push('B');
      return 'B';
    },
    40,
  ).catch(err => {
    executionOrder.push('B-timeout');
    return 'B-caught';
  });

  // Waiter C: queues behind B with generous 1000ms timeout
  const pC = withFileLock(
    resource,
    async () => {
      executionOrder.push('C');
      return 'C';
    },
    1000,
  );

  try {
    await pB;
  } finally {
    releaseA();
  }
  const [resA, resB, resC] = await Promise.all([pA, pB, pC]);

  assert.equal(resA, 'A');
  assert.equal(resB, 'B-caught');
  assert.equal(resC, 'C');

  // Verify order: A starts, B times out while A is running, A finishes, C runs after A
  assert.deepEqual(executionOrder, ['A-start', 'B-timeout', 'A-finish', 'C']);

  // Verify inProcessLocks map is completely cleaned up
  assert.equal(inProcessLocks.has(path.resolve(resource)), false);
});

test('withFileLock handles concurrency with jittered exponential backoff', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'coagent8-perf-lock-'));
  const targetResource = path.join(tempDir, 'critical-resource');

  let order = [];
  const p1 = withFileLock(targetResource, async () => {
    order.push('start-1');
    await new Promise(r => setTimeout(r, 60));
    order.push('end-1');
    return 1;
  });

  const p2 = withFileLock(targetResource, async () => {
    order.push('start-2');
    await new Promise(r => setTimeout(r, 20));
    order.push('end-2');
    return 2;
  });

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1, 1);
  assert.equal(res2, 2);

  // Critical sections must not overlap
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);

  await fsp.rm(tempDir, { recursive: true, force: true });
});

test('storage locks serialize actual competing Node processes (F09/F10)', async () => {
  const counter = path.join(tempDir, 'multiprocess-counter');
  fs.writeFileSync(counter, '0');
  const module = path.resolve(__dirname, '../..', 'src/storage/lock.ts');
  const script = `const fs=require('node:fs/promises');const {withFileLock}=require(process.argv[1]);(async()=>{for(let i=0;i<8;i++)await withFileLock(process.argv[2],async()=>{const n=Number(await fs.readFile(process.argv[2],'utf8'));await new Promise(r=>setTimeout(r,2));await fs.writeFile(process.argv[2],String(n+1));});})().catch(e=>{console.error(e);process.exitCode=1;});`;
  await Promise.all(
    Array.from(
      { length: 3 },
      () =>
        new Promise((resolve, reject) => {
          const proc = spawn(process.execPath, ['--require', 'tsx/cjs', '-e', script, module, counter], {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
          });
          let error = '';
          proc.stderr.on('data', d => {
            error += d;
          });
          proc.on('error', reject);
          proc.on('exit', code => (code === 0 ? resolve() : reject(new Error(error))));
        }),
    ),
  );
  assert.equal(fs.readFileSync(counter, 'utf8'), '24');
});

test('atomic lease lock serializes contender and recovers cleanly upon release', async () => {
  const resource = path.join(tempDir, 'atomic-lease-contention');
  let releaseOwner,
    ownerEntered,
    contenderEntered = false;
  const ownerGate = new Promise(r => (releaseOwner = r));
  const ownerReady = new Promise(r => (ownerEntered = r));

  const owner = withFileLock(resource, async () => {
    ownerEntered();
    await ownerGate;
    return 'owner-done';
  });
  await ownerReady;

  const contender = withFileLock(resource, async () => {
    contenderEntered = true;
    return 'contender-done';
  });

  // While owner is holding lock, contender cannot enter
  await new Promise(r => setTimeout(r, 30));
  assert.equal(contenderEntered, false, 'Contender must not enter while owner holds the atomic lease');

  releaseOwner();
  const [ownerRes, contenderRes] = await Promise.all([owner, contender]);
  assert.equal(ownerRes, 'owner-done');
  assert.equal(contenderRes, 'contender-done');
  assert.equal(contenderEntered, true);
  assert.equal(fs.existsSync(resource + '.lease'), false, 'Lease file must be cleaned up after release');
});

function writeLease(resource, content, ageMs) {
  const file = `${resource}.lease`;
  fs.writeFileSync(file, content);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

test('an empty lease left by a crash between open and write is reclaimed after its grace period (AUD-P1-9)', async () => {
  const resource = path.join(tempDir, 'empty-lease');
  writeLease(resource, '', 10000);
  assert.equal(await withFileLock(resource, async () => 'acquired', 1000), 'acquired');
  assert.equal(fs.existsSync(`${resource}.lease`), false);
  // A fresh unreadable lease may still be in creation by an older release: it is not taken.
  writeLease(resource, '', 0);
  await assert.rejects(
    withFileLock(resource, async () => 'stolen', 300),
    /Timed out/,
  );
  fs.rmSync(`${resource}.lease`, { force: true });
});

test('a lease not renewed for the maximum age is reclaimed even when its PID is alive (reused PID, AUD-P1-9)', async () => {
  const resource = path.join(tempDir, 'reused-pid-lease');
  const token = 'dead-owner-token';
  writeLease(resource, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() - 60000 }), 60000);
  assert.equal(
    await withFileLock(resource, async () => JSON.parse(fs.readFileSync(`${resource}.lease`, 'utf8')).token !== token, 1000),
    true,
  );
  // A renewed lease of a live PID is respected.
  writeLease(resource, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), 0);
  await assert.rejects(
    withFileLock(resource, async () => 'stolen', 300),
    /Timed out/,
  );
  fs.rmSync(`${resource}.lease`, { force: true });
});

test('the holder renews its lease, so a long critical section is not reclaimed', async () => {
  const resource = path.join(tempDir, 'renewed-lease');
  await withFileLock(resource, async () => {
    const before = fs.statSync(`${resource}.lease`).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.ok(fs.statSync(`${resource}.lease`).mtimeMs > before, 'the lease modification time advances while held');
  });
});

test('a lease is published complete: no contender ever reads an empty or partial lease', async () => {
  const resource = path.join(tempDir, 'complete-lease');
  const observed = [];
  let holding = true;
  const reader = (async () => {
    while (holding) {
      // Windows reports EPERM for a lease that is being deleted: no content is observed.
      try {
        observed.push(fs.readFileSync(`${resource}.lease`, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'EPERM') throw err;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  })();
  for (let i = 0; i < 20; i++) await withFileLock(resource, async () => {});
  holding = false;
  await reader;
  assert.ok(observed.length > 0, 'the reader observed held leases');
  for (const content of observed) assert.equal(typeof JSON.parse(content).token, 'string');
});

test('a lock timeout is a typed LockTimeoutError, so callers can tell contention from I/O failures', async () => {
  const resource = path.join(tempDir, 'typed-timeout');
  fs.writeFileSync(`${resource}.lease`, JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() }));
  try {
    await assert.rejects(
      withFileLock(resource, async () => {}, 50),
      err => err instanceof LockTimeoutError,
    );
  } finally {
    fs.rmSync(`${resource}.lease`, { force: true });
  }
});

test('a wait the budget bounds ends as budget expiry even when the budget clock still shows time left', async () => {
  // The wait is timed by the wall clock, the budget by its own monotonic clock. Here that clock
  // stands 30 ms before the execution deadline and does not move, as when it lags the wall clock
  // by a fraction of a millisecond on a busy runner: the wait must not end as plain contention.
  const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
  let now = 0;
  const budget = createExecutionBudget({ totalBudgetMs: 10000, teardownAllowanceMs: 1000, clock: () => now });
  now = 8970;
  const resource = path.join(tempDir, 'budget-bound-wait');
  fs.writeFileSync(`${resource}.lease`, JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() }));
  try {
    assert.equal(budget.remainingExecutionMs(), 30);
    await assert.rejects(
      withFileLock(resource, async () => {}, { timeoutMs: 5000, budget }),
      err => err instanceof ToolError && err.code === 'TIMEOUT',
    );
    await assert.rejects(
      withFileLock(resource, async () => {}, { timeoutMs: 20, budget }),
      err => err instanceof LockTimeoutError,
      'a wait its own shorter timeout bounds is still contention',
    );
  } finally {
    budget.dispose();
    fs.rmSync(`${resource}.lease`, { force: true });
  }
});

test('aborting the middle of three in-process waiters does not strand the third waiter and preserves FIFO progress (EXEC-001-T09b)', async () => {
  const resource = path.join(tempDir, 'lock-queue-abort-three-waiters');
  const executionOrder = [];

  let acquiredA;
  let releaseA;
  const startedA = new Promise(resolve => {
    acquiredA = resolve;
  });
  const heldA = new Promise(resolve => {
    releaseA = resolve;
  });

  const acB = new AbortController();

  // Waiter A: owns the lock until released
  const pA = withFileLock(
    resource,
    async () => {
      executionOrder.push('A-start');
      acquiredA();
      await heldA;
      executionOrder.push('A-finish');
      return 'A';
    },
    2000,
  );

  // Ensure Waiter A has actually acquired before queuing B and C
  await startedA;

  // Waiter B: queues behind A with an AbortSignal
  const pB = withFileLock(
    resource,
    async () => {
      executionOrder.push('B');
      return 'B';
    },
    { abortSignal: acB.signal, timeoutMs: 2000 },
  ).catch(err => {
    executionOrder.push('B-aborted');
    assert.ok(err instanceof ToolError && err.code === 'ABORTED', `Expected ToolError ABORTED, got: ${err}`);
    return 'B-caught';
  });

  // Waiter C: queues behind B with generous timeout
  const pC = withFileLock(
    resource,
    async () => {
      executionOrder.push('C');
      return 'C';
    },
    2000,
  );

  // Now abort Waiter B while Waiter A is still running
  acB.abort();

  // Waiter B must reject immediately, while Waiter A is still holding the lock
  const resB = await pB;
  assert.equal(resB, 'B-caught');
  assert.equal(executionOrder.includes('A-finish'), false, 'Waiter B must reject before Waiter A finishes');

  // Now release Waiter A
  releaseA();

  const [resA, resC] = await Promise.all([pA, pC]);
  assert.equal(resA, 'A');
  assert.equal(resC, 'C');

  // Verify full ordering: A started, B aborted while A held lock, A finished, C ran after A
  assert.deepEqual(executionOrder, ['A-start', 'B-aborted', 'A-finish', 'C']);

  // Clean inProcessLocks map after async .finally settlement
  await new Promise(r => setImmediate(r));
  assert.equal(inProcessLocks.has(path.resolve(resource)), false, 'inProcessLocks tail must be cleanly deleted');
});

test('aborting during on-disk lease contention interrupts backoff immediately and never releases another owner lease (EXEC-001-T09b)', async () => {
  const resource = path.join(tempDir, 'lock-contention-abort');
  const foreignToken = 'foreign-process-token-12345';
  const leaseFile = `${resource}.lease`;

  // Pre-seed an active foreign lease owned by our PID (so it looks alive and non-stale)
  fs.writeFileSync(leaseFile, JSON.stringify({ token: foreignToken, pid: process.pid, createdAt: Date.now() }));

  const ac = new AbortController();
  const started = Date.now();

  const contenderPromise = withFileLock(
    resource,
    async () => {
      return 'contender-should-not-run';
    },
    { timeoutMs: 5000, abortSignal: ac.signal },
  );

  // Wait a short moment to ensure contender is in the on-disk backoff loop
  await new Promise(r => setTimeout(r, 25));

  // Abort contender
  ac.abort();

  await assert.rejects(contenderPromise, err => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'ABORTED');
    return true;
  });

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `Contender must abort immediately, took ${elapsed}ms`);

  // Foreign lease must NOT have been removed or modified
  assert.equal(fs.existsSync(leaseFile), true, 'Foreign lease must survive contender abort');
  const content = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  assert.equal(content.token, foreignToken, 'Foreign lease token must remain intact');

  // Cleanup
  fs.rmSync(leaseFile, { force: true });
});

test('pre-aborted signal rejects immediately without queueing or touching filesystem (EXEC-001-T09b)', async () => {
  const resource = path.join(tempDir, 'lock-pre-aborted');
  const ac = new AbortController();
  ac.abort(new Error('Pre-flight cancellation'));

  let fnCalled = false;
  await assert.rejects(
    withFileLock(
      resource,
      async () => {
        fnCalled = true;
      },
      { abortSignal: ac.signal },
    ),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'ABORTED');
      return true;
    },
  );

  assert.equal(fnCalled, false, 'fn must never be invoked');
  assert.equal(fs.existsSync(`${resource}.lease`), false, 'Lease file must not be created');
  assert.equal(inProcessLocks.has(path.resolve(resource)), false, 'inProcessLocks must not have registered the pre-aborted call');
});

test('withFileLock supports BackendReadContext and ExecutionBudget (EXEC-001-T09b)', async () => {
  const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
  const resource = path.join(tempDir, 'lock-budget-context');

  // 1. Context with parent signal aborted
  const parentAc = new AbortController();
  parentAc.abort();
  const contextWithAbortedParent = {
    budget: createExecutionBudget({ totalBudgetMs: 5000, parentSignal: parentAc.signal }),
    timeoutMs: 1000,
  };

  await assert.rejects(
    withFileLock(resource, async () => 'not-run', { context: contextWithAbortedParent }),
    err => err instanceof ToolError && err.code === 'ABORTED',
  );

  // 2. Direct AbortSignal argument polymorphism: withFileLock(resource, fn, abortSignal)
  const directAc = new AbortController();
  directAc.abort();
  await assert.rejects(
    withFileLock(resource, async () => 'not-run', directAc.signal),
    err => err instanceof ToolError && err.code === 'ABORTED',
  );

  // 3. Context passed directly as 3rd parameter: withFileLock(resource, fn, context)
  const directCtx = {
    abortSignal: directAc.signal,
    timeoutMs: 1000,
  };
  await assert.rejects(
    withFileLock(resource, async () => 'not-run', directCtx),
    err => err instanceof ToolError && err.code === 'ABORTED',
  );
});

test('distinguishes contention LockTimeoutError from cancellation ToolError(ABORTED) (EXEC-001-T09b)', async () => {
  const resource = path.join(tempDir, 'lock-distinction');
  const foreignToken = 'foreign-owner';
  fs.writeFileSync(`${resource}.lease`, JSON.stringify({ token: foreignToken, pid: process.pid, createdAt: Date.now() }));

  try {
    // 1. Timeout throws LockTimeoutError
    await assert.rejects(
      withFileLock(resource, async () => 'not-run', { timeoutMs: 30 }),
      err => {
        assert.ok(err instanceof LockTimeoutError);
        assert.equal(err.name, 'LockTimeoutError');
        return true;
      },
    );

    // 2. Abort throws ToolError with code ABORTED
    const ac = new AbortController();
    const abortP = withFileLock(resource, async () => 'not-run', { timeoutMs: 2000, abortSignal: ac.signal });
    ac.abort();
    await assert.rejects(abortP, err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'ABORTED');
      return true;
    });
  } finally {
    fs.rmSync(`${resource}.lease`, { force: true });
  }
});

test('cross-process contention: cancelling a contender never corrupts or releases the child process lease (EXEC-001-T09b)', async () => {
  const resource = path.join(tempDir, 'cross-process-contention-abort');
  const modulePath = path.resolve(__dirname, '../..', 'src/storage/lock.ts');
  const readyFile = path.join(tempDir, 'child-ready.flag');
  const stopFile = path.join(tempDir, 'child-stop.flag');

  // Child process acquires lock, writes ready flag, waits for stop flag, then exits cleanly
  const childScript = `
    const fs = require('node:fs');
    const { withFileLock } = require(process.argv[1]);
    (async () => {
      await withFileLock(process.argv[2], async () => {
        fs.writeFileSync(process.argv[3], 'ready');
        while (!fs.existsSync(process.argv[4])) {
          await new Promise(r => setTimeout(r, 10));
        }
      }, 5000);
    })().catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
  `;

  const child = spawn(process.execPath, ['--require', 'tsx/cjs', '-e', childScript, modulePath, resource, readyFile, stopFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  let childStderr = '';
  let childExited = false;
  let childExitCode = null;
  let childSpawnError = null;

  child.stderr.on('data', d => {
    childStderr += d;
  });
  child.on('error', err => {
    childSpawnError = err;
  });
  child.on('exit', code => {
    childExited = true;
    childExitCode = code;
  });

  try {
    // Wait for child to hold lock with bounded deadline and child exit detection
    const waitDeadline = Date.now() + 5000;
    while (!fs.existsSync(readyFile)) {
      if (childSpawnError) {
        throw new Error(`Child process failed to spawn: ${childSpawnError.message}`);
      }
      if (childExited) {
        throw new Error(`Child process exited prematurely with code ${childExitCode}: ${childStderr}`);
      }
      if (Date.now() > waitDeadline) {
        throw new Error(`Timed out waiting for child to acquire lock: ${childStderr}`);
      }
      await new Promise(r => setTimeout(r, 10));
    }

    // Now parent process attempts to acquire with an abortSignal and cancels
    const ac = new AbortController();
    const contender = withFileLock(resource, async () => 'contender-run', { timeoutMs: 5000, abortSignal: ac.signal });

    // Wait a brief moment to ensure contender is contending for the child's lease
    await new Promise(r => setTimeout(r, 30));

    // Cancel contender
    ac.abort();

    await assert.rejects(contender, err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'ABORTED');
      return true;
    });

    // Verify child is still alive and lease file still exists
    assert.equal(fs.existsSync(`${resource}.lease`), true, 'Child lease must remain intact');
  } finally {
    // Tell child to finish
    try {
      fs.writeFileSync(stopFile, 'stop');
    } catch {
      /* ignore if temp dir cleaned */
    }

    if (!childExited) {
      await new Promise((resolve, reject) => {
        let forceTimer = null;
        let hardDeadlineTimer = null;
        const cleanupTimers = () => {
          clearTimeout(exitTimer);
          if (forceTimer) clearTimeout(forceTimer);
          if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
        };

        const exitTimer = setTimeout(() => {
          if (!childExited) {
            try {
              child.kill('SIGTERM');
            } catch (kErr) {
              /* ignore if already gone */
            }
            forceTimer = setTimeout(() => {
              if (!childExited) {
                try {
                  child.kill('SIGKILL');
                } catch (kErr) {
                  /* ignore */
                }
              }
            }, 1000);
          }
        }, 2000);

        hardDeadlineTimer = setTimeout(() => {
          cleanupTimers();
          if (!childExited) {
            reject(new Error(`Failed to confirm child process (PID ${child.pid}) termination within teardown deadline.`));
          } else {
            resolve();
          }
        }, 5000);

        child.once('exit', () => {
          cleanupTimers();
          resolve();
        });
        child.once('error', err => {
          cleanupTimers();
          reject(err);
        });
      });
    }

    if (childStderr) {
      assert.fail(`Child process failed: ${childStderr}`);
    }
  }

  // After child cleanly exited, lease is released
  assert.equal(fs.existsSync(`${resource}.lease`), false, 'Child releases lease upon normal exit');
});

test('uncontended lock with timeoutMs: 0 succeeds on the first attempt without throwing (EXEC-001-T09b backward compatibility)', async () => {
  const resource = path.join(tempDir, 'lock-timeout-zero');
  const result = await withFileLock(resource, async () => 'acquired-zero', 0);
  assert.equal(result, 'acquired-zero');
});
