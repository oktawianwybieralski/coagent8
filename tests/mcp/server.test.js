const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-server-'));
process.env.coagent8_DIR = tempDir;

const { createHistoryWriter } = require('../../src/sessions/history/index.ts');
const { createSession } = require('../../src/sessions/session.ts');
const { createServer, createToolDefinitions, validateToolArguments } = require('../../src/mcp/server.ts');
const { readResult } = require('../helpers/result.cjs');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('MCP server registers and fulfills coagent8://sessions and coagent8://sessions/{id}/history resources', async () => {
  const sess = createSession('agy', tempDir);
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'agy', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Testing MCP resource exposure' });
  writer.accept({ type: 'assistant_message', messageId: 'm-mcp', text: 'MCP resources are live and durable.' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();
  // A session of another workspace stays invisible through resources (AUD-P1-8).
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-other-workspace-'));
  const other = createSession('agy', otherDir);
  const otherWriter = createHistoryWriter(other.sessionHandle, otherDir, 'agy', randomUUID());
  otherWriter.accept({ type: 'turn_started' });
  otherWriter.accept({ type: 'user_message', text: 'Other workspace' });
  otherWriter.accept({ type: 'turn_finished', status: 'completed' });
  await otherWriter.flush();

  // Without client roots the server directory is the workspace.
  const launchDirectory = process.cwd();
  process.chdir(tempDir);
  try {
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
  assert.ok(!resourcesResult.resources.some(r => r.uri.includes(other.sessionHandle)), 'another workspace is not listed');

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
  assert.ok(!parsedSessions.some(s => s.sessionHandle === other.sessionHandle), 'another workspace is not returned');

  // 4. Read coagent8://sessions/{id}/history
  const readHistoryResult = await server._requestHandlers.get('resources/read')({
    method: 'resources/read',
    params: { uri: `coagent8://sessions/${sess.sessionHandle}/history` },
  });
  assert.equal(readHistoryResult.contents.length, 1);
  const parsedHistory = JSON.parse(readHistoryResult.contents[0].text);
  assert.equal(parsedHistory.sessionHandle, sess.sessionHandle);
  assert.ok(parsedHistory.events.length >= 4);
  await assert.rejects(server._requestHandlers.get('resources/read')({
    method: 'resources/read',
    params: { uri: `coagent8://sessions/${other.sessionHandle}/history` },
  }), /not found in this workspace/, 'the history of another workspace is not readable');

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
  } finally {
    process.chdir(launchDirectory);
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('F14/F15: shared schema validates required fields, types, enums and unknown fields',()=>{
  const tools=createToolDefinitions();assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  const consultTool=tools.find(t=>t.name==='consult');assert.ok(consultTool.inputSchema.properties.session_handle);assert.equal(consultTool.outputSchema,undefined,'execution results are markdown only (CONTEXT-001)');
  assert.throws(()=>validateToolArguments({},consultTool.inputSchema),/Missing/);
  assert.throws(()=>validateToolArguments({proposal:'x',user_confirmed:true},consultTool.inputSchema),/Unknown arguments\.user_confirmed/,'consent is not a tool argument');
  assert.throws(()=>validateToolArguments({proposal:'x',extra:1},consultTool.inputSchema),/Unknown/);
  // AX-002: the price limit is a non-negative finite number of USD per million output tokens.
  assert.ok(validateToolArguments({proposal:'x',output_price_below:4.99},consultTool.inputSchema));
  for (const bad of ['5',-1,null,Number.POSITIVE_INFINITY]) assert.throws(()=>validateToolArguments({proposal:'x',output_price_below:bad},consultTool.inputSchema),/output_price_below/,String(bad));
  const { getAllCallableToolDefinitions } = require('../../src/mcp/server.ts');
  const schema=getAllCallableToolDefinitions().find(t=>t.name==='analyze').inputSchema;
  assert.ok(validateToolArguments({task:'x',backend:'agy'},schema));
  assert.throws(()=>validateToolArguments({task:'x',file_paths:[3]},schema),/expected string/);
});

test('the connected client name sets the caller CLI that auto routing avoids', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { resolveBackend, setCallerProvider } = require('../../src/execution/routing.ts');
  const { saveConfig } = require('../../src/config.ts');
  const original = { ...adapterRegistry };
  const server = createServer();
  const client = new Client({ name: 'claude-code', version: '2.1.291' });
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = { id, name: id, inspectQuota: async () => undefined,
        probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }), execute: async () => { throw new Error('Not executed'); } };
    }
    await saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'agy'] } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await resolveBackend()).id, 'agy', 'Claude Code as client is routed to another CLI');
  } finally {
    await client.close();
    await server.close();
    setCallerProvider(null);
    Object.assign(adapterRegistry, original);
  }
});

