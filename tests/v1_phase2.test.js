const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-phase2-'));
process.env.coagent8_DIR = tempDir;

const {
  createHistoryWriter,
  sessionHistory,
  getHistory,
  getHistoryDir,
  deleteHistory,
  pruneHistoryDirectory,
} = require('../src/sessions/history.ts');

const {
  createSession,
  getSession,
  acquireSessionTurn,
  releaseSessionTurn,
  listSessions,
  pruneExpiredSessions,
  getSessionsDir,
} = require('../src/sessions/session.ts');

const { withFileLock, inProcessLocks } = require('../src/sessions/lock.ts');
const { createServer } = require('../src/server.ts');
const {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// =========================================================================
// Task 2.1: Append-Only Event Store (JSONL WAL)
// =========================================================================

test('Phase 2 Task 2.1: streaming deltas append directly to .jsonl event store in O(1)', async () => {
  const sess = createSession('gemini', tempDir);
  const turnId = randomUUID();
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', turnId);

  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Hello Phase 2 append-only store' });
  await writer.flush();

  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);
  assert.ok(fs.existsSync(logFile), 'JSONL event log must exist');

  const rawBefore = fs.readFileSync(logFile, 'utf8');
  const linesBefore = rawBefore.trim().split('\n');
  assert.ok(linesBefore.length >= 2, 'Header and events should be present in JSONL');

  // Streaming deltas append new lines to .jsonl
  for (let i = 1; i <= 3; i++) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: `chunk-${i} ` });
    await writer.flush();
  }

  const rawAfterDeltas = fs.readFileSync(logFile, 'utf8');
  assert.ok(rawAfterDeltas.length > rawBefore.length, 'Log file must grow with streaming appends');
  assert.ok(rawAfterDeltas.includes('chunk-3'), 'Delta content must be appended to the log file');

  // Complete turn
  writer.accept({ type: 'assistant_message', messageId: 'm1', text: 'Final complete answer' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const history = await getHistory(sess.sessionHandle);
  assert.ok(history, 'History must be loadable');
  assert.equal(history.events.filter(e => e.type === 'assistant_message').length, 1);
  assert.equal(history.events.find(e => e.type === 'assistant_message').text, 'Final complete answer');
  assert.equal(history.events.at(-1).type, 'turn_finished');
  assert.equal(history.events.at(-1).status, 'completed');
});

test('Phase 2 Task 2.1: capacity limits are strictly enforced during append-only writes', async () => {
  const sess = createSession('gemini', tempDir);
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());

  // Oversized message exceeding 10MB session limit must fail on flush
  for (let i = 0; i < 11; i++) {
    writer.accept({ type: 'assistant_message', messageId: `msg-${i}`, text: 'X'.repeat(1024 * 1024) });
  }

  await assert.rejects(
    async () => { await writer.flush(); },
    /History session limit reached\./
  );
});

// =========================================================================
// Task 2.2: Atomic Session Leases
// =========================================================================

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

// =========================================================================
// Task 2.3: Deterministic Pagination & MCP Resources
// =========================================================================

test('Phase 2 Task 2.3: pagination is deterministically indexed by event sequence', async () => {
  const sess = createSession('gemini', tempDir);
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());

  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Prompt 1' });
  writer.accept({ type: 'assistant_message', messageId: 'm1', text: 'Answer 1' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const writer2 = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());
  writer2.accept({ type: 'turn_started' });
  writer2.accept({ type: 'user_message', text: 'Prompt 2' });
  writer2.accept({ type: 'assistant_message', messageId: 'm2', text: 'Answer 2' });
  writer2.accept({ type: 'turn_finished', status: 'completed' });
  await writer2.flush();

  // Page 1 with limit=3
  const page1 = await sessionHistory(sess.sessionHandle, tempDir, undefined, 3);
  assert.equal(page1.events.length, 3);
  assert.ok(page1.nextCursor, 'Next cursor must be present');

  // Verify cursor format: contains sequence after
  const decodedCursor = JSON.parse(Buffer.from(page1.nextCursor, 'base64url').toString('utf8'));
  assert.equal(decodedCursor.handle, sess.sessionHandle);
  assert.equal(decodedCursor.after, 3);

  // Page 2
  const page2 = await sessionHistory(sess.sessionHandle, tempDir, page1.nextCursor, 3);
  assert.equal(page2.events.length, 3);
  assert.equal(page2.events[0].sequence, 4);

  // Remaining events on page 3
  const page3 = await sessionHistory(sess.sessionHandle, tempDir, page2.nextCursor, 3);
  assert.equal(page3.events.length, 2);
  assert.equal(page3.nextCursor, null, 'No next cursor on final page');
});

