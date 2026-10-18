const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScenarios, chooseModel, NotRun } = require('../../tooling/acceptance/scenarios.cjs');

const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'dist', 'index.cjs');

// The fixture lane runs every scenario through the built runtime with the Codex double; it
// proves the scenario logic and the server behavior, not native sign-in or a real model.
test('ACCEPT-001a2: scenarios N2-N4 pass through the built runtime with the Codex fixture', { skip: !fs.existsSync(entry) && 'dist/index.cjs is not built' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-scenarios-'));
  try {
    const steps = [];
    const record = async (id, name, backend, fn) => {
      try { const res = await fn(); steps.push({ id, backend, status: 'PASS', details: res?.details }); }
      catch (error) { steps.push({ id, backend, status: error instanceof NotRun ? 'NOT_RUN' : 'FAIL', error: error.message }); }
    };
    const env = { ...process.env, coagent8_DIR: path.join(work, 'coagent8'), CODEX_HOME: path.join(work, 'codex'), CODEX_FIXTURE_MODE: 'acceptance' };
    await runScenarios({ entry, env, slowEnv: { CODEX_FIXTURE_MODE: 'acceptance-slow' }, workRoot: path.join(work, 'scenarios'), backends: ['codex'], record, timeoutProbeMs: 100 });
    const status = Object.fromEntries(steps.map(step => [step.id, step.status]));
    const failures = steps.filter(step => step.status === 'FAIL');
    assert.deepEqual(failures, [], 'no scenario fails');
    for (const id of ['n2_doctor', 'n2_health_codex', 'n2_consult_codex', 'n3_continuation_codex', 'n3_history_codex', 'n3_isolation_codex', 'n2_review_codex', 'n3_repeat_codex', 'n4_cancel_codex', 'n3_close']) {
      assert.equal(status[id], 'PASS', id);
    }
    // A fixture turn can beat a 100 ms deadline on a fast machine; that is NOT_RUN, never PASS.
    assert.ok(['PASS', 'NOT_RUN'].includes(status.n2_timeout_codex));
    assert.equal(status.n2_quiet, 'NOT_RUN', 'a console window cannot be observed headless');
    assert.match(steps.find(step => step.id === 'n4_cancel_codex').details, /other server refused; lease released; reused/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ACCEPT-001a2: backend sign-in reaches a scenario server only on request, in place and at the configured roots', () => {
  const { scenarioBackendEnv, resolveBackendCommands } = require('../../tooling/acceptance/backends.cjs');
  const home = path.join(os.tmpdir(), 'real-home');
  const commands = { codex: { command: path.join(home, 'codex.exe') }, claude: { command: null, reason: 'missing' }, agy: { command: path.join(home, 'agy.exe') } };
  assert.deepEqual(scenarioBackendEnv(commands, { withBackendAuth: false, parentEnv: {}, realHome: home }), { CODEX_PATH: commands.codex.command, AGY_PATH: commands.agy.command }, 'without the flag only the CLI paths pass');
  assert.deepEqual(scenarioBackendEnv(commands, { withBackendAuth: true, parentEnv: { codex_home: path.join(home, 'custom-codex') }, realHome: home }), {
    CODEX_PATH: commands.codex.command,
    AGY_PATH: commands.agy.command,
    CODEX_HOME: path.join(home, 'custom-codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GEMINI_CLI_HOME: home,
  }, 'the user\'s roots are used in place, a configured one first');
  // The test environment points every CLI at a fixture through *_PATH.
  const resolved = resolveBackendCommands(process.env, os.homedir());
  for (const id of ['codex', 'claude', 'agy']) assert.ok(resolved[id].command && path.isAbsolute(resolved[id].command), id);
});

test('ACCEPT-001a2: a scenario uses the backend default, the operator\'s model, or with --cheapest the cheapest verified price', () => {
  const models = { selection: [
    { backend: 'agy', model: 'pricey', efforts: ['low'], price: { outputUsdPerMTok: 30 }, approval: { required: true } },
    { backend: 'agy', model: 'standard', defaultSource: 'first-listed', efforts: [], price: { outputUsdPerMTok: 5 }, approval: { required: false } },
    { backend: 'agy', model: 'cheap', efforts: ['high', 'medium'], price: { outputUsdPerMTok: 1 }, approval: { required: false } },
    { backend: 'agy', model: 'unpriced', efforts: [], price: null, approval: { required: false } },
    { backend: 'agy', model: 'denied', efforts: [], price: { outputUsdPerMTok: 0.1 }, approval: { required: false, denied: true } },
    { backend: 'claude', model: 'opus', defaultSource: 'catalog', efforts: [], price: null, approval: { required: true } },
  ] };
  const health = { backends: { agy: { models: [{ id: 'cheap', effortRequired: true }] } } };
  // What a user gets with auto: the server resolves the default, so the call omits the model.
  assert.deepEqual(chooseModel('agy', models, health), { model: 'standard', serverDefault: true, source: 'backend default (first-listed)' });
  assert.match(chooseModel('claude', models, health).error, /needs approval, which the runner never grants/);
  assert.match(chooseModel('codex', models, health).error, /names no codex default model/);
  assert.deepEqual(chooseModel('agy', models, health, undefined, true), { model: 'cheap', effort: 'medium', source: 'lowest verified output price (1 USD/M)' });
  assert.match(chooseModel('codex', models, health, undefined, true).error, /no codex model with a verified price/);
  assert.equal(chooseModel('agy', models, health, 'pricey').source, 'operator');
});

test('ACCEPT-001a2: a server whose handshake fails is stopped before the error is reported', async () => {
  const { connectMcp } = require('../../tooling/acceptance/mcp-client.cjs');
  // A process that never answers and ignores the end of its stdin.
  const started = Date.now();
  await assert.rejects(connectMcp({ command: process.execPath, args: ['-e', 'process.stdin.on("end", () => {}); setInterval(() => {}, 1000);'], initTimeoutMs: 300, closeGraceMs: 300 }), /initialize timed out/);
  assert.ok(Date.now() - started < 10_000, 'the supervisor stopped the server after the grace period');
  // A server that answers initialize with a null result is stopped as well.
  const nullResult = 'process.stdin.on("data", d => { const m = JSON.parse(String(d).split("\\n")[0]); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: null }) + "\\n"); }); setInterval(() => {}, 1000);';
  await assert.rejects(connectMcp({ command: process.execPath, args: ['-e', nullResult], initTimeoutMs: 2000, closeGraceMs: 300 }), /invalid initialize result/);
});

test('ACCEPT-001a2: a CLI only the vendor installed is found in the parent context, as the runtime finds it', () => {
  const { resolveBackendCommands } = require('../../tooling/acceptance/backends.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-vendor-home-'));
  try {
    const agy = path.join(home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.mkdirSync(path.dirname(agy), { recursive: true });
    fs.writeFileSync(agy, '');
    fs.chmodSync(agy, 0o755);
    const resolved = resolveBackendCommands({ PATH: '' }, home);
    assert.equal(resolved.agy.command, agy, 'the managed agy installation');
    assert.equal(resolved.codex.command, null);
    assert.match(resolved.codex.reason, /not found in its configuration, on the parent PATH or as a vendor copy/);
    // An explicit override that does not resolve never falls back to another installation.
    for (const override of ['missing-agy', path.join('missing', 'agy.exe')]) {
      assert.equal(resolveBackendCommands({ PATH: '', AGY_PATH: override }, home).agy.command, null, override);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ACCEPT-001a2: with backend sign-in only the observed backend cache key may change in the real home', () => {
  const { snapshotWatchlist, verifyHomePreservation } = require('../../tooling/acceptance/runner.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-preservation-'));
  try {
    const file = path.join(home, '.claude.json');
    const write = value => fs.writeFileSync(file, JSON.stringify(value));
    write({ mcpServers: { coagent8: { command: 'node' } }, cachedGrowthBookFeaturesAt: 1 });
    let snapshot = snapshotWatchlist([file]);
    write({ mcpServers: { coagent8: { command: 'node' } }, cachedGrowthBookFeaturesAt: 2 });
    assert.deepEqual(verifyHomePreservation(snapshot, true), ['.claude.json (cachedGrowthBookFeaturesAt)']);
    assert.throws(() => verifyHomePreservation(snapshot, false), /top-level keys changed: cachedGrowthBookFeaturesAt/, 'without backend sign-in nothing may change');
    snapshot = snapshotWatchlist([file]);
    write({ mcpServers: {}, cachedGrowthBookFeaturesAt: 3 });
    assert.throws(() => verifyHomePreservation(snapshot, true), /top-level keys changed: cachedGrowthBookFeaturesAt, mcpServers/, 'a registration change always fails');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ACCEPT-001a2: a late response to a timed-out request is dropped and the client keeps working', async () => {
  const { connectMcp } = require('../../tooling/acceptance/mcp-client.cjs');
  const server = [
    'let buffer = "";',
    'const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
    'process.stdin.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);',
    '  if (m.method === "initialize") reply(m.id, { protocolVersion: "2025-06-18", serverInfo: { name: "fixture" }, capabilities: {} });',
    '  else if (m.method === "slow") setTimeout(() => reply(m.id, { late: true }), 400);',
    '  else if (m.id != null) reply(m.id, { ok: true }); } });',
    'process.stdin.on("end", () => process.exit(0));',
  ].join('\n');
  const client = await connectMcp({ command: process.execPath, args: ['-e', server], closeGraceMs: 300 });
  try {
    await assert.rejects(client.request('slow', {}, { timeoutMs: 100 }), /timed out/);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(await client.request('fast', {}), { ok: true }, 'the late response did not close the client');
  } finally {
    await client.close();
  }
});
