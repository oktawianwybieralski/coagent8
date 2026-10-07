const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupClients, resolveSetupClient } = require('../../src/integrations/setup.ts');
const { parse } = require('jsonc-parser');
const { parse: toml } = require('smol-toml');
const { hasManualVscodeRegistration } = require('../../src/integrations/vscode-profile.ts');
const source = path.resolve(__dirname, '../../dist/index.cjs');
function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-setup-'));
  const cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CODEX_PATH: cli, CLAUDE_PATH: cli, AGY_PATH: cli, coagent8_DIR: path.join(home, '.coagent8'),
    SETUP_FIXTURE_HOME: home, GEMINI_CLI_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_CONFIG_PATH: undefined,
  };
  return { home, cwd, env, runtimeSource: source, clients: ['codex', 'claude', 'agy'] };
}
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
test('shared setup installs selected clients, preserves comments/secrets, and repair is idempotent', async t => {
  const options = profile(t);
  const codex = path.join(options.home, '.codex/config.toml');
  const agy = path.join(options.home, '.gemini/config/mcp_config.json');
  const claude = path.join(options.home, '.claude.json');
  write(codex, '# retained comment\nmodel = "synthetic"\n[mcp_servers.other]\ncommand = "synthetic-other"\nargs = []\n');
  const jsonc = '{\n // retained comment\n "inputs": [{"id":"keep"}],\n "token":"synthetic-secret",\n "mcpServers": {"other":{"command":"keep","args":[]}},\n}\n';
  write(agy, jsonc); write(claude, jsonc);
  const first = await setupClients(options);
  assert.ok(first.every(result => result.action === 'installed'), JSON.stringify(first));
  assert.ok(first.every(result => result.runtimeCallable));
  assert.equal(first[0].hostCallable, true);
  assert.ok(first.slice(1).every(result => !result.hostCallable));
  assert.ok(!JSON.stringify(first).includes('synthetic-secret'));
  for (const file of [agy, claude]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('// retained comment'));
    assert.equal(parse(text).token, 'synthetic-secret');
    assert.deepEqual(parse(text).inputs, [{ id: 'keep' }]);
    assert.equal(parse(text).mcpServers.other.command, 'keep');
  }
  assert.equal(toml(fs.readFileSync(codex, 'utf8')).mcp_servers.other.command, 'synthetic-other');
  assert.equal(toml(fs.readFileSync(codex, 'utf8')).mcp_servers.coagent8.tool_timeout_sec, 1800, 'reviews outlast the 60 s Codex default');
  assert.ok(fs.readFileSync(codex, 'utf8').includes('# retained comment'));
  const snapshot = [codex, agy, claude].map(file => fs.readFileSync(file, 'utf8'));
  const second = await setupClients({ ...options, clients: undefined });
  assert.ok(second.every(result => result.action === 'preserved'), JSON.stringify(second));
  assert.deepEqual([codex, agy, claude].map(file => fs.readFileSync(file, 'utf8')), snapshot);
  assert.ok(fs.existsSync(path.join(options.home, '.coagent8/setup.json')));
});
test('manual registrations are verified and retained while new candidates use immutable owned paths', async t => {
  const options = profile(t);
  const file = path.join(options.home, '.claude.json');
  const manual = JSON.stringify({ mcpServers: { coagent8: { command: process.execPath, args: [source], env: { coagent8_DIR: path.join(options.home, '.coagent8') } } } });
  write(file, manual);
  const result = await setupClients({ ...options, clients: ['claude'] });
  assert.equal(result[0].action, 'preserved');
  assert.equal(result[0].runtimeCallable, true);
  assert.equal(fs.readFileSync(file, 'utf8'), manual);
  const state = JSON.parse(fs.readFileSync(path.join(options.home, '.coagent8/setup.json'), 'utf8'));
  assert.deepEqual(state.owned, {});
});