test('Phase 2 Task 2.3: MCP server registers and fulfills coagent8://sessions and coagent8://sessions/{id}/history resources', async () => {
  const sess = createSession('gemini', tempDir);
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Testing MCP resource exposure' });
  writer.accept({ type: 'assistant_message', messageId: 'm-mcp', text: 'MCP resources are live and durable.' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const server = createServer();

  // 1. List Resources
  const listHandler = server._requestHandlers?.get('resources/list') || server.handlers?.get?.('resources/list');
  // Access through request handler
  const resourcesResult = await server._requestHandlers.get('resources/list')({
    method: 'resources/list',
    params: {},
  });

  assert.ok(resourcesResult.resources.length >= 1, 'At least coagent8://sessions must be listed');
  const sessionsResource = resourcesResult.resources.find(r => r.uri === 'coagent8://sessions');
  assert.ok(sessionsResource, 'coagent8://sessions must be present');
  assert.equal(sessionsResource.mimeType, 'application/json');

  const historyResource = resourcesResult.resources.find(r => r.uri === `coagent8://sessions/${sess.sessionHandle}/history`);
  assert.ok(historyResource, 'Session-specific history resource must be listed');

  // 2. List Resource Templates
  const templatesResult = await server._requestHandlers.get('resources/templates/list')({
    method: 'resources/templates/list',
    params: {},
  });
  assert.ok(templatesResult.resourceTemplates.some(t => t.uriTemplate === 'coagent8://sessions/{id}/history'));

  // 3. Read coagent8://sessions
  const readSessionsResult = await server._requestHandlers.get('resources/read')({
    method: 'resources/read',
    params: { uri: 'coagent8://sessions' },
  });
  assert.equal(readSessionsResult.contents.length, 1);
  const parsedSessions = JSON.parse(readSessionsResult.contents[0].text);
  assert.ok(Array.isArray(parsedSessions));
  assert.ok(parsedSessions.some(s => s.sessionHandle === sess.sessionHandle));

  // 4. Read coagent8://sessions/{id}/history
  const readHistoryResult = await server._requestHandlers.get('resources/read')({
    method: 'resources/read',
    params: { uri: `coagent8://sessions/${sess.sessionHandle}/history` },
  });
  assert.equal(readHistoryResult.contents.length, 1);
  const parsedHistory = JSON.parse(readHistoryResult.contents[0].text);
  assert.equal(parsedHistory.sessionHandle, sess.sessionHandle);
  assert.ok(parsedHistory.events.length >= 4);

  // 5. Invalid / Unknown resource URI throws
  await assert.rejects(
    async () => {
      await server._requestHandlers.get('resources/read')({
        method: 'resources/read',
        params: { uri: 'coagent8://unknown-resource' },
      });
    },
    /Resource not found/
  );
});

// =========================================================================
// Author-Reviewer Audit Remediations (Codex Sol)
// =========================================================================

test('Phase 2 Audit Remediation: streaming deltas do not trigger monolithic .json snapshot rewrite', async () => {
  const sess = createSession('gemini', tempDir);
  const jsonFile = path.join(getHistoryDir(), `${sess.sessionHandle}.json`);
  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);

  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Prompt' });
  await writer.flush();

  assert.ok(fs.existsSync(jsonFile), 'Initial user message should materialize .json');
  const jsonStatBefore = fs.statSync(jsonFile);

  // Rapid streaming chunks
  await new Promise(r => setTimeout(r, 20));
  for (let i = 1; i <= 5; i++) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: `delta-${i} ` });
    await writer.flush();
  }

  // Verify that during streaming deltas, .json was NOT rewritten
  const jsonStatAfter = fs.statSync(jsonFile);
  assert.equal(jsonStatAfter.mtimeMs, jsonStatBefore.mtimeMs, 'JSON snapshot must not be rewritten during streaming deltas');

  // But .jsonl MUST have grown with O(1) appends
  assert.ok(fs.existsSync(logFile));
  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.ok(logContent.includes('delta-5'), 'Log file must have received streaming deltas');

  // Once turn finishes, .json snapshot is materialized
  await new Promise(r => setTimeout(r, 20));
  writer.accept({ type: 'assistant_message', messageId: 'm1', text: 'Complete answer' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const jsonStatFinal = fs.statSync(jsonFile);
  assert.ok(jsonStatFinal.mtimeMs > jsonStatBefore.mtimeMs, 'Final snapshot materialized on turn finish');
  const finalJson = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  assert.equal(finalJson.events.at(-1).type, 'turn_finished');
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


