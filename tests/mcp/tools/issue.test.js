'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tools-issue-'));
const tempSessionsFile = path.join(tempDir, 'sessions.json');
process.env.coagent8_DIR = tempDir;
process.env.coagent8_SESSIONS = tempSessionsFile;

const { GITHUB_NEW_ISSUE_BASE } = require('../../../src/diagnostics/issue.ts');
const { handleIssue, issueToolDefinition } = require('../../../src/mcp/tools/issue.tool.ts');
const { handleRun, runToolDefinition } = require('../../../src/mcp/tools/run.tool.ts');
const { adapterRegistry } = require('../../../src/backends/registry.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('canonical issue tool formats bug report, executes doctor by default, and supports opting out', async () => {
  assert.equal(issueToolDefinition.name, 'issue');
  assert.ok(issueToolDefinition.description.includes('sanitized report'));
  for (const instruction of [
    'Be concise',
    'reproduction steps',
    'expected/actual behavior',
    'impact',
    'sanitized telemetry',
    'tool/backend/model',
    'CLI versions',
    'errors',
    'timing',
    'scope/check evidence',
    'Mark unknown facts; never invent them',
    'Opens the bug report form',
  ]) {
    assert.ok(issueToolDefinition.description.includes(instruction), instruction);
  }
  assert.equal(
    issueToolDefinition.inputSchema.properties.include_doctor.description,
    'Default true: CLI versions only, no readiness/quota.',
  );
  assert.match(runToolDefinition.inputSchema.properties.include_doctor.description, /detected CLI versions only \(no readiness or quota\)/);

  // Default with doctor (must probe CLI versions without running native quota inspection)
  const originalCodex = adapterRegistry.codex;
  const originalClaude = adapterRegistry.claude;
  const originalAgy = adapterRegistry.agy;
  let quotaCalls = 0;
  adapterRegistry.codex = {
    ...originalCodex,
    probe: async () => ({ id: 'codex', name: 'OpenAI Codex CLI', installed: true, version: 'codex-cli 0.162.0-alpha.17.2' }),
    inspectQuota: async () => {
      quotaCalls++;
      return undefined;
    },
  };
  adapterRegistry.claude = {
    ...originalClaude,
    probe: async () => ({ id: 'claude', name: 'Claude Code CLI', installed: true, version: '2.1.296 (Claude Code)' }),
    inspectQuota: async () => {
      quotaCalls++;
      return undefined;
    },
  };
  adapterRegistry.agy = {
    ...originalAgy,
    probe: async () => ({ id: 'agy', name: 'Google Gemini (Antigravity agy)', installed: true, version: '1.3.3' }),
    inspectQuota: async () => {
      quotaCalls++;
      return undefined;
    },
  };
  const opened = [];
  const deps = {
    openBrowser: url => {
      opened.push(url);
      return true;
    },
  };
  let resWithDoc;
  try {
    resWithDoc = await handleIssue(
      {
        title: 'debug tool cannot start on Windows',
        error_message: 'Spawn failed with ENOENT',
        context: 'Calling debug tool on Windows',
      },
      deps,
    );
  } finally {
    adapterRegistry.codex = originalCodex;
    adapterRegistry.claude = originalClaude;
    adapterRegistry.agy = originalAgy;
  }
  assert.equal(quotaCalls, 0, 'include_doctor must not trigger native quota reads');
  assert.ok(resWithDoc.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(resWithDoc.content[0].text.includes(GITHUB_NEW_ISSUE_BASE));
  assert.ok(resWithDoc.structuredContent.issueUrl.startsWith(`${GITHUB_NEW_ISSUE_BASE}?template=bug_report.yml&title=`));
  assert.deepEqual(opened, [resWithDoc.structuredContent.issueUrl], 'the filled-in form opens once');
  assert.equal(resWithDoc.structuredContent.opened, true);
  assert.match(resWithDoc.content[0].text, /^Opened the filled-in bug report form in your browser/);
  assert.equal(resWithDoc.structuredContent.title, '[Bug]: debug tool cannot start on Windows');
  const filled = new URL(resWithDoc.structuredContent.issueUrl).searchParams;
  assert.equal(filled.get('title'), '[Bug]: debug tool cannot start on Windows');
  assert.match(filled.get('what-happened'), /Spawn failed with ENOENT[\s\S]*Calling debug tool on Windows/);
  assert.match(filled.get('environment'), /Claude Code CLI\*\*: 2\.1\.296/);
  assert.ok(resWithDoc.structuredContent.body.includes('Spawn failed with ENOENT'));
  assert.ok(
    resWithDoc.structuredContent.body.includes(
      '- **Detected CLIs**:\n' +
        '  - **OpenAI Codex CLI**: codex-cli 0.162.0-alpha.17.2\n' +
        '  - **Google Gemini (Antigravity agy)**: 1.3.3\n' +
        '  - **Claude Code CLI**: 2.1.296 (Claude Code)',
    ),
  );
  assert.ok(!resWithDoc.structuredContent.body.includes('vcodex-cli'));

  // Opting out of doctor
  const resNoDoc = await handleIssue(
    {
      error_message: 'Configuration syntax error',
      context: 'Parsing custom config.json',
      include_doctor: false,
    },
    deps,
  );
  assert.ok(resNoDoc.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(resNoDoc.structuredContent.body.includes('- **Detected CLIs**: Not provided'));
  const renderedLink = resNoDoc.content[0].text.match(/\[Submit Bug Report on GitHub\]\(<([^>]+)>\)/)[1];
  assert.equal(renderedLink, resNoDoc.structuredContent.issueUrl);
  assert.ok(renderedLink.includes('?template=bug_report.yml'));
  assert.equal(resNoDoc.structuredContent.title, '[Bug]: Configuration syntax error', 'the title falls back to the error');
  const context = 'Reproduction and timing evidence. '.repeat(50) + 'CONTEXT_END';
  const diagnostic = 'Failure details. '.repeat(100) + 'DIAGNOSTIC_END';
  const completeReport = await handleIssue({ error_message: diagnostic, context, include_doctor: false }, deps);
  assert.ok(completeReport.structuredContent.body.includes(context));
  assert.ok(completeReport.structuredContent.body.includes(diagnostic));
  assert.ok(new URL(completeReport.structuredContent.issueUrl).searchParams.get('what-happened').includes('CONTEXT_END'));

  // open_browser: false never opens; a failed opener reports opened: false
  opened.length = 0;
  const notOpened = await handleIssue({ error_message: 'x', include_doctor: false, open_browser: false }, deps);
  assert.equal(opened.length, 0);
  assert.equal(notOpened.structuredContent.opened, false);
  assert.match(notOpened.content[0].text, /^The bug report form is filled in/);
  const failed = await handleIssue({ error_message: 'x', include_doctor: false }, { openBrowser: () => false });
  assert.equal(failed.structuredContent.opened, false);
  const thrown = await handleIssue(
    { error_message: 'x', include_doctor: false },
    {
      openBrowser: () => {
        throw new Error('no browser');
      },
    },
  );
  assert.equal(thrown.structuredContent.opened, false);

  // Output schema assertion
  assert.ok(issueToolDefinition.outputSchema);
  assert.deepEqual(issueToolDefinition.outputSchema.required, ['title', 'body', 'issueUrl', 'prompt', 'pasteRequired', 'opened']);
  assert.equal(resNoDoc.structuredContent.prompt, resNoDoc.content[0].text);
  assert.equal(resNoDoc.structuredContent.pasteRequired, false);
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
  assert.equal(parsed.tools.length, 7);

  // tools/call dispatch
  const callHandler = server._requestHandlers.get('tools/call');
  const callRes = await callHandler(
    {
      method: 'tools/call',
      params: { name: 'issue', arguments: { error_message: 'Test crash', include_doctor: false, open_browser: false } },
    },
    { signal: null },
  );
  assert.equal(callRes.isError, undefined);
  assert.ok(callRes.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(callRes.structuredContent.body.includes('Test crash'));
  assert.equal(callRes.structuredContent.prompt, callRes.content[0].text);
  assert.equal(callRes.structuredContent.pasteRequired, false);
  assert.equal(callRes.structuredContent.opened, false);
});

test('run gateway dispatches action: "issue" to handleIssue cleanly', async () => {
  const result = await handleRun(
    {
      action: 'issue',
      error_message: 'Command exited with 127',
      context: 'Gateway invocation smoke test',
      include_doctor: false,
      open_browser: false,
    },
    tempDir,
  );
  assert.ok(result.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(result.structuredContent.body.includes('Command exited with 127'));
  assert.equal(result.structuredContent.prompt, result.content[0].text);
  assert.equal(result.structuredContent.opened, false);
});

test('tools/call run with action "issue" accepts title and open_browser', async () => {
  const { createServer } = require('../../../src/mcp/server.ts');
  const callHandler = createServer()._requestHandlers.get('tools/call');
  const res = await callHandler(
    {
      method: 'tools/call',
      params: {
        name: 'run',
        arguments: { action: 'issue', title: 'Gateway title', error_message: 'boom', include_doctor: false, open_browser: false },
      },
    },
    { signal: null },
  );
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  assert.equal(res.structuredContent.title, '[Bug]: Gateway title');
  assert.equal(res.structuredContent.opened, false);
});
