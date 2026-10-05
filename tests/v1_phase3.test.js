const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-phase3-'));
process.env.coagent8_DIR = tempDir;

const {
  createToolDefinitions,
  getAllCallableToolDefinitions,
  createServer,
} = require('../src/server.ts');
const { CANONICAL_TOOL_NAMES, TOOL_NAMES } = require('../src/constants/index.ts');
const { validateConfig, saveConfig, loadConfig } = require('../src/config.ts');
const {
  createSession,
  getSession,
  acquireSessionTurn,
  releaseSessionTurn,
  cancelSession,
  listSessions,
  getSessionFilePath,
  isProcessAlive,
  setExecutionCanceller,
} = require('../src/sessions/session.ts');
const {
  handleSession,
  handleCancelSession,
} = require('../src/tools/session.tool.ts');
const { handleRun, runToolDefinition } = require('../src/tools/run.tool.ts');
const { formatExecutionResult } = require('../src/tools/common.ts');
const { cancelSessionExecution } = require('../src/execution/controller.ts');
const { createHistoryWriter } = require('../src/sessions/history.ts');

test.after(() => {
  delete process.env.coagent8_TOOL_PROFILE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// =========================================================================
// Task 3.1: Canonical Unprefixed Domain Tools
// =========================================================================

test('Phase 3 Task 3.1: canonical profile advertises exactly 9 unprefixed domain tools', () => {
  const tools = createToolDefinitions({
    schemaVersion: 1,
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'gemini'] },
    toolProfile: 'canonical',
  });

  assert.equal(tools.length, 9, 'Default canonical profile must advertise exactly 9 tools');
  const names = tools.map(t => t.name).sort();
  const expected = [
    'analyze',
    'cancel',
    'consult',
    'debug',
    'doctor',
    'implement',
    'issue',
    'review',
    'session',
  ].sort();
  assert.deepEqual(names, expected, 'Canonical tools must match the 9 unprefixed names');

  // Verify none have double prefixes
  for (const name of names) {
    assert.ok(!name.startsWith('coagent8_'), `Tool ${name} should not have coagent8_ prefix`);
    assert.ok(!name.startsWith('omniagent_'), `Tool ${name} should not have omniagent_ prefix`);
    assert.ok(!name.startsWith('codex_'), `Tool ${name} should not have codex_ prefix`);
  }
});

