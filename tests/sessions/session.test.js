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
} = require('../../src/sessions/session.ts');
const { withFileLock } = require('../../src/sessions/lock.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('Phase 2 Task 2.2: atomic file lease replaces .claims directory and prevents race conditions', async () => {
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

test('Phase 2 Task 2.2: stale lease with dead process is atomically reclaimed', async () => {
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

test('Phase 2 Task 2.2: session pruner cleans up stale .lease files', async () => {
  const sess = createSession('gemini', tempDir);
  const leasePath = path.join(getSessionsDir(), `${sess.sessionHandle}.json.lease`);

  fs.writeFileSync(leasePath, JSON.stringify({ token: randomUUID(), pid: 99999999, createdAt: Date.now() }));
  assert.ok(fs.existsSync(leasePath), 'Simulated stale lease file exists');

  await pruneExpiredSessions(true);
  assert.ok(!fs.existsSync(leasePath), 'Stale lease file must be pruned when owner is dead');
});

test('Phase 2 Audit Remediation: stale lease recovery does not steal replacement lease of a live owner', async () => {
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
  await assert.rejects(updateSession(sess.sessionHandle,{backend:'gemini'}),/Immutable/);
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
  const script=`process.env.coagent8_DIR=process.argv[1];process.env.coagent8_HISTORY='off';const fs=require('node:fs');const path=require('node:path');const s=require(process.argv[2]);const {adapterRegistry}=require(process.argv[3]);const {executeTask}=require(process.argv[4]);(async()=>{const old=s.createSession('gemini',process.argv[1]);const file=s.getSessionFilePath(old.sessionHandle);const raw=JSON.parse(fs.readFileSync(file));raw.lastUsedAt=new Date(0).toISOString();fs.writeFileSync(file,JSON.stringify(raw));adapterRegistry.gemini={id:'gemini',name:'fixture',probe:async()=>({installed:true,executionSupported:true}),execute:async()=>({status:'completed',isError:false,output:'public',truncated:false,continuationAvailable:false})};await executeTask('x','x',{backend:'gemini'},process.argv[1]);console.log(JSON.stringify({oldFile:fs.existsSync(file)}));})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',script,data,path.resolve(__dirname, '../..', 'src/sessions/session.ts'),path.resolve(__dirname, '../..', 'src/backends/registry.ts'),path.resolve(__dirname, '../..', 'src/execution/controller.ts')],{env:{...process.env},windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
  assert.equal(result.oldFile,false);
});

test('closing expired, invalidated or already closed sessions checks workspace under the storage lock',async()=>{
  const {handleCloseSession}=require('../../src/tools/session.tool.ts');
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
