const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connect: connectStdio } = require('./helpers/stdio.cjs');

function createClient(dir, extraEnv = {}) {
  return connectStdio(
    process.execPath,
    ['--require', 'tsx/cjs', path.resolve(__dirname, '../src/index.ts')],
    {
      env: {
        ...process.env,
        coagent8_DIR: dir,
        ...extraEnv,
      },
    }
  );
}

test('MCP-001 & STARTUP-001: arbitrary client initializes and lists tools without backend or host mutation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-generic-mcp-'));
  const configPath = path.join(dir, 'config.json');
  // Create minimal isolated config with no default backend set
  fs.writeFileSync(configPath, JSON.stringify({ routing: { allowedBackends: ['codex', 'claude', 'gemini'] } }, null, 2));
  const initialConfigContent = fs.readFileSync(configPath, 'utf8');

  // Point to non-existent executables so no real CLI can run
  const c = createClient(dir, {
    CODEX_PATH: path.join(dir, 'nonexistent-codex'),
    CLAUDE_PATH: path.join(dir, 'nonexistent-claude'),
    GEMINI_PATH: path.join(dir, 'nonexistent-gemini'),
  });
  t.after(async () => {
    await c.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Client with arbitrary name and no optional capabilities
  const init = await c.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'ThirdPartyArbitraryClient', version: '9.8.7' },
  });

  assert.equal(init.result.serverInfo.title, 'CoAgent');
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Tools list succeeds without invoking any backend or failing
  const list = await c.request('tools/list', {});
  assert.equal(list.result.tools.length, 9, 'All canonical tools must be advertised even with uninstalled backends');
  assert.ok(list.result.tools.some(tool => tool.name === 'consult'));
  assert.ok(list.result.tools.some(tool => tool.name === 'review'));
  assert.ok(list.result.tools.some(tool => tool.name === 'doctor'));

  // Calling a tool with missing backend returns actionable CLI_NOT_FOUND error without crashing server
  const call = await c.request('tools/call', {
    name: 'consult',
    arguments: { proposal: 'Evaluate architecture without installed backend', backend: 'claude', workspace_path: dir },
  });
  assert.equal(call.result.isError, true);
  assert.ok(call.result.structuredContent);
  assert.equal(call.result.structuredContent.error.code, 'CLI_NOT_FOUND');
  assert.ok(call.result.structuredContent.error.message.includes('not installed; run doctor'));
  assert.equal(call.result.structuredContent.verdict, 'NOT_APPLICABLE');

  // Verify host configuration was NOT mutated
  const finalConfigContent = fs.readFileSync(configPath, 'utf8');
  assert.equal(finalConfigContent, initialConfigContent, 'Server initialization and routing must not mutate disk config');

  c.proc.stdin.end();
  await c.waitForExit(5000);
});

test('CONSULT-001: consult returns plain advice and NOT_APPLICABLE verdict without synthetic State Envelope', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-consult-plain-'));
  const fixturePath = path.resolve(__dirname, 'fixtures/gemini-cli/gemini.cjs');
  const captureFile = path.join(dir, 'fixture-capture.json');
  const c = createClient(dir, {
    GEMINI_PATH: fixturePath,
    GEMINI_CLI_HOME: path.join(dir, 'gemini-home'),
    coagent8_FIXTURE_CAPTURE: captureFile,
  });
  t.after(async () => {
    await c.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await c.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'AdvisorClient', version: '1.0' },
  });
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Call consult with a proposal discussing [P1] and [P2] defect topics
  const res = await c.request('tools/call', {
    name: 'consult',
    arguments: {
      proposal: 'How should we handle [P1] critical bugs and [P2] latency bottlenecks in our service?',
      backend: 'gemini',
      workspace_path: dir,
    },
  });

  assert.equal(res.result.isError, false);
  const structured = res.result.structuredContent;
  assert.equal(structured.status, 'completed');
  assert.equal(structured.verdict, 'NOT_APPLICABLE', 'Consult must return verdict: NOT_APPLICABLE');
  assert.equal(structured.reason, undefined, 'Consult must not have verdict reason');
  // Ensure synthetic State Envelope was NOT injected
  assert.ok(!res.result.content[0].text.includes('VERDICT: BLOCKED'), 'Ordinary consult must not acquire synthetic VERDICT: BLOCKED');
  assert.ok(!res.result.content[0].text.includes('CHECKS: typecheck='), 'Ordinary consult must not have synthetic CHECKS');

  // Verify that the prompt sent to the backend CLI completely excluded State Envelope formatting instructions
  assert.ok(fs.existsSync(captureFile), 'Fixture must have captured the executed prompt');
  const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  assert.ok(captured.prompt.includes('[TASK: TECHNICAL ADVICE & CONSULTATION]'), 'Prompt must use technical advice header');
  assert.ok(!captured.prompt.includes('FORMAT REQUIREMENTS:'), 'Prompt must not contain State Envelope FORMAT REQUIREMENTS');
  assert.ok(!captured.prompt.includes('State Envelope protocol'), 'Prompt must not mention State Envelope protocol');
  assert.ok(!captured.prompt.includes('END_REVIEW'), 'Prompt must not contain END_REVIEW header');

  c.proc.stdin.end();
  await c.waitForExit(5000);
});

