'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-sessions-session-'));
process.env.coagent8_DIR = tempDir;
const tempSessionsFile = path.join(tempDir, 'sessions.json');
process.env.coagent8_SESSIONS = tempSessionsFile;

const {
  createSession,
  pruneExpiredSessions,
  getSessionsDir,
  getSession,
  updateSession,
  closeSession,
  resolveOrInitSession,
  acquireAndResolveSession,
  acquireSessionTurn,
  releaseSessionTurn,
  getSessionFilePath,
  cancelSession,
} = require('../../src/sessions/session.ts');
const { withFileLock } = require('../../src/storage/lock.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../src/contracts/error.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('atomic file lease replaces .claims directory and prevents race conditions', async () => {
  const resource = path.join(tempDir, 'atomic-lease-test');
  const leaseFile = `${resource}.lease`;
  const claimsDir = `${resource}.claims`;

  let lockHeld = false;
  const execution = withFileLock(resource, async () => {
    lockHeld = true;
    assert.ok(fs.existsSync(leaseFile), 'Lease file must exist while lock is held');
    assert.ok(!fs.existsSync(claimsDir), 'Legacy .claims directory must NOT be created');
    await new Promise(resolve => setTimeout(resolve, 50));
    return 'success';
  });

  const result = await execution;
  assert.equal(result, 'success');
  assert.equal(lockHeld, true);
  assert.ok(!fs.existsSync(leaseFile), 'Lease file must be removed after release');
});

test('stale lease with dead process is atomically reclaimed', async () => {
  const resource = path.join(tempDir, 'stale-lease-test');
  const leaseFile = `${resource}.lease`;

  // Write a stale lease with a dead PID (e.g. 99999999)
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
  fs.writeFileSync(leaseFile, JSON.stringify({ token: randomUUID(), pid: 99999999, createdAt: Date.now() }));
  assert.ok(fs.existsSync(leaseFile), 'Stale lease exists');

  // A live process must atomically reclaim and acquire the lease
  let reclaimed = false;
  await withFileLock(resource, async () => {
    reclaimed = true;
  });

  assert.equal(reclaimed, true, 'Lock must be acquired after reclaiming stale lease');
  assert.ok(!fs.existsSync(leaseFile), 'Lease file must be cleaned up');
});

test('the session sweep leaves leases to the lease protocol (AUD-P1-9)', async () => {
  // The sweep once deleted every dead owner's `.json.lease` by name, outside the token
  // protocol, and could delete a newer lease that replaced it meanwhile. It now reaches
  // leases only through withFileLock on a session record, which verifies the owner.
  createSession('agy', tempDir);
  const handle = 'syn_sess_0123456789abcdef01234567';
  const leasePath = path.join(getSessionsDir(), `${handle}.json.lease`);
  const lease = JSON.stringify({ token: randomUUID(), pid: 99999999, createdAt: Date.now() });
  fs.writeFileSync(leasePath, lease);
  await pruneExpiredSessions(true);
  assert.equal(fs.readFileSync(leasePath, 'utf8'), lease, 'the sweep deletes no lease by name');
  await withFileLock(path.join(getSessionsDir(), `${handle}.json`), async () => {});
  assert.equal(fs.existsSync(leasePath), false, 'withFileLock reclaims the lease of the dead owner');
});

test('stale lease recovery does not steal replacement lease of a live owner', async () => {
  const resource = path.join(tempDir, 'lease-race-test');
  const leaseFile = `${resource}.lease`;

  // Write stale lease for dead PID
  const deadToken = randomUUID();
  fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
  fs.writeFileSync(leaseFile, JSON.stringify({ token: deadToken, pid: 99999999, createdAt: Date.now() }));

  // Run withFileLock and verify it cleanly acquires without corrupting live locks
  let acquired = false;
  await withFileLock(resource, async () => {
    acquired = true;
    const current = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.notEqual(current.token, deadToken);
  });
  assert.equal(acquired, true);
  assert.ok(!fs.existsSync(leaseFile));
});