test('Phase 3 Task 3.1: session tool consolidates list, history and close actions', async () => {
  const sess = createSession('gemini', tempDir);
  const handle = sess.sessionHandle;

  // Write durable history so history action has data
  const writer = createHistoryWriter(handle, tempDir, 'gemini', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Initial message for history test' });
  writer.accept({ type: 'assistant_message', messageId: 'msg-1', text: 'Assistant reply' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();

  // 1. action: list
  const listRes = await handleSession({ action: 'list' });
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

test('Phase 3 Task 3.1: cancel tool releases leases, child execution and recovers locks', async () => {
  const sess = createSession('gemini', tempDir);
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

// =========================================================================
// Task 3.2: Optional Compact Gateway Profile (run)
// =========================================================================

test('Phase 3 Task 3.2: compact profile advertises exactly 4 tools (run, doctor, session, cancel)', () => {
  const tools = createToolDefinitions({
    schemaVersion: 1,
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'gemini'] },
    toolProfile: 'compact',
  });

  assert.equal(tools.length, 4, 'Compact profile must advertise exactly 4 tools');
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['cancel', 'doctor', 'run', 'session']);
});

test('Phase 3 Task 3.2: run gateway strictly validates parameters per-action', async () => {
  // 1. Unknown action
  await assert.rejects(
    async () => handleRun({ action: 'unknown' }, tempDir),
    /Unknown action "unknown"/
  );

  // 2. Action: consult requires proposal
  await assert.rejects(
    async () => handleRun({ action: 'consult' }, tempDir),
    /proposal must be a non-empty string for action "consult"/
  );
  await assert.rejects(
    async () => handleRun({ action: 'consult', proposal: '   ' }, tempDir),
    /proposal must be a non-empty string for action "consult"/
  );

  // 3. Action: analyze requires task
  await assert.rejects(
    async () => handleRun({ action: 'analyze' }, tempDir),
    /task must be a non-empty string for action "analyze"/
  );

  // 4. Action: debug requires error_message
  await assert.rejects(
    async () => handleRun({ action: 'debug' }, tempDir),
    /error_message must be a non-empty string for action "debug"/
  );

  // 5. Action: implement requires specification
  await assert.rejects(
    async () => handleRun({ action: 'implement' }, tempDir),
    /specification must be a non-empty string for action "implement"/
  );
});

// =========================================================================
// Task 3.3: Backward Compatibility Layer
// =========================================================================

test('Phase 4: canonical profile advertises exactly 9 domain tools without legacy aliases', () => {
  const tools = createToolDefinitions({
    schemaVersion: 1,
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'gemini'] },
    toolProfile: 'canonical',
  });

  assert.equal(tools.length, 9);
  const names = new Set(tools.map(t => t.name));
  for (const name of ['consult', 'review', 'analyze', 'debug', 'implement', 'doctor', 'session', 'cancel', 'issue']) {
    assert.ok(names.has(name));
  }
  for (const name of names) {
    assert.ok(!name.startsWith('coagent8_'));
    assert.ok(!name.startsWith('omniagent_'));
    assert.ok(!name.startsWith('codex_'));
  }
});

test('Phase 4: getAllCallableToolDefinitions provides lookup strictly for canonical tools and run gateway', () => {
  const allTools = getAllCallableToolDefinitions();
  const allNames = new Set(allTools.map(t => t.name));

  assert.equal(allNames.size, 10);
  assert.ok(allNames.has('consult'));
  assert.ok(allNames.has('review'));
  assert.ok(allNames.has('analyze'));
  assert.ok(allNames.has('debug'));
  assert.ok(allNames.has('implement'));
  assert.ok(allNames.has('doctor'));
  assert.ok(allNames.has('session'));
  assert.ok(allNames.has('cancel'));
  assert.ok(allNames.has('run'));
  assert.ok(allNames.has('issue'));

  // Ensure no legacy aliases exist
  assert.ok(!allNames.has('coagent8_consult'));
  assert.ok(!allNames.has('omniagent_consult'));
  assert.ok(!allNames.has('codex_status'));
});

test('Phase 4: server tools/call dispatches canonical tools and rejects legacy aliases as unknown', async () => {
  const server = createServer();
  const callHandler = server._requestHandlers.get('tools/call');

  // 1. Call canonical doctor
  const doctorCall = await callHandler(
    { method: 'tools/call', params: { name: 'doctor', arguments: {} } },
    { signal: null }
  );
  assert.equal(doctorCall.isError, undefined);
  assert.ok(doctorCall.content[0].text.includes('codex'));

  // 2. Reject legacy coagent8_doctor
  const legacyCall = await callHandler(
    { method: 'tools/call', params: { name: 'coagent8_doctor', arguments: {} } },
    { signal: null }
  );
  assert.equal(legacyCall.isError, true);
  assert.ok(legacyCall.content[0].text.includes('Unknown tool: coagent8_doctor'));

  // 3. Reject legacy codex_status
  const codexCall = await callHandler(
    { method: 'tools/call', params: { name: 'codex_status', arguments: {} } },
    { signal: null }
  );
  assert.equal(codexCall.isError, true);
  assert.ok(codexCall.content[0].text.includes('Unknown tool: codex_status'));

  // 4. Call session action via canonical session tool
  const sess = createSession('gemini', tempDir);
  const sessionCall = await callHandler(
    {
      method: 'tools/call',
      params: {
        name: 'session',
        arguments: { action: 'list' },
      },
    },
    { signal: null }
  );
  assert.equal(sessionCall.isError, undefined);
  assert.ok(sessionCall.content[0].text.includes(sess.sessionHandle));

  // 5. Call cancel tool
  const cancelCall = await callHandler(
    {
      method: 'tools/call',
      params: {
        name: 'cancel',
        arguments: { session_handle: sess.sessionHandle },
      },
    },
    { signal: null }
  );
  assert.equal(cancelCall.isError, undefined);
  assert.ok(cancelCall.content[0].text.includes('cancelled and resources released'));
});

// =========================================================================
// Task 3.4: Professional Telemetry Formatting (No-Emoji Standard)
// =========================================================================

test('Phase 3 Task 3.4: formatExecutionResult enforces strict No-Emoji standard and clean blockquotes', async () => {
  const result = {
    status: 'completed',
    isError: false,
    output: 'System analysis successful.',
    model: 'gpt-6.1-sol',
    truncated: false,
    continuationAvailable: true,
  };

  const formatted = await formatExecutionResult('codex', result, '', 'syn_sess_1234567890abcdef', {
    turn: 2,
    toolCount: 3,
    durationMs: 4500,
    historyAvailable: true,
  });

  const text = formatted.content[0].text;

  // Verify absence of emojis
  const emojiRegex = /[\u2300-\u23FF\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/;
  assert.ok(!emojiRegex.test(text), `Output should not contain any emojis: ${text}`);

  // Verify clean blockquotes
  assert.ok(text.includes('> CoAgent: codex (gpt-6.1-sol) · 4.5s · 3 ops'));
  assert.ok(text.includes('> Session: syn_sess_1234567890abcdef (turn 2 · ready)'));
});

test('Phase 3 Task 3.4: error formatting uses enterprise-grade blockquote without warning emojis', async () => {
  const errorResult = {
    status: 'failed',
    isError: true,
    output: '',
    model: 'gpt-6.1-sol',
    truncated: false,
    continuationAvailable: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Provider quota exhausted.',
      retryable: true,
    },
  };

  const formatted = await formatExecutionResult('codex', errorResult, '', null, {
    turn: 1,
    toolCount: 0,
    durationMs: 500,
    historyAvailable: false,
  });

  const text = formatted.content[0].text;
  const emojiRegex = /[\u2300-\u23FF\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/;
  assert.ok(!emojiRegex.test(text), `Error output should not contain any emojis: ${text}`);
  assert.ok(text.includes('> Error [RATE_LIMITED]: Provider quota exhausted.'));
});

test('Phase 3 Audit Remediation: cancelSession respects external live processes and protects replacement turn tokens', async () => {
  const sess = createSession('gemini', tempDir);
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
  const sess2 = createSession('gemini', tempDir);
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
    return true;
  });

  const cancelRes = await cancelSession(handle2, tempDir);
  assert.equal(cancelRes.cancelled, true);

  const updatedRecord = JSON.parse(fs.readFileSync(file2, 'utf8'));
  assert.equal(updatedRecord.turnToken, turn2Token, 'Replacement turn token must be preserved');
  assert.equal(updatedRecord.state, 'running', 'Replacement running turn must not be forced to idle');

  // 3. Idle session cancellation must not clear a newly acquired turn
  const sess3 = createSession('gemini', tempDir);
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
    return true;
  });

  const cancelRes3 = await cancelSession(handle3, tempDir);
  assert.equal(cancelRes3.cancelled, true);

  const updatedRecord3 = JSON.parse(fs.readFileSync(file3, 'utf8'));
  assert.equal(updatedRecord3.turnToken, turn3Token, 'Initially idle cancellation must not clear newly acquired turn');
  assert.equal(updatedRecord3.state, 'running', 'Initially idle cancellation must not force new running turn to idle');

  // 4. Cancellation timeout must fail cleanly without releasing ownership
  setExecutionCanceller(async () => {
    return false; // Timed out
  });
  await assert.rejects(
    async () => cancelSession(handle3, tempDir),
    /cancellation timed out/
  );
});
