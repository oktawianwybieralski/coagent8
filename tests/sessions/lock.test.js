const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-sessions-lock-'));
process.env.coagent8_DIR = tempDir;

const { withFileLock, inProcessLocks } = require('../../src/sessions/lock.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('Phase 2 Audit Remediation: inProcessLocks queue entries are deterministically deleted upon lock release', async () => {
  const resource1 = path.join(tempDir, 'lock-cleanup-1');
  const resource2 = path.join(tempDir, 'lock-cleanup-2');

  assert.equal(inProcessLocks.has(path.resolve(resource1)), false);
  await withFileLock(resource1, async () => {
    assert.equal(inProcessLocks.has(path.resolve(resource1)), true);
  });
  assert.equal(inProcessLocks.has(path.resolve(resource1)), false);

  await Promise.all([
    withFileLock(resource1, async () => { await new Promise(r => setTimeout(r, 20)); }),
    withFileLock(resource2, async () => { await new Promise(r => setTimeout(r, 20)); }),
  ]);
  assert.equal(inProcessLocks.has(path.resolve(resource1)), false);
  assert.equal(inProcessLocks.has(path.resolve(resource2)), false);
});

test('Phase 2 Audit Remediation: timed out waiters in inProcessLocks queue preserve FIFO ordering for subsequent waiters and cleanly delete tail', async () => {
  const resource = path.join(tempDir, 'lock-queue-timeout-test');
  const executionOrder = [];

  let acquiredA;
  let releaseA;
  const startedA = new Promise(resolve => { acquiredA = resolve; });
  const heldA = new Promise(resolve => { releaseA = resolve; });

  // Waiter A owns the lease until the queued timeout is observed.
  const pA = withFileLock(resource, async () => {
    executionOrder.push('A-start');
    acquiredA();
    await heldA;
    executionOrder.push('A-finish');
    return 'A';
  }, 1000);

  // Queue only after acquisition, independent of filesystem or scheduler speed.
  await startedA;

  // Waiter B: queues behind A but times out after 40ms
  const pB = withFileLock(resource, async () => {
    executionOrder.push('B');
    return 'B';
  }, 40).catch(err => {
    executionOrder.push('B-timeout');
    return 'B-caught';
  });

  // Waiter C: queues behind B with generous 1000ms timeout
  const pC = withFileLock(resource, async () => {
    executionOrder.push('C');
    return 'C';
  }, 1000);

  try { await pB; } finally { releaseA(); }
  const [resA, resB, resC] = await Promise.all([pA, pB, pC]);

  assert.equal(resA, 'A');
  assert.equal(resB, 'B-caught');
  assert.equal(resC, 'C');

  // Verify order: A starts, B times out while A is running, A finishes, C runs after A
  assert.deepEqual(executionOrder, ['A-start', 'B-timeout', 'A-finish', 'C']);

  // Verify inProcessLocks map is completely cleaned up
  assert.equal(inProcessLocks.has(path.resolve(resource)), false);
});

test('Perf Optimization Area 3: withFileLock handles concurrency with jittered exponential backoff', async () => {
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

test('storage locks serialize actual competing Node processes (F09/F10)',async()=>{
  const counter=path.join(tempDir,'multiprocess-counter');fs.writeFileSync(counter,'0');
  const module=path.resolve(__dirname, '../..', 'src/sessions/lock.ts');
  const script=`const fs=require('node:fs/promises');const {withFileLock}=require(process.argv[1]);(async()=>{for(let i=0;i<8;i++)await withFileLock(process.argv[2],async()=>{const n=Number(await fs.readFile(process.argv[2],'utf8'));await new Promise(r=>setTimeout(r,2));await fs.writeFile(process.argv[2],String(n+1));});})().catch(e=>{console.error(e);process.exitCode=1;});`;
  await Promise.all(Array.from({length:3},()=>new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,['--require','tsx/cjs','-e',script,module,counter],{stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';proc.stderr.on('data',d=>{error+=d;});proc.on('error',reject);proc.on('exit',code=>code===0?resolve():reject(new Error(error)));
  })));
  assert.equal(fs.readFileSync(counter,'utf8'),'24');
});

test('atomic lease lock serializes contender and recovers cleanly upon release', async () => {
  const resource = path.join(tempDir, 'atomic-lease-contention');
  let releaseOwner, ownerEntered, contenderEntered = false;
  const ownerGate = new Promise(r => releaseOwner = r);
  const ownerReady = new Promise(r => ownerEntered = r);

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
