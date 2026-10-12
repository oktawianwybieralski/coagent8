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
} = require('../../../src/sessions/session.ts');
const { handleSession, handleCancelSession, sessionToolDefinition } = require('../../../src/mcp/tools/session.tool.ts');
const { createHistoryWriter } = require('../../../src/sessions/history/index.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('session tool consolidates list, history and close actions', async () => {
  assert.match(sessionToolDefinition.inputSchema.properties.cursor.description, /history/i);
  assert.match(sessionToolDefinition.inputSchema.properties.limit.description, /history/i);

  const sess = createSession('agy', tempDir);
  const sessExtra = createSession('codex', tempDir);
  const handle = sess.sessionHandle;

  // Write durable history so history action has data
  const writer = createHistoryWriter(handle, tempDir, 'agy', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Initial message for history test' });
  writer.accept({ type: 'assistant_message', messageId: 'msg-1', text: 'Assistant reply' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  // 1. action: list (workspace-scoped; cursor and limit are history-only)
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-other-list-'));
  const other = createSession('agy', otherDir);
  const listRes = await handleSession({ action: 'list', limit: 1, cursor: '{"v":1,"after":1,"offset":0}', workspace_path: tempDir });
  assert.ok(!listRes.structuredContent.sessions.some(s => s.sessionHandle === other.sessionHandle), 'list shows only this workspace (AUD-P1-8)');
  fs.rmSync(otherDir, { recursive: true, force: true });
  assert.equal(listRes.structuredContent.schemaVersion, 1);
  assert.ok(listRes.structuredContent.sessions.some(s => s.sessionHandle === handle));
  assert.ok(listRes.structuredContent.sessions.some(s => s.sessionHandle === sessExtra.sessionHandle));
  assert.ok(listRes.content[0].text.includes(handle));
  await handleSession({ action: 'close', session_handle: sessExtra.sessionHandle, workspace_path: tempDir });

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
      /actively running in another CoAgent8 server process/
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
  const { formatExecutionResult } = require('../../../src/mcp/result.ts');
  const { handleSessionHistory } = require('../../../src/mcp/tools/session.tool.ts');

  // Test formatExecutionResult
  const formatted = await formatExecutionResult('codex', {
    status: 'completed',
    isError: false,
    output: '# Analysis Result\nEverything looks good.',
    continuationAvailable: true,
  }, '', 'syn_sess_test123', { turn: 1, toolCount: 2, durationMs: 3450, historyAvailable: true });

  assert.equal(formatted.isError, false);
  assert.ok(formatted.content[0].text.startsWith('```plaintext\n# Analysis Result\nEverything looks good.\n```'));
  assert.ok(formatted.content[0].text.includes('\n```plaintext\nCoAgent8: codex · provider default · 3.5s · 2 ops · session_handle=syn_sess_test123 (ready)\n```'));

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
  const { cancelSession, setExecutionCanceller } = require('../../../src/sessions/session.ts');
  const { composeExecutionCancellation } = require('../../../src/execution/controller.ts');
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
    const { createServer } = require('../../../src/mcp/server.ts');
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

test('second client cancels a confirmed running Claude turn, releases lease and process resources, and permits a subsequent turn in the same session (FEEDBACK-060h)', async () => {
  const { createServer } = require('../../../src/mcp/server.ts');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { saveConfig } = require('../../../src/config.ts');
  const { activeProcesses, terminateAllProcesses } = require('../../../src/execution/process.ts');
  const { readResult } = require('../../helpers/result.cjs');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-claude-cancel-'));
  const readyFile = path.join(workspace, 'claude-ready.json');
  const captureTurn1 = path.join(workspace, 'claude-capture-1.json');
  const captureTurn2 = path.join(workspace, 'claude-capture-2.json');
  const previousEnv = { ...process.env };

  // Creating the servers installs the real execution canceller via composeExecutionCancellation(),
  // replacing any stub canceller left by earlier unit tests.
  const server1 = createServer();
  const server2 = createServer();
  const client1 = new Client({ name: 'turn-client', version: '1' }, { capabilities: {} });
  const client2 = new Client({ name: 'cancel-client', version: '1' }, { capabilities: {} });
  const [client1Transport, server1Transport] = InMemoryTransport.createLinkedPair();
  const [client2Transport, server2Transport] = InMemoryTransport.createLinkedPair();

  let turn1Promise;
  try {
    process.env.CLAUDE_PATH = path.resolve(__dirname, '../../fixtures/claude-cli/claude.cjs');
    process.env.CLAUDE_FIXTURE_SCENARIO = 'interruptible';
    process.env.CLAUDE_FIXTURE_READY = readyFile;
    process.env.CLAUDE_FIXTURE_CAPTURE = captureTurn1;
    delete process.env.CLAUDE_FIXTURE_MODE;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

    await saveConfig({
      defaultBackend: 'claude',
      routing: { strategy: 'fixed', allowedBackends: ['claude'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, models: { allow: ['claude-sonnet-4-6'], ask: [], deny: [] } },
    });

    await server1.connect(server1Transport);
    await client1.connect(client1Transport);
    await server2.connect(server2Transport);
    await client2.connect(client2Transport);

    // 1. Client 1 starts a Claude consult turn that enters the active running state
    let turn1Settled = false;
    turn1Promise = client1.callTool({
      name: 'consult',
      arguments: {
        proposal: 'Long-running architecture check',
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        workspace_path: workspace,
      },
    }).finally(() => {
      turn1Settled = true;
    });

    // 2. Bounded wait for the deterministic running-turn handshake from claude.cjs
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(readyFile)) {
      if (turn1Settled) {
        const early = await turn1Promise;
        assert.fail(`Turn 1 settled before ready handshake: ${JSON.stringify(early)}`);
      }
      if (Date.now() >= deadline) {
        assert.fail('Timed out waiting for CLAUDE_FIXTURE_READY handshake');
      }
      await new Promise(r => setTimeout(r, 15));
    }

    const readyData = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    assert.equal(readyData.state, 'running');
    assert.equal(readyData.scenario, 'interruptible');
    assert.equal(turn1Settled, false, 'natural completion must not count as a cancellation pass');
    assert.ok(
      [...activeProcesses].some(proc => proc.pid === readyData.pid),
      'live Claude child process must be tracked in activeProcesses while turn is running'
    );

    // 3. Client 2 lists active sessions in the workspace and confirms the session is running
    const listRes = await client2.callTool({
      name: 'session',
      arguments: { action: 'list', workspace_path: workspace },
    });
    assert.equal(listRes.isError, undefined);
    const listedSessions = listRes.structuredContent.sessions;
    assert.equal(listedSessions.length, 1);
    const handle = listedSessions[0].sessionHandle;
    assert.equal(listedSessions[0].backend, 'claude');
    assert.equal(listedSessions[0].state, 'running');

    const activeRecord = getSession(handle);
    assert.ok(activeRecord, 'running session record must exist');
    assert.equal(activeRecord.state, 'running');
    assert.equal(activeRecord.activePid, process.pid);
    assert.ok(activeRecord.turnToken, 'running session must hold a non-null turnToken lease');
    assert.equal(turn1Settled, false, 'Turn 1 must still be running right before Client 2 invokes cancel');

    // 4. Client 2 cancels the running Claude turn
    const cancelRes = await client2.callTool({
      name: 'cancel',
      arguments: { session_handle: handle, workspace_path: workspace },
    });
    assert.equal(cancelRes.isError, undefined);
    assert.equal(cancelRes.structuredContent.cancelled, true);
    assert.equal(cancelRes.structuredContent.sessionHandle, handle);
    assert.match(cancelRes.content[0].text, /cancelled and resources released/);

    // 5. Immediately when cancel resolves, process resources and session lease are already released
    assert.ok(
      ![...activeProcesses].some(proc => proc.pid === readyData.pid),
      'Claude child process must be cleaned up before cancel returns'
    );
    assert.equal(activeProcesses.size, 0, 'no active child processes remain after cancel');
    const afterCancel = getSession(handle);
    assert.ok(afterCancel, 'session record remains available after cancel');
    assert.equal(afterCancel.state, 'idle', 'session state must be reset to idle');
    assert.equal(afterCancel.activePid, null, 'session activePid must be cleared');
    assert.equal(afterCancel.turnToken, null, 'session turnToken lease must be released');
    assert.equal(afterCancel.threadId, readyData.sessionId, 'native Claude session ID from system/init is preserved for continuation');
    assert.equal(fs.existsSync(`${getSessionFilePath(handle)}.lease`), false, 'no storage lock lease file remains after cancel');

    // 6. Client 1 receives the cancelled turn result with ABORTED and continuationAvailable
    const turn1Res = await turn1Promise;
    assert.equal(turn1Res.isError, true);
    const parsedTurn1 = readResult(turn1Res);
    assert.equal(parsedTurn1.status, 'cancelled');
    assert.equal(parsedTurn1.error?.code, 'ABORTED');
    assert.equal(parsedTurn1.sessionHandle, handle);
    assert.equal(parsedTurn1.continuationAvailable, true, 'cancelled turn after init and partial output stays resumable');

    const captured1 = JSON.parse(fs.readFileSync(captureTurn1, 'utf8'));
    assert.deepEqual(captured1.records.map(r => r.type), ['user', 'control_request']);
    assert.equal(captured1.records[1].request.subtype, 'interrupt');

    // 7. Subsequent turn in the same session reuses the handle and resumes the native Claude session
    fs.rmSync(readyFile, { force: true });
    delete process.env.CLAUDE_FIXTURE_READY;
    delete process.env.CLAUDE_FIXTURE_SCENARIO;
    process.env.CLAUDE_FIXTURE_CAPTURE = captureTurn2;

    const turn2Res = await client1.callTool({
      name: 'consult',
      arguments: {
        proposal: 'Follow-up question after cancellation',
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        session_handle: handle,
        workspace_path: workspace,
      },
    });
    assert.equal(turn2Res.isError, false, turn2Res.content?.[0]?.text);
    const parsedTurn2 = readResult(turn2Res);
    assert.equal(parsedTurn2.status, 'completed');
    assert.equal(parsedTurn2.sessionHandle, handle);
    assert.equal(parsedTurn2.turn, 2);
    assert.match(parsedTurn2.answer, /OK/);

    const captured2 = JSON.parse(fs.readFileSync(captureTurn2, 'utf8'));
    assert.equal(captured2.records[0]?.type, 'user');
    assert.equal(captured2.argv[captured2.argv.indexOf('--resume') + 1], readyData.sessionId);
    assert.ok(!captured2.argv.includes('--session-id'));

    const afterTurn2 = getSession(handle);
    assert.equal(afterTurn2.state, 'idle');
    assert.equal(afterTurn2.activePid, null);
    assert.equal(afterTurn2.turnToken, null);
    assert.equal(afterTurn2.turnCount, 2);

    // 8. Durable history records both the cancelled first turn and the completed second turn
    const historyRes = await client2.callTool({
      name: 'session',
      arguments: { action: 'history', session_handle: handle, workspace_path: workspace, limit: 100 },
    });
    assert.equal(historyRes.isError, undefined);
    const finishedEvents = historyRes.structuredContent.events.filter(e => e.type === 'turn_finished');
    assert.deepEqual(finishedEvents.map(e => e.status), ['cancelled', 'completed']);
  } finally {
    await terminateAllProcesses();
    await client1.close().catch(() => {});
    await server1.close().catch(() => {});
    await client2.close().catch(() => {});
    await server2.close().catch(() => {});
    await turn1Promise?.catch(() => {});
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

