'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-backends-gemini-adapter-'));
process.env.coagent8_DIR = tempDir;
process.env.GEMINI_CLI_HOME = path.join(tempDir, 'original-home');
process.env.AGY_PATH = path.resolve(__dirname, '../../fixtures/agy-cli/agy.cjs');

const {
  execute,
  execute: executeGemini,
  resolveModelAndEffort,
  parseGeminiUsage,
  probe: probeGemini,
  inspectQuota: inspectGeminiQuota,
  probe: probeAgy,
  inspectQuota: inspectAgyQuota,
  listModels: listAgyModels,
  inheritedTools: inheritedAgyTools,
  agyAdapter,
} = require('../../../src/backends/agy/adapter.ts');
const { StreamReducer } = require('../../../src/execution/stream-reducer.ts');
const { ToolError } = require('../../../src/contracts/index.ts');
const { activeProcesses } = require('../../../src/execution/process.ts');
/** The model the controller would select; the adapter never chooses one. */
const MODEL = 'gemini-3.8-flash-high';
const { createGeminiCollector } = require('../../../src/backends/agy/collector.ts');
const { readResult } = require('../../helpers/result.cjs');

async function waitForActiveProcess(timeoutMs = 2000) {
  const start = Date.now();
  while (activeProcesses.size === 0 && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10));
  }
}

process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('Gemini resolves relative primary and legacy data directories before entering its isolated workspace', async () => {
  const { getDataDir } = require('../../../src/paths.ts');
  const relative = path.relative(process.cwd(), tempDir);
  const cli = process.env.AGY_PATH;
  try {
    process.env.coagent8_DIR = relative;
    assert.equal(getDataDir(), tempDir);
    process.env.AGY_PATH = path.relative(process.cwd(), cli);
    process.env.coagent8_FIXTURE_CAPTURE = path.join(tempDir, 'relative-capture.json');
    const result = await execute('relative directory', { model: MODEL, cwd: relative });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const capture = JSON.parse(fs.readFileSync(process.env.coagent8_FIXTURE_CAPTURE, 'utf8'));
    assert.ok(capture.args.includes('--add-dir'));
    assert.equal(capture.args[capture.args.indexOf('--add-dir') + 1], tempDir);
    assert.equal(capture.nested, '1', 'agy passes the nested-turn guard to the MCP servers it starts (CUR-002)');
  } finally {
    process.env.coagent8_DIR = tempDir;
    process.env.AGY_PATH = cli;
    delete process.env.coagent8_FIXTURE_CAPTURE;
  }
});

test('Gemini production adapter uses runner, isolated read-only sandbox, streaming NDJSON and exact UUID resume (fixture)', async () => {
  process.env.coagent8_FIXTURE_CAPTURE = path.join(tempDir, 'capture.json');
  const events = [];
  const first = await execute('zażółć 😀', { cwd: tempDir, model: 'gemini-explicit', onEvent: e => events.push(e) });
  assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.equal(first.model, 'gemini-explicit');
  assert.equal(first.usage.totalTokens, 14);
  assert.ok(first.output.includes('const value = 42;'));
  assert.ok(!first.output.includes('Draft'));
  assert.ok(!first.output.includes('PRIVATE_CHAIN'));
  assert.ok(events.some(e => e.type === 'tool_finished' && e.success));
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_SECRET'));

  const second = await execute('second turn', { model: MODEL, cwd: tempDir, nativeSessionId: first.nativeSessionId });
  assert.equal(second.status, 'completed');
  assert.equal(second.nativeSessionId, first.nativeSessionId);

  const capture = JSON.parse(fs.readFileSync(process.env.coagent8_FIXTURE_CAPTURE, 'utf8'));
  assert.ok(capture.args.includes('--conversation'));
  assert.ok(capture.args.includes(first.nativeSessionId));
  assert.ok(capture.args.includes('--sandbox'));
  assert.ok(capture.args.includes('--output-format'));
  assert.ok(capture.args.includes('stream-json'));
  delete process.env.coagent8_FIXTURE_CAPTURE;
});

test('Gemini protocol errors are authoritative at exit zero and failures have typed codes (fixture)', async () => {
  for (const [mode, code] of [
    ['auth', 'AUTH_REQUIRED'],
    ['model', 'MODEL_UNAVAILABLE'],
    ['rate', 'RATE_LIMITED'],
    ['invalid-session', 'SESSION_INVALID'],
    ['error-exit-zero', 'PROCESS_ERROR'],
    ['no-terminal', 'PROTOCOL_ERROR'],
    ['malformed', 'PROTOCOL_ERROR'],
    ['exit-failed', 'AUTH_REQUIRED'],
  ]) {
    process.env.coagent8_FIXTURE_MODE = mode;
    const result = await execute('request', { model: MODEL, cwd: tempDir });
    assert.equal(result.status, 'failed', mode);
    assert.equal(result.error.code, code, mode);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('fixtureSecret'));
  }

  process.env.coagent8_FIXTURE_MODE = 'wrong-session';
  assert.equal((await execute('request', { model: MODEL, cwd: tempDir, nativeSessionId: '11111111-aaaa-bbbb-cccc-123456789012' })).error.code, 'SESSION_INVALID');

  process.env.coagent8_FIXTURE_MODE = 'rate-before-init';
  const resumedRate = await execute('request', { model: MODEL, cwd: tempDir, nativeSessionId: '11111111-aaaa-bbbb-cccc-123456789012' });
  assert.equal(resumedRate.error.code, 'RATE_LIMITED');
  assert.equal(resumedRate.continuationAvailable, true);
  delete process.env.coagent8_FIXTURE_MODE;

  assert.equal((await execute('request', { model: MODEL, nativeSessionId: 'latest' })).error.code, 'SESSION_INVALID');
  assert.equal((await execute('request', { model: MODEL, reasoningEffort: 'invalid-effort' })).error.code, 'CLI_UNSUPPORTED');

  const validEffort = await execute('request', { model: MODEL, cwd: tempDir, reasoningEffort: 'high' });
  assert.equal(validEffort.status, 'completed');

  process.env.coagent8_FIXTURE_MODE = 'sandbox-denied';
  const warnings = [];
  const deniedRes = await execute('request', { model: MODEL, cwd: tempDir, onEvent: e => { if (e.type === 'warning') warnings.push(e.message); } });
  assert.equal(deniedRes.status, 'completed', 'a denial shows the sandbox works; the answer stays');
  assert.equal(deniedRes.output, 'Answer from the files agy could read.');
  assert.equal(deniedRes.continuationAvailable, true);
  assert.equal(warnings.filter(w => /sandbox denied/.test(w)).length, 1);

  process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-empty';
  const empty = await execute('request', { model: MODEL, cwd: tempDir });
  assert.equal(empty.status, 'failed', 'a denial that ended the turn without an answer is not a completed answer');
  assert.equal(empty.error.code, 'POLICY_DENIED');
  assert.match(empty.error.message, /without an answer after its sandbox denied action command/);
  delete process.env.coagent8_FIXTURE_MODE;
});