test('STARTUP-001 & SHUTDOWN: graceful shutdown cleanly awaits pending background maintenance', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-shutdown-delay-'));
  const gateFile = path.join(dir, 'gate');
  const c = createClient(dir, {
    coagent8_MAINTENANCE_GATE: gateFile,
  });
  t.after(async () => {
    try { fs.writeFileSync(gateFile + '.release', 'release'); } catch {}
    await c.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await c.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'ShutdownClient', version: '1.0' },
  });
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Synchronize with maintenance start signal: wait until gate.started exists
  const waitStarted = Date.now();
  while (!fs.existsSync(gateFile + '.started')) {
    if (Date.now() - waitStarted > 10000) throw new Error('Timed out waiting for maintenance to start');
    await new Promise(r => setTimeout(r, 20));
  }

  // Trigger EOF while background maintenance is actively held by gate
  c.proc.stdin.end();

  // Give shutdown a moment to start processing EOF
  await new Promise(r => setTimeout(r, 100));

  // Assert process is still alive because it is cleanly awaiting maintenance
  assert.equal(c.proc.exitCode, null, 'Process must NOT exit while maintenance is held by gate');

  // Now release the gate to let maintenance complete
  fs.writeFileSync(gateFile + '.release', 'release');

  // Await clean exit
  await c.waitForExit(5000);
  assert.equal(c.proc.exitCode, 0, 'Process must exit cleanly with code 0 after maintenance completes');
});

test('CONSULT-001 & REVIEW: review evaluates State Envelope gate and exposes machine-readable verdict in structuredContent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-review-envelope-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'AuditFixture'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'audit@example.invalid'], { cwd: dir, windowsHide: true });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello initial\n');
  execFileSync('git', ['add', '.'], { cwd: dir, windowsHide: true });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir, windowsHide: true });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello modified\n');

  const fixturePath = path.resolve(__dirname, 'fixtures/gemini-cli/gemini.cjs');
  const c = createClient(dir, {
    GEMINI_PATH: fixturePath,
    GEMINI_CLI_HOME: path.join(dir, 'gemini-home'),
  });
  t.after(async () => {
    await c.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await c.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'AuditClient', version: '1.0' },
  });
  c.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const res = await c.request('tools/call', {
    name: 'review',
    arguments: {
      instructions: 'Audit recent changes for security defects.',
      backend: 'gemini',
      workspace_path: dir,
    },
  });

  assert.equal(res.result.isError, false);
  const structured = res.result.structuredContent;
  assert.equal(structured.status, 'completed');
  assert.equal(structured.verdict, 'BLOCKED', 'Review missing envelope fields must evaluate to VERDICT: BLOCKED');
  assert.ok(structured.reason, 'Review BLOCKED must provide structured reason');

  c.proc.stdin.end();
  await c.waitForExit(5000);
});

test('CONSULT-001 & REVIEW: READY envelope with prose containing "VERDICT: BLOCKED" evaluates to structured verdict READY', async () => {
  const { evaluateStateEnvelopeGate, formatExecutionResult } = require('../src/tools/common.ts');
  const reviewOutput = [
    'REVIEW: 1',
    'SNAPSHOT: sha1234567890',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    '',
    '[P3] docs/README.md:10',
    'Problem: Documentation typo regarding VERDICT: BLOCKED state',
    'Evidence: Mentioning "VERDICT: BLOCKED" in documentation prose should not confuse header parsing',
    'Fix: Correct grammar',
    '',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  const evalResult = evaluateStateEnvelopeGate(reviewOutput, false, true);
  assert.equal(evalResult.verdict, 'READY', 'Quoted verdict in prose must not override header VERDICT: READY');

  const formatted = await formatExecutionResult('gemini', {
    status: 'completed',
    isError: false,
    output: reviewOutput,
    truncated: false,
    continuationAvailable: false,
  }, '', null, { turn: 1, toolCount: 0, durationMs: 10, historyAvailable: false }, { requireEnvelope: true });

  assert.equal(formatted.structuredContent.verdict, 'READY');
  assert.equal(formatted.structuredContent.reason, undefined);
});