test('execution results report a workspace taken from client roots; roots are read once until the client reports a change', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const { pathToFileURL } = require('node:url');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { saveConfig } = require('../../src/config.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-root-'));
  const original = adapterRegistry.agy;
  const seen = [];
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => { seen.push(options.cwd); return { status: 'completed', isError: false, output: 'ok', nativeSessionId: randomUUID(), model: 'gemini-test', truncated: false, continuationAvailable: true }; } };
  const server = createServer();
  const client = new Client({ name: 'roots-client', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  let rootsRequests = 0;
  client.setRequestHandler(ListRootsRequestSchema, async () => { rootsRequests++; return { roots: [{ uri: pathToFileURL(root).href, name: 'project' }] }; });
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const first = await client.callTool({ name: 'consult', arguments: { proposal: 'x' } });
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(fs.realpathSync(seen[0]), fs.realpathSync(root));
    assert.equal(readResult(first).workspace, null, 'a client root costs no extra text');
    await client.callTool({ name: 'consult', arguments: { proposal: 'y' } });
    assert.equal(rootsRequests, 1, 'roots are cached per connection');
    await client.sendRootsListChanged();
    await new Promise(resolve => setTimeout(resolve, 50));
    await client.callTool({ name: 'consult', arguments: { proposal: 'z' } });
    assert.equal(rootsRequests, 2, 'a roots change is read again');
    const explicit = await client.callTool({ name: 'consult', arguments: { proposal: 'w', workspace_path: tempDir } });
    assert.equal(readResult(explicit).workspace, null, 'an explicit path costs no extra text');
    assert.equal(fs.realpathSync(seen[3]), fs.realpathSync(tempDir), 'the explicit path is the workspace');
    assert.equal(rootsRequests, 2, 'an explicit path needs no roots request');
  } finally {
    await client.close();
    await server.close();
    adapterRegistry.agy = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution errors carry the code raised at their source; an unknown failure is PROCESS_ERROR, not INPUT_LIMIT (AUD-P1-2)', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { saveConfig } = require('../../src/config.ts');
  const original = adapterRegistry.agy;
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => { throw new Error('Lock timeout on probe cache.'); },
    execute: async () => { throw new Error('must not run'); } };
  const server = createServer();
  const client = new Client({ name: 'errors-client', version: '1' });
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async args => readResult(await client.callTool({ name: 'consult', arguments: { workspace_path: tempDir, ...args } })).error;
    const unknown = await call({ proposal: 'x' });
    assert.equal(unknown.code, 'PROCESS_ERROR');
    assert.equal(unknown.message, 'Lock timeout on probe cache.');
    const denied = await call({ proposal: 'x', backend: 'codex' });
    assert.equal(denied.code, 'POLICY_DENIED');
    assert.ok(!denied.message.startsWith('POLICY_DENIED'), 'the message carries no code prefix');
    assert.equal((await call({ proposal: 'x', session_handle: 'syn_sess_0000000000000000' })).code, 'SESSION_INVALID');
    const invalid = await client.callTool({ name: 'consult', arguments: { proposal: '', workspace_path: tempDir } });
    assert.equal(readResult(invalid).error.code, 'INPUT_LIMIT', 'rejected input keeps INPUT_LIMIT');
    // Live, 2026-10-07: a call refused before launch showed "provider default" beside the model the caller named.
    const refused = readResult(await client.callTool({ name: 'consult', arguments: { proposal: 'x', model: 'gemini-3.8-flash', workspace_path: tempDir } }));
    assert.equal(refused.model, 'gemini-3.8-flash', 'the footer names the requested model');
    assert.equal(readResult(await client.callTool({ name: 'consult', arguments: { proposal: 'x', model: '--yolo', workspace_path: tempDir } })).model, 'provider default', 'an invalid identifier is not echoed');
  } finally {
    await client.close();
    await server.close();
    adapterRegistry.agy = original;
  }
});

