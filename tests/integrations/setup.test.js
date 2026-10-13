const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupClients, readRegistrations, resolveSetupClient, clientSource, listInstallations, configuredExecutable, checkExecutable } = require('../../src/integrations/setup.ts');
const { extractRuntimePath, setupShapedEntry, entryOwnership, readSelection } = require('../../src/integrations/setup-storage.ts');
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
  write(config, JSON.stringify(require('../../src/config.ts').validateConfig({ defaultBackend: 'agy' })));
  options.env.coagent8_CONFIG = config;
  const results = await setupClients(options);
  assert.ok(results.every(result => result.action === 'installed'), JSON.stringify(results));
  const codex = toml(fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8')).mcp_servers.coagent8;
  const claude = parse(fs.readFileSync(path.join(options.home, '.claude.json'), 'utf8')).mcpServers.coagent8;
  const agy = parse(fs.readFileSync(path.join(options.home, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers.coagent8;
  for (const entry of [codex, claude, agy]) assert.equal(entry.env.coagent8_CONFIG, config);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).defaultBackend, 'agy');
  assert.deepEqual(readRegistrations(options).map(item => item.current), [true, true, true], 'a TOML env table equals the candidate');
  const codexBefore = fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8');
  assert.ok((await setupClients(options)).every(result => result.action === 'preserved'), 'repair keeps an identical entry with an environment');
  assert.equal(fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8'), codexBefore);
  const nextConfig = path.join(options.home, 'replacement configuration.json');
  write(nextConfig, JSON.stringify(require('../../src/config.ts').validateConfig({ defaultBackend: 'codex' })));
  options.env.coagent8_CONFIG = nextConfig;
  const repaired = await setupClients(options);
  assert.ok(repaired.every(result => result.action === 'updated'), JSON.stringify(repaired));
  assert.equal(toml(fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8')).mcp_servers.coagent8.env.coagent8_CONFIG, nextConfig);
  for (const file of ['.claude.json', '.gemini/config/mcp_config.json']) {
    assert.equal(parse(fs.readFileSync(path.join(options.home, file), 'utf8')).mcpServers.coagent8.env.coagent8_CONFIG, nextConfig, `${file}: owned entries without a host check update on the runtime check`);
  }
});

test('a new runtime replaces owned Claude and agy entries, keeping the previous runtime and a backup', async t => {
  const options = { ...profile(t), clients: ['claude', 'agy'] };
  assert.ok((await setupClients(options)).every(result => result.action === 'installed'));
  const files = ['.claude.json', '.gemini/config/mcp_config.json'].map(file => path.join(options.home, file));
  const runtimeOf = file => parse(fs.readFileSync(file, 'utf8')).mcpServers.coagent8.args.at(-1);
  const previous = files.map(runtimeOf);
  const updatedSource = path.join(options.home, 'updated.cjs');
  fs.writeFileSync(updatedSource, fs.readFileSync(source, 'utf8') + '\n// synthetic update\n');
  const updated = await setupClients({ ...options, runtimeSource: updatedSource });
  assert.ok(updated.every(result => result.action === 'updated' && result.runtimeCallable && !result.hostCallable), JSON.stringify(updated));
  assert.ok(updated.every(result => /previous runtime stays until cleanup/.test(result.message)));
  assert.deepEqual(readRegistrations({ ...options, runtimeSource: updatedSource }).filter(item => item.client !== 'codex').map(item => [item.state, item.current]), [['owned', true], ['owned', true]]);
  for (const [index, file] of files.entries()) {
    assert.notEqual(runtimeOf(file), previous[index]);
    assert.ok(fs.existsSync(previous[index]), 'the previous runtime stays for running chats and rollback');
  }
  const backups = fs.readdirSync(path.join(options.home, '.coagent8/setup-backups'));
  assert.ok(backups.flatMap(name => fs.readdirSync(path.join(options.home, '.coagent8/setup-backups', name))).filter(name => name === 'claude.config').length >= 2, 'each update keeps the original bytes');
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
test('extension registrations carry its data directory and leave tagged backups without Codex staging copies', async t => {
  const options = profile(t);
  const storage = path.join(options.home, 'globalStorage', 'okidev.coagent8-mcp');
  const results = await setupClients({ ...options, origin: 'vscode-extension', dataDirectory: storage });
  assert.ok(results.every(result => result.action === 'installed'), JSON.stringify(results));
  const codex = toml(fs.readFileSync(path.join(options.home, '.codex/config.toml'), 'utf8')).mcp_servers.coagent8;
  const claude = parse(fs.readFileSync(path.join(options.home, '.claude.json'), 'utf8')).mcpServers.coagent8;
  for (const entry of [codex, claude]) assert.equal(entry.env.coagent8_DIR, storage, 'CLI chats keep their data where VS Code deletes it on uninstall');
  assert.deepEqual(readRegistrations({ ...options, dataDirectory: storage }).map(item => item.current), [true, true, true]);
  assert.deepEqual(readRegistrations(options).map(item => item.current), [false, false, false], 'another data directory is another registration');
  const backups = fs.readdirSync(path.join(options.home, '.coagent8/setup-backups'));
  assert.equal(backups.length, 3);
  assert.ok(backups.every(name => name.startsWith('vscode-extension-')));
  const leftovers = backups.flatMap(name => fs.readdirSync(path.join(options.home, '.coagent8/setup-backups', name)));
  assert.deepEqual(leftovers.sort(), ['agy.config', 'claude.config', 'codex.config'], 'no codex-staging directory remains');
});
test('the first registration records the CLI in config.json, keeps a later user change, and a configured path is used', async t => {
  const options = profile(t);
  const config = path.join(options.home, 'config.json');
  options.env.coagent8_CONFIG = config;
  const cli = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  assert.ok((await setupClients({ ...options, clients: ['claude'] })).every(result => result.action === 'installed'));
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).backends.claude.executable, cli, 'a JavaScript launcher is recorded by its script');
  const changed = { ...JSON.parse(fs.readFileSync(config, 'utf8')) };
  changed.backends.claude.executable = cli;
  changed.backends.codex = { executable: '~/custom/codex' };
  fs.writeFileSync(config, JSON.stringify(changed));
  await setupClients({ ...options, clients: ['codex'], env: { ...options.env, CODEX_PATH: cli } });
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).backends.codex.executable, '~/custom/codex', 'the user value is kept');
  // Without an environment override the runtime and setup use the configured path.
  const env = { ...options.env, CLAUDE_PATH: undefined };
  assert.equal(resolveSetupClient('claude', options.home, env).argsPrefix[0], cli);
  changed.backends.claude.executable = path.join(options.home, 'missing', 'claude.exe');
  fs.writeFileSync(config, JSON.stringify(changed));
  assert.throws(() => resolveSetupClient('claude', options.home, env), /backends\.claude\.executable \(configured path\) cannot be resolved/, 'no fallback to another installation');
  const [blocked] = await setupClients({ ...options, env, clients: ['claude'], statusOnly: true });
  assert.equal(blocked.action, 'blocked');
});
test('a missing selected extension copy is installable without falling back or changing configuration', async t => {
  const options = profile(t);
  const config = path.join(options.home, 'config.json');
  const content = JSON.stringify({ backends: Object.fromEntries(['codex', 'claude', 'agy'].map(client => [client, { executable: 'vscode-extension' }])) });
  fs.writeFileSync(config, content);
  const env = { ...options.env, coagent8_CONFIG: config, coagent8_EXTENSION_PATHS: '{}', CODEX_PATH: undefined, CLAUDE_PATH: undefined, AGY_PATH: undefined };
  for (const client of ['codex', 'claude', 'agy']) assert.equal(resolveSetupClient(client, options.home, env), null);
  const results = await setupClients({ ...options, env, statusOnly: true });
  assert.ok(results.every(result => result.action === 'missing' && !result.installed), JSON.stringify(results));
  assert.equal(fs.readFileSync(config, 'utf8'), content, 'status preserves the selected source');
  assert.throws(() => resolveSetupClient('claude', options.home, { ...env, CLAUDE_PATH: path.join(options.home, 'absent') }), /cannot be resolved/, 'environment overrides still fail closed');
});

test('status with registrations reads host files only: no runtime start, no host discovery', async t => {
  const options = profile(t);
  assert.ok((await setupClients(options)).every(result => result.action === 'installed'));
  const log = path.join(options.home, 'probes.log');
  const result = await setupClients({ ...options, clients: undefined, statusOnly: true, env: { ...options.env, SETUP_FIXTURE_PROBE_LOG: log } });
  assert.ok(result.every(item => item.registered && item.ready && item.action === 'preserved'), JSON.stringify(result));
  assert.ok(result.every(item => item.message === 'Registered. Status reads the host configuration only; CoAgent8: Manage Coding CLIs or npx -y coagent8@next repair (coagent8 repair when installed globally) verifies the connection.'));
  assert.ok(result.every(item => !item.runtimeCallable && !item.hostCallable && !item.tools.length), 'status claims no connection evidence');
  const launches = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!launches.some(args => args.length === 1 && args[0] === 'app-server'), 'no Codex discovery thread');
  assert.equal(launches.length, 3 * 3 + 1, 'version, help and sign-in per CLI, plus the Codex app-server handshake');
});
test('registrations are read from host files with ownership and the current runtime', async t => {
  const options = profile(t);
  await setupClients({ ...options, clients: ['codex', 'claude'] });
  const manual = { mcpServers: { coagent8: { command: process.execPath, args: [source] } } };
  write(path.join(options.home, '.gemini/config/mcp_config.json'), JSON.stringify(manual));
  assert.deepEqual(readRegistrations(options).map(item => [item.client, item.state, item.current]), [['codex', 'owned', true], ['claude', 'owned', true], ['agy', 'manual', false]]);
  const updatedSource = path.join(options.home, 'updated.cjs');
  fs.writeFileSync(updatedSource, fs.readFileSync(source, 'utf8') + '\n// synthetic update\n');
  assert.deepEqual(readRegistrations({ ...options, runtimeSource: updatedSource }).map(item => item.current), [false, false, false], 'another bundle is another version');
  write(path.join(options.home, '.claude.json'), '{ malformed');
  const blocked = readRegistrations(options);
  assert.equal(blocked[1].state, 'blocked');
  assert.equal(blocked[0].state, 'owned', 'one unreadable host does not hide the others');
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
test('setup replaces an entry it wrote whose ownership record and runtime copy are gone', async t => {
  const options = profile(t);
  const file = path.join(options.home, '.claude.json');
  const stale = { command: process.execPath, args: [path.join(options.home, '.coagent8', 'runtime', 'c'.repeat(64), 'index.cjs')] };
  write(file, JSON.stringify({ mcpServers: { coagent8: stale } }));
  assert.deepEqual(readRegistrations(options)[1], { client: 'claude', state: 'owned', current: false, message: 'Registered by setup for another CoAgent8 version, configuration file or data directory.' });
  const [result] = await setupClients({ ...options, clients: ['claude'] });
  assert.equal(result.action, 'updated', JSON.stringify(result));
  assert.equal(result.runtimeCallable, true, 'the replacement starts and lists its tools');
  const entry = parse(fs.readFileSync(file, 'utf8')).mcpServers.coagent8;
  assert.ok(fs.existsSync(entry.args.at(-1)));
  assert.deepEqual(readRegistrations(options)[1].state, 'owned');
  assert.equal(readRegistrations(options)[1].current, true);
});
test('a link to the extension copy of agy, as the official installer makes, is that copy and no second installation', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-source-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const copy = path.join(home, '.gemini', 'bin', name);
  write(copy, '#!/bin/sh\n');
  fs.chmodSync(copy, 0o755);
  // %LOCALAPPDATA%\agy\bin is a junction to ~/.gemini/bin after the Windows installer runs.
  const linked = path.join(home, 'local', 'agy', 'bin');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(path.dirname(copy), linked, 'junction');
  const env = isolated(home, { PATH: linked });
  const source = clientSource('agy', { command: path.join(linked, name), argsPrefix: [], source: 'native' }, home, env);
  assert.deepEqual(source, { kind: 'vscode-extension', executable: 'vscode-extension' });
  assert.deepEqual(listInstallations('agy', home, env), [{ kind: 'vscode-extension', executable: 'vscode-extension', file: copy }], 'the menu shows no second copy of the same file');
});
/** An environment whose PATH, installer folders and configuration all lie in the temporary profile. */
function isolated(home, extra = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), SCOOP: path.join(home, 'scoop'),
    coagent8_CONFIG: path.join(home, '.coagent8', 'config.json'), coagent8_EXTENSION_PATHS: '{}', CODEX_PATH: undefined, CLAUDE_PATH: undefined, AGY_PATH: undefined, PATH: '', ...extra };
}
/** A launcher the resolver accepts as a native executable on every platform. */
function launcher(file) {
  write(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}
test('the installation list covers every PATH folder, the installer folders and a configured path once each', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-installations-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const onPath = launcher(path.join(home, 'on-path', 'codex'));
  // ~/.local/bin is searched also when the PATH this process inherited misses it.
  const installer = launcher(path.join(home, '.local', 'bin', 'codex'));
  const custom = launcher(path.join(home, 'tools', 'codex'));
  const env = isolated(home, { PATH: [path.dirname(onPath), path.dirname(installer)].join(path.delimiter) });
  assert.deepEqual(listInstallations('codex', home, env), [onPath, installer].map(file => ({ kind: 'standalone', executable: file, file })), 'a folder on PATH and among the installer folders counts once');
  write(env.coagent8_CONFIG, JSON.stringify({ backends: { codex: { executable: custom } } }));
  assert.deepEqual(listInstallations('codex', home, env).map(item => item.file), [onPath, installer, custom]);
  assert.deepEqual(listInstallations('claude', home, env), [], 'other clients are not mixed in');
  if (process.platform === 'win32') {
    write(path.join(home, 'shim', 'claude.cmd'), '@echo off\r\n"%~dp0missing.exe" %* extra\r\n');
    assert.deepEqual(listInstallations('claude', home, isolated(home, { PATH: path.join(home, 'shim') })), [], 'an unsupported shim is no usable installation');
  }
});
test('the configured executable reports whether it can be started; an environment override replaces it', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-configured-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = isolated(home);
  assert.equal(configuredExecutable('codex', home, env), undefined);
  const file = launcher(path.join(home, 'tools', 'codex'));
  const configure = executable => write(env.coagent8_CONFIG, JSON.stringify({ backends: { codex: { executable } } }));
  configure(file);
  assert.deepEqual(configuredExecutable('codex', home, env), { value: file, found: true });
  configure('~/tools/codex');
  assert.deepEqual(configuredExecutable('codex', home, env), { value: '~/tools/codex', found: true }, 'a path in the profile may start with ~/');
  configure(path.join(home, 'missing', 'codex'));
  assert.deepEqual(configuredExecutable('codex', home, env), { value: path.join(home, 'missing', 'codex'), found: false });
  configure('vscode-extension');
  assert.deepEqual(configuredExecutable('codex', home, env), { value: 'vscode-extension', found: false }, 'no vendor extension provides a copy');
  assert.equal(configuredExecutable('codex', home, { ...env, CODEX_PATH: file }), undefined);
});
test('a chosen executable is accepted only as a compatible CLI of its client', async t => {
  const options = profile(t);
  const cli = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const env = { ...options.env, CODEX_PATH: undefined };
  const accepted = await checkExecutable('codex', cli, options.home, env, process.execPath, options.cwd);
  assert.deepEqual(accepted.source, { kind: 'npm', executable: cli }, 'a JavaScript launcher is kept as the file Node runs');
  assert.equal(accepted.readiness.compatibility, 'supported');
  assert.equal(accepted.readiness.authentication, 'authenticated');
  await assert.rejects(checkExecutable('codex', cli, options.home, { ...env, SETUP_FIXTURE_HELP: 'usage: other-tool' }, process.execPath, options.cwd),
    /^Error: client\.cjs is not a compatible codex CLI: Required CLI controls are missing/);
  await assert.rejects(checkExecutable('codex', path.join(options.home, 'missing.exe'), options.home, env, process.execPath, options.cwd), /^Error: missing\.exe cannot be started: /);
});