test('session manager persists, updates, and closes multi-turn session handles cleanly', async () => {
  // Create session
  const session = createSession('codex', process.cwd());
  assert.ok(session);
  assert.ok(session.sessionHandle.startsWith('syn_sess_'));
  assert.equal(session.backend, 'codex');
  assert.equal(session.threadId, null);

  // Retrieve session
  const loaded = getSession(session.sessionHandle);
  assert.ok(loaded);
  assert.equal(loaded.sessionHandle, session.sessionHandle);

  // Update session with captured CLI threadId
  const updated = await updateSession(session.sessionHandle, { threadId: 'thread_xyz999' });
  assert.equal(updated.threadId, 'thread_xyz999');

  const reloaded = getSession(session.sessionHandle);
  assert.equal(reloaded.threadId, 'thread_xyz999');

  // Close session
  const closed = await closeSession(session.sessionHandle);
  assert.equal(closed, true);
  assert.equal(getSession(session.sessionHandle), null);

  // Workspace and backend validation
  const sess2 = createSession('codex', path.join(tempDir, 'project-a'));
  assert.ok(getSession(sess2.sessionHandle, { backend: 'codex', workspace: path.join(tempDir, 'project-a') }));
  assert.equal(getSession(sess2.sessionHandle, { backend: 'claude' }), null);
  assert.equal(getSession(sess2.sessionHandle, { workspace: path.join(tempDir, 'project-b') }), null);

  // resolveOrInitSession tests
  const resolvedValid = resolveOrInitSession(sess2.sessionHandle, 'codex', path.join(tempDir, 'project-a'));
  assert.ok(resolvedValid.session);
  assert.equal(resolvedValid.session.sessionHandle, sess2.sessionHandle);

  const resolvedInvalid = resolveOrInitSession('syn_sess_nonexistent', 'codex', path.join(tempDir, 'project-a'));
  assert.ok(resolvedInvalid.error);
  assert.ok(resolvedInvalid.error.includes('Invalid or expired session handle'));

  const resolvedWrongDir = resolveOrInitSession(sess2.sessionHandle, 'codex', path.join(tempDir, 'project-b'));
  assert.ok(resolvedWrongDir.error);

  const resolvedFresh = resolveOrInitSession(null, 'codex', path.join(tempDir, 'project-a'));
  assert.ok(resolvedFresh.session);
  assert.ok(resolvedFresh.session.sessionHandle.startsWith('syn_sess_'));

  // Concurrency & process isolation test
  const sessA = createSession('codex', path.join(tempDir, 'workspace-1'));
  const sessB = createSession('codex', path.join(tempDir, 'workspace-2'));
  await updateSession(sessA.sessionHandle, { threadId: 'thread_aaa' });
  await updateSession(sessB.sessionHandle, { threadId: 'thread_bbb' });
  assert.equal(getSession(sessA.sessionHandle).threadId, 'thread_aaa');
  assert.equal(getSession(sessB.sessionHandle).threadId, 'thread_bbb');
  await closeSession(sessA.sessionHandle);
  assert.equal(getSession(sessA.sessionHandle), null);
  assert.equal(getSession(sessB.sessionHandle).threadId, 'thread_bbb');

  // Turn serialization test
  const turn1 = await acquireSessionTurn(sessB.sessionHandle);
  assert.equal(turn1.ok, true);

  // Competing turn on same session while busy
  const turn2 = await acquireSessionTurn(sessB.sessionHandle);
  assert.equal(turn2.ok, false);
  assert.ok(turn2.error.includes('currently busy executing another turn'));

  // Attempting to close while busy throws
  await assert.rejects(async () => {
    await closeSession(sessB.sessionHandle);
  }, /Cannot close session.*busy executing another turn/);

  // Release turn
  await releaseSessionTurn(sessB.sessionHandle);

  // acquireAndResolveSession acquires turn and returns session
  const turnResolved = await acquireAndResolveSession(sessB.sessionHandle, 'codex', path.join(tempDir, 'workspace-2'));
  assert.ok(turnResolved.session);
  assert.equal(turnResolved.session.sessionHandle, sessB.sessionHandle);

  // A concurrent turn while resolved turn is open is rejected
  const turnConcurrent = await acquireAndResolveSession(sessB.sessionHandle, 'codex', path.join(tempDir, 'workspace-2'));
  assert.ok(turnConcurrent.error);
  assert.ok(turnConcurrent.error.includes('currently busy executing another turn'));

  await releaseSessionTurn(sessB.sessionHandle);

  // After turn release, closing succeeds
  const closedB = await closeSession(sessB.sessionHandle);
  assert.equal(closedB, true);
});

