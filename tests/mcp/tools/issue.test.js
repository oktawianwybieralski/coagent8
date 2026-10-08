'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tools-issue-'));
const tempSessionsFile = path.join(tempDir, 'sessions.json');
process.env.coagent8_SESSIONS = tempSessionsFile;

const { GITHUB_NEW_ISSUE_BASE } = require('../../../src/diagnostics/issue.ts');
const { handleIssue, issueToolDefinition } = require('../../../src/mcp/tools/issue.tool.ts');
const { handleRun } = require('../../../src/mcp/tools/run.tool.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('canonical issue tool formats bug report, executes doctor by default, and supports opting out', async () => {
  assert.equal(issueToolDefinition.name, 'issue');
  assert.ok(issueToolDefinition.description.includes('Sanitized bug report'));

  // Default with doctor
  const resWithDoc = await handleIssue({
    error_message: 'Spawn failed with ENOENT',
    context: 'Calling debug tool on Windows',
  });
  assert.ok(resWithDoc.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(resWithDoc.content[0].text.includes(GITHUB_NEW_ISSUE_BASE));
  assert.ok(resWithDoc.structuredContent.issueUrl.includes('title='));
  assert.ok(resWithDoc.structuredContent.body.includes('Spawn failed with ENOENT'));

  // Opting out of doctor
  const resNoDoc = await handleIssue({
    error_message: 'Configuration syntax error',
    context: 'Parsing custom config.json',
    include_doctor: false,
  });
  assert.ok(resNoDoc.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(resNoDoc.structuredContent.body.includes('Not provided'));

  // Output schema assertion
  assert.ok(issueToolDefinition.outputSchema);
  assert.deepEqual(issueToolDefinition.outputSchema.required, ['title', 'body', 'issueUrl']);
});

test('server advertises issue tool and dispatches tools/call issue cleanly', async () => {
  const { createServer, createToolDefinitions } = require('../../../src/mcp/server.ts');
  const server = createServer();
  const tools = createToolDefinitions();
  const advertisedIssue = tools.find(t => t.name === 'issue');
  assert.ok(advertisedIssue, 'Canonical profile must advertise issue tool');
  assert.ok(advertisedIssue.outputSchema, 'Advertised issue must include outputSchema');

  const advertisedRun = tools.find(t => t.name === 'run');
  // Check run when in callable definitions
  const { getAllCallableToolDefinitions } = require('../../../src/mcp/server.ts');
  const allCallable = getAllCallableToolDefinitions();
  const runDef = allCallable.find(t => t.name === 'run');
  assert.equal(runDef.outputSchema, undefined, 'run returns execution results, which are markdown only (CONTEXT-001)');

  // The advertised tools pass the SDK's ListToolsResultSchema validation
  const { ListToolsResultSchema } = require('@modelcontextprotocol/sdk/types.js');
  const parsed = ListToolsResultSchema.parse({ tools: createToolDefinitions() });
  assert.equal(parsed.tools.length, 6);

  // tools/call dispatch
  const callHandler = server._requestHandlers.get('tools/call');
  const callRes = await callHandler(
    { method: 'tools/call', params: { name: 'issue', arguments: { error_message: 'Test crash', include_doctor: false } } },
    { signal: null }
  );
  assert.equal(callRes.isError, undefined);
  assert.ok(callRes.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(callRes.structuredContent.body.includes('Test crash'));
});

test('run gateway dispatches action: "issue" to handleIssue cleanly', async () => {
  const result = await handleRun(
    {
      action: 'issue',
      error_message: 'Command exited with 127',
      context: 'Gateway invocation smoke test',
      include_doctor: false,
    },
    tempDir
  );
  assert.ok(result.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(result.structuredContent.body.includes('Command exited with 127'));
});