test('extractRuntimePath recognizes both registration shapes under strict containment and bounds', t => {
  const { home } = profile(t);
  const root = path.join(home, '.coagent8');
  const sha = 'a'.repeat(64);
  const runtime = path.join(root, 'runtime', sha, 'index.cjs');

  // Modern shape: [...node.argsPrefix, runtime, 'mcp']
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, 'mcp'] }, root), runtime);

  // Legacy shape: [...node.argsPrefix, runtime]
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime] }, root), runtime);

  // Global storage runtime path
  const extDir = path.join(home, 'User', 'globalStorage', 'okidev.coagent8-mcp');
  const extRuntime = path.join(extDir, 'runtime', sha, 'index.cjs');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [extRuntime, 'mcp'], env: { coagent8_DIR: extDir } }, root), extRuntime);

  // Invalid argument order
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['mcp', runtime] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['mcp'] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, 'mcp', runtime] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: [] }, root), null);

  // Foreign tokens and extra flags
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['--foreign', runtime] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, '--foreign'] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['--foreign', runtime, 'mcp'] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, 'mcp', '--foreign'] }, root), null);
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, 'foreign', 'mcp'] }, root), null);

  // Manual and npx entries
  assert.equal(extractRuntimePath({ command: 'coagent8', args: ['mcp'] }, root), null);
  assert.equal(extractRuntimePath({ command: 'npx', args: ['-y', 'coagent8@next', 'mcp'] }, root), null);

  // Containment and shape validation violations
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['runtime/' + sha + '/index.cjs', 'mcp'] }, root), null, 'relative path');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [path.join(root, 'runtime', sha, 'server.js'), 'mcp'] }, root), null, 'non-index.cjs basename');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [path.join(root, 'runtime', 'g'.repeat(64), 'index.cjs'), 'mcp'] }, root), null, 'non-hex subdirectory');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [path.join(root, 'runtime', 'a'.repeat(32), 'index.cjs'), 'mcp'] }, root), null, 'short hex subdirectory');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [path.join(home, 'other', 'runtime', sha, 'index.cjs'), 'mcp'] }, root), null, 'outside root');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [path.join(root, 'runtime', sha, '..', '..', 'index.cjs'), 'mcp'] }, root), null, 'traversal');

  // Outside-root entry cannot authorize itself via coagent8_DIR
  assert.equal(extractRuntimePath({ command: process.execPath, args: [path.join(home, 'other', 'runtime', sha, 'index.cjs'), 'mcp'], env: { coagent8_DIR: path.join(home, 'other') } }, root), null, 'outside-root coagent8_DIR rejected');

  // Malformed env.coagent8_DIR yields null instead of throwing
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, 'mcp'], env: { coagent8_DIR: 123 } }, root), null, 'numeric coagent8_DIR');
  assert.equal(extractRuntimePath({ command: process.execPath, args: [runtime, 'mcp'], env: { coagent8_DIR: {} } }, root), null, 'object coagent8_DIR');

  // Permitted launcher argsPrefix support
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['--launcher-flag', runtime, 'mcp'] }, root, ['--launcher-flag']), runtime);
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['--launcher-flag', runtime] }, root, ['--launcher-flag']), runtime);
  assert.equal(extractRuntimePath({ command: process.execPath, args: ['--wrong-flag', runtime, 'mcp'] }, root, ['--launcher-flag']), null);
});

