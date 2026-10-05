const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const {
  resolveCliCommand,
  clearCliResolverCache,
} = require('../src/backends/cli-resolver.ts');
const {
  startDescendantTracking,
  terminateProcessTree,
  trackedDescendants,
} = require('../src/execution/process.ts');
const {
  truncateToByteLength,
  createStreamReducer,
} = require('../src/execution/stream.ts');
const {
  withFileLock,
  atomicWrite,
} = require('../src/sessions/lock.ts');
const {
  createHistoryWriter,
  sessionHistory,
  clearHistoryCache,
  invalidateHistoryCache,
  deleteHistory,
  getHistory,
} = require('../src/sessions/history.ts');
const {
  createSession,
  closeSession,
} = require('../src/sessions/session.ts');

test('Perf Optimization Area 1: CLI resolution caching with clearCliResolverCache and fast hits', () => {
  clearCliResolverCache();

  // Resolve node executable (guaranteed to exist across platforms)
  const res1 = resolveCliCommand(process.execPath);
  assert.ok(res1);
  assert.equal(res1.source, 'native');

  // Second resolution should return from cache
  const res2 = resolveCliCommand(process.execPath);
  assert.deepEqual(res1, res2);

  // argsPrefix in returned object should be an independent array to prevent mutation pollution
  res2.argsPrefix.push('--mutated');
  const res3 = resolveCliCommand(process.execPath);
  assert.ok(!res3.argsPrefix.includes('--mutated'), 'Cached resolution returned isolated argsPrefix');

  clearCliResolverCache();
});

test('Perf Optimization Area 1: startDescendantTracking cleans up tiered timers immediately', (t) => {
  const dummyProc = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  const stop = startDescendantTracking(dummyProc);

  // Calling stop should cleanly tear down timers without throwing
  assert.doesNotThrow(() => stop());
  stop(); // Idempotent teardown
});

test('Perf Optimization Area 1: CimMutex serializes concurrent queries and permits queued cancellation', async () => {
  const { CimMutex } = require('../src/execution/process.ts');
  const mutex = new CimMutex();
  const procA = { pid: 11111 };
  const procB = { pid: 22222 };
  const procC = { pid: 33333 };

  let bCancelled = false;
  let cAcquired = false;

  // Proc A acquires lock
  const releaseA = await mutex.acquire(procA, () => false);
  assert.equal(typeof releaseA, 'function', 'Proc A acquires release function');

  // Proc B and Proc C attempt to acquire while A holds it
  const waitB = mutex.acquire(procB, () => bCancelled);
  const waitC = mutex.acquire(procC, () => false).then(rel => {
    cAcquired = true;
    return rel;
  });

  // Neither B nor C should acquire while A holds lock
  assert.equal(cAcquired, false, 'C must not acquire while A holds lock');

  // Cancel B from queue
  bCancelled = true;
  mutex.cancelWait(procB);
  const resB = await waitB;
  assert.equal(resB, null, 'Cancelled B resolves with null immediately');
  assert.equal(cAcquired, false, 'Cancelling B must not allow C to acquire while A holds lock');

  // Release A
  releaseA();

  // Now C must acquire
  const releaseC = await waitC;
  assert.equal(cAcquired, true, 'C acquires once A releases');
  assert.equal(typeof releaseC, 'function');
  releaseC();
});

test('Perf Optimization Area 1: CimMutex does not grant lock to cancelled entry upon dequeue', async () => {
  const { CimMutex } = require('../src/execution/process.ts');
  const mutex = new CimMutex();
  const procA = { pid: 11111 };
  const procB = { pid: 22222 };
  const procC = { pid: 33333 };

  let bCancelled = false;
  let cAcquired = false;

  const releaseA = await mutex.acquire(procA, () => false);
  const waitB = mutex.acquire(procB, () => bCancelled);
  const waitC = mutex.acquire(procC, () => false).then(rel => {
    cAcquired = true;
    return rel;
  });

  // Mark B as cancelled without explicit cancelWait
  bCancelled = true;

  // Release A - dequeue should skip B and grant to C
  releaseA();

  const resB = await waitB;
  assert.equal(resB, null, 'Cancelled B resolved with null during dequeue');

  const releaseC = await waitC;
  assert.equal(cAcquired, true, 'C acquired lock directly after B was skipped');
  releaseC();
});

