const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tools-surface-'));
process.env.coagent8_DIR = tempDir;

const {
  createToolDefinitions,
  getCoreCanonicalTools,
  getLegacyAliasTools,
  getAllCallableToolDefinitions,
  createServer,
} = require('../../src/server.ts');
const { CORE_CANONICAL_TOOL_NAMES, DEPRECATED_LEGACY_TOOL_NAMES } = require('../../src/constants.ts');
const { handleAnalyze } = require('../../src/tools/analyze.tool.ts');
const { handleDebugError } = require('../../src/tools/debug.tool.ts');
const { handleImplement } = require('../../src/tools/implement.tool.ts');
const { handleRun, runToolDefinition } = require('../../src/tools/run.tool.ts');
const { createSession } = require('../../src/sessions/session.ts');

test.after(() => {
  delete process.env.coagent8_TOOL_PROFILE;
});

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('SURFACE-001: core canonical tools interface defines exactly 6 canonical tools', () => {
  const coreTools = getCoreCanonicalTools();
  assert.equal(coreTools.length, 6, 'Must define exactly 6 core canonical tools');
  const names = coreTools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'cancel',
    'consult',
    'doctor',
    'issue',
    'review',
    'session',
  ]);
  assert.deepEqual([...CORE_CANONICAL_TOOL_NAMES].sort(), names);
});

test('SURFACE-001: legacy aliases define analyze, debug, implement with deprecation notice', () => {
  const legacyTools = getLegacyAliasTools();
  assert.equal(legacyTools.length, 3);
  const names = legacyTools.map(t => t.name).sort();
  assert.deepEqual(names, ['analyze', 'debug', 'implement']);
  assert.deepEqual([...DEPRECATED_LEGACY_TOOL_NAMES].sort(), names);

  for (const tool of legacyTools) {
    assert.ok(
      tool.description.includes('[Deprecated: Use consult with task_type='),
      `Tool ${tool.name} must have deprecation notice in description`
    );
  }
});

test('SURFACE-001: consult inputSchema supports optional task_type and context_files', () => {
  const tools = createToolDefinitions();
  const consult = tools.find(t => t.name === 'consult');
  assert.ok(consult, 'consult tool must be present');

  const schema = consult.inputSchema;
  assert.ok(schema.properties.task_type, 'task_type property must exist');
  assert.deepEqual(schema.properties.task_type.enum, ['architecture', 'debug', 'implementation']);
  assert.ok(schema.properties.context_files, 'context_files property must exist');
  assert.ok(schema.properties.file_paths, 'file_paths property must exist');
  assert.deepEqual(schema.required, ['proposal']);
});

test('SURFACE-001: debug inputSchema does not expose phantom context_files property', () => {
  const tools = createToolDefinitions();
  const debug = tools.find(t => t.name === 'debug');
  assert.ok(debug, 'debug tool must be present');
  assert.equal(debug.inputSchema.properties.context_files, undefined, 'debug schema must not contain phantom context_files');
  assert.ok(debug.inputSchema.properties.file_paths, 'debug schema must contain file_paths');
});

test('SURFACE-001: run tool inputSchema supports both canonical and legacy actions', () => {
  const actions = runToolDefinition.inputSchema.properties.action.enum;
  assert.deepEqual(actions, ['consult', 'review', 'issue', 'analyze', 'debug', 'implement']);
  assert.ok(runToolDefinition.inputSchema.properties.task_type, 'run gateway must accept task_type');
});

test('SURFACE-001: run gateway validates required parameters per action', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-surface-'));
  try {
    // consult requires proposal
    await assert.rejects(
      async () => handleRun({ action: 'consult' }, tempDir),
      /proposal must be a non-empty string for action "consult"/
    );

    // analyze requires task
    await assert.rejects(
      async () => handleRun({ action: 'analyze' }, tempDir),
      /task must be a non-empty string for action "analyze"/
    );

    // debug requires error_message
    await assert.rejects(
      async () => handleRun({ action: 'debug' }, tempDir),
      /error_message must be a non-empty string for action "debug"/
    );

    // implement requires specification
    await assert.rejects(
      async () => handleRun({ action: 'implement' }, tempDir),
      /specification must be a non-empty string for action "implement"/
    );

    // unknown action throws
    await assert.rejects(
      async () => handleRun({ action: 'unknown_action' }, tempDir),
      /Unknown action "unknown_action"/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SURFACE-001: direct legacy handlers validate required parameters', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-surface-direct-'));
  try {
    const analyzeRes = await handleAnalyze('analyze', { task: '' }, tempDir);
    assert.equal(analyzeRes.isError, true);
    assert.ok(analyzeRes.content[0].text.includes('Validation Error: task must be a non-empty string.'));

    const debugRes = await handleDebugError({ error_message: '' }, tempDir);
    assert.equal(debugRes.isError, true);
    assert.ok(debugRes.content[0].text.includes('Validation Error: error_message must be a non-empty string.'));

    const implementRes = await handleImplement({ specification: '' }, tempDir);
    assert.equal(implementRes.isError, true);
    assert.ok(implementRes.content[0].text.includes('Validation Error: specification must be a non-empty string.'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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
