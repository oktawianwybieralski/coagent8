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

test('streaming deltas append directly to .jsonl event store in O(1)', async () => {
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