test('setupShapedEntry and entryOwnership detect both shapes and enforce anti-widening invariants', t => {
  const { home } = profile(t);
  const root = path.join(home, '.coagent8');
  const sha = 'b'.repeat(64);
  const runtime = path.join(root, 'runtime', sha, 'index.cjs');
  const saved = { clients: [], owned: {}, origin: {}, skills: {}, skillOrigin: {} };

  // Valid legacy and modern shapes
  assert.deepEqual(setupShapedEntry('claude', { command: process.execPath, args: [runtime] }, root), {});
  assert.deepEqual(setupShapedEntry('claude', { command: process.execPath, args: [runtime, 'mcp'] }, root), {});
  assert.equal(entryOwnership('claude', { command: process.execPath, args: [runtime] }, saved, root).owned, true);
  assert.equal(entryOwnership('claude', { command: process.execPath, args: [runtime, 'mcp'] }, saved, root).owned, true);

  // Command anti-widening: binary, npx, arbitrary shell and utilities
  for (const command of ['coagent8', 'npx', 'sh', 'bash', 'cmd.exe', 'powershell.exe', 'python']) {
    assert.equal(setupShapedEntry('claude', { command, args: [runtime, 'mcp'] }, root), null, `${command} must not be owned`);
    assert.equal(entryOwnership('claude', { command, args: [runtime, 'mcp'] }, saved, root).owned, false, `${command} must be manual`);
  }

  // Outside-root entry with matching coagent8_DIR must not be owned
  const outsideEntry = { command: process.execPath, args: [path.join(home, 'other', 'runtime', sha, 'index.cjs'), 'mcp'], env: { coagent8_DIR: path.join(home, 'other') } };
  assert.equal(setupShapedEntry('claude', outsideEntry, root), null);
  assert.equal(entryOwnership('claude', outsideEntry, saved, root).owned, false);

  // Malformed env.coagent8_DIR
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: [runtime, 'mcp'], env: { coagent8_DIR: 123 } }, root), null);

  // Invalid argument orders and foreign tokens
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: ['mcp', runtime] }, root), null);
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: ['--flag', runtime, 'mcp'] }, root), null);
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: [runtime, 'mcp', '--flag'] }, root), null);
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: [runtime, '--flag'] }, root), null);

  // Unknown environment or extra fields
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: [runtime, 'mcp'], env: { UNKNOWN: '1' } }, root), null);
  assert.equal(setupShapedEntry('claude', { command: process.execPath, args: [runtime, 'mcp'], extraField: true }, root), null);

  // Extension globalStorage origin detection
  const extDir = path.join(home, 'User', 'globalStorage', 'okidev.coagent8-mcp');
  const extRuntime = path.join(extDir, 'runtime', sha, 'index.cjs');
  const extEntry = { command: process.execPath, args: [extRuntime, 'mcp'], env: { coagent8_DIR: extDir } };
  assert.deepEqual(setupShapedEntry('claude', extEntry, root), { origin: 'vscode-extension' });
  assert.deepEqual(entryOwnership('claude', extEntry, saved, root), { owned: true, origin: 'vscode-extension' });

  // Candidate nodePath
  const candidateNode = path.join(home, 'custom-node.exe');
  assert.deepEqual(setupShapedEntry('claude', { command: candidateNode, args: [runtime, 'mcp'] }, root, candidateNode), {});

  // Permitted launcher argsPrefix
  assert.deepEqual(setupShapedEntry('claude', { command: process.execPath, args: ['--flag', runtime, 'mcp'] }, root, undefined, ['--flag']), {});
});