test('the server declares no resource list notifications it never sends (AUD-P2-8)', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const server = createServer();
  const client = new Client({ name: 'capabilities-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities.resources, 'resources are offered');
    assert.notEqual(capabilities.resources.listChanged, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a top-tier model runs only after the user approves it through MCP elicitation (AUD-P1-7)', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { saveConfig, loadConfig } = require('../../src/config.ts');
  const original = adapterRegistry.agy;
  const consented = [];
  const withDefault = defaultModel => async () => ({ installed: true, version: 'fixture', config: { defaultModel } });
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: withDefault('gemini-3.8-flash-high'),
    execute: async (_prompt, options) => {
      consented.push(options.model);
      return { status: 'completed', isError: false, output: 'approved answer', nativeSessionId: randomUUID(), model: options.model, truncated: false, continuationAvailable: true };
    } };
  const connect = async capabilities => {
    const server = createServer();
    const client = new Client({ name: 'consent-client', version: '1' }, { capabilities });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  };
  const opened = [];
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] }, governance: { priceMultiplier: 2, askAbovePrice: 20, models: { allow: [], ask: [], deny: [] } } });
    const callWith = (client, args) => client.callTool({ name: 'consult', arguments: { proposal: 'x', workspace_path: tempDir, ...args } });
    const call = (client, model) => callWith(client, model ? { model } : {});

    const plain = await connect({});
    opened.push(plain);
    const refused = readResult(await call(plain.client, 'claude-opus-4-6-thinking')).error;
    assert.equal(refused.code, 'POLICY_DENIED');
    assert.match(refused.message, /no MCP elicitation/);

    const asking = await connect({ elicitation: {} });
    opened.push(asking);
    const requests = [];
    let answer = { action: 'decline' };
    asking.client.setRequestHandler(ElicitRequestSchema, async request => { requests.push(request.params); return answer; });
    const declined = readResult(await call(asking.client, 'claude-opus-4-6-thinking')).error;
    assert.equal(declined.code, 'POLICY_DENIED');
    assert.match(declined.message, /did not approve/);
    // Codex 0.160.1 declares form elicitation but answers `cancel` in 3 ms without showing a
    // form (measured 2026-10-07), so a cancel must not be reported as the user's decision.
    answer = { action: 'cancel' };
    const unanswered = readResult(await call(asking.client, 'claude-opus-4-6-thinking')).error;
    assert.equal(unanswered.code, 'POLICY_DENIED');
    assert.match(unanswered.message, /^The client closed the approval request for model 'claude-opus-4-6-thinking' without an answer, possibly without showing it to the user\. Its price is known only approximately/);
    assert.match(unanswered.message, /Tell the user; switch to another model only if the user asks\. The user can approve it in a client that shows MCP forms, or allow it in governance\.models\.allow \(VS Code: CoAgent8: Manage Model Approvals\); never change that setting yourself\.$/);
    // Only an explicit `approve: true` is consent (CUR-003): an accepted form without the
    // field, with an empty or a non-boolean value, or unchecked, declines.
    const notConsent = [{ action: 'accept' }, { action: 'accept', content: {} }, { action: 'accept', content: { approve: 'true' } },
      { action: 'accept', content: { approve: false } }];
    for (const reply of notConsent) {
      answer = reply;
      assert.equal(readResult(await call(asking.client, 'claude-opus-4-6-thinking')).error?.code, 'POLICY_DENIED', JSON.stringify(reply));
    }
    assert.deepEqual(consented, [], 'nothing runs before the user approves');

    answer = { action: 'accept', content: { approve: true } };
    const approved = readResult(await call(asking.client, 'claude-opus-4-6-thinking'));
    assert.equal(approved.answer, 'approved answer');
    assert.deepEqual(consented, ['claude-opus-4-6-thinking']);
    assert.match(requests[0].message, /run 'claude-opus-4-6-thinking' on agy\? Its price is known only approximately/);
    assert.equal(requests[0].requestedSchema.properties.approve.type, 'boolean');
    assert.deepEqual(requests[0].requestedSchema.required, ['approve']);
    assert.equal(requests[0].requestedSchema.properties.remember.type, 'boolean', 'an approximate price offers remember');

    // A continued session asks again on every turn, and an empty form still declines.
    answer = { action: 'accept', content: {} };
    const resumed = await callWith(asking.client, { model: 'claude-opus-4-6-thinking', session_handle: approved.sessionHandle });
    assert.equal(readResult(resumed).error.code, 'POLICY_DENIED');

    // A governed default model is asked for like a requested one.
    adapterRegistry.agy = { ...adapterRegistry.agy, probe: withDefault('claude-opus-4-6-thinking') };
    assert.equal(readResult(await call(asking.client, undefined)).error.code, 'POLICY_DENIED');
    assert.deepEqual(consented, ['claude-opus-4-6-thinking'], 'no declined turn ran');
    adapterRegistry.agy = { ...adapterRegistry.agy, probe: withDefault('gemini-3.8-flash-high') };

    // A default model the policy does not price as expensive never prompts the user.
    const plainTurn = await call(asking.client, undefined);
    assert.equal(plainTurn.isError, false, plainTurn.content[0].text);
    assert.equal(requests.length, 9);
    assert.deepEqual(consented, ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high']);

    // An expensive priced model asks on every turn, without remember.
    answer = { action: 'decline' };
    assert.equal(readResult(await call(asking.client, 'gpt-6-astra')).error.code, 'POLICY_DENIED');
    assert.equal(requests.at(-1).requestedSchema.properties.remember, undefined, 'a known high price is asked for every time');
    // An unknown model approved with remember is not asked for again.
    answer = { action: 'accept', content: { approve: true, remember: true } };
    assert.equal(readResult(await call(asking.client, 'gpt-7-nova')).answer, 'approved answer');
    assert.deepEqual(loadConfig().governance.models.allow, ['gpt-7-nova']);
    answer = { action: 'decline' };
    const asked = requests.length;
    assert.equal(readResult(await call(asking.client, 'gpt-7-nova')).answer, 'approved answer');
    assert.equal(requests.length, asked, 'remembered: no prompt');
  } finally {
    for (const { client, server } of opened) { await client.close(); await server.close(); }
    adapterRegistry.agy = original;
  }
});