test('pruneExpiredSessions removes expired sessions and preserves legacy artifacts', async () => {
  const sessionsDir = getSessionsDir();
  const activeSess = createSession('codex', path.join(tempDir, 'active'));

  // Create an expired session file (> 2h old)
  const expiredHandle = 'syn_sess_expired123';
  const expiredFile = path.join(sessionsDir, `${expiredHandle}.json`);
  const twoHoursAndTenMinsAgo = new Date(Date.now() - 130 * 60 * 1000).toISOString();
  fs.writeFileSync(expiredFile, JSON.stringify({
    sessionHandle: expiredHandle,
    backend: 'codex',
    workspace: path.join(tempDir, 'active'),
    createdAt: twoHoursAndTenMinsAgo,
    lastUsedAt: twoHoursAndTenMinsAgo,
  }), 'utf8');

  // Create an expired busy lock
  const expiredBusy = path.join(sessionsDir, `${expiredHandle}.busy`);
  fs.writeFileSync(expiredBusy, JSON.stringify({ pid: 9999999, lockedAt: Date.now() - 130 * 60 * 1000 }), 'utf8');

  assert.ok(fs.existsSync(expiredFile));
  assert.ok(fs.existsSync(expiredBusy));

  // Run forced prune
  await pruneExpiredSessions(true);

  // Expired files should be purged
  assert.equal(fs.existsSync(expiredFile), false);
  assert.equal(fs.existsSync(expiredBusy), true, 'Legacy lock paths are not deleted by the new owner protocol');

  // Active session should remain intact
  assert.ok(getSession(activeSess.sessionHandle));
});

test('acquireSessionTurn safely reclaims lock held by dead process', async () => {
  const sess = createSession('codex', path.join(tempDir, 'dead-proc-test'));
  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${sess.sessionHandle}.json`);

  // Simulate a turn belonging to a dead PID (e.g. 99999999)
  const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  sessionData.activePid = 99999999;
  sessionData.activeTurnAt = Date.now() - 20000;
  fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');

  // acquireSessionTurn should detect dead PID, safely reclaim the turn, and succeed
  const turn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(turn.ok, true);

  // We now own the turn
  const updated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(updated.activePid, process.pid);

  await releaseSessionTurn(sess.sessionHandle);
  const released = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(released.activePid, null);
});

test('active session turn is strictly immune from TTL expiration while executing', async () => {
  const sess = createSession('codex', path.join(tempDir, 'active-ttl-test'));
  assert.equal((await acquireSessionTurn(sess.sessionHandle)).ok, true);
  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${sess.sessionHandle}.json`);

  // Simulate an active turn owned by this live process, but lastUsedAt is 3 hours ago (> 2h TTL)
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const rawSession = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  rawSession.activePid = process.pid;
  rawSession.activeTurnAt = Date.now() - 3 * 3600 * 1000;
  rawSession.lastUsedAt = threeHoursAgo;
  fs.writeFileSync(filePath, JSON.stringify(rawSession, null, 2), 'utf8');

  // getSession MUST NOT delete an actively executing session
  const loaded = getSession(sess.sessionHandle);
  assert.ok(loaded, 'Actively executing session should not be expired or deleted by getSession');
  assert.equal(loaded.activePid, process.pid);
  assert.ok(fs.existsSync(filePath), 'Session file must remain on disk while executing');

  // While busy, concurrent turn is rejected
  const busyTurn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(busyTurn.ok, false);

  // Release the turn
  await releaseSessionTurn(sess.sessionHandle);

  // Now acquire a new turn cleanly
  const turn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(turn.ok, true);
  assert.ok(fs.existsSync(filePath));

  // Release turn again
  await releaseSessionTurn(sess.sessionHandle);

  // Now that turn is released (IDLE), backdate lastUsedAt to 3 hours ago
  const idleSession = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  idleSession.lastUsedAt = threeHoursAgo;
  fs.writeFileSync(filePath, JSON.stringify(idleSession, null, 2), 'utf8');

  // Now that it is idle, getSession strictly expires and cleans it up
  const expired = getSession(sess.sessionHandle);
  assert.equal(expired, null, 'Idle session older than 2 hours should expire');
  await pruneExpiredSessions(true);
  assert.equal(fs.existsSync(filePath), false, 'Expired idle session file should be unlinked');
});

