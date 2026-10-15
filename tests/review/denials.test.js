'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createCodexStreamCollector } = require('../../src/backends/codex/collector.ts');
const { evaluateStateEnvelopeGate } = require('../../src/review/gate.ts');
const { formatExecutionResult } = require('../../src/mcp/result.ts');
const { codexAppServerArgs } = require('../../src/backends/codex/app-server.ts');

test('codexAppServerArgs includes windows.sandbox="elevated" on Windows platforms', () => {
  const args = codexAppServerArgs();
  if (process.platform === 'win32') {
    assert.ok(args.includes('windows.sandbox="elevated"'), 'elevated sandbox configured on Windows');
  } else {
    assert.ok(!args.includes('windows.sandbox="elevated"'), 'elevated sandbox omitted on non-Windows');
  }
});

test('createCodexStreamCollector captures filesystem permission denials only on failed items', () => {
  const collector = createCodexStreamCollector();
  collector.initialize('thread_denial');
  collector.beginTurn('turn_1');

  // 1. Failed tool execution with PowerShell UnauthorizedAccessException and leading switches in Get-Content
  collector.line(JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'thread_denial',
      turnId: 'turn_1',
      item: {
        id: 'cmd_1',
        type: 'commandExecution',
        command: '"pwsh.exe" -Command "Get-Content -Raw \'docs/ARCHITECTURE.md\'"',
        aggregatedOutput: 'Get-Content : Odmowa dostępu\nCategoryInfo : PermissionDenied: (C:\\repo\\docs\\ARCHITECTURE.md:String) [Get-Content], UnauthorizedAccessException',
        exitCode: 1,
        status: 'failed',
      },
    },
  }));

  // 2. Failed Git command with permission denial
  collector.line(JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'thread_denial',
      turnId: 'turn_1',
      item: {
        id: 'cmd_2',
        type: 'commandExecution',
        command: 'git -C "C:/repo" show HEAD:docs/HANDOFF.md',
        aggregatedOutput: "fatal: failed to stat 'C:/repo/parent': Permission denied",
        exitCode: 1,
        status: 'failed',
      },
    },
  }));

  // 3. Successful command whose output happens to contain "Permission denied" text (e.g. reading docs discussing permissions)
  collector.line(JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'thread_denial',
      turnId: 'turn_1',
      item: {
        id: 'cmd_3',
        type: 'commandExecution',
        command: '"pwsh.exe" -Command "Get-Content -LiteralPath \'docs/SECURITY.md\' -Raw"',
        aggregatedOutput: 'When access is refused, the OS returns Permission denied.',
        exitCode: 0,
        status: 'completed',
      },
    },
  }));

  // 4. Failed search (exit 1) whose command line contained "blocked by policy", but whose output has no denial
  collector.line(JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'thread_denial',
      turnId: 'turn_1',
      item: {
        id: 'cmd_4',
        type: 'commandExecution',
        command: 'rg "blocked by policy" src',
        aggregatedOutput: '',
        exitCode: 1,
        status: 'failed',
      },
    },
  }));

  // 5. Failed Test-Path command (Test-Path must not match -Path parameter regex)
  collector.line(JSON.stringify({
    method: 'item/completed',
    params: {
      threadId: 'thread_denial',
      turnId: 'turn_1',
      item: {
        id: 'cmd_5',
        type: 'commandExecution',
        command: 'Test-Path docs/foo.md',
        aggregatedOutput: 'Access is denied',
        exitCode: 1,
        status: 'failed',
      },
    },
  }));

  const snapshot = collector.snapshot();
  assert.ok(Array.isArray(snapshot.denials), 'snapshot contains denials array');
  assert.equal(snapshot.denials.length, 3, 'captured 3 failed denial events');
  assert.equal(snapshot.denials[0].path, 'docs/ARCHITECTURE.md');
  assert.equal(snapshot.denials[0].operation, 'read');
  assert.match(snapshot.denials[0].reason, /permission denied|unauthorized/i);
  // cmd_5 should have path: undefined (not extracting docs/foo.md falsely via -Path)
  assert.equal(snapshot.denials[2].path, undefined);
  assert.equal(snapshot.denials[1].path, 'docs/HANDOFF.md');
  assert.equal(snapshot.denials[1].operation, 'git');
  assert.match(snapshot.denials[1].reason, /permission denied/i);
});