test('#92: a workspace-write turn names the denied action and recovers once inside the workspace (fixture)', async () => {
  const capture = path.join(tempDir, 'write-denial-capture.json');
  Object.assign(process.env, { coagent8_FIXTURE_MODE: 'sandbox-denied-recover', coagent8_FIXTURE_DENIED_ACTION: 'read_file', coagent8_FIXTURE_CAPTURE: capture });
  try {
    const warnings = [];
    const recovered = await execute('Change it', { model: MODEL, cwd: tempDir, profile: 'workspace-write', onEvent: e => { if (e.type === 'warning') warnings.push(e.message); } });
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered.error));
    assert.equal(recovered.output, 'Recovered answer from read_file without shell commands.');
    const retry = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.ok(retry.args.includes('--conversation') && !retry.args.includes('--sandbox'), 'the writer retries in its conversation without the sandbox');
    assert.match(retry.prompt, /^Headless mode denied action read_file and your previous turn ended without an answer\./);
    assert.ok(retry.prompt.includes(`inside ${tempDir}, never another checkout`), 'the recovery prompt names the workspace');
    assert.deepEqual(warnings, ['agy headless mode denied action read_file (a workspace-write turn runs no commands and uses files inside the workspace only); the answer may be incomplete.']);

    process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-empty';
    const empty = await execute('Change it', { model: MODEL, cwd: tempDir, profile: 'workspace-write' });
    assert.equal(empty.status, 'failed');
    assert.equal(empty.error.code, 'POLICY_DENIED');
    assert.match(empty.error.message, /after headless mode denied action read_file, including on automatic retry inside the workspace: /);
  } finally {
    for (const key of ['coagent8_FIXTURE_MODE', 'coagent8_FIXTURE_DENIED_ACTION', 'coagent8_FIXTURE_CAPTURE']) delete process.env[key];
  }
});

test('#89: an answer cut off at agy\'s output token limit is a completed, length-limited result (fixture)', async () => {
  try {
    process.env.coagent8_FIXTURE_MODE = 'output-limit';
    const warnings = [];
    const partial = await execute('Answer D1-D6', { model: MODEL, cwd: tempDir, onEvent: e => { if (e.type === 'warning') warnings.push(e.message); } });
    assert.equal(partial.status, 'completed', JSON.stringify(partial.error));
    assert.equal(partial.error, undefined);
    assert.equal(partial.lengthLimited, true);
    assert.equal(partial.output, 'D1: first part of a long answer');
    assert.equal(partial.continuationAvailable, true);
    assert.equal(warnings.filter(w => /output token limit; the answer is incomplete/.test(w)).length, 1);

    process.env.coagent8_FIXTURE_MODE = 'output-limit-empty';
    const empty = await execute('Answer D1-D6', { model: MODEL, cwd: tempDir });
    assert.equal(empty.status, 'failed');
    assert.equal(empty.error.code, 'PROCESS_ERROR');
    assert.match(empty.error.message, /output token limit before it answered\. Ask for a shorter answer in a new session/);
    assert.equal(empty.lengthLimited, true);

    delete process.env.coagent8_FIXTURE_MODE;
    const normal = await execute('request', { model: MODEL, cwd: tempDir });
    assert.equal(normal.lengthLimited, undefined, 'without a reported stop agy reports no stop reason');
  } finally {
    delete process.env.coagent8_FIXTURE_MODE;
  }
});

test('#92: denied action names come from agy reports and stderr, bounded and without operands', () => {
  const collector = createGeminiCollector();
  collector.denySandbox('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.');
  collector.denySandbox('jetski: RunCommand auto-denied by sandbox policy');
  collector.line(JSON.stringify({ event: 'result', result: { conversation_id: '11111111-aaaa-bbbb-cccc-123456789012', status: 'SUCCESS', response: '', denied_actions: [
    { action: 'read_file' }, { action: 'command' }, { action: 'C:\\Users\\name\\secret.txt' }, { action: 'rm -rf /' }, {}, null,
    ...['a1', 'a2', 'a3', 'a4'].map(action => ({ action })),
  ] } }));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.sandboxDenied, true);
  assert.deepEqual(snapshot.deniedActions, ['read_file', 'command', 'a1', 'a2', 'a3'], 'identifiers only, five at most, no paths or command text');
});

test('Gemini deadline preserves a partial public answer (fixture)', async () => {
  process.env.coagent8_FIXTURE_MODE = 'hang';
  const result = await execute('request', { model: MODEL, cwd: tempDir, timeoutMs: 4000 });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.ok(result.output.includes('Markdown'));
  delete process.env.coagent8_FIXTURE_MODE;
});