test('dead legacy lock is preserved while the new unique-claim protocol acquires the turn', async () => {
  const sess = createSession('codex', path.join(tempDir, 'competing-reclaim'));
  const sessionsDir = getSessionsDir();
  const lockFile = path.join(sessionsDir, `${sess.sessionHandle}.json.lock`);
  const reclaimMutex = `${lockFile}.reclaim`;

  // Write a stale lock file with dead PID
  const staleData = JSON.stringify({ token: 'dead_token', pid: 99999999, time: Date.now() - 10000 });
  fs.writeFileSync(lockFile, staleData, 'utf8');

  // Legacy shared pathnames are never reclaimed or replaced by the new protocol.
  const turn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(turn.ok, true);
  assert.equal(fs.readFileSync(lockFile,'utf8'),staleData);

  assert.equal(fs.existsSync(reclaimMutex), false);

  await releaseSessionTurn(sess.sessionHandle);
});

test('F09/F10/F11: unique claim ownership, async contention, stale claimant recovery, validation and immutable fields',async()=>{
  const sess=createSession('codex',tempDir);
  const file=getSessionFilePath(sess.sessionHandle);
  const first=await acquireSessionTurn(sess.sessionHandle);assert.ok(first.ok);
  assert.equal((await acquireSessionTurn(sess.sessionHandle)).ok,false);
  assert.equal((await releaseSessionTurn(sess.sessionHandle,randomUUID())).ok,false);
  assert.equal(getSession(sess.sessionHandle).turnToken,first.data.token);
  await releaseSessionTurn(sess.sessionHandle,first.data.token);
  await assert.rejects(updateSession(sess.sessionHandle,{backend:'agy'}),/Immutable/);
  assert.equal(getSession('../'+sess.sessionHandle),null);
  const data=JSON.parse(fs.readFileSync(file,'utf8'));data.lastUsedAt='invalid-date';fs.writeFileSync(file,JSON.stringify(data));
  assert.equal(getSession(sess.sessionHandle),null);
  const lock=path.join(tempDir,'counter');let responsive=false;
  const held=withFileLock(lock,async()=>{await new Promise(resolve=>setTimeout(resolve,80));});
  await new Promise(resolve=>setTimeout(resolve,10));
  const contender=withFileLock(lock,async()=>{});
  setTimeout(()=>{responsive=true;},20);await Promise.all([held,contender]);assert.ok(responsive);
});

test('session leases reject a second process, permit an independent session and recover a dead turn owner',async()=>{
  const a=createSession('codex',tempDir),b=createSession('codex',tempDir),c=createSession('codex',tempDir);
  const lease=await acquireSessionTurn(a.sessionHandle);assert.ok(lease.ok);
  const script=`const s=require(process.argv[1]);(async()=>{const busy=await s.acquireSessionTurn(process.argv[2]);const independent=await s.acquireSessionTurn(process.argv[3]);await s.releaseSessionTurn(process.argv[3],independent.data.token);const abandoned=await s.acquireSessionTurn(process.argv[4]);console.log(JSON.stringify({busy,independent,abandoned}));})().catch(()=>process.exit(1));`;
  const data=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',script,path.resolve(__dirname, '../..', 'src/sessions/session.ts'),a.sessionHandle,b.sessionHandle,c.sessionHandle],{env:{...process.env},windowsHide:true});let out='';p.stdout.on('data',d=>out+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error('lease fixture failed')));});
  assert.equal(data.busy.ok,false);assert.equal(data.independent.ok,true);assert.equal(data.abandoned.ok,true);
  await releaseSessionTurn(a.sessionHandle,lease.data.token);
  const recovered=await acquireSessionTurn(c.sessionHandle);assert.equal(recovered.ok,true);assert.notEqual(recovered.data.token,data.abandoned.data.token);await releaseSessionTurn(c.sessionHandle,recovered.data.token);
});

