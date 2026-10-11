const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupClients, resolveSetupClient } = require('../../src/integrations/setup.ts');
const { resolveCliCommand, clearCliResolverCache } = require('../../src/execution/cli-resolver.ts');
function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-readiness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const log = path.join(home, 'probe.jsonl');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: '', CODEX_PATH: undefined, CLAUDE_PATH: undefined, AGY_PATH: undefined, AGY_PATH: undefined,
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: undefined, CODEX_CONFIG_PATH: undefined, GEMINI_CLI_HOME: undefined,
    coagent8_EXTENSION_PATHS: '{}', SETUP_FIXTURE_HOME: home, SETUP_FIXTURE_PROBE_LOG: log };
  const options = { home, cwd: home, env, statusOnly: true, runtimeSource: 'not-used' };
  return { ...options, log };
}
const fixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
test('no CLI status stays visible and read-only; one standalone authenticated backend suffices', async t => {
  const p = profile(t);
  const missing = await setupClients(p);
  assert.equal(missing.length, 3);
  assert.ok(missing.every(r => !r.installed && !r.ready));
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false);
  const found = await setupClients({ ...p, env: { ...p.env, CLAUDE_PATH: fixture } });
  assert.equal(found.filter(r => r.ready).length, 1);
  assert.equal(found.find(r => r.client === 'claude').authentication, 'authenticated');
  assert.equal(found.find(r => r.client === 'claude').registered, false);
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false);
  const calls = fs.readFileSync(p.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['--version'], ['--help'], ['auth', 'status', '--json']], 'no prompt, installation, login or host registration');
});
test('bad authoritative override does not hide other clients; old/malformed controls fail closed', async t => {
  const p = profile(t);
  const results = await setupClients({ ...p, env: { ...p.env, CODEX_PATH: path.join(p.home, 'missing.exe'), CLAUDE_PATH: fixture } });
  assert.equal(results[0].action, 'blocked');
  assert.equal(results[1].ready, true);
  assert.equal(results[2].action, 'missing');
  for (const extra of [{ SETUP_FIXTURE_VERSION: '2.1.288' }, { SETUP_FIXTURE_HELP: '--output-format' }]) {
    const status = await setupClients({ ...p, env: { ...p.env, CLAUDE_PATH: fixture, ...extra } });
    assert.equal(status[1].compatibility, 'unsupported'); assert.equal(status[1].ready, false);
  }
  const signedOut = await setupClients({ ...p, env: { ...p.env, CLAUDE_PATH: fixture, SETUP_FIXTURE_SIGNED_OUT: '1' } });
  assert.equal(signedOut[1].authentication, 'unauthenticated');
  assert.equal(signedOut[1].ready, false);
});
test('Antigravity-only installation checks controls and sign-in silently without starting a model', async t => {
  const p = profile(t);
  const envLog = path.join(p.home, 'env.jsonl');
  const results = await setupClients({ ...p, env: { ...p.env, AGY_PATH: fixture, SETUP_FIXTURE_ENV_LOG: envLog } });
  assert.equal(results[2].installed, true);
  assert.equal(results[2].compatibility, 'supported');
  assert.equal(results[2].authentication, 'authenticated');
  assert.equal(results[2].ready, true);
  assert.doesNotMatch(JSON.stringify(results), /fixture@example/, 'the signed-in account is not reported');
  assert.deepEqual(fs.readFileSync(p.log, 'utf8').trim().split('\n').map(JSON.parse), [['--version'], ['--help'], []], 'no prompt, -p or login');
  const calls = fs.readFileSync(envLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.autoUpdate === 'true'), 'every agy probe disables its console-opening updater');
  assert.deepEqual(calls.map(call => call.auth), [null, null, 'check']);
  const signedOut = await setupClients({ ...p, env: { ...p.env, AGY_PATH: fixture, SETUP_FIXTURE_SIGNED_OUT: '1' } });
  assert.equal(signedOut[2].authentication, 'unauthenticated');
  assert.equal(signedOut[2].ready, false);
  // Any other failure, such as a token refresh without network, is not evidence of sign-out.
  const unclear = await setupClients({ ...p, env: { ...p.env, AGY_PATH: fixture, SETUP_FIXTURE_AUTH_ERROR: '1' } });
  assert.equal(unclear[2].authentication, 'unknown');
  // agy 1.3.1 writes its help to stderr with exit code 0.
  const stderrHelp = await setupClients({ ...p, env: { ...p.env, AGY_PATH: fixture, SETUP_FIXTURE_HELP_STDERR: '1' } });
  assert.equal(stderrHelp[2].compatibility, 'supported');
});
test('Codex-only readiness initializes app-server without a thread/model turn and separates sign-in', async t => {
  const p = profile(t);
  const results = await setupClients({ ...p, env: { ...p.env, CODEX_PATH: fixture } });
  assert.equal(results[0].ready, true);
  assert.equal(results[0].registered, false);
  const calls = fs.readFileSync(p.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(args => args[0]), ['--version', '--help', 'app-server', 'login']);
  assert.ok(calls[2].includes('sandbox_mode="read-only"'));
  assert.equal(fs.existsSync(path.join(p.home, 'baseline-config')), false, 'metadata handshake did not start a host thread');
  const signedOut = await setupClients({ ...p, env: { ...p.env, CODEX_PATH: fixture, SETUP_FIXTURE_SIGNED_OUT: '1' } });
  assert.equal(signedOut[0].authentication, 'unauthenticated');
  assert.equal(signedOut[0].ready, false);
});
test('registration errors do not erase independently verified CLI presence or sign-in', async t => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.home, '.claude.json'), '{broken');
  const results = await setupClients({ ...p, env: { ...p.env, CLAUDE_PATH: fixture } });
  assert.equal(results[1].installed, true);
  assert.equal(results[1].ready, true);
  assert.equal(results[1].action, 'blocked');
});
test('actual custom extension paths reach shared runtime resolution and update/removal never pins vendor paths', t => {
  const p = profile(t);
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  function bundle(root) { const file = path.join(root, 'resources/native-binary', executable); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic'); fs.chmodSync(file, 0o755); return file; }
  const oldRoot = path.join(p.home, 'custom root', 'v1'), nextRoot = path.join(p.home, 'another root', 'v2');
  const first = bundle(oldRoot), second = bundle(nextRoot);
  const env = root => ({ ...p.env, coagent8_EXTENSION_PATHS: JSON.stringify({ claude: root }) });
  assert.equal(resolveSetupClient('claude', p.home, env(oldRoot)).command, first);
  assert.equal(resolveCliCommand('claude', { env: env(nextRoot) }).command, second);
  fs.rmSync(second);
  assert.equal(resolveSetupClient('claude', p.home, env(nextRoot)), null, 'removed active extension cannot use an older inactive path');
  assert.equal(resolveSetupClient('claude', p.home, p.env), null);
  clearCliResolverCache();
  assert.throws(() => resolveSetupClient('claude', p.home, { ...p.env, coagent8_EXTENSION_PATHS: 'invalid-json' }), /cannot be resolved/);
});
test('custom Codex extension paths and cached standalone removal are revalidated', t => {
  const p = profile(t);
  const family = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const root = path.join(p.home, 'custom OpenAI extension');
  const file = path.join(root, 'bin', `${family}-${arch}`, executable);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic'); fs.chmodSync(file, 0o755);
  const env = { ...p.env, coagent8_EXTENSION_PATHS: JSON.stringify({ codex: root }) };
  assert.equal(resolveSetupClient('codex', p.home, env).command, file);
  fs.rmSync(file);
  assert.equal(resolveSetupClient('codex', p.home, env), null);
  const script = path.join(p.home, 'standalone.cjs'); fs.writeFileSync(script, 'synthetic');
  // A script runs from its canonical path (npm shims are links; macOS /var is /private/var).
  assert.equal(resolveCliCommand(script).argsPrefix[0], fs.realpathSync(script));
  fs.rmSync(script);
  assert.throws(() => resolveCliCommand(script), /not installed/);
});