test('readRegistrations and active runtime inspection recognize both legacy and modern mcp shapes', async t => {
  const options = profile(t);
  const file = path.join(options.home, '.claude.json');
  const sha = 'd'.repeat(64);
  const runtime = path.join(options.home, '.coagent8', 'runtime', sha, 'index.cjs');

  // Modern shaped entry without setup.json is recognized as owned
  write(file, JSON.stringify({ mcpServers: { coagent8: { command: process.execPath, args: [runtime, 'mcp'] } } }));
  assert.deepEqual(readRegistrations(options)[1], {
    client: 'claude',
    state: 'owned',
    current: false,
    message: 'Registered by setup for another CoAgent8 version, configuration file or data directory.',
  });

  // Manual command: "coagent8" is recognized as manual
  write(file, JSON.stringify({ mcpServers: { coagent8: { command: 'coagent8', args: ['mcp'] } } }));
  assert.deepEqual(readRegistrations(options)[1], {
    client: 'claude',
    state: 'manual',
    current: false,
    message: 'Manual or independently edited entry; setup preserves it.',
  });

  // Broken modern entry (runtime missing) is replaced by setupClients
  write(file, JSON.stringify({ mcpServers: { coagent8: { command: process.execPath, args: [runtime, 'mcp'] } } }));
  const [result] = await setupClients({ ...options, clients: ['claude'] });
  assert.equal(result.action, 'updated');
  assert.equal(result.runtimeCallable, true);

  // Fingerprint-owned modern registration matching candidate is preserved
  const { hash: hashEntry } = require('../../src/integrations/setup-storage.ts');
  const bundle = fs.readFileSync(source);
  const bundleSha = hashEntry(bundle);
  const liveRuntime = path.join(options.home, '.coagent8', 'runtime', bundleSha, 'index.cjs');
  write(liveRuntime, bundle);
  const liveEntry = { command: process.execPath, args: [liveRuntime] };
  write(file, JSON.stringify({ mcpServers: { coagent8: liveEntry } }));
  const stateFile = path.join(options.home, '.coagent8', 'setup.json');
  write(stateFile, JSON.stringify({ clients: ['claude'], owned: { claude: hashEntry(JSON.stringify(liveEntry)) }, origin: {}, skills: {}, skillOrigin: {} }));
  const [preservedResult] = await setupClients({ ...options, clients: ['claude'] });
  assert.equal(preservedResult.action, 'preserved');
  assert.equal(preservedResult.runtimeCallable, true);

  // Fingerprint-owned registration with a different launcher prefix is probed and verified
  const prefixedEntry = { command: process.execPath, args: ['--title=coagent8', liveRuntime, 'mcp'] };
  write(file, JSON.stringify({ mcpServers: { coagent8: prefixedEntry } }));
  write(stateFile, JSON.stringify({ clients: ['claude'], owned: { claude: hashEntry(JSON.stringify(prefixedEntry)) }, origin: {}, skills: {}, skillOrigin: {} }));
  const [prefixedResult] = await setupClients({ ...options, clients: ['claude'] });
  assert.equal(prefixedResult.action, 'updated');
  assert.equal(prefixedResult.runtimeCallable, true);
  assert.ok(prefixedResult.tools.includes('doctor'));

  // On Codex, fingerprint-owned registration with custom launcher prefix is recognized as owned
  const codexFile = path.join(options.home, '.codex/config.toml');
  const codexEntry = `[mcp_servers.coagent8]\ntool_timeout_sec = 1800\ncommand = "${process.execPath.replace(/\\/g, '\\\\')}"\nargs = ["--title=coagent8", "${liveRuntime.replace(/\\/g, '\\\\')}", "mcp"]\n`;
  write(codexFile, codexEntry);
  const parsedFromToml = toml(codexEntry).mcp_servers.coagent8;
  const stateData = { clients: ['codex'], owned: { codex: hashEntry(JSON.stringify(parsedFromToml)) }, origin: {}, skills: {}, skillOrigin: {} };
  write(stateFile, JSON.stringify(stateData));
  const savedState = readSelection(stateFile);
  assert.equal(entryOwnership('codex', parsedFromToml, savedState, options.home + '/.coagent8').owned, true);

  // When existing host check fails, managed runtime update is deferred
  const baseline = path.join(options.home, 'baseline-config');
  write(baseline, '# different baseline\n');
  const envFailingHost = { ...options.env, SETUP_FIXTURE_FAIL_CANDIDATE: '1' };
  const [deferredResult] = await setupClients({ ...options, clients: ['codex'], env: envFailingHost });
  assert.equal(deferredResult.action, 'preserved');
  assert.equal(deferredResult.hostCallable, false);
  assert.ok(deferredResult.message.includes('deferred'));

  // When existing host check passes, owned entry is migrated / updated to standard candidate
  if (fs.existsSync(baseline)) fs.rmSync(baseline);
  const [updatedCodexResult] = await setupClients({ ...options, clients: ['codex'] });
  assert.equal(updatedCodexResult.action, 'updated');
  assert.equal(updatedCodexResult.runtimeCallable, true);
  assert.equal(updatedCodexResult.hostCallable, true);
});