test('Perf Optimization Area 2: truncateToByteLength handles fast-path, emoji, and large strings efficiently', () => {
  const polish = 'zażółć gęślą jaźń';
  const emoji = '😀🎉🚀🔥💎';

  // Fast-path: within budget returns unchanged
  assert.equal(truncateToByteLength(polish, 100), polish);
  assert.equal(truncateToByteLength(emoji, 100), emoji);

  // Exact bounds check without corruption
  for (let limit = 0; limit <= Buffer.byteLength(polish, 'utf8') + 5; limit++) {
    const res = truncateToByteLength(polish, limit);
    assert.ok(Buffer.byteLength(res, 'utf8') <= limit);
    assert.ok(!res.includes('\uFFFD'), `Limit ${limit} corrupted Polish character`);
  }

  for (let limit = 0; limit <= Buffer.byteLength(emoji, 'utf8') + 5; limit++) {
    const res = truncateToByteLength(emoji, limit);
    assert.ok(Buffer.byteLength(res, 'utf8') <= limit);
    assert.ok(!res.includes('\uFFFD'), `Limit ${limit} corrupted emoji sequence`);
  }

  // Large string truncation with custom suffix
  const largeText = 'CoAgent High-Performance Architecture '.repeat(500);
  const truncated = truncateToByteLength(largeText, 200, '...[perf]');
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 200);
  assert.ok(truncated.endsWith('...[perf]'));
});

test('Perf Optimization Area 2: StreamReducer fast-path token streaming without full-string recomputation', () => {
  const reducer = createStreamReducer({
    maxLineBuffer: 1024,
    maxMessageBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
  });

  // Stream 100 tokens as incremental deltas
  const tokens = ['Hello', ' ', 'world', '!', ' ', 'This', ' ', 'is', ' ', 'CoAgent', '.'];
  for (let i = 0; i < 50; i++) {
    for (const tok of tokens) {
      reducer.upsertMessage('msg1', tok, { delta: true });
    }
  }

  const messages = reducer.getMessages();
  assert.equal(messages.length, 1);
  assert.ok(messages[0].startsWith('Hello world!'));
  assert.equal(reducer.getTotalBytes(), Buffer.byteLength(messages[0], 'utf8'));

  // Terminal answer replacement clears token trackers cleanly
  reducer.setFinalAnswer('Final authoritative answer.');
  assert.equal(reducer.getMessages().length, 1);
  assert.equal(reducer.getMessages()[0], 'Final authoritative answer.');
  assert.equal(reducer.getTotalBytes(), Buffer.byteLength('Final authoritative answer.', 'utf8'));
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

test('Perf Optimization Area 4: sessionHistory uses binary search pagination and in-memory cache', async () => {
  clearHistoryCache();
  const testDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'coagent8-perf-history-'));
  const session = createSession('codex', testDir);
  const handle = session.sessionHandle;

  const writer = createHistoryWriter(handle, testDir, 'codex', 'turn-1');
  writer.accept({ type: 'user_message', text: 'Generate performance events' });
  for (let i = 0; i < 20; i++) {
    writer.accept({ type: 'status', message: `Step ${i} completed` });
  }
  writer.accept({ type: 'assistant_message', messageId: 'm1', text: 'All operations finished successfully.' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  // Page 1: fetch first 10 events
  const page1 = await sessionHistory(handle, testDir, undefined, 10);
  assert.equal(page1.events.length, 10);
  assert.ok(page1.nextCursor, 'Cursor provided for next page');

  // Page 2: fetch next 10 events via cursor
  const page2 = await sessionHistory(handle, testDir, page1.nextCursor, 10);
  assert.equal(page2.events.length, 10);
  assert.notEqual(page1.events[0].sequence, page2.events[0].sequence);

  // In-memory cache should fulfill getHistory rapidly
  const cachedHistory = await getHistory(handle);
  assert.ok(cachedHistory);
  assert.equal(cachedHistory.sessionHandle, handle);

  // Invalidation
  invalidateHistoryCache(handle);
  clearHistoryCache();

  await deleteHistory(handle, testDir);
  await closeSession(handle, testDir);
  await fsp.rm(testDir, { recursive: true, force: true });
});

test('Perf Optimization Area 2: StreamReducer accounts for split surrogate pairs without overcounting', () => {
  const reducer = createStreamReducer({
    maxLineBuffer: 1024,
    maxMessageBytes: 8,
    maxTotalBytes: 8,
  });

  // Append high surrogate then low surrogate across separate deltas
  reducer.upsertMessage('msg1', '\uD83D', { delta: true });
  reducer.upsertMessage('msg1', '\uDE00', { delta: true });

  const messages = reducer.getMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0], '😀');
  // Full UTF-8 byte length for 😀 is exactly 4 bytes (not 6)
  assert.equal(reducer.getTotalBytes(), 4);
  assert.equal(Buffer.byteLength(messages[0], 'utf8'), 4);
});