test('cancelled Gemini partial quoted credentials are redacted in both the public response and durable history', async () => {
  const { adapterRegistry } = require('../../../src/backends/registry.ts');
  const { executeTask } = require('../../../src/execution/controller.ts');
  const { sessionHistory, getHistoryDir } = require('../../../src/sessions/history/index.ts');
  const { saveConfig } = require('../../../src/config.ts');
  const original = adapterRegistry.agy;
  const controller = new AbortController();
  adapterRegistry.agy = {
    ...original,
    execute: (prompt, options) => execute(prompt, {
      ...options,
      onEvent: event => {
        options.onEvent?.(event);
        if (event.type === 'assistant_delta') controller.abort();
      },
    }),
  };
  process.env.coagent8_FIXTURE_MODE = 'secret-hang';
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const response = await executeTask('partial answer', 'public request', { backend: 'agy' }, tempDir, controller.signal);
    assert.equal(readResult(response).status, 'cancelled', JSON.stringify(response));
    assert.ok(readResult(response).answer.includes('REDACTED'));
    assert.ok(!JSON.stringify(response).includes('fixtureSecret'));
    const handle = readResult(response).sessionHandle;
    const page = await sessionHistory(handle, tempDir);
    assert.equal(page.events.filter(e => e.type === 'assistant_message').length, 1);
    assert.equal(page.events.at(-1).status, 'cancelled');
    assert.ok(!JSON.stringify(page).includes('fixtureSecret'));
    assert.ok(!fs.readFileSync(path.join(getHistoryDir(), handle + '.json'), 'utf8').includes('fixtureSecret'));
  } finally {
    adapterRegistry.agy = original;
    delete process.env.coagent8_FIXTURE_MODE;
  }
});

test('Gemini collector rejects malformed roles/content, duplicate terminal and total answer overflow', () => {
  const { classifyGeminiError } = require('../../../src/backends/agy/errors.ts');
  assert.equal(classifyGeminiError('Model report-429.txt not found').code, 'MODEL_UNAVAILABLE');
  assert.equal(classifyGeminiError('Connection failed on port 1429').code, 'PROCESS_ERROR');
  const c = createGeminiCollector();
  assert.throws(() => c.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'private', thought: 'true' })), /metadata/);
  assert.throws(() => c.line(JSON.stringify({ type: 'message', role: 'assistant', content: 4 })), /Invalid/);
  assert.throws(() => c.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'x'.repeat(1024 * 1024 + 1) })), { code: 'BUFFER_LIMIT' });
  const terminal = createGeminiCollector();
  terminal.line(JSON.stringify({ type: 'result', status: 'success' }));
  assert.throws(() => terminal.line(JSON.stringify({ type: 'result', status: 'success' })), /duplicate/);
});

test('Gemini collector ignores an unknown event type with one warning and keeps the answer (AUD-P1-5)', () => {
  const events = [];
  const c = createGeminiCollector(event => events.push(event));
  c.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'answer' }));
  c.line(JSON.stringify({ type: 'progress_heartbeat', detail: 'new in a later agy' }));
  c.line(JSON.stringify({ type: 'progress_heartbeat', detail: 'again' }));
  c.line(JSON.stringify({ type: 'result', status: 'success' }));
  const snapshot = c.snapshot();
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.terminalError, undefined);
  assert.equal(snapshot.output, 'answer');
  assert.deepEqual(events.filter(event => event.type === 'warning').map(event => event.message), ['Ignored unknown Gemini event type: progress_heartbeat']);
  assert.throws(() => c.line(JSON.stringify({ type: 'brand_new', event_id: 'bad\nid' })), /metadata/, 'metadata of an unknown event is still validated');
});

test('Gemini production adapter reports a denial independently of terminal order and rejects real duplicates', async () => {
  try {
    for (const mode of ['sandbox-denied-stderr-first', 'sandbox-denied-stdout-first']) {
      process.env.coagent8_FIXTURE_MODE = mode;
      const warnings = [];
      const result = await execute('synthetic denial request', { model: MODEL, cwd: tempDir, onEvent: e => { if (e.type === 'warning') warnings.push(e.message); } });
      assert.equal(result.status, 'completed', mode);
      assert.equal(result.output, 'Answer from the files agy could read.', mode);
      assert.equal(warnings.filter(w => /sandbox denied/.test(w)).length, 1, mode);
      assert.equal(result.continuationAvailable, true, mode);
      assert.equal(result.nativeSessionId, '11111111-aaaa-bbbb-cccc-123456789012');
    }
    process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-duplicate';
    const duplicate = await execute('synthetic duplicate request', { model: MODEL, cwd: tempDir });
    assert.equal(duplicate.error.code, 'PROTOCOL_ERROR');
    assert.equal(duplicate.continuationAvailable, false);
  } finally { delete process.env.coagent8_FIXTURE_MODE; }
});

test('Gemini (agy) gets a 2 s SIGTERM grace on POSIX to shut down its own commands', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group signals only'); return; }
  const marker = path.join(tempDir, 'agy-clean-shutdown');
  process.env.coagent8_FIXTURE_MODE = 'sigterm-cleanup';
  process.env.coagent8_FIXTURE_MARKER = marker;
  try {
    const controller = new AbortController();
    const result = await execute('request', { model: MODEL, cwd: tempDir, timeoutMs: 15000, abortSignal: controller.signal, onEvent: event => { if (event.type === 'assistant_delta' || event.type === 'assistant_message') controller.abort(); } });
    assert.equal(result.status, 'cancelled');
    // Exit code, signal and the handler marker tell a signal before the handler (SIGTERM, no
    // marker) from a cleanup that outlasted the grace (SIGKILL).
    const exit = `exitCode=${result.exitCode} signal=${result.signal} handlerEntered=${fs.existsSync(`${marker}.received`)}`;
    assert.equal(result.exitCode, 0, exit);
    assert.equal(result.signal, null, exit);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'clean', 'agy finished its SIGTERM cleanup before SIGKILL');
  } finally {
    delete process.env.coagent8_FIXTURE_MODE;
    delete process.env.coagent8_FIXTURE_MARKER;
  }
});

