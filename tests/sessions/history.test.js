const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-sessions-history-'));
process.env.coagent8_DIR = tempDir;

const {
  createHistoryWriter,
  sessionHistory,
  getHistory,
  getHistoryDir,
  clearHistoryCache,
  invalidateHistoryCache,
  deleteHistory,
} = require('../../src/sessions/history.ts');
const { createSession, closeSession } = require('../../src/sessions/session.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('streamed 60 KiB answer in 40-byte deltas persists within a factor of <= 3x (AUD-P0-3 remediation)', async () => {
  const sess = createSession('gemini', tempDir);
  const turnId = randomUUID();
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', turnId);

  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Prompt requesting 60 KiB response' });
  await writer.flush();

  const chunkSize = 40;
  const targetBytes = 60 * 1024;
  const chunkText = '0123456789abcdefghijklmnopqrstuvwxyzABC\n'; // 40 bytes
  const totalChunks = targetBytes / chunkSize;

  // Stream in 40-byte deltas with periodic flushes (simulating 250ms streaming intervals)
  for (let i = 0; i < totalChunks; i++) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: chunkText });
    if (i % 10 === 0) {
      await writer.flush();
    }
  }
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);
  const jsonFile = path.join(getHistoryDir(), `${sess.sessionHandle}.json`);
  const logBytes = fs.statSync(logFile).size;
  const jsonBytes = fs.statSync(jsonFile).size;
  const totalPersistedBytes = logBytes + jsonBytes;
  const ratio = totalPersistedBytes / targetBytes;

  // Audit measured 6.55 MiB (112x). We assert <= 3x.
  assert.ok(
    ratio <= 3.0,
    `Persisted bytes ratio ${ratio.toFixed(2)}x (${totalPersistedBytes} bytes for ${targetBytes} answer) must be <= 3.0x`
  );

  const history = await getHistory(sess.sessionHandle);
  assert.ok(history, 'History must be loadable');
  const msg = history.events.find(e => e.type === 'assistant_message');
  assert.ok(msg);
  assert.equal(Buffer.byteLength(msg.text, 'utf8'), targetBytes);
});