test('EXEC-001-T11b: handleDoctor forwards its signal for both scopes; MCP server forwards extra.signal to doctor and reports timeout as isError text', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { handleDoctor } = require('../../src/mcp/tools/doctor.tool.ts');
  const { ToolError } = require('../../src/contracts/index.ts');
  const { adapterRegistry } = require('../../src/backends/registry.ts');

  // 1. handleDoctor forwards signal for scope: health
  const abortedHealth = new AbortController();
  abortedHealth.abort();
  await assert.rejects(
    handleDoctor({ scope: 'health' }, abortedHealth.signal),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );

  // 2. handleDoctor forwards signal for scope: models
  const abortedModels = new AbortController();
  abortedModels.abort();
  await assert.rejects(
    handleDoctor({ scope: 'models' }, abortedModels.signal),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );

  // 3. MCP server forwards extra.signal to doctor and reports a doctor timeout as isError: true text
  const server = createServer();
  const client = new Client({ name: 'doctor-client', version: '1' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const originalCodex = adapterRegistry.codex;
  try {
    adapterRegistry.codex = {
      ...originalCodex,
      probe: async () => {
        throw new ToolError('TIMEOUT', 'Diagnostic deadline exceeded (60000 ms).');
      },
    };

    const res = await client.callTool({ name: 'doctor', arguments: { scope: 'health' } });
    assert.equal(res.isError, true, 'doctor timeout reports isError: true');
    assert.ok(Array.isArray(res.content));
    assert.equal(res.content[0].type, 'text');
    assert.match(res.content[0].text, /Diagnostic deadline exceeded/);
  } finally {
    adapterRegistry.codex = originalCodex;
    await client.close();
    await server.close();
  }
});

test('EXEC-001-T11b: server startup runs no probe, and doctor call creates no session file', async () => {
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { handleDoctor } = require('../../src/mcp/tools/doctor.tool.ts');
  const { getSessionsDir } = require('../../src/sessions/activity.ts');

  let probeCalls = 0;
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'agy']) {
      adapterRegistry[id] = {
        ...original[id],
        probe: async () => {
          probeCalls++;
          return { id, installed: false, executionSupported: false };
        },
      };
    }

    // 1. Server startup runs no probe
    const server = createServer();
    assert.equal(probeCalls, 0, 'createServer runs no probe during startup');
    await server.close();

    // 2. Doctor call creates no session file
    const sessionDir = getSessionsDir();
    const listSessions = () => fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
    const filesBefore = listSessions();

    await handleDoctor({ scope: 'models' });
    const filesAfterModels = listSessions();
    assert.deepEqual(filesAfterModels, filesBefore, 'scope: models creates no session file');

    await handleDoctor({ scope: 'health' });
    const filesAfterHealth = listSessions();
    assert.deepEqual(filesAfterHealth, filesBefore, 'scope: health creates no session file');
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('EXEC-001-T11c: early failure during tool preparation or Git collection formats non-zero elapsed duration matching elapsed monotonic time', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { saveConfig } = require('../../src/config.ts');

  let now = 1000;
  const clock = () => now;
  const server = createServer({ clock });
  const client = new Client({ name: 'test-timing-client', version: '1' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const originalCodex = adapterRegistry.codex;
  try {
    await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
    adapterRegistry.codex = {
      ...originalCodex,
      probe: async () => {
        // Advance clock during probe / preparation
        now = 2500;
        throw new Error('Preparation probe failure');
      },
    };

    const res = await client.callTool({
      name: 'consult',
      arguments: {
        proposal: 'testing early timing failure',
        workspace_path: tempDir,
      },
    });

    assert.equal(res.isError, true, 'tool call should fail');
    const parsed = readResult(res);
    assert.equal(parsed.durationSec, 1.5, `duration in footer should match elapsed monotonic time (1.5s), got ${parsed.durationSec}`);
    assert.ok(parsed.durationSec > 0, 'duration in footer must be strictly non-zero');
  } finally {
    adapterRegistry.codex = originalCodex;
    await client.close();
    await server.close();
  }
});

test('EXEC-001-T11c: cancelled or timed-out consent wait reflects actual elapsed time in result footer', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { saveConfig } = require('../../src/config.ts');

  let now = 1000;
  const clock = () => now;
  const server = createServer({ clock });
  const client = new Client({ name: 'test-consent-client', version: '1' }, { capabilities: { elicitation: {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  client.setRequestHandler(ElicitRequestSchema, async () => {
    // Simulate user waiting 2.4s then closing / cancelling dialog
    now = 3400;
    return { action: 'cancel' };
  });

  const originalAgy = adapterRegistry.agy;
  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { priceMultiplier: 2, askAbovePrice: 20, models: { allow: [], ask: ['expensive-model'], deny: [] } },
    });
    adapterRegistry.agy = {
      ...originalAgy,
      probe: async () => ({
        installed: true,
        executionSupported: true,
        config: { defaultModel: 'gemini-3.8-flash' },
      }),
      listModels: async () => ({
        source: 'agy',
        models: [{ id: 'expensive-model', displayName: 'Expensive Model', default: false, reasoningEffort: false }],
      }),
    };

    const res = await client.callTool({
      name: 'consult',
      arguments: {
        proposal: 'testing consent timeout timing',
        model: 'expensive-model',
        workspace_path: tempDir,
      },
    });

    assert.equal(res.isError, true, 'cancelled consent should result in error');
    const parsed = readResult(res);
    assert.equal(parsed.error.code, 'POLICY_DENIED');
    assert.equal(parsed.durationSec, 2.4, `duration in footer should reflect elapsed monotonic time (2.4s), got ${parsed.durationSec}`);
    assert.ok(parsed.durationSec > 0, 'duration in footer must be strictly non-zero');
  } finally {
    adapterRegistry.agy = originalAgy;
    await client.close();
    await server.close();
  }
});