test('evaluateStateEnvelopeGate enforces COVERAGE: PARTIAL and BLOCKED on file, directory, and policy denials', () => {
  const envelope = [
    'REVIEW: 1',
    'SNAPSHOT: fixture#digest',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'Reviewed: docs/ARCHITECTURE.md and src/index.ts.',
    'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN',
    'END_REVIEW',
  ].join('\n');

  // Case A: exact file match
  const evalFile = evaluateStateEnvelopeGate(envelope, false, true, {
    expectedSnapshot: 'fixture#digest',
    inputComplete: true,
    requiredChecks: [],
    requiredFiles: ['docs/ARCHITECTURE.md', 'src/index.ts'],
    workspaceRoot: 'C:/repo',
    observedDenials: [
      { path: 'docs/ARCHITECTURE.md', operation: 'read', reason: 'Permission denied' },
    ],
  });
  assert.equal(evalFile.coverage, 'PARTIAL');
  assert.equal(evalFile.verdict, 'BLOCKED');
  assert.match(evalFile.reason, /docs\/ARCHITECTURE\.md/);

  // Case B: parent directory denial within workspaceRoot matches required child file
  const evalDir = evaluateStateEnvelopeGate(envelope, false, true, {
    expectedSnapshot: 'fixture#digest',
    inputComplete: true,
    requiredChecks: [],
    requiredFiles: ['docs/ARCHITECTURE.md', 'src/index.ts'],
    workspaceRoot: 'C:/repo',
    observedDenials: [
      { path: 'C:/repo/docs', operation: 'read', reason: 'Permission denied' },
    ],
  });
  assert.equal(evalDir.coverage, 'PARTIAL');
  assert.equal(evalDir.verdict, 'BLOCKED');
  assert.match(evalDir.reason, /docs\/ARCHITECTURE\.md/);

  // Case C: unrelated directory outside workspaceRoot does NOT falsely match
  const evalUnrelated = evaluateStateEnvelopeGate(envelope, false, true, {
    expectedSnapshot: 'fixture#digest',
    inputComplete: true,
    requiredChecks: [],
    requiredFiles: ['src/index.ts'],
    workspaceRoot: 'C:/repo',
    observedDenials: [
      { path: 'C:/Temp/src', operation: 'read', reason: 'Permission denied' },
    ],
  });
  assert.equal(evalUnrelated.verdict, 'READY');

  // Case D: pathless policy block forces PARTIAL and BLOCKED
  const evalPolicy = evaluateStateEnvelopeGate(envelope, false, true, {
    expectedSnapshot: 'fixture#digest',
    inputComplete: true,
    requiredChecks: [],
    requiredFiles: ['src/index.ts'],
    workspaceRoot: 'C:/repo',
    observedDenials: [
      { operation: 'commandExecution', reason: 'Blocked by policy' },
    ],
  });
  assert.equal(evalPolicy.coverage, 'PARTIAL');
  assert.equal(evalPolicy.verdict, 'BLOCKED');
  assert.match(evalPolicy.reason, /blocked by policy/i);

  // Case E: pathless filesystem permission denial forces PARTIAL and BLOCKED
  const evalPathless = evaluateStateEnvelopeGate(envelope, false, true, {
    expectedSnapshot: 'fixture#digest',
    inputComplete: true,
    requiredChecks: [],
    requiredFiles: ['src/index.ts'],
    workspaceRoot: 'C:/repo',
    observedDenials: [
      { operation: 'command', reason: 'Permission denied' },
    ],
  });
  assert.equal(evalPathless.coverage, 'PARTIAL');
  assert.equal(evalPathless.verdict, 'BLOCKED');
  assert.match(evalPathless.reason, /Tool execution access was denied: command \(Permission denied\)/i);
});

test('formatExecutionResult reports observed tool denials in footer distinctly and redacts home paths', () => {
  const answer = [
    'REVIEW: 1',
    'SNAPSHOT: fixture#digest',
    'COVERAGE: PARTIAL',
    'VERDICT: BLOCKED',
    'Reviewed: Checked src/index.ts.',
    'Blocked: Filesystem access denied reading docs/ARCHITECTURE.md.',
    'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN',
    'END_REVIEW',
  ].join('\n');

  const absoluteHomePath = path.join(os.homedir(), 'workspace', 'docs', 'ARCHITECTURE.md');

  const formatted = formatExecutionResult(
    'codex',
    {
      status: 'completed',
      isError: false,
      output: answer,
      truncated: false,
      continuationAvailable: true,
      denials: [
        { path: absoluteHomePath, operation: 'read', reason: 'Permission denied' },
      ],
    },
    '',
    'syn_sess_123',
    { turn: 1, toolCount: 2, durationMs: 1500, historyAvailable: true },
    {
      requireEnvelope: true,
      reviewContext: {
        expectedSnapshot: 'fixture#digest',
        inputComplete: true,
        requiredChecks: [],
      },
    }
  );

  const text = formatted.content[0].text;
  assert.ok(!text.includes(os.homedir()), 'raw user home directory is redacted from denial footer');
  assert.match(text, /Denied \(observed from tool events\): read (~|\[HOME\])[/\\]workspace[/\\]docs[/\\]ARCHITECTURE\.md \(Permission denied\)/, 'footer carries redacted denial path');
  assert.ok(text.includes('Verdict: BLOCKED'), 'verdict line retained');
});

test('classifyCodexError classifies sandbox provisioning and backend failures as SANDBOX_UNAVAILABLE', () => {
  const { classifyCodexError } = require('../../src/backends/codex/errors.ts');
  const err1 = classifyCodexError('sandbox backend is unavailable on this system');
  assert.equal(err1.code, 'SANDBOX_UNAVAILABLE');
  assert.equal(err1.retryable, false);

  const err2 = classifyCodexError('sandbox setup failed: provisioning error');
  assert.equal(err2.code, 'SANDBOX_UNAVAILABLE');

  const err3 = classifyCodexError('refusing to run unsandboxed');
  assert.equal(err3.code, 'SANDBOX_UNAVAILABLE');

  // Unrelated stderr containing sandbox and failed in ordinary prose should not match
  const err4 = classifyCodexError('test inside sandbox: assertion failed at line 10');
  assert.equal(err4.code, 'PROCESS_ERROR');
});