test('split credentials across multiple streaming deltas and flushes never reach disk unredacted', async () => {
  const sess = createSession('gemini', tempDir);
  const turnId = randomUUID();
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', turnId);

  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Generate split secret' });
  await writer.flush();

  // Split ghp_ token across multiple deltas and flushes
  // ghp_ + 36 alphanumeric characters = 40 chars total
  const secretGhp = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const partsGhp = ['prefix text: g', 'hp_ABCDEF', 'GHIJKLMN', 'OPQRSTUV', 'WXYZ0123456789', ' suffix prose\n'];

  for (const part of partsGhp) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: part });
    await writer.flush();
  }

  // Split sk- token across multiple deltas and flushes
  const secretSk = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const partsSk = ['another: s', 'k-abcdefg', 'hijklmnop', 'qrstuvwxyz', '123456', ' end prose\n'];

  for (const part of partsSk) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: part });
    await writer.flush();
  }

  // Split URL credentials across multiple deltas and flushes
  const rawPassword = 'hunter2secret';
  const partsUrl = ['git clone https://bob:hunter2sec', 'ret@host/x repo\n'];
  for (const part of partsUrl) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: part });
    await writer.flush();
  }

  // Split token preceded by non-whitespace (e.g. dot) across deltas and flushes
  const dotToken = 'ghp_ABCDEFGHIJKLMN0123456789opqrstuvwxyz';
  const partsDot = ['config.ghp_ABCDEFGHIJKLMN', '0123456789opqrstuvwxyz finished\n'];
  for (const part of partsDot) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: part });
    await writer.flush();
  }

  // Split AKIA token across multiple deltas and flushes
  const secretAws = 'AKIAIOSFODNN7EXAMPLE';
  const partsAws = ['aws key: AKIAIOSF', 'ODNN7EXAMPLE done\n'];
  for (const part of partsAws) {
    writer.accept({ type: 'assistant_delta', messageId: 'm1', text: part });
    await writer.flush();
  }

  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);
  const jsonFile = path.join(getHistoryDir(), `${sess.sessionHandle}.json`);
  const rawLog = fs.readFileSync(logFile, 'utf8');
  const rawJson = fs.readFileSync(jsonFile, 'utf8');

  // Verify the raw .jsonl and .json files NEVER contain unredacted secrets
  assert.ok(!rawLog.includes(secretGhp), '.jsonl must never contain raw unredacted ghp token');
  assert.ok(!rawLog.includes(secretSk), '.jsonl must never contain raw unredacted sk token');
  assert.ok(!rawLog.includes(rawPassword), '.jsonl must never contain raw unredacted URL password');
  assert.ok(!rawLog.includes('hunter2sec'), '.jsonl must never contain partial unredacted URL password');
  assert.ok(!rawLog.includes(dotToken), '.jsonl must never contain raw unredacted dot-prefixed token');
  assert.ok(!rawLog.includes('ghp_ABCDEFGHIJKLMN'), '.jsonl must never contain partial unredacted dot-prefixed token');
  assert.ok(!rawLog.includes(secretAws), '.jsonl must never contain raw unredacted aws token');
  assert.ok(!rawLog.includes('AKIAIOSF'), '.jsonl must never contain partial unredacted aws token');

  assert.ok(!rawJson.includes(secretGhp), '.json must never contain raw unredacted ghp token');
  assert.ok(!rawJson.includes(secretSk), '.json must never contain raw unredacted sk token');
  assert.ok(!rawJson.includes(rawPassword), '.json must never contain raw unredacted URL password');
  assert.ok(!rawJson.includes('hunter2sec'), '.json must never contain partial unredacted URL password');
  assert.ok(!rawJson.includes(dotToken), '.json must never contain raw unredacted dot-prefixed token');
  assert.ok(!rawJson.includes('ghp_ABCDEFGHIJKLMN'), '.json must never contain partial unredacted dot-prefixed token');
  assert.ok(!rawJson.includes(secretAws), '.json must never contain raw unredacted aws token');
  assert.ok(!rawJson.includes('AKIAIOSF'), '.json must never contain partial unredacted aws token');

  // Verify redacted token presence
  assert.ok(rawLog.includes('ghp_***[REDACTED]***'), '.jsonl must contain redacted ghp token');
  assert.ok(rawLog.includes('sk-***[REDACTED]***'), '.jsonl must contain redacted sk token');
  assert.ok(rawLog.includes('bob:***[REDACTED]***@host'), '.jsonl must contain redacted URL credentials');
  assert.ok(rawLog.includes('AKIA***[REDACTED]***'), '.jsonl must contain redacted aws token');

  const history = await getHistory(sess.sessionHandle);
  assert.ok(history);
  const msg = history.events.find(e => e.type === 'assistant_message');
  assert.ok(msg);
  assert.ok(msg.text.includes('ghp_***[REDACTED]***'));
  assert.ok(msg.text.includes('sk-***[REDACTED]***'));
  assert.ok(msg.text.includes('bob:***[REDACTED]***@host'));
  assert.ok(msg.text.includes('AKIA***[REDACTED]***'));
});

test('streaming delta ending in potential secret prefix is held back until turn_finished', async () => {
  const sess = createSession('gemini', tempDir);
  const turnId = randomUUID();
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', turnId);

  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Give advice' });
  await writer.flush();

  // Send delta ending in "id AKI" without newline or space, flushed separately
  writer.accept({ type: 'assistant_delta', messageId: 'm1', text: 'Connecting with id AKI' });
  await writer.flush();

  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);
  const rawLogAfterFirstFlush = fs.readFileSync(logFile, 'utf8');
  assert.ok(!rawLogAfterFirstFlush.includes('AKI'), 'Potential secret prefix AKI must be held back from disk on intermediate flush');

  // Now finish turn without completing the token as a secret
  writer.accept({ type: 'assistant_delta', messageId: 'm1', text: 'RA non-secret suffix\n' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  const rawLogAfterFinish = fs.readFileSync(logFile, 'utf8');
  assert.ok(rawLogAfterFinish.includes('AKIRA'), 'Held-back prefix is committed when turn finishes');

  const history = await getHistory(sess.sessionHandle);
  assert.ok(history);
  const msg = history.events.find(e => e.type === 'assistant_message');
  assert.ok(msg);
  assert.ok(msg.text.includes('AKIRA'));
});

test('resuming a session older than 7 days succeeds without lock timeout deadlock', async () => {
  const sess = createSession('gemini', tempDir);
  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);
  const jsonFile = path.join(getHistoryDir(), `${sess.sessionHandle}.json`);

  // Write initial turn
  const writer1 = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());
  writer1.accept({ type: 'turn_started' });
  writer1.accept({ type: 'user_message', text: 'Turn 1' });
  writer1.accept({ type: 'assistant_message', messageId: 'm1', text: 'Response 1' });
  writer1.accept({ type: 'turn_finished', status: 'completed' });
  await writer1.flush();

  // Age the history files past 7 days (e.g. 10 days ago)
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(logFile, tenDaysAgo, tenDaysAgo);
  if (fs.existsSync(jsonFile)) {
    fs.utimesSync(jsonFile, tenDaysAgo, tenDaysAgo);
  }

  // Resume the session with a new turn
  const writer2 = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());
  writer2.accept({ type: 'turn_started' });
  writer2.accept({ type: 'user_message', text: 'Turn 2' });
  writer2.accept({ type: 'assistant_message', messageId: 'm2', text: 'Response 2' });
  writer2.accept({ type: 'turn_finished', status: 'completed' });

  // Must not throw lock timeout or fail
  await writer2.flush();

  const history = await getHistory(sess.sessionHandle);
  assert.ok(history);
  const messages = history.events.filter(e => e.type === 'assistant_message');
  assert.equal(messages.length, 2);
  assert.equal(messages[1].text, 'Response 2');
});

