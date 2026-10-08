const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tools-session-'));
process.env.coagent8_DIR = tempDir;

const {
  createSession,
  getSession,
  acquireSessionTurn,
  cancelSession,
  getSessionFilePath,
  isProcessAlive,
  setExecutionCanceller,
} = require('../../src/sessions/session.ts');
const { handleSession, handleCancelSession } = require('../../src/tools/session.tool.ts');
const { createHistoryWriter } = require('../../src/sessions/history.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('session tool consolidates list, history and close actions', async () => {
  const sess = createSession('agy', tempDir);
  const handle = sess.sessionHandle;

  // Write durable history so history action has data
  const writer = createHistoryWriter(handle, tempDir, 'agy', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Initial message for history test' });
  writer.accept({ type: 'assistant_message', messageId: 'msg-1', text: 'Assistant reply' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  // 1. action: list
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-other-list-'));
  const other = createSession('agy', otherDir);
  const listRes = await handleSession({ action: 'list', workspace_path: tempDir });
  assert.ok(!listRes.structuredContent.sessions.some(s => s.sessionHandle === other.sessionHandle), 'list shows only this workspace (AUD-P1-8)');
  fs.rmSync(otherDir, { recursive: true, force: true });
  assert.equal(listRes.structuredContent.schemaVersion, 1);
  assert.ok(listRes.structuredContent.sessions.some(s => s.sessionHandle === handle));
  assert.ok(listRes.content[0].text.includes(handle));

  // 2. action: history
  const histRes = await handleSession({ action: 'history', session_handle: handle, workspace_path: tempDir });
  assert.ok(histRes.structuredContent, 'History structured content should be returned');
  assert.ok(histRes.content[0].text.includes('Initial message for history test'));

  // Missing handle for history should throw
  await assert.rejects(
    async () => handleSession({ action: 'history' }),
    /session_handle is required for action "history"/
  );

  // 3. action: close
  const closeRes = await handleSession({ action: 'close', session_handle: handle, workspace_path: tempDir });
  assert.ok(closeRes.content[0].text.includes('closed successfully'));

  // Missing handle for close should throw
  await assert.rejects(
    async () => handleSession({ action: 'close' }),
    /session_handle is required for action "close"/
  );

  // Invalid action should throw
  await assert.rejects(
    async () => handleSession({ action: 'invalid_action' }),
    /Validation Error: action must be one of/
  );
});

test('cancel tool releases leases, child execution and recovers locks', async () => {
  const sess = createSession('agy', tempDir);
  const handle = sess.sessionHandle;

  // Simulate acquiring a turn
  const turn = await acquireSessionTurn(handle);
  assert.ok(turn.ok);

  // Session should be in running state
  let current = getSession(handle);
  assert.equal(current.state, 'running');

  // Cancel via cancel tool
  const cancelRes = await handleCancelSession({ session_handle: handle, workspace_path: tempDir });
  assert.equal(cancelRes.structuredContent.cancelled, true);
  assert.ok(cancelRes.content[0].text.includes('cancelled and resources released'));

  // Session state must be reset to idle
  current = getSession(handle);
  assert.equal(current.state, 'idle');
  assert.equal(current.activePid, null);
  assert.equal(current.turnToken, null);

  // Cancelling with mismatched workspace should throw
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-mismatch-'));
  try {
    await assert.rejects(
      async () => handleCancelSession({ session_handle: handle, workspace_path: otherDir }),
      /Session workspace mismatch/
    );
  } finally {
    fs.rmSync(otherDir, { recursive: true, force: true });
  }

  // Cancelling non-existent session should return gracefully
  const fakeRes = await handleCancelSession({ session_handle: 'syn_sess_0123456789abcdef' });
  assert.equal(fakeRes.structuredContent.cancelled, false);
});

test('cancelSession respects external live processes and protects replacement turn tokens', async () => {
  const sess = createSession('agy', tempDir);
  const handle = sess.sessionHandle;
  const file = getSessionFilePath(handle);

  // 1. External live process protection
  // Set an activePid with a live PID different from current process (e.g. parent process.ppid if alive)
  const externalPid = process.ppid;
  if (isProcessAlive(externalPid)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.activePid = externalPid;
    raw.state = 'running';
    fs.writeFileSync(file, JSON.stringify(raw));

    await assert.rejects(
      async () => handleCancelSession({ session_handle: handle, workspace_path: tempDir }),
      /actively running in another process/
    );
  }

  // 2. Replacement turn token protection
  const sess2 = createSession('agy', tempDir);
  const handle2 = sess2.sessionHandle;
  const file2 = getSessionFilePath(handle2);

  const turn1 = await acquireSessionTurn(handle2);
  assert.ok(turn1.ok);
  const token1 = turn1.data.token;

  // Simulate turn1 being aborted and turn2 immediately acquiring the session
  // while cancellation is in flight
  const turn2Token = randomUUID();
  setExecutionCanceller(() => {
    const currentRecord = JSON.parse(fs.readFileSync(file2, 'utf8'));
    currentRecord.turnToken = turn2Token;
    currentRecord.state = 'running';
    fs.writeFileSync(file2, JSON.stringify(currentRecord));
    return 'settled';
  });

  const cancelRes = await cancelSession(handle2, tempDir);
  assert.equal(cancelRes.cancelled, true);

  const updatedRecord = JSON.parse(fs.readFileSync(file2, 'utf8'));
  assert.equal(updatedRecord.turnToken, turn2Token, 'Replacement turn token must be preserved');
  assert.equal(updatedRecord.state, 'running', 'Replacement running turn must not be forced to idle');

  // 3. Idle session cancellation must not clear a newly acquired turn
  const sess3 = createSession('agy', tempDir);
  const handle3 = sess3.sessionHandle;
  const file3 = getSessionFilePath(handle3);

  // Hook executionCanceller to acquire a turn while cancelSession is in flight
  const turn3Token = randomUUID();
  setExecutionCanceller(async () => {
    // Session was idle when cancelSession was called (targetToken was null)
    // Now simulate a turn being acquired
    const currentRecord = JSON.parse(fs.readFileSync(file3, 'utf8'));
    currentRecord.turnToken = turn3Token;
    currentRecord.state = 'running';
    fs.writeFileSync(file3, JSON.stringify(currentRecord));
    return 'settled';
  });

  const cancelRes3 = await cancelSession(handle3, tempDir);
  assert.equal(cancelRes3.cancelled, true);

  const updatedRecord3 = JSON.parse(fs.readFileSync(file3, 'utf8'));
  assert.equal(updatedRecord3.turnToken, turn3Token, 'Initially idle cancellation must not clear newly acquired turn');
  assert.equal(updatedRecord3.state, 'running', 'Initially idle cancellation must not force new running turn to idle');

  // 4. Cancellation timeout must fail cleanly without releasing ownership
  setExecutionCanceller(async () => {
    return 'timed_out';
  });
  await assert.rejects(
    async () => cancelSession(handle3, tempDir),
    /cancellation timed out/
  );
});

test('formatExecutionResult produces clean Markdown with answer at top, and handleSessionHistory preserves global turn numbers across pagination', async () => {
  const { formatExecutionResult } = require('../../src/tools/result.ts');
  const { handleSessionHistory } = require('../../src/tools/session.tool.ts');

  // Test formatExecutionResult
  const formatted = await formatExecutionResult('codex', {
    status: 'completed',
    isError: false,
    output: '# Analysis Result\nEverything looks good.',
    continuationAvailable: true,
  }, '', 'syn_sess_test123', { turn: 1, toolCount: 2, durationMs: 3450, historyAvailable: true });

  assert.equal(formatted.isError, false);
  assert.ok(formatted.content[0].text.startsWith('# Analysis Result\nEverything looks good.'));
  assert.ok(formatted.content[0].text.includes('> CoAgent8: codex · provider default · 3.5s · 2 ops · syn_sess_test123 (ready)'));

  // Test handleSessionHistory across two turns
  const s = createSession('codex', tempDir);
  const w1 = createHistoryWriter(s.sessionHandle, tempDir, 'codex', randomUUID());
  w1.accept({ type: 'turn_started' });
  w1.accept({ type: 'user_message', text: 'Turn 1 prompt' });
  w1.accept({ type: 'tool_started', toolId: 't1', name: 'read_code' });
  w1.accept({ type: 'tool_finished', toolId: 't1', name: 'read_code', success: true });
  w1.accept({ type: 'assistant_message', messageId: 'm1', text: 'Turn 1 response' });
  w1.accept({ type: 'turn_finished', status: 'completed' });
  await w1.flush();

  const w2 = createHistoryWriter(s.sessionHandle, tempDir, 'codex', randomUUID());
  w2.accept({ type: 'turn_started' });
  w2.accept({ type: 'user_message', text: 'Turn 2 prompt' });
  w2.accept({ type: 'assistant_message', messageId: 'm2', text: 'Turn 2 response' });
  w2.accept({ type: 'turn_finished', status: 'completed' });
  await w2.flush();

  // Page 1 (limit 6 events covering Turn 1)
  const page1 = await handleSessionHistory({ session_handle: s.sessionHandle, workspace_path: tempDir, limit: 6 });
  assert.ok(page1.content[0].text.includes('### Turn 1'));
  assert.ok(page1.content[0].text.includes('**User:**\n\nTurn 1 prompt'));
  assert.ok(page1.structuredContent.nextCursor);

  // Page 2 using cursor from page 1 (covering Turn 2)
  const page2 = await handleSessionHistory({ session_handle: s.sessionHandle, workspace_path: tempDir, cursor: page1.structuredContent.nextCursor });
  assert.ok(page2.content[0].text.includes('### Turn 2'));
  assert.ok(page2.content[0].text.includes('**User:**\n\nTurn 2 prompt'));
  assert.ok(page2.content[0].text.includes('**Assistant (codex):**\n\nTurn 2 response'));
  // Verify Turn 2 is NOT mislabeled as Turn 1 on page 2!
  assert.ok(!page2.content[0].text.includes('### Turn 1'));
});

test('cancel reports cancelled: false when the session has no running turn (SIMPLIFY-001)', async () => {
  const { cancelSession, setExecutionCanceller } = require('../../src/sessions/session.ts');
  const { composeExecutionCancellation } = require('../../src/execution/controller.ts');
  composeExecutionCancellation();
  const idle = createSession('agy', tempDir);
  const result = await cancelSession(idle.sessionHandle, tempDir);
  assert.equal(result.cancelled, false);
  assert.match(result.message, /nothing to cancel/);
});

test('session list and the sessions resource show a workspace under the home directory as ~ (SIMPLIFY-001)', async () => {
  const workspace = fs.mkdtempSync(path.join(os.homedir(), 'coagent8-list-'));
  try {
    const created = createSession('agy', workspace);
    const listed = await handleSession({ action: 'list' }, workspace);
    const record = listed.structuredContent.sessions.find(s => s.sessionHandle === created.sessionHandle);
    // Windows stores the canonical lower-case path.
    assert.equal(record.workspace.toLowerCase(), `~${path.sep}${path.basename(workspace)}`.toLowerCase());
    assert.ok(!JSON.stringify(listed).toLowerCase().includes(JSON.stringify(os.homedir()).slice(1, -1).toLowerCase()), 'no absolute home path');
    const { createServer } = require('../../src/server.ts');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    const { pathToFileURL } = require('node:url');
    const server = createServer(), client = new Client({ name: 'list-client', version: '1' }, { capabilities: { roots: {} } });
    // Resources are scoped to the client's root.
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(workspace).href }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const text = (await client.readResource({ uri: 'coagent8://sessions' })).contents[0].text;
      const resource = JSON.parse(text).find(s => s.sessionHandle === created.sessionHandle);
      assert.equal(resource.workspace.toLowerCase(), record.workspace.toLowerCase());
      assert.ok(!text.toLowerCase().includes(JSON.stringify(os.homedir()).slice(1, -1).toLowerCase()), 'no absolute home path');
    } finally { await client.close(); await server.close(); }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
