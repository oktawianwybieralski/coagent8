'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-backends-gemini-adapter-'));
process.env.coagent8_DIR = tempDir;
process.env.GEMINI_CLI_HOME = path.join(tempDir, 'original-home');
process.env.GEMINI_PATH = path.resolve(__dirname, '../../fixtures/gemini-cli/gemini.cjs');

const {
  execute,
  execute: executeGemini,
  resolveModelAndEffort,
  parseGeminiUsage,
  probe: probeGemini,
  inspectQuota: inspectGeminiQuota,
} = require('../../../src/backends/gemini/adapter.ts');
const { StreamReducer } = require('../../../src/execution/stream-reducer.ts');
/** The model the controller would select; the adapter never chooses one. */
const MODEL = 'gemini-3.8-flash-high';
const { createGeminiCollector } = require('../../../src/backends/gemini/collector.ts');
const { readResult } = require('../../helpers/result.cjs');

process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('Gemini resolves relative primary and legacy data directories before entering its isolated workspace', async () => {
  const { getDataDir } = require('../../../src/paths.ts');
  const relative = path.relative(process.cwd(), tempDir);
  const cli = process.env.GEMINI_PATH;
  try {
    process.env.coagent8_DIR = relative;
    assert.equal(getDataDir(), tempDir);
    process.env.GEMINI_PATH = path.relative(process.cwd(), cli);
    process.env.coagent8_FIXTURE_CAPTURE = path.join(tempDir, 'relative-capture.json');
    const result = await execute('relative directory', { model: MODEL, cwd: relative });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const capture = JSON.parse(fs.readFileSync(process.env.coagent8_FIXTURE_CAPTURE, 'utf8'));
    assert.ok(capture.args.includes('--add-dir'));
    assert.equal(capture.args[capture.args.indexOf('--add-dir') + 1], tempDir);
    assert.equal(capture.nested, '1', 'agy passes the nested-turn guard to the MCP servers it starts (CUR-002)');
  } finally {
    process.env.coagent8_DIR = tempDir;
    process.env.GEMINI_PATH = cli;
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
  delete process.env.coagent8_FIXTURE_MODE;
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
  const { sessionHistory, getHistoryDir } = require('../../../src/sessions/history.ts');
  const { saveConfig } = require('../../../src/config.ts');
  const original = adapterRegistry.gemini;
  const controller = new AbortController();
  adapterRegistry.gemini = {
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
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const response = await executeTask('partial answer', 'public request', { backend: 'gemini' }, tempDir, controller.signal);
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
    adapterRegistry.gemini = original;
    delete process.env.coagent8_FIXTURE_MODE;
  }
});

test('Gemini collector rejects malformed roles/content, duplicate terminal and total answer overflow', () => {
  const { classifyGeminiError } = require('../../../src/backends/gemini/errors.ts');
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
  const { createGeminiCollector } = require('../../../src/backends/gemini/collector.ts');
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
                remaining_fraction: 0.512,
                reset_time: '2026-10-05T17:31:49Z',
              },
              {
                id: 'gemini-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                remaining_fraction: 0.723,
                reset_time: '2026-10-05T17:35:23Z',
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
  assert.equal(quota.headroomPercent, 51);
  assert.equal(quota.usedPercent, 49);
  assert.equal(quota.resetsAt, '2026-10-05T17:31:49Z');
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
  const { listModels } = require('../../../src/backends/gemini/adapter.ts');
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
  const { parseAgyMcpList, listAgyPlugins, inheritedTools } = require('../../../src/backends/gemini/adapter.ts');
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