test('legacy snapshot-repeating format loads, paginates and resumes cleanly', async () => {
  const sess = createSession('gemini', tempDir);
  const logFile = path.join(getHistoryDir(), `${sess.sessionHandle}.jsonl`);

  // Write a legacy format log where assistant_message full snapshots are repeated
  const { canonicalPath } = require('../../src/sessions/identity.ts');
  const lines = [
    JSON.stringify({ _type: 'header', schemaVersion: 1, sessionHandle: sess.sessionHandle, workspace: canonicalPath(tempDir), createdAt: new Date().toISOString(), nextSequence: 1 }),
    JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), sequence: 1, timestamp: new Date().toISOString(), sessionHandle: sess.sessionHandle, turnId: 'turn-1', provider: 'gemini', type: 'turn_started' }),
    JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), sequence: 2, timestamp: new Date().toISOString(), sessionHandle: sess.sessionHandle, turnId: 'turn-1', provider: 'gemini', type: 'user_message', text: 'Legacy prompt' }),
    JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), sequence: 3, timestamp: new Date().toISOString(), sessionHandle: sess.sessionHandle, turnId: 'turn-1', provider: 'gemini', type: 'assistant_message', messageId: 'm1', text: 'Partial 1' }),
    JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), sequence: 4, timestamp: new Date().toISOString(), sessionHandle: sess.sessionHandle, turnId: 'turn-1', provider: 'gemini', type: 'assistant_message', messageId: 'm1', text: 'Partial 1 + Partial 2' }),
    JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), sequence: 5, timestamp: new Date().toISOString(), sessionHandle: sess.sessionHandle, turnId: 'turn-1', provider: 'gemini', type: 'assistant_message', messageId: 'm1', text: 'Final complete message' }),
    JSON.stringify({ schemaVersion: 1, eventId: randomUUID(), sequence: 6, timestamp: new Date().toISOString(), sessionHandle: sess.sessionHandle, turnId: 'turn-1', provider: 'gemini', type: 'turn_finished', status: 'completed' }),
  ];
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');

  // Verify load and pagination
  const history = await getHistory(sess.sessionHandle);
  assert.ok(history, 'Legacy log must load successfully');
  const messages = history.events.filter(e => e.type === 'assistant_message');
  assert.equal(messages.length, 1, 'Repeated snapshots must coalesce to single final message');
  assert.equal(messages[0].text, 'Final complete message');

  const page = await sessionHistory(sess.sessionHandle, tempDir);
  assert.equal(page.events.filter(e => e.type === 'assistant_message').length, 1);
  assert.equal(page.events.find(e => e.type === 'assistant_message').text, 'Final complete message');
});