test('prompt is delivered via STDIN and omitted from CLI args', async () => {
  const capturePath = path.join(tempDir, 'capture-stdin.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;

  const testPrompt = 'Synthesize architecture and audit diff boundaries.';
  const result = await executeGemini(testPrompt, { model: MODEL, cwd: tempDir });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(fs.existsSync(capturePath), 'Fixture capture must exist');

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.prompt, testPrompt, 'Prompt must be received by process stdin');
  assert.ok(!capture.args.includes('-p'), 'CLI args must not include -p flag');
  assert.ok(!capture.args.includes('--print'), 'CLI args must not include --print with prompt value');
  assert.ok(!capture.args.includes(testPrompt), 'Prompt text must not be passed in CLI argument vector');

  delete process.env.coagent8_FIXTURE_CAPTURE;
});

test('large prompts exceeding 32KB pass safely via STDIN without CreateProcessW limit crashes', async () => {
  const capturePath = path.join(tempDir, 'capture-large-stdin.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;

  // 64KB prompt - exceeds Windows 32767 chars CreateProcessW command line limit
  const largePrompt = 'A'.repeat(64 * 1024);
  const result = await executeGemini(largePrompt, { model: MODEL, cwd: tempDir });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(fs.existsSync(capturePath));

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.prompt.length, 64 * 1024, 'Full 64KB prompt delivered via stdin');
  assert.ok(!capture.args.includes(largePrompt), 'Large prompt was not in argv');

  delete process.env.coagent8_FIXTURE_CAPTURE;
});

test('resolveModelAndEffort decouples base models from reasoning effort', () => {
  // 1. Explicit effort strips synthetic suffix
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', 'low'), {
    model: 'gemini-3.8-flash',
    effort: 'low',
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', 'high'), {
    model: 'gemini-3.8-flash',
    effort: 'high',
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.7-flash-medium', 'max'), {
    model: 'gemini-3.7-flash',
    effort: 'max',
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.1-pro-low', 'high'), {
    model: 'gemini-3.1-pro',
    effort: 'high',
  });
  assert.deepEqual(resolveModelAndEffort('gpt-oss-120b-medium', 'xhigh'), {
    model: 'gpt-oss-120b',
    effort: 'xhigh',
  });

  // 2. Explicit effort on model without synthetic suffix preserves model
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash', 'medium'), {
    model: 'gemini-3.8-flash',
    effort: 'medium',
  });
  assert.deepEqual(resolveModelAndEffort('claude-sonnet-4-6', 'high'), {
    model: 'claude-sonnet-4-6',
    effort: 'high',
  });

  // 3. Model without effort specified retains its exact name (for catalog matching)
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', undefined), {
    model: 'gemini-3.8-flash-high',
    effort: undefined,
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', null), {
    model: 'gemini-3.8-flash-high',
    effort: undefined,
  });

  // 4. Undefined model with explicit effort
  assert.deepEqual(resolveModelAndEffort(undefined, 'high'), {
    model: undefined,
    effort: 'high',
  });
});

test('execute separates model and effort into distinct CLI arguments', async () => {
  const capturePath = path.join(tempDir, 'capture-model-effort.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;

  await executeGemini('test prompt', {
    cwd: tempDir,
    model: 'gemini-3.8-flash-high',
    reasoningEffort: 'low',
  });

  assert.ok(fs.existsSync(capturePath));
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));

  // Suffix -high was stripped because effort low was explicitly specified
  const modelIdx = capture.args.indexOf('--model');
  assert.ok(modelIdx !== -1, 'Must include --model flag');
  assert.equal(capture.args[modelIdx + 1], 'gemini-3.8-flash', 'Model must have suffix stripped');

  const effortIdx = capture.args.indexOf('--effort');
  assert.ok(effortIdx !== -1, 'Must include --effort flag');
  assert.equal(capture.args[effortIdx + 1], 'low', 'Effort must be low');

  delete process.env.coagent8_FIXTURE_CAPTURE;
});

test('messages exceeding maxMessages set isTruncated and throw in Gemini adapter', async () => {
  const reducer = new StreamReducer({ maxMessages: 3 });
  reducer.upsertMessage('m1', 'first');
  reducer.upsertMessage('m2', 'second');
  reducer.upsertMessage('m3', 'third');
  assert.equal(reducer.isTruncated(), false);

  // 4th message exceeds limit -> rejected and marked truncated
  reducer.upsertMessage('m4', 'fourth');
  assert.equal(reducer.isTruncated(), true);
  assert.equal(reducer.getMessageMap().size, 3);

  // Gemini adapter throws BufferLimitError when exceeding maxMessages public messages
  const { createGeminiCollector } = require('../../../src/backends/agy/collector.ts');
  const collector = createGeminiCollector();
  for (let i = 0; i < 50; i++) {
    collector.line(JSON.stringify({ type: 'message', role: 'assistant', content: `Message ${i}`, message_id: `msg-${i}` }));
  }
  assert.throws(
    () => collector.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'Message 51', message_id: 'msg-51' })),
    /Too many public messages/
  );
});

test('gemini-adapter: parseGeminiUsage parses agy usage groups and computes bottleneck headroom', () => {
  const samplePayload = {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                remaining_fraction: 0.596,
                reset_time: '2026-10-05T18:00:00Z',
              },
              {
                id: 'gemini-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                remaining_fraction: 0.796,
                reset_time: '2026-10-05T16:00:00Z',
              },
            ],
          },
        ],
      },
    },
  };

  const quota = parseGeminiUsage(samplePayload);
  assert.ok(quota);
  assert.equal(quota.measured, true);
  assert.equal(quota.headroomPercent, 60);
  assert.equal(quota.usedPercent, 40);
  assert.equal(quota.resetsAt, '2026-10-05T18:00:00Z');
  assert.equal(quota.window, 'weekly');
  assert.equal(quota.buckets.length, 2);
});

