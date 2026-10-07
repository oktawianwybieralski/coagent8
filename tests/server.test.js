const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-server-'));
process.env.coagent8_DIR = tempDir;

const { createHistoryWriter } = require('../src/sessions/history.ts');
const { createSession } = require('../src/sessions/session.ts');
const { createServer, createToolDefinitions, validateToolArguments } = require('../src/server.ts');
const { isGovernedModel } = require('../src/backends/governance.ts');
const { readResult } = require('./helpers/result.cjs');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('MCP server registers and fulfills coagent8://sessions and coagent8://sessions/{id}/history resources', async () => {
  const sess = createSession('gemini', tempDir);
  const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'gemini', randomUUID());
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Testing MCP resource exposure' });
  writer.accept({ type: 'assistant_message', messageId: 'm-mcp', text: 'MCP resources are live and durable.' });
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await writer.flush();
  // A session of another workspace stays invisible through resources (AUD-P1-8).
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-other-workspace-'));
  const other = createSession('gemini', otherDir);
  const otherWriter = createHistoryWriter(other.sessionHandle, otherDir, 'gemini', randomUUID());
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

test('F14/F15: shared schema validates required fields, types, enums, unknown fields and model families',()=>{
  const tools=createToolDefinitions();assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  const consultTool=tools.find(t=>t.name==='consult');assert.ok(consultTool.inputSchema.properties.session_handle);assert.equal(consultTool.outputSchema,undefined,'execution results are markdown only (CONTEXT-001)');
  assert.throws(()=>validateToolArguments({},consultTool.inputSchema),/Missing/);
  assert.throws(()=>validateToolArguments({proposal:'x',user_confirmed:true},consultTool.inputSchema),/Unknown arguments\.user_confirmed/,'consent is not a tool argument');
  assert.throws(()=>validateToolArguments({proposal:'x',extra:1},consultTool.inputSchema),/Unknown/);
  const { getAllCallableToolDefinitions } = require('../src/server.ts');
  const schema=getAllCallableToolDefinitions().find(t=>t.name==='analyze').inputSchema;
  assert.ok(validateToolArguments({task:'x',backend:'gemini'},schema));
  assert.throws(()=>validateToolArguments({task:'x',file_paths:[3]},schema),/expected string/);
  for(const model of ['gpt-6-astra','gpt-6.1-astra','claude-opus-4-6','opus','astra'])assert.ok(isGovernedModel(model),model);
});

test('the connected client name sets the caller CLI that auto routing avoids', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { adapterRegistry } = require('../src/backends/registry.ts');
  const { resolveBackend, setCallerProvider } = require('../src/backends/routing.ts');
  const { saveConfig } = require('../src/config.ts');
  const original = { ...adapterRegistry };
  const server = createServer();
  const client = new Client({ name: 'claude-code', version: '2.1.291' });
  try {
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = { id, name: id, inspectQuota: async () => undefined,
        probe: async () => ({ installed: true, executionSupported: true }), execute: async () => { throw new Error('Not executed'); } };
    }
    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['claude', 'gemini'] } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal((await resolveBackend()).id, 'gemini', 'Claude Code as client is routed to another CLI');
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
  const { adapterRegistry } = require('../src/backends/registry.ts');
  const { saveConfig } = require('../src/config.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-root-'));
  const original = adapterRegistry.gemini;
  const seen = [];
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', probe: async () => ({ installed: true, executionSupported: true }),
    execute: async (_prompt, options) => { seen.push(options.cwd); return { status: 'completed', isError: false, output: 'ok', nativeSessionId: randomUUID(), model: 'gemini-test', truncated: false, continuationAvailable: true }; } };
  const server = createServer();
  const client = new Client({ name: 'roots-client', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  let rootsRequests = 0;
  client.setRequestHandler(ListRootsRequestSchema, async () => { rootsRequests++; return { roots: [{ uri: pathToFileURL(root).href, name: 'project' }] }; });
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
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
    adapterRegistry.gemini = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution errors carry the code raised at their source; an unknown failure is PROCESS_ERROR, not INPUT_LIMIT (AUD-P1-2)', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { adapterRegistry } = require('../src/backends/registry.ts');
  const { saveConfig } = require('../src/config.ts');
  const original = adapterRegistry.gemini;
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', probe: async () => { throw new Error('Lock timeout on probe cache.'); },
    execute: async () => { throw new Error('must not run'); } };
  const server = createServer();
  const client = new Client({ name: 'errors-client', version: '1' });
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
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
  } finally {
    await client.close();
    await server.close();
    adapterRegistry.gemini = original;
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
  const { adapterRegistry } = require('../src/backends/registry.ts');
  const { saveConfig } = require('../src/config.ts');
  const original = adapterRegistry.gemini;
  const consented = [];
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', probe: async () => ({ installed: true, version: 'fixture' }),
    resolveModel: requested => requested || 'gemini-3.8-flash-high',
    execute: async (_prompt, options) => {
      consented.push(options.consentedModel);
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
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const call = (client, model) => client.callTool({ name: 'consult', arguments: { proposal: 'x', workspace_path: tempDir, ...(model && { model }) } });

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
    answer = { action: 'accept', content: { approve: false } };
    assert.equal(readResult(await call(asking.client, 'claude-opus-4-6-thinking')).error.code, 'POLICY_DENIED', 'an unchecked box declines');
    assert.deepEqual(consented, [], 'nothing runs before the user approves');

    answer = { action: 'accept', content: { approve: true } };
    const approved = await call(asking.client, 'claude-opus-4-6-thinking');
    assert.equal(readResult(approved).answer, 'approved answer');
    assert.deepEqual(consented, ['claude-opus-4-6-thinking']);
    assert.match(requests[0].message, /top-tier model 'claude-opus-4-6-thinking' on gemini/);
    assert.equal(requests[0].requestedSchema.properties.approve.type, 'boolean');

    // A default-tier model never prompts the user.
    const plainTurn = await call(asking.client, undefined);
    assert.equal(plainTurn.isError, false, plainTurn.content[0].text);
    assert.equal(requests.length, 3);
    assert.deepEqual(consented, ['claude-opus-4-6-thinking', undefined]);
  } finally {
    for (const { client, server } of opened) { await client.close(); await server.close(); }
    adapterRegistry.gemini = original;
  }
});
