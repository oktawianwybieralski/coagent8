const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-gemini-'));
process.env.coagent8_DIR = dir;
process.env.GEMINI_CLI_HOME = path.join(dir, 'original-home');
process.env.GEMINI_PATH = path.resolve(__dirname, 'fixtures/gemini-cli/gemini.cjs');
const { execute, createGeminiCollector } = require('../src/backends/gemini.adapter.ts');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Gemini resolves relative primary and legacy data directories before entering its isolated workspace', async () => {
  const { getDataDir } = require('../src/paths.ts');
  const relative = path.relative(process.cwd(), dir);
  const cli = process.env.GEMINI_PATH;
  try {
    process.env.coagent8_DIR = relative;
    assert.equal(getDataDir(), dir);
    process.env.GEMINI_PATH = path.relative(process.cwd(), cli);
    process.env.coagent8_FIXTURE_CAPTURE = path.join(dir, 'relative-capture.json');
    const result = await execute('relative directory', { cwd: relative });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    const capture = JSON.parse(fs.readFileSync(process.env.coagent8_FIXTURE_CAPTURE, 'utf8'));
    assert.ok(capture.args.includes('--add-dir'));
    assert.equal(capture.args[capture.args.indexOf('--add-dir') + 1], dir);
  } finally {
    process.env.coagent8_DIR = dir;
    process.env.GEMINI_PATH = cli;
    delete process.env.coagent8_FIXTURE_CAPTURE;
  }
});

test('Gemini production adapter uses runner, isolated read-only sandbox, streaming NDJSON and exact UUID resume (fixture)', async () => {
  process.env.coagent8_FIXTURE_CAPTURE = path.join(dir, 'capture.json');
  const events = [];
  const first = await execute('zażółć 😀', { cwd: dir, model: 'gemini-explicit', onEvent: e => events.push(e) });
  assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.equal(first.model, 'gemini-explicit');
  assert.equal(first.usage.totalTokens, 14);
  assert.ok(first.output.includes('const value = 42;'));
  assert.ok(!first.output.includes('Draft'));
  assert.ok(!first.output.includes('PRIVATE_CHAIN'));
  assert.ok(events.some(e => e.type === 'tool_finished' && e.success));
  assert.ok(!JSON.stringify(events).includes('SYNTHETIC_SECRET'));

  const second = await execute('second turn', { cwd: dir, nativeSessionId: first.nativeSessionId });
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
    const result = await execute('request', { cwd: dir });
    assert.equal(result.status, 'failed', mode);
    assert.equal(result.error.code, code, mode);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('fixtureSecret'));
  }

  process.env.coagent8_FIXTURE_MODE = 'wrong-session';
  assert.equal((await execute('request', { cwd: dir, nativeSessionId: '11111111-aaaa-bbbb-cccc-123456789012' })).error.code, 'SESSION_INVALID');

  process.env.coagent8_FIXTURE_MODE = 'rate-before-init';
  const resumedRate = await execute('request', { cwd: dir, nativeSessionId: '11111111-aaaa-bbbb-cccc-123456789012' });
  assert.equal(resumedRate.error.code, 'RATE_LIMITED');
  assert.equal(resumedRate.continuationAvailable, true);
  delete process.env.coagent8_FIXTURE_MODE;

  assert.equal((await execute('request', { nativeSessionId: 'latest' })).error.code, 'SESSION_INVALID');
  assert.equal((await execute('request', { reasoningEffort: 'invalid-effort' })).error.code, 'CLI_UNSUPPORTED');

  const validEffort = await execute('request', { cwd: dir, reasoningEffort: 'high' });
  assert.equal(validEffort.status, 'completed');

  process.env.coagent8_FIXTURE_MODE = 'sandbox-denied';
  const deniedRes = await execute('request', { cwd: dir });
  assert.equal(deniedRes.status, 'failed');
  assert.equal(deniedRes.error.code, 'SANDBOX_UNAVAILABLE');
  assert.equal(deniedRes.continuationAvailable, false);
  delete process.env.coagent8_FIXTURE_MODE;
});

test('Gemini deadline preserves a partial public answer (fixture)', async () => {
  process.env.coagent8_FIXTURE_MODE = 'hang';
  const result = await execute('request', { cwd: dir, timeoutMs: 4000 });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error.code, 'TIMEOUT');
  assert.ok(result.output.includes('Markdown'));
  delete process.env.coagent8_FIXTURE_MODE;
});

test('cancelled Gemini partial quoted credentials are redacted in both the public response and durable history', async () => {
  const { adapterRegistry } = require('../src/backends/registry.ts');
  const { executeTask } = require('../src/execution/controller.ts');
  const { sessionHistory, getHistoryDir } = require('../src/sessions/history.ts');
  const { saveConfig } = require('../src/config.ts');
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
    const response = await executeTask('partial answer', 'public request', { backend: 'gemini' }, dir, controller.signal);
    assert.equal(response.structuredContent.status, 'cancelled', JSON.stringify(response));
    assert.ok(response.structuredContent.output.includes('REDACTED'));
    assert.ok(!JSON.stringify(response).includes('fixtureSecret'));
    const handle = response.structuredContent.sessionHandle;
    const page = await sessionHistory(handle, dir);
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
  const { classifyGeminiError } = require('../src/backends/gemini.adapter.ts');
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

test('Gemini production adapter preserves denial independently of terminal order and rejects real duplicates', async () => {
  try {
    for (const mode of ['sandbox-denied-stderr-first', 'sandbox-denied-stdout-first']) {
      process.env.coagent8_FIXTURE_MODE = mode;
      const result = await execute('synthetic denial request', { cwd: dir });
      assert.equal(result.status, 'failed', mode);
      assert.equal(result.error.code, 'SANDBOX_UNAVAILABLE', mode);
      assert.equal(result.continuationAvailable, false, mode);
      assert.equal(result.nativeSessionId, '11111111-aaaa-bbbb-cccc-123456789012');
    }
    process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-duplicate';
    const duplicate = await execute('synthetic duplicate request', { cwd: dir });
    assert.equal(duplicate.error.code, 'PROTOCOL_ERROR');
    assert.equal(duplicate.continuationAvailable, false);
  } finally { delete process.env.coagent8_FIXTURE_MODE; }
});