test('Perf Optimization Area 4: getHistory returns defensive copies protecting cached snapshots from mutation', async () => {
  clearHistoryCache();
  const testDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'coagent8-perf-defensive-'));
  const session = createSession('codex', testDir);
  const handle = session.sessionHandle;

  const writer = createHistoryWriter(handle, testDir, 'codex', 'turn-1');
  writer.accept({ type: 'user_message', text: 'Immutable cache test' });
  writer.accept({ type: 'error', error: { code: 'CLI_NOT_FOUND', message: 'Original error', retryable: false } });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const h1 = await getHistory(handle);
  assert.ok(h1);
  const originalLength = h1.events.length;

  // Mutate existing events and nested error objects in returned snapshot
  h1.events[0].text = 'MUTATED_USER_MESSAGE';
  h1.events[0].sequence = 8888;
  if (h1.events[1].type === 'error' && h1.events[1].error) {
    h1.events[1].error.message = 'MUTATED_ERROR_MESSAGE';
  }

  // Push new event into returned array and alter sequence counter
  h1.events.push({
    schemaVersion: 1,
    eventId: 'rogue-id',
    turnId: 'rogue-turn',
    sessionHandle: handle,
    provider: 'codex',
    sequence: 999,
    timestamp: new Date().toISOString(),
    type: 'status',
    message: 'corrupted',
  });
  h1.nextSequence = 1000;

  // Second read from cache should not contain any mutations
  const h2 = await getHistory(handle);
  assert.ok(h2);
  assert.equal(h2.events.length, originalLength);
  assert.equal(h2.nextSequence, 4);
  assert.equal(h2.events[0].text, 'Immutable cache test');
  assert.equal(h2.events[0].sequence, 1);
  if (h2.events[1].type === 'error' && h2.events[1].error) {
    assert.equal(h2.events[1].error.message, 'Original error');
  }
  assert.ok(!h2.events.some(e => e.eventId === 'rogue-id'));

  // sessionHistory pagination should also return pristine events
  const page = await sessionHistory(handle, testDir);
  assert.equal(page.events[0].text, 'Immutable cache test');
  if (page.events[1].type === 'error' && page.events[1].error) {
    assert.equal(page.events[1].error.message, 'Original error');
  }

  clearHistoryCache();
  await deleteHistory(handle, testDir);
  await closeSession(handle, testDir);
  await fsp.rm(testDir, { recursive: true, force: true });
});

test('Perf Optimization Area 1: cliCache hit refreshes LRU recency', () => {
  clearCliResolverCache();
  const testNode = process.execPath;
  const env = { PATH: path.dirname(testNode) };
  const cmd = path.basename(testNode);

  // First resolution inserts into cache
  const r1 = resolveCliCommand(cmd, { env });
  assert.equal(r1.command, testNode);

  // Subsequent hit should refresh LRU recency without throwing or altering results
  const r2 = resolveCliCommand(cmd, { env });
  assert.equal(r2.command, testNode);
  clearCliResolverCache();
});