test('Gemini falls back to the requested model when agy omits it from init', async () => {
  process.env.coagent8_FIXTURE_MODE = 'init-without-model';
  try {
    const result = await execute('request', { cwd: tempDir, model: 'gemini-3.8-flash-low' });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.model, 'gemini-3.8-flash-low');
  } finally {
    delete process.env.coagent8_FIXTURE_MODE;
  }
});

test('agy always runs exactly the selected model; the controller, not the adapter, asks for consent (AUD-P1-7)', async () => {
  const capturePath = path.join(tempDir, 'governed-capture.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;
  try {
    const unselected = await execute('request', { cwd: tempDir });
    assert.equal(unselected.error.code, 'INPUT_LIMIT', "agy's interface selection never decides the model");
    assert.equal(fs.existsSync(capturePath), false, 'agy is not launched without a model');
    const plain = await execute('request', { model: MODEL, cwd: tempDir });
    assert.equal(plain.status, 'completed', JSON.stringify(plain));
    const args = JSON.parse(fs.readFileSync(capturePath, 'utf8')).args;
    assert.equal(args[args.indexOf('--model') + 1], MODEL);
    fs.rmSync(capturePath);
    const expensive = 'claude-opus-4-6-thinking';
    const ran = await execute('request', { cwd: tempDir, model: expensive });
    assert.equal(ran.status, 'completed', JSON.stringify(ran));
    const expensiveArgs = JSON.parse(fs.readFileSync(capturePath, 'utf8')).args;
    assert.equal(expensiveArgs[expensiveArgs.indexOf('--model') + 1], expensive);
  } finally {
    delete process.env.coagent8_FIXTURE_CAPTURE;
  }
});

test('agy /usage runs only from quota inspection, sandboxed; probe and execute launch no extra process (AUD-P1-4)', async () => {
  const capture = path.join(tempDir, 'probe-capture.json');
  process.env.coagent8_FIXTURE_CAPTURE = capture;
  try {
    const probed = await probeGemini();
    assert.equal(probed.installed, true);
    assert.equal(probed.quota, undefined, 'the probe makes no /usage call');
    assert.equal(fs.existsSync(capture), false, 'the probe runs only --version, which the fixture answers before capturing');
    const quota = await inspectGeminiQuota(probed);
    assert.equal(quota.measured, true);
    const usageCall = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(usageCall.prompt, '/usage');
    assert.ok(usageCall.args.includes('--sandbox'), 'the quota read is sandboxed like every agy launch');
    fs.rmSync(capture);
    const launches = [];
    const result = await executeGemini('question', { model: MODEL, cwd: tempDir, onEvent: () => {} });
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    launches.push(JSON.parse(fs.readFileSync(capture, 'utf8')));
    assert.ok(!launches[0].args.includes('--version'), 'execute launches the turn directly');
  } finally {
    delete process.env.coagent8_FIXTURE_CAPTURE;
    fs.rmSync(capture, { force: true });
  }
});

test('gemini-adapter: a window without remaining_fraction is unmeasured, not full headroom (AUD-P2-2)', () => {
  const payload = (buckets) => ({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets }] } } });
  assert.equal(parseGeminiUsage(payload([{ id: 'weekly', window: 'weekly' }])), undefined, 'no measured window, no quota');
  const partial = parseGeminiUsage(payload([{ id: 'five-hour', window: '5h' }, { id: 'weekly', window: 'weekly', remaining_fraction: 0.3 }]));
  assert.equal(partial.headroomPercent, 30);
  assert.equal(partial.buckets.length, 1, 'the unmeasured window is not reported');
  assert.equal(parseGeminiUsage('not a payload'), undefined);
});

test('every agy launch disables its auto-updater, whose console window takes the focus on Windows (WINDOWS-001)', async () => {
  const { listModels } = require('../../../src/backends/agy/adapter.ts');
  const log = path.join(tempDir, 'launches.jsonl');
  const inherited = process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
  // agy 1.3.1 honours only 'true'; an inherited '1' must not leave the updater on.
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = '1';
  process.env.coagent8_FIXTURE_LAUNCH_LOG = log;
  try {
    const probed = await probeGemini();
    await inspectGeminiQuota(probed);
    assert.ok(await listModels());
    const result = await executeGemini('question', { model: MODEL, cwd: tempDir, onEvent: () => {} });
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    const launches = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(launches.length, 4, 'probe, quota read, catalog and turn');
    for (const launch of launches) assert.equal(launch.autoUpdate, 'true', JSON.stringify(launch.args));
    assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, '1', 'the server environment is not changed');
  } finally {
    delete process.env.coagent8_FIXTURE_LAUNCH_LOG;
    if (inherited === undefined) delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE;
    else process.env.AGY_CLI_DISABLE_AUTO_UPDATE = inherited;
    fs.rmSync(log, { force: true });
  }
});

test('agy inherited tools: enabled MCP servers from `agy mcp list` and enabled discovered plugins (CUR-002)', async () => {
  const { parseAgyMcpList, listAgyPlugins, inheritedTools } = require('../../../src/backends/agy/adapter.ts');
  // Recorded from agy 1.3.1 (2026-10-07), plus a disabled row.
  assert.deepEqual(parseAgyMcpList('NAME      TYPE   STATUS    COMMAND/URL\ncontext7  stdio  enabled   npx.cmd -y @upstash/context7-mcp\nold       http   disabled  http://127.0.0.1:9/mcp\n'), ['context7']);
  assert.deepEqual(parseAgyMcpList('No MCP servers configured.\n'), []);

  const config = path.join(tempDir, 'agy-config');
  const plugin = (dir, manifest) => { fs.mkdirSync(path.join(config, 'plugins', dir), { recursive: true }); if (manifest) fs.writeFileSync(path.join(config, 'plugins', dir, 'plugin.json'), JSON.stringify(manifest)); };
  assert.deepEqual(listAgyPlugins(config), [], 'no plugins directory');
  plugin('kit', { name: 'kit' });
  plugin('shipped-off', { disabled: true });
  plugin('turned-on', { disabled: true });
  plugin('turned-off', {});
  plugin('not-a-plugin', null);
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ plugins: { 'turned-on': { enabled: true }, 'turned-off': { enabled: false } } }));
  assert.deepEqual(listAgyPlugins(config).sort(), ['kit', 'turned-on']);

  process.env.coagent8_FIXTURE_AGY_MCP = JSON.stringify([['coagent8', 'enabled'], ['context7', 'disabled']]);
  try {
    assert.deepEqual(await inheritedTools(), { mcpServers: ['coagent8'], plugins: [] });
  } finally {
    delete process.env.coagent8_FIXTURE_AGY_MCP;
  }
});