test('production execution automatically prunes expired session metadata with history disabled',async()=>{
  const data=path.join(tempDir,'prune-production');fs.mkdirSync(data);
  const script=`process.env.coagent8_DIR=process.argv[1];process.env.coagent8_HISTORY='off';const fs=require('node:fs');const path=require('node:path');const s=require(process.argv[2]);const {adapterRegistry}=require(process.argv[3]);const {executeTask}=require(process.argv[4]);(async()=>{const old=s.createSession('agy',process.argv[1]);const file=s.getSessionFilePath(old.sessionHandle);const raw=JSON.parse(fs.readFileSync(file));raw.lastUsedAt=new Date(0).toISOString();fs.writeFileSync(file,JSON.stringify(raw));adapterRegistry.agy={id:'agy',name:'fixture',probe:async()=>({installed:true,executionSupported:true,config:{defaultModel:'fixture-model'}}),execute:async()=>({status:'completed',isError:false,output:'public',truncated:false,continuationAvailable:false})};await executeTask('x','x',{backend:'agy'},process.argv[1]);console.log(JSON.stringify({oldFile:fs.existsSync(file)}));})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',script,data,path.resolve(__dirname, '../..', 'src/sessions/session.ts'),path.resolve(__dirname, '../..', 'src/backends/registry.ts'),path.resolve(__dirname, '../..', 'src/execution/controller.ts')],{env:{...process.env},windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
  assert.equal(result.oldFile,false);
});

test('closing expired, invalidated or already closed sessions checks workspace under the storage lock',async()=>{
  const {handleCloseSession}=require('../../src/mcp/tools/session.tool.ts');
  fs.mkdirSync(path.join(tempDir,'other'),{recursive:true});
  for(const state of ['idle','invalidated','closed']) {
    const s=createSession('codex',tempDir),file=getSessionFilePath(s.sessionHandle),raw=JSON.parse(fs.readFileSync(file));
    raw.state=state;raw.lastUsedAt=new Date(Date.now()-3*3600*1000).toISOString();fs.writeFileSync(file,JSON.stringify(raw));
    await assert.rejects(handleCloseSession({session_handle:s.sessionHandle,workspace_path:path.join(tempDir,'other')}),/workspace mismatch/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),raw);
    await handleCloseSession({session_handle:s.sessionHandle,workspace_path:tempDir});
    assert.equal(JSON.parse(fs.readFileSync(file)).state,'closed');
  }
});

test('EXEC-001-T09c: aborting contender waiting for busy session lock rejects without corrupting active turn or stranding subsequent contenders', async () => {
  const sess = createSession('codex', path.join(tempDir, 'contender-abort-test'));
  const handle = sess.sessionHandle;
  const file = getSessionFilePath(handle);

  // 1. Acquire active turn on the session
  const turn1 = await acquireSessionTurn(handle);
  assert.equal(turn1.ok, true);
  const activeToken = turn1.data.token;
  assert.equal(getSession(handle).turnToken, activeToken);

  // 2. Simulate storage lock contention: hold session file lock
  let lockAcquired;
  const lockAcquiredPromise = new Promise(resolve => { lockAcquired = resolve; });
  let allowLockRelease;
  const allowLockReleasePromise = new Promise(resolve => { allowLockRelease = resolve; });

  const holdingLockPromise = withFileLock(file, async () => {
    lockAcquired();
    await allowLockReleasePromise;
  });

  await lockAcquiredPromise;

  // 3. Contender 2 attempts acquisition with abortSignal while lock is held
  const ac2 = new AbortController();
  const contender2Promise = acquireSessionTurn(handle, { abortSignal: ac2.signal });

  // Contender 3 queues up behind Contender 2
  const contender3Promise = acquireSessionTurn(handle);

  // 4. Abort Contender 2 while waiting in queue
  ac2.abort();

  // Contender 2 must reject immediately with ABORTED ToolError
  await assert.rejects(contender2Promise, err => {
    assert.ok(err instanceof ToolError, 'Must throw ToolError');
    assert.equal(err.code, 'ABORTED', 'Error code must be ABORTED');
    return true;
  });

  // 5. Active turn must remain completely untouched
  const sessionDuring = getSession(handle);
  assert.ok(sessionDuring, 'Session record must exist');
  assert.equal(sessionDuring.turnToken, activeToken, 'Active turn token must not be modified or cleared');
  assert.equal(sessionDuring.activePid, process.pid, 'Active PID must remain process.pid');

  // 6. Release file lock so Contender 3 can proceed
  allowLockRelease();
  await holdingLockPromise;

  // Contender 3 finishes lock wait and receives busy (since active turn is still executing)
  const result3 = await contender3Promise;
  assert.equal(result3.ok, false, 'Contender 3 sees session busy');
  assert.ok(result3.error.includes('busy executing another turn'));

  // 7. Cleanly release active turn 1
  await releaseSessionTurn(handle, activeToken);

  // 8. Subsequent contender 4 acquires cleanly without hanging or being stranded
  const contender4 = await acquireSessionTurn(handle);
  assert.equal(contender4.ok, true, 'Subsequent contender acquires successfully');
  assert.notEqual(contender4.data.token, activeToken);
  await releaseSessionTurn(handle, contender4.data.token);
});

test('EXEC-001-T09c: expired execution budget before or during session acquisition rejects without leaving turnToken or orphaned session', async () => {
  // Case A: Pre-expired budget for new session creation
  const expiredBudget = createExecutionBudget({ totalBudgetMs: 1, teardownAllowanceMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(expiredBudget.isExecutionExpired(), true, 'Budget must be expired');

  const dir = getSessionsDir();
  const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir) : [];

  await assert.rejects(
    acquireAndResolveSession(null, 'codex', tempDir, { budget: expiredBudget }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    }
  );

  const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(filesAfter, filesBefore, 'No orphaned session file should be created for pre-expired budget');

  // Case B: Pre-expired budget on existing session
  const sess = createSession('codex', path.join(tempDir, 'existing-expired-test'));
  const handle = sess.sessionHandle;
  const initialRecord = getSession(handle);
  assert.equal(initialRecord.turnToken, null);

  await assert.rejects(
    acquireAndResolveSession(handle, 'codex', path.join(tempDir, 'existing-expired-test'), { budget: expiredBudget }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    }
  );

  const recordAfter = getSession(handle);
  assert.equal(recordAfter.turnToken, null, 'No turnToken created on existing session');
  assert.equal(recordAfter.state, 'idle', 'Session remains idle');
  assert.equal(recordAfter.activePid, null, 'ActivePid remains null');

  // Case C: Budget expires while waiting for session lock
  const file = getSessionFilePath(handle);
  let lockAcquired;
  const lockAcquiredPromise = new Promise(resolve => { lockAcquired = resolve; });
  let allowLockRelease;
  const allowLockReleasePromise = new Promise(resolve => { allowLockRelease = resolve; });

  const lockHold = withFileLock(file, async () => {
    lockAcquired();
    await allowLockReleasePromise;
  });

  await lockAcquiredPromise;

  // Short budget that expires while waiting for lock
  const shortBudget = createExecutionBudget({ totalBudgetMs: 50, teardownAllowanceMs: 25 });
  const inFlightPromise = acquireSessionTurn(handle, { budget: shortBudget });

  await assert.rejects(
    inFlightPromise,
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    }
  );

  allowLockRelease();
  await lockHold;

  const recordAfterContention = getSession(handle);
  assert.equal(recordAfterContention.turnToken, null, 'No orphaned turnToken after in-flight timeout');
  assert.equal(recordAfterContention.state, 'idle', 'Session remains idle');
});

test('EXEC-001-T09c: acquireSessionTurn surfaces expiry ToolError even if rollback write fails', async () => {
  const sess = createSession('codex', path.join(tempDir, 'failed-rollback-test'));
  const handle = sess.sessionHandle;
  const ac = new AbortController();

  const fsp = require('node:fs/promises');
  const originalRename = fsp.rename;
  let callCount = 0;
  fsp.rename = async function (...args) {
    if (typeof args[1] === 'string' && args[1].includes(handle)) {
      callCount++;
      if (callCount === 1) {
        ac.abort();
        return originalRename.apply(this, args);
      }
      throw new Error('EIO: simulated disk write failure during rollback');
    }
    return originalRename.apply(this, args);
  };

  try {
    await assert.rejects(
      acquireSessionTurn(handle, { abortSignal: ac.signal }),
      err => {
        assert.ok(err instanceof ToolError, 'Must surface ToolError despite rollback failure');
        assert.equal(err.code, 'ABORTED');
        return true;
      }
    );
  } finally {
    fsp.rename = originalRename;
  }

  // Verify that this process holds no active turn ownership in memory
  await assert.rejects(
    updateSession(handle, { threadId: 'thread-test' }),
    err => {
      assert.ok(err.message.includes('Turn ownership mismatch'));
      return true;
    }
  );
});

test('EXEC-001-T09c: session lock timeout under contention returns {ok:false} when options are provided without expiry', async () => {
  const sess = createSession('codex', path.join(tempDir, 'lock-contention-options-test'));
  const handle = sess.sessionHandle;
  const file = getSessionFilePath(handle);

  let lockHeld;
  const lockHeldPromise = new Promise(resolve => { lockHeld = resolve; });
  let allowRelease;
  const allowReleasePromise = new Promise(resolve => { allowRelease = resolve; });

  const hold = withFileLock(file, async () => {
    lockHeld();
    await allowReleasePromise;
  });

  await lockHeldPromise;

  const result = await acquireSessionTurn(handle, { timeoutMs: 30 });
  assert.equal(result.ok, false, 'Must return {ok:false} rather than throwing on plain contention timeout');
  assert.ok(result.error, 'Must provide error message');

  allowRelease();
  await hold;
});

test('EXEC-001-T09c: acquireSessionTurn rejects with TIMEOUT when real budget remainingExecutionMs reaches zero at sub-millisecond boundary', async () => {
  const sess = createSession('codex', path.join(tempDir, 'budget-zero-remaining-test'));
  const handle = sess.sessionHandle;

  let currentClock = 1000;
  const customClock = () => currentClock;
  const realBudget = createExecutionBudget({
    totalBudgetMs: 100,
    teardownAllowanceMs: 20,
    clock: customClock,
  });

  // Advance clock to 1079.8ms:
  // executionDeadlineMs is 1080ms.
  // remainingExecutionMs = Math.floor(1080 - 1079.8) = Math.floor(0.2) = 0.
  // isExecutionExpired = 1079.8 >= 1080 = false.
  currentClock = 1079.8;
  assert.equal(realBudget.remainingExecutionMs(), 0, 'remainingExecutionMs must be 0');
  assert.equal(realBudget.isExecutionExpired(), false, 'isExecutionExpired must be false at 1079.8ms');

  await assert.rejects(
    acquireSessionTurn(handle, { budget: realBudget }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      assert.match(err.message, /Execution budget expired/);
      return true;
    }
  );

  const s = getSession(handle);
  assert.equal(s.turnToken, null);
  assert.equal(s.state, 'idle');
});

test('cancel of a closed session says it is closed, not that no turn runs (FEEDBACK-060e)', async () => {
  const session = createSession('codex', path.join(tempDir, 'closed-cancel'));
  assert.equal(await closeSession(session.sessionHandle), true);
  const outcome = await cancelSession(session.sessionHandle);
  assert.equal(outcome.cancelled, false);
  assert.match(outcome.message, /is closed; nothing to cancel/);
});

test('AUDIT-001-A08: a failed initial publication returns no handle, acquires no turn and leaves no file', async () => {
  const { createSession: create, acquireAndResolveSession: acquire, listSessions: list, getSessionsDir: dir } = require('../../src/sessions/session.ts');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-a08-'));
  const before = fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : [];
  const rename = fs.renameSync;
  // A new session publishes a temporary file by renaming it to a fresh handle; fail that step.
  fs.renameSync = (from, to) => { if (String(from).includes('.tmp.')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); return rename(from, to); };
  try {
    assert.throws(() => create('codex', workspace), /EPERM/, 'createSession reports the failure instead of returning a handle');
    await assert.rejects(acquire(null, 'codex', workspace), /EPERM/, 'no turn is acquired after a failed creation');
  } finally {
    fs.renameSync = rename;
  }
  const after = fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : [];
  assert.deepEqual(after, before, 'neither a session file nor a temporary file remains');
  assert.deepEqual(list(workspace), []);
  // The same path succeeds once publication works, and only then is the handle returned.
  const created = create('codex', workspace);
  assert.ok(fs.existsSync(path.join(dir(), `${created.sessionHandle}.json`)));
  fs.rmSync(workspace, { recursive: true, force: true });
});
