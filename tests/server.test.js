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
const { checkModelGovernance } = require('../src/backends/governance.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

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

test('F14/F15: shared schema validates required fields, types, enums, unknown fields and model families',()=>{
  const tools=createToolDefinitions();assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  const consultTool=tools.find(t=>t.name==='consult');assert.ok(consultTool.inputSchema.properties.session_handle);assert.ok(consultTool.outputSchema);
  assert.throws(()=>validateToolArguments({},consultTool.inputSchema),/Missing/);
  assert.throws(()=>validateToolArguments({proposal:'x',user_confirmed:'yes'},consultTool.inputSchema),/expected boolean/);
  assert.throws(()=>validateToolArguments({proposal:'x',extra:1},consultTool.inputSchema),/Unknown/);
  const schema=tools.find(t=>t.name==='analyze').inputSchema;
  assert.ok(validateToolArguments({task:'x',backend:'gemini'},schema));
  assert.throws(()=>validateToolArguments({task:'x',file_paths:[3]},schema),/expected string/);
  for(const model of ['gpt-6-astra','gpt-6.1-astra','claude-opus-4-6','opus','astra'])assert.ok(checkModelGovernance(model,false),model);
});