test('EXEC-001-T08e: bound agy reads support backward compatibility when context is omitted', async () => {
  const normalProbe = await probeAgy();
  assert.equal(normalProbe.installed, true);
  const normalQuota = await inspectAgyQuota(normalProbe);
  assert.ok(normalQuota?.measured);
  const normalCatalog = await listAgyModels(normalProbe);
  assert.ok(normalCatalog?.models.length > 0);
  assert.equal(normalCatalog?.source, 'agy models');
  const normalTools = await inheritedAgyTools();
  assert.ok(Array.isArray(normalTools?.mcpServers));
});

test('EXEC-001-T08e: bound agy reads reject pre-aborted signal before launch with 0 spawned processes', async () => {
  const normalProbe = await probeAgy();
  const preController = new AbortController();
  preController.abort();
  await assert.rejects(
    probeAgy({ abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    inspectAgyQuota(normalProbe, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    listAgyModels(normalProbe, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    inheritedAgyTools({ abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    agyAdapter.probe({ abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  assert.equal(activeProcesses.size, 0, 'no process launched for pre-aborted reads');
});

test('EXEC-001-T08e: bound agy reads reject pre-expired budget before launch with 0 spawned processes', async () => {
  const normalProbe = await probeAgy();
  const expiredBudget = { isExecutionExpired: () => true, isTimedOut: () => true, executionSignal: new AbortController().signal };
  await assert.rejects(
    probeAgy({ budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    inspectAgyQuota(normalProbe, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    listAgyModels(normalProbe, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    inheritedAgyTools({ budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  assert.equal(activeProcesses.size, 0, 'no process launched for expired budgets');
});

test('EXEC-001-T08e: stalled agy reads abort via abortSignal, releasing processes and rejecting with ABORTED', async () => {
  const normalProbe = await probeAgy();

  // 1. Probe
  process.env.AGY_FIXTURE_MODE = 'hang-probe';
  try {
    const probeCtrl = new AbortController();
    const probePromise = probeAgy({ abortSignal: probeCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'probe process is running');
    probeCtrl.abort();
    await assert.rejects(probePromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'probe process cleaned up after abort');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // 2. Quota
  process.env.AGY_FIXTURE_MODE = 'hang-usage';
  try {
    const quotaCtrl = new AbortController();
    const quotaPromise = inspectAgyQuota(normalProbe, { abortSignal: quotaCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'quota process is running');
    quotaCtrl.abort();
    await assert.rejects(quotaPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'quota process cleaned up after abort');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // 3. Catalog
  process.env.AGY_FIXTURE_MODE = 'hang-models';
  try {
    const catalogCtrl = new AbortController();
    const catalogPromise = listAgyModels(normalProbe, { abortSignal: catalogCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'catalog process is running');
    catalogCtrl.abort();
    await assert.rejects(catalogPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'catalog process cleaned up after abort');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // 4. Inherited Tools
  process.env.AGY_FIXTURE_MODE = 'hang-mcp';
  try {
    const toolsCtrl = new AbortController();
    const toolsPromise = inheritedAgyTools({ abortSignal: toolsCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'tools process is running');
    toolsCtrl.abort();
    await assert.rejects(toolsPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'tools process cleaned up after abort');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }
});

test('EXEC-001-T08e: stalled agy probe falls back to budget.executionSignal cancellation', async () => {
  process.env.AGY_FIXTURE_MODE = 'hang-probe';
  try {
    const budgetCtrl = new AbortController();
    const liveBudget = { isExecutionExpired: () => false, isTimedOut: () => false, executionSignal: budgetCtrl.signal };
    const budgetProbePromise = probeAgy({ budget: liveBudget });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'probe process is running under budget');
    budgetCtrl.abort();
    await assert.rejects(budgetProbePromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'probe process cleaned up after budget abort');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }
});

test('EXEC-001-T08e: stalled agy reads ended by timeoutMs clean up process without misclassifying authStatus', async () => {
  const normalProbe = await probeAgy();

  // Probe
  process.env.AGY_FIXTURE_MODE = 'hang-probe';
  try {
    const timedOutProbe = await probeAgy({ timeoutMs: 150 });
    assert.equal(timedOutProbe.installed, false);
    assert.equal(timedOutProbe.authStatus, 'unknown', 'timeout does not misclassify auth as unauthenticated');
    assert.equal(activeProcesses.size, 0, 'timed-out probe process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // Quota
  process.env.AGY_FIXTURE_MODE = 'hang-usage';
  try {
    const timedOutQuota = await inspectAgyQuota(normalProbe, { timeoutMs: 150 });
    assert.equal(timedOutQuota, undefined);
    assert.equal(activeProcesses.size, 0, 'timed-out quota process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // Catalog
  process.env.AGY_FIXTURE_MODE = 'hang-models';
  try {
    const timedOutCatalog = await listAgyModels(normalProbe, { timeoutMs: 150 });
    assert.equal(timedOutCatalog, undefined);
    assert.equal(activeProcesses.size, 0, 'timed-out catalog process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // Inherited Tools
  process.env.AGY_FIXTURE_MODE = 'hang-mcp';
  try {
    const timedOutTools = await inheritedAgyTools({ timeoutMs: 150 });
    assert.equal(timedOutTools, undefined);
    assert.equal(activeProcesses.size, 0, 'timed-out tools process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }
});

test('EXEC-001-T08e: stalled agy reads ended by budget expiration during run reject with TIMEOUT', async () => {
  const normalProbe = await probeAgy();

  // Probe
  process.env.AGY_FIXTURE_MODE = 'hang-probe';
  try {
    let expired = false;
    const expCtrl = new AbortController();
    const expBudget = {
      isExecutionExpired: () => expired,
      isTimedOut: () => expired,
      executionSignal: expCtrl.signal,
    };
    const expPromise = probeAgy({ budget: expBudget, timeoutMs: 150 });
    await waitForActiveProcess();
    expired = true;
    expCtrl.abort();
    await assert.rejects(expPromise, err => err instanceof ToolError && err.code === 'TIMEOUT');
    assert.equal(activeProcesses.size, 0, 'expired budget process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // Quota
  process.env.AGY_FIXTURE_MODE = 'hang-usage';
  try {
    let expired = false;
    const expCtrl = new AbortController();
    const expBudget = {
      isExecutionExpired: () => expired,
      isTimedOut: () => expired,
      executionSignal: expCtrl.signal,
    };
    const expPromise = inspectAgyQuota(normalProbe, { budget: expBudget, timeoutMs: 150 });
    await waitForActiveProcess();
    expired = true;
    expCtrl.abort();
    await assert.rejects(expPromise, err => err instanceof ToolError && err.code === 'TIMEOUT');
    assert.equal(activeProcesses.size, 0, 'expired quota budget process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // Catalog
  process.env.AGY_FIXTURE_MODE = 'hang-models';
  try {
    let expired = false;
    const expCtrl = new AbortController();
    const expBudget = {
      isExecutionExpired: () => expired,
      isTimedOut: () => expired,
      executionSignal: expCtrl.signal,
    };
    const expPromise = listAgyModels(normalProbe, { budget: expBudget, timeoutMs: 150 });
    await waitForActiveProcess();
    expired = true;
    expCtrl.abort();
    await assert.rejects(expPromise, err => err instanceof ToolError && err.code === 'TIMEOUT');
    assert.equal(activeProcesses.size, 0, 'expired catalog budget process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }

  // Inherited Tools
  process.env.AGY_FIXTURE_MODE = 'hang-mcp';
  try {
    let expired = false;
    const expCtrl = new AbortController();
    const expBudget = {
      isExecutionExpired: () => expired,
      isTimedOut: () => expired,
      executionSignal: expCtrl.signal,
    };
    const expPromise = inheritedAgyTools({ budget: expBudget, timeoutMs: 150 });
    await waitForActiveProcess();
    expired = true;
    expCtrl.abort();
    await assert.rejects(expPromise, err => err instanceof ToolError && err.code === 'TIMEOUT');
    assert.equal(activeProcesses.size, 0, 'expired tools budget process cleaned up');
  } finally {
    delete process.env.AGY_FIXTURE_MODE;
  }
});

test('Issue #20: agy automatically resumes once when sandbox denies a command with an empty answer and preserves history across reused step_index', async () => {
  const { executeTask } = require('../../../src/execution/controller.ts');
  const { sessionHistory } = require('../../../src/sessions/history/index.ts');
  const { saveConfig } = require('../../../src/config.ts');

  process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-recover';
  try {
    const warnings = [];
    const direct = await execute('Analyze architecture', {
      model: MODEL,
      cwd: tempDir,
      onEvent: e => {
        if (e.type === 'warning') warnings.push(e.message);
      },
    });
    assert.equal(direct.status, 'completed');
    assert.equal(direct.isError, false);
    assert.equal(direct.output, 'Recovered answer from read_file without shell commands.');
    assert.equal(direct.nativeSessionId, '11111111-aaaa-bbbb-cccc-123456789012');
    assert.equal(direct.continuationAvailable, true);
    assert.deepEqual(direct.usage, { source: 'provider', inputTokens: 25, outputTokens: 25, totalTokens: 50 });
    assert.equal(warnings.filter(w => /sandbox denied/.test(w)).length, 1, 'sandbox warning emitted exactly once across initial and recovery turns');

    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const response = await executeTask('Analyze architecture', 'Analyze architecture', { backend: 'agy' }, tempDir);
    const parsed = readResult(response);
    assert.equal(parsed.status, 'completed', JSON.stringify(response));
    assert.equal(parsed.answer, 'Recovered answer from read_file without shell commands.');

    const page = await sessionHistory(parsed.sessionHandle, tempDir);
    const toolStartedIds = page.events.filter(e => e.type === 'tool_started').map(e => e.toolId);
    const toolFinishedIds = page.events.filter(e => e.type === 'tool_finished').map(e => e.toolId);
    assert.deepEqual(toolStartedIds, ['tool-1', 'retry-tool-1'], 'initial and retry tool IDs must not collide when agy reuses step_index');
    assert.deepEqual(toolFinishedIds, ['tool-1', 'retry-tool-1']);

    const assistantMessages = page.events.filter(e => e.type === 'assistant_message');
    assert.deepEqual(
      assistantMessages.map(m => ({ messageId: m.messageId, text: m.text })),
      [
        { messageId: 'msg-2', text: '   ' },
        { messageId: 'retry-msg-2', text: 'Recovered answer from read_file without shell commands.' },
      ],
      'recovered assistant answer must be recorded in durable history without colliding with initial step_index'
    );
    assert.equal(page.events.at(-1).type, 'turn_finished');
    assert.equal(page.events.at(-1).status, 'completed');

    process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-empty';
    const emptyWarnings = [];
    const stillEmpty = await execute('Analyze architecture', {
      model: MODEL,
      cwd: tempDir,
      onEvent: e => {
        if (e.type === 'warning') emptyWarnings.push(e.message);
      },
    });
    assert.equal(stillEmpty.status, 'failed');
    assert.equal(stillEmpty.error.code, 'POLICY_DENIED');
    assert.match(stillEmpty.error.message, /including on automatic retry without shell commands/);
    assert.equal(emptyWarnings.filter(w => /sandbox denied/.test(w)).length, 1, 'sandbox warning emitted once even when retry also fails');

    // Verify retry ID mapper preserves 256-byte UTF-8 bound and distinctness for multibyte and long ASCII IDs
    const { createRetryIdMapper } = require('../../../src/backends/agy/adapter.ts');
    const { validEventIdentifier } = require('../../../src/contracts/index.ts');
    const mapRetryId = createRetryIdMapper(['retry-msg-1']);
    assert.equal(mapRetryId('msg-2'), 'retry-msg-2');
    assert.equal(mapRetryId('msg-2'), 'retry-msg-2', 'same input ID maps deterministically across repeated events');
    assert.equal(mapRetryId('msg-1'), 'retry-id-1', 'avoids colliding with an initial turn ID already named retry-msg-1');

    const multibyte256Bytes = 'é'.repeat(128);
    assert.equal(Buffer.byteLength(multibyte256Bytes, 'utf8'), 256);
    const mappedMultibyte = mapRetryId(multibyte256Bytes);
    assert.ok(validEventIdentifier(mappedMultibyte), `mapped multibyte ID must be valid: ${mappedMultibyte}`);
    assert.equal( mapRetryId(multibyte256Bytes), mappedMultibyte);

    const longAsciiA = `${'a'.repeat(255)}1`;
    const longAsciiB = `${'a'.repeat(255)}2`;
    const mappedA = mapRetryId(longAsciiA);
    const mappedB = mapRetryId(longAsciiB);
    assert.ok(validEventIdentifier(mappedA));
    assert.ok(validEventIdentifier(mappedB));
    assert.notEqual(mappedA, mappedB, 'distinct 256-char IDs differing at the end must not collapse to the same retry ID');
    assert.equal(mapRetryId(longAsciiA), mappedA);
    assert.equal(mapRetryId(longAsciiB), mappedB);

    // Verify omitted timeoutMs resolves DEFAULT_TIMEOUT_MS once and subtracts elapsed time before recovery
    const { DEFAULT_TIMEOUT_MS } = require('../../../src/execution/process.ts');
    process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-recover';
    let fakeNow = 1000;
    const exhaustedDefaultBudget = await execute('Analyze architecture', {
      model: MODEL,
      cwd: tempDir,
      clock: () => fakeNow,
      onEvent: e => {
        if (e.type === 'tool_finished') fakeNow += DEFAULT_TIMEOUT_MS;
      },
    });
    assert.equal(exhaustedDefaultBudget.status, 'failed', 'exhausted default budget during turn 1 skips retry');
    assert.equal(exhaustedDefaultBudget.error.code, 'POLICY_DENIED');
    assert.doesNotMatch(exhaustedDefaultBudget.error.message, /including on automatic retry/);

    process.env.coagent8_FIXTURE_RETRY_HANG = '1';
    let fakeNowHang = 1000;
    const retryTimedOut = await execute('Analyze architecture', {
      model: MODEL,
      cwd: tempDir,
      clock: () => fakeNowHang,
      onEvent: e => {
        if (e.type === 'tool_finished') fakeNowHang += DEFAULT_TIMEOUT_MS - 120;
      },
    });
    assert.equal(retryTimedOut.status, 'timed_out', 'omitted timeoutMs passes remaining default budget to retry');
    assert.equal(retryTimedOut.error.code, 'TIMEOUT');
    delete process.env.coagent8_FIXTURE_RETRY_HANG;

    // Verify a recovery turn that reports a different conversation UUID fails with SESSION_INVALID and disables continuation even when the retry also fails
    process.env.coagent8_FIXTURE_RETRY_WRONG_SESSION = '1';
    for (const retryMode of ['sandbox-denied-empty', 'sandbox-denied-recover']) {
      process.env.coagent8_FIXTURE_MODE = retryMode;
      const mismatchedRetry = await execute('Analyze architecture', { model: MODEL, cwd: tempDir });
      assert.equal(mismatchedRetry.status, 'failed', retryMode);
      assert.equal(mismatchedRetry.error.code, 'SESSION_INVALID', retryMode);
      assert.equal(mismatchedRetry.nativeSessionId, null, retryMode);
      assert.equal(mismatchedRetry.threadId, null, retryMode);
      assert.equal(mismatchedRetry.continuationAvailable, false, retryMode);
    }
  } finally {
    delete process.env.coagent8_FIXTURE_MODE;
    delete process.env.coagent8_FIXTURE_RETRY_HANG;
    delete process.env.coagent8_FIXTURE_RETRY_WRONG_SESSION;
  }
});

test('FEEDBACK-061i: a resumed agy turn without a conversation id keeps the requested id instead of failing', async () => {
  const requestedId = '11111111-aaaa-bbbb-cccc-123456789012';
  process.env.coagent8_FIXTURE_MODE = 'resume-without-conversation-id';
  try {
    const res = await execute('Continue previous analysis', {
      model: MODEL,
      cwd: tempDir,
      nativeSessionId: requestedId,
    });
    assert.equal(res.status, 'completed', JSON.stringify(res.error));
    assert.equal(res.isError, false);
    assert.equal(res.nativeSessionId, requestedId, 'must keep requested session id when agy omits conversation_id');
    assert.equal(res.threadId, requestedId);
    assert.equal(res.continuationAvailable, true);

    const fresh = await execute('New analysis', { model: MODEL, cwd: tempDir });
    assert.equal(fresh.status, 'failed', 'a new turn without a conversation id has no session to continue');
    assert.equal(fresh.error.code, 'PROTOCOL_ERROR');
    assert.equal(fresh.continuationAvailable, false);
  } finally {
    delete process.env.coagent8_FIXTURE_MODE;
  }
});