test('new native-host registrations retain the explicitly selected configuration file', async t => {
  const options = profile(t);
  const config = path.join(options.home, 'custom configuration.json');
  write(config, JSON.stringify(require('../../src/config.ts').validateConfig({ defaultBackend: 'gemini' })));
  options.env.coagent8_CONFIG = config;
  const results = await setupClients(options);
  assert.ok(results.every(result => result.action === 'installed'), JSON.stringify(results));
  const codex = toml(fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8')).mcp_servers.coagent8;
  const claude = parse(fs.readFileSync(path.join(options.home, '.claude.json'), 'utf8')).mcpServers.coagent8;
  const agy = parse(fs.readFileSync(path.join(options.home, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers.coagent8;
  for (const entry of [codex, claude, agy]) assert.equal(entry.env.coagent8_CONFIG, config);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).defaultBackend, 'gemini');
  const nextConfig = path.join(options.home, 'replacement configuration.json');
  write(nextConfig, JSON.stringify(require('../../src/config.ts').validateConfig({ defaultBackend: 'codex' })));
  options.env.coagent8_CONFIG = nextConfig;
  const repaired = await setupClients(options);
  assert.equal(repaired[0].action, 'updated', JSON.stringify(repaired));
  assert.ok(repaired.slice(1).every(result => result.action === 'preserved'), 'unverified native-host updates must remain deferred');
  assert.equal(toml(fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8')).mcp_servers.coagent8.env.coagent8_CONFIG, nextConfig);
});
test('malformed, duplicate-key, workspace shadow, and independently edited settings are never overwritten', async t => {
  const options = profile(t);
  const file = path.join(options.home, '.claude.json');
  for (const input of ['{"token":"synthetic-secret", bad}', '{"mcpServers":{},"mcpServers":{}}']) {
    write(file, input);
    const result = await setupClients({ ...options, clients: ['claude'] });
    assert.equal(result[0].action, 'blocked');
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    assert.equal(fs.readFileSync(file, 'utf8'), input);
  }
  write(file, '{}');
  write(path.join(options.cwd, '.mcp.json'), '{"mcpServers":{"coagent8":{"command":"keep","args":[]}}}');
  assert.equal((await setupClients({ ...options, clients: ['claude'] }))[0].action, 'blocked');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});
test('native failed replacement rolls back exact original config and preserves concurrent unrelated edits', async t => {
  const options = { ...profile(t), clients: ['codex'] };
  const initial = await setupClients(options);
  assert.equal(initial[0].action, 'installed', JSON.stringify(initial));
  const file = path.join(options.home, '.codex/config.toml');
  const before = fs.readFileSync(file, 'utf8');
  const updatedSource = path.join(options.home, 'updated.cjs');
  fs.writeFileSync(updatedSource, fs.readFileSync(source, 'utf8') + '\n// synthetic update\n');
  options.env.SETUP_FIXTURE_FAIL_CANDIDATE = '1';
  const result = await setupClients({ ...options, runtimeSource: updatedSource });
  assert.equal(result[0].action, 'blocked', JSON.stringify(result));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const oldRuntime = toml(before).mcp_servers.coagent8.args[0];
  assert.ok(fs.existsSync(oldRuntime));
  options.env.SETUP_FIXTURE_CONCURRENT_EDIT = '1';
  const concurrent = await setupClients({ ...options, runtimeSource: updatedSource });
  assert.equal(concurrent[0].action, 'blocked', JSON.stringify(concurrent));
  const recovered = toml(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(recovered.mcp_servers.coagent8, toml(before).mcp_servers.coagent8);
  assert.ok(recovered.unrelated, JSON.stringify(concurrent));
  assert.equal(recovered.unrelated.secret, 'synthetic-concurrent-secret');
  assert.equal(concurrent[0].registered, true);
  assert.equal(concurrent[0].hostCallable, true);
});
test('setup status is read-only and custom remote/profile roots fail before mutation', async t => {
  const options = profile(t);
  const result = await setupClients({ ...options, statusOnly: true });
  // An installed CLI without a CoAgent8 entry is `not-registered`, never reported as a missing CLI.
  assert.ok(result.every(item => !item.registered && item.action === (item.installed ? 'not-registered' : 'missing')));
  assert.ok(result.some(item => item.installed), 'the fixture profile has installed CLIs');
  assert.equal(fs.existsSync(path.join(options.home, '.coagent8')), false);
  await assert.rejects(setupClients({ ...options, env: { ...options.env, CODEX_HOME: path.join(options.home, 'other') } }), /profile/);
  assert.equal(fs.existsSync(path.join(options.home, '.coagent8')), false);
});
test('Claude extension fallback resolves newest usable installed version on each call', t => {
  const { home } = profile(t);
  const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const file = version => path.join(home, '.vscode/extensions', `anthropic.claude-code-${version}`, 'resources/native-binary', executable);
  for (const version of ['2.1.9', '2.1.10']) { write(file(version), 'synthetic'); fs.chmodSync(file(version), 0o755); }
  const env = { PATH: '', PATHEXT: '.EXE' };
  assert.equal(resolveSetupClient('claude', home, env).command, file('2.1.10'));
  fs.rmSync(file('2.1.10'));
  assert.equal(resolveSetupClient('claude', home, env).command, file('2.1.9'));
});

test('Codex extension fallback works without PATH, follows updates, and preserves explicit overrides', t => {
  const { home } = profile(t);
  const family = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const file = version => path.join(home, '.vscode/extensions', `openai.chatgpt-${version}`, 'bin', `${family}-${arch}`, executable);
  for (const version of ['26.9.99', '26.10.1']) { write(file(version), 'synthetic'); fs.chmodSync(file(version), 0o755); }
  const env = { PATH: '', PATHEXT: '.EXE' };
  assert.equal(resolveSetupClient('codex', home, env).command, file('26.10.1'));
  const { resolveCliCommand } = require('../../src/execution/cli-resolver.ts');
  assert.equal(resolveCliCommand('codex', { env: { ...env, HOME: home, USERPROFILE: home } }).command, file('26.10.1'), 'runtime resolution uses the same fallback');
  const standalone = path.join(home, 'standalone', executable);
  write(standalone, 'synthetic'); fs.chmodSync(standalone, 0o755);
  assert.equal(resolveSetupClient('codex', home, { ...env, PATH: path.dirname(standalone) }).command, standalone, 'PATH wins over bundled extensions');
  fs.rmSync(file('26.10.1'));
  assert.equal(resolveSetupClient('codex', home, env).command, file('26.9.99'));
  assert.throws(() => resolveSetupClient('codex', home, { ...env, CODEX_PATH: path.join(home, 'missing.exe') }), /cannot be resolved/);
  fs.rmSync(file('26.9.99'));
  assert.equal(resolveSetupClient('codex', home, env), null);
});
test('VS Code provider yields discovery to the active profile manual registration without deleting it', t => {
  const { home, cwd } = profile(t);
  const storage = path.join(home, 'User/profiles/selected/globalStorage/coagent8');
  assert.equal(hasManualVscodeRegistration(storage, [cwd]), false);
  const file = path.join(home, 'User/profiles/selected/mcp.json');
  const original = '// comment\n{"servers":{"coagent8":{"command":"node","args":["synthetic"]}},"inputs":[{"id":"keep"}]}';
  write(file, original);
  assert.equal(hasManualVscodeRegistration(storage, [cwd]), true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(hasManualVscodeRegistration(path.join(home, 'User/globalStorage/coagent8'), []), false);
});

test('setup reclaims an interrupted owner lease and releases its own lease after repair', async t => {
  const options = { ...profile(t), clients: ['codex'] };
  const lease = path.join(options.home, '.coagent8/setup.lease');
  write(lease, JSON.stringify({ token: 'synthetic-dead-owner', pid: 2147483647, createdAt: 0 }));
  const result = await setupClients(options);
  assert.equal(result[0].action, 'installed', JSON.stringify(result));
  assert.equal(result[0].hostCallable, true);
  assert.equal(fs.existsSync(lease), false);
});

test('setup uses its supplied Node executable for JavaScript client launchers', t => {
  const options = profile(t);
  const suppliedNode = path.join(options.home, 'selected-node.exe');
  const first = resolveSetupClient('codex', options.home, options.env, suppliedNode);
  assert.equal(first.command, suppliedNode);
  const second = resolveSetupClient('codex', options.home, options.env, process.execPath);
  assert.equal(second.command, process.execPath);
  assert.deepEqual(second.argsPrefix, first.argsPrefix);
});

test('the Codex tool timeout is added after the CoAgent8 table header only, keeping formatting and other keys', () => {
  const { withCodexToolTimeout, CODEX_TOOL_TIMEOUT_SEC } = require('../../src/integrations/setup.ts');
  const config = '# keep\r\nmodel = "m"\r\n[mcp_servers.coagent8]\r\ncommand = "node"\r\nargs = ["x"]\r\n\r\n[mcp_servers.coagent8.env]\r\nA = "1"\r\n[mcp_servers.other]\r\ncommand = "o"\r\n';
  const edited = withCodexToolTimeout(config);
  assert.equal(edited, config.replace('[mcp_servers.coagent8]\r\n', `[mcp_servers.coagent8]\r\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}\r\n`));
  assert.equal(withCodexToolTimeout(edited), edited, 'an existing timeout is kept');
  assert.throws(() => withCodexToolTimeout('[mcp_servers.other]\ncommand = "o"\n'), /no \[mcp_servers\.coagent8\] table/);
});