test('capacity limits are strictly enforced during append-only writes', async () => {
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

test('pagination is deterministically indexed by event sequence', async () => {
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

test('streaming deltas do not trigger monolithic .json snapshot rewrite', async () => {
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

test('sessionHistory cleanly ignores corrupted trailing JSONL line from unexpected process crash', async () => {
  const handle = 'syn_sess_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const historyDir = getHistoryDir(tempDir);
  fs.mkdirSync(historyDir, { recursive: true });
  const file = path.join(historyDir, `${handle}.jsonl`);

  const turnId = randomUUID();
  const writer = createHistoryWriter(handle, tempDir, 'gemini', turnId);
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Check system health' });
  writer.accept({ type: 'assistant_message', messageId: 'msg-1', text: 'System is healthy and responsive.' });
  await writer.flush();

  // Append an abruptly truncated / partial record mimicking process crash mid-write
  fs.appendFileSync(file, '\n{"eventId":"abruptly_truncated_record_mid_write","sessionHandle":"' + handle, 'utf8');

  // sessionHistory must parse valid events without throwing or failing
  const history = await sessionHistory(handle, tempDir);
  assert.equal(history.sessionHandle, handle);
  assert.equal(history.events.length, 3);
  assert.equal(history.events[0].type, 'turn_started');
  assert.equal(history.events[1].text, 'Check system health');
  assert.equal(history.events[2].text, 'System is healthy and responsive.');

  // getHistory must also cleanly parse valid events
  const direct = await getHistory(handle);
  assert.ok(direct);
  assert.equal(direct.events.length, 3);
});

test('subsequent append cleanly starts on newline even if previous process crashed with a torn tail', async () => {
  const handle = 'syn_sess_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const historyDir = getHistoryDir(tempDir);
  fs.mkdirSync(historyDir, { recursive: true });
  const file = path.join(historyDir, `${handle}.jsonl`);

  const turnId1 = randomUUID();
  const writer1 = createHistoryWriter(handle, tempDir, 'gemini', turnId1);
  writer1.accept({ type: 'turn_started' });
  writer1.accept({ type: 'user_message', text: 'First query' });
  await writer1.flush();

  // Emulate an incomplete write that terminated without newline
  fs.appendFileSync(file, '{"eventId":"torn_event_without_newline"', 'utf8');

  // Next turn writer appends a new batch
  const turnId2 = randomUUID();
  const writer2 = createHistoryWriter(handle, tempDir, 'gemini', turnId2);
  writer2.accept({ type: 'turn_started' });
  writer2.accept({ type: 'user_message', text: 'Second query' });
  await writer2.flush();

  // The file should cleanly repair the torn tail and include turn 2 events
  const direct = await getHistory(handle);
  assert.ok(direct);
  assert.equal(direct.events.filter(e => e.type === 'user_message').length, 2);
  assert.equal(direct.events.find(e => e.text === 'Second query')?.text, 'Second query');
});

test('sessionHistory uses binary search pagination and in-memory cache', async () => {
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

test('getHistory returns defensive copies protecting cached snapshots from mutation', async () => {
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

test('history reports byte-limit failures, expires old local files and supports explicit disable',async()=>{
  const old=createSession('gemini',tempDir),writer=createHistoryWriter(old.sessionHandle,tempDir,'gemini',randomUUID());
  writer.accept({type:'user_message',text:'old public'});await writer.flush();
  const file=path.join(tempDir,'history',old.sessionHandle+'.json');fs.utimesSync(file,new Date(0),new Date(0));
  const fresh=createSession('gemini',tempDir),next=createHistoryWriter(fresh.sessionHandle,tempDir,'gemini',randomUUID());next.accept({type:'turn_started'});await next.flush();assert.equal(fs.existsSync(file),false);
  const full=createHistoryWriter(fresh.sessionHandle,tempDir,'gemini',randomUUID());
  for(let i=0;i<10;i++)full.accept({type:'assistant_message',messageId:'large-'+i,text:'x'.repeat(1024*1024)});
  await assert.rejects(full.flush(),/session limit/);
  assert.equal((await sessionHistory(fresh.sessionHandle,tempDir)).events.length,1);
  process.env.coagent8_HISTORY='off';try{const disabled=createHistoryWriter(fresh.sessionHandle,tempDir,'gemini',randomUUID());assert.equal(disabled.disabled,true);disabled.accept({type:'user_message',text:'never persisted'});await disabled.flush();}finally{delete process.env.coagent8_HISTORY;}
  assert.equal((await sessionHistory(fresh.sessionHandle,tempDir)).events.length,1);
});

test('history survives a fresh process and failed turns; duplicate native snapshots are canonical',async()=>{
  const s=createSession('gemini',tempDir),turn=randomUUID();
  const writer=createHistoryWriter(s.sessionHandle,tempDir,'gemini',turn);
  writer.accept({type:'turn_started'});writer.accept({type:'user_message',text:'public user'});
  writer.accept({type:'assistant_delta',messageId:'m',text:'draft'});await writer.flush();
  writer.accept({type:'assistant_message',messageId:'m',text:'final'});writer.accept({type:'assistant_message',messageId:'m',text:'final'});
  writer.accept({type:'error',error:{code:'AUTH_REQUIRED',message:'token=fixtureSecret',retryable:false}});writer.accept({type:'turn_finished',status:'failed'});await writer.flush();
  const code=`const {sessionHistory}=require(process.argv[1]);sessionHistory(process.argv[2],process.argv[3]).then(h=>process.stdout.write(JSON.stringify(h)));`;
  const output=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',code,path.resolve(__dirname, '../..', 'src/sessions/history.ts'),s.sessionHandle,tempDir],{env:{...process.env},windowsHide:true});let out='';p.stdout.on('data',d=>out+=d);p.on('error',reject);p.on('exit',c=>c===0?resolve(out):reject(new Error('history subprocess failed')));});
  const h=JSON.parse(output);assert.equal(h.events.filter(e=>e.type==='assistant_message').length,1);assert.equal(h.events.find(e=>e.type==='assistant_message').text,'final');assert.ok(!output.includes('fixtureSecret'));
});

test('live pagination rejects a changed snapshot so final assistant text is never silently skipped',async()=>{
  const s=createSession('gemini',tempDir),w=createHistoryWriter(s.sessionHandle,tempDir,'gemini',randomUUID());
  w.accept({type:'assistant_delta',messageId:'m',text:'draft'});w.accept({type:'status',message:'running'});await w.flush();
  const before=await sessionHistory(s.sessionHandle,tempDir,undefined,1);assert.equal(before.events[0].text,'draft');assert.ok(before.nextCursor);
  w.accept({type:'assistant_message',messageId:'m',text:'final'});w.accept({type:'turn_finished',status:'completed'});await w.flush();
  await assert.rejects(sessionHistory(s.sessionHandle,tempDir,before.nextCursor,1),/HISTORY_CHANGED.*restart/);
  const after=await sessionHistory(s.sessionHandle,tempDir);assert.equal(after.events.filter(e=>e.type==='assistant_message').length,1);assert.equal(after.events[0].text,'final');assert.notEqual(before.revision,after.revision);
});

test('history fragment pagination returns the whole large UTF-8 message at limit=1 without skipping an unreturned prefix',async()=>{
  const s=createSession('gemini',tempDir),writer=createHistoryWriter(s.sessionHandle,tempDir,'gemini',randomUUID());
  const text=('😀"\n').repeat(100000);writer.accept({type:'turn_started'});writer.accept({type:'assistant_message',messageId:'large',text});await writer.flush();
  let cursor,joined='',pages=0;
  do {const page=await sessionHistory(s.sessionHandle,tempDir,cursor,1);assert.ok(Buffer.byteLength(JSON.stringify(page))<256*1024);joined+=page.events.filter(e=>e.type==='assistant_message').map(e=>e.text).join('');cursor=page.nextCursor;pages++;assert.ok(pages<20);}while(cursor);
  assert.equal(joined,text);assert.ok(pages>1);
});

test('oversized provider metadata cannot hang history pagination',async()=>{
  const s=createSession('gemini',tempDir),writer=createHistoryWriter(s.sessionHandle,tempDir,'gemini',randomUUID());
  assert.throws(()=>writer.accept({type:'assistant_message',messageId:'x'.repeat(300*1024),text:'short'}),/identifier/);
  const {createGeminiCollector}=require('../../src/backends/gemini/collector.ts');
  assert.throws(()=>createGeminiCollector().line(JSON.stringify({type:'message',role:'assistant',message_id:'x'.repeat(300*1024),content:'short'})),/metadata/);
  writer.accept({type:'assistant_message',messageId:'safe',text:'short'});await writer.flush();
  const file=path.join(tempDir,'history',s.sessionHandle+'.json'),raw=JSON.parse(fs.readFileSync(file));
  raw.events[0].messageId='x'.repeat(300*1024);fs.writeFileSync(file,JSON.stringify(raw));
  await assert.rejects(sessionHistory(s.sessionHandle,tempDir),/identifier/);
});
