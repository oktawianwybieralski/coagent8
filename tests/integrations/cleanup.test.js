const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parse } = require('jsonc-parser');
const { parse: toml } = require('smol-toml');
const { cleanupClients } = require('../../src/integrations/cleanup.ts');
const { setupClients } = require('../../src/integrations/setup.ts');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-cleanup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: undefined, CODEX_CONFIG_PATH: undefined, GEMINI_CLI_HOME: undefined, coagent8_DIR: path.join(home, '.coagent8'), SETUP_FIXTURE_HOME: home };
  const state = path.join(home, '.coagent8/setup.json');
  const files = { codex: path.join(home, '.codex/config.toml'), claude: path.join(home, '.claude.json'), agy: path.join(home, '.gemini/config/mcp_config.json') };
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { home, env, state, files, write };
}
test('isolated setup -> CLI removal -> cleanup preserves other servers, backups and referenced runtimes; repeated cleanup is idempotent', async t => {
  const p = profile(t), fixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const originals = { codex: '# keep\n[mcp_servers.other]\ncommand="keep"\nargs=[]\n', claude: '// keep\n{"mcpServers":{"other":{"command":"keep"}},"token":"synthetic-secret"}', agy: '{"mcpServers":{"other":{"command":"keep"}}}' };
  for (const client of Object.keys(p.files)) p.write(p.files[client], originals[client]);
  const installed = await setupClients({ ...p, cwd: p.home, runtimeSource: path.resolve(__dirname, '../../dist/index.cjs'), clients: ['codex', 'claude', 'agy'], env: { ...p.env, CODEX_PATH: fixture, CLAUDE_PATH: fixture, AGY_PATH: fixture } });
  assert.ok(installed.every(result => result.action === 'installed'), JSON.stringify(installed));
  const snapshots = Object.fromEntries(Object.entries(p.files).map(([client, file]) => [client, fs.readFileSync(file, 'utf8')]));
  const runtime = parse(snapshots.claude).mcpServers.coagent8.args[0];
  // No CLI is needed to clean an owned registration after extension/CLI removal.
  const options = { ...p, env: { ...p.env, CODEX_PATH: 'absent', CLAUDE_PATH: 'absent', AGY_PATH: 'absent' } };
  const preview = await cleanupClients(options);
  assert.ok(preview.results.every(result => result.action === 'remove'), JSON.stringify(preview));
  for (const [client, file] of Object.entries(p.files)) assert.equal(fs.readFileSync(file, 'utf8'), snapshots[client], 'preview is read-only');
  const applied = await cleanupClients({ ...options, apply: preview.token });
  assert.ok(applied.results.every(result => result.action === 'removed'), JSON.stringify(applied));
  assert.equal(applied.stateError, undefined);
  assert.equal(toml(fs.readFileSync(p.files.codex, 'utf8')).mcp_servers.coagent8, undefined);
  assert.equal(toml(fs.readFileSync(p.files.codex, 'utf8')).mcp_servers.other.command, 'keep');
  for (const client of ['claude', 'agy']) {
    const text = fs.readFileSync(p.files[client], 'utf8');
    assert.equal(parse(text).mcpServers.coagent8, undefined);
    assert.equal(parse(text).mcpServers.other.command, 'keep');
  }
  assert.equal(parse(fs.readFileSync(p.files.claude, 'utf8')).token, 'synthetic-secret');
  assert.ok(fs.readFileSync(p.files.claude, 'utf8').includes('// keep'));
  assert.ok(fs.existsSync(runtime), 'runtime retention protects preserved/manual references');
  const backups = fs.readdirSync(path.join(p.home, '.coagent8/setup-backups')).flatMap(dir => {
    const root = path.join(p.home, '.coagent8/setup-backups', dir);
    return fs.readdirSync(root).filter(file => file.endsWith('.config')).map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  });
  for (const snapshot of Object.values(snapshots)) assert.ok(backups.includes(snapshot), 'private backups contain exact pre-cleanup bytes');
  const again = await cleanupClients(options);
  assert.ok(again.results.every(result => result.action === 'absent'));
  await cleanupClients({ ...options, apply: again.token });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.state, 'utf8')).owned, {});
});
test('cleanup preserves manual, legacy and independently edited entries, histories and credentials', async t => {
  const p = profile(t), owned = { command: 'owned', args: [] };
  p.write(p.state, JSON.stringify({ clients: ['claude'], owned: { claude: fingerprint(owned) } }));
  const manual = '{"mcpServers":{"coagent8":{"command":"manual","args":[]},"omniagent":{"command":"legacy"}},"credentials":"keep"}';
  p.write(p.files.agy, manual);
  const edited = JSON.stringify({ mcpServers: { coagent8: { ...owned, args: ['independent-edit'] } } });
  p.write(p.files.claude, edited);
  const history = path.join(p.home, '.claude/history.jsonl'); p.write(history, 'keep history');
  const preview = await cleanupClients(p);
  assert.equal(preview.results.find(r => r.client === 'agy').action, 'preserved');
  assert.equal(preview.results.find(r => r.client === 'claude').action, 'preserved');
  const applied = await cleanupClients({ ...p, apply: preview.token });
  assert.ok(applied.results.filter(r => r.client !== 'codex').every(r => r.action === 'preserved'));
  assert.equal(fs.readFileSync(p.files.agy, 'utf8'), manual);
  assert.equal(fs.readFileSync(p.files.claude, 'utf8'), edited);
  assert.equal(fs.readFileSync(history, 'utf8'), 'keep history');
});
test('a stale preview cannot remove an independently changed entry or unrelated concurrent setting', async t => {
  const p = profile(t), entry = { command: 'owned', args: [] };
  p.write(p.state, JSON.stringify({ clients: ['claude'], owned: { claude: fingerprint(entry) } }));
  p.write(p.files.claude, JSON.stringify({ mcpServers: { coagent8: entry } }));
  const preview = await cleanupClients(p);
  const changed = JSON.stringify({ mcpServers: { coagent8: entry }, unrelated: 'new-value' });
  p.write(p.files.claude, changed);
  await assert.rejects(cleanupClients({ ...p, apply: preview.token }), /preview changed/);
  assert.equal(fs.readFileSync(p.files.claude, 'utf8'), changed);
});
test('cleanup reports malformed client files individually while removing another owned entry', async t => {
  const p = profile(t), entry = { command: 'owned', args: [] };
  p.write(p.state, JSON.stringify({ clients: ['claude'], owned: { claude: fingerprint(entry) } }));
  p.write(p.files.claude, JSON.stringify({ mcpServers: { coagent8: entry } }));
  p.write(p.files.agy, '{"token":"synthetic-secret", broken');
  const preview = await cleanupClients(p);
  assert.equal(preview.results.find(r => r.client === 'agy').action, 'blocked');
  const applied = await cleanupClients({ ...p, apply: preview.token });
  assert.equal(applied.results.find(r => r.client === 'claude').action, 'removed');
  assert.ok(!JSON.stringify(applied).includes('synthetic-secret'));
  assert.equal(fs.readFileSync(p.files.agy, 'utf8'), '{"token":"synthetic-secret", broken');
});
test('Codex cleanup supports quoted/nested owned tables and fails closed for inline ownership', async t => {
  const p = profile(t);
  const supported = '# keep\n[mcp_servers."coagent8"]\ncommand="node"\nargs=[]\n[mcp_servers.coagent8.env]\nKEY="keep-in-backup"\n[mcp_servers.other]\ncommand="other"\n';
  p.write(p.files.codex, supported);
  p.write(p.state, JSON.stringify({ clients: ['codex'], owned: { codex: fingerprint(toml(supported).mcp_servers.coagent8) } }));
  const preview = await cleanupClients(p);
  assert.equal(preview.results[0].action, 'remove');
  await cleanupClients({ ...p, apply: preview.token });
  assert.equal(fs.readFileSync(p.files.codex, 'utf8'), '# keep\n[mcp_servers.other]\ncommand="other"\n');
  const inline = '[mcp_servers]\ncoagent8={command="node",args=[]}\nother={command="other"}\n';
  p.write(p.files.codex, inline);
  p.write(p.state, JSON.stringify({ clients: ['codex'], owned: { codex: fingerprint(toml(inline).mcp_servers.coagent8) } }));
  assert.equal((await cleanupClients(p)).results[0].action, 'blocked');
  assert.equal(fs.readFileSync(p.files.codex, 'utf8'), inline);
});
test('backup failure reports a recoverable blocked removal without changing owned configuration', async t => {
  const p = profile(t), entry = { command: 'owned', args: [] };
  p.write(p.state, JSON.stringify({ clients: ['claude'], owned: { claude: fingerprint(entry) } }));
  const original = JSON.stringify({ mcpServers: { coagent8: entry } });
  p.write(p.files.claude, original);
  p.write(path.join(p.home, '.coagent8/setup-backups'), 'directory unavailable');
  const preview = await cleanupClients(p);
  const result = await cleanupClients({ ...p, apply: preview.token });
  assert.equal(result.results.find(r => r.client === 'claude').action, 'blocked');
  assert.equal(fs.readFileSync(p.files.claude, 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(p.state, 'utf8')).owned.claude, fingerprint(entry));
});

/** An extension-made claude entry and, optionally, a CLI-made agy entry, each with its runtime copy. */
function uninstallProfile(t, { withCli }) {
  const p = profile(t), runtime = name => path.join(p.home, '.coagent8/runtime', name.repeat(64), 'index.cjs');
  const extension = { command: 'node', args: [runtime('a')] }, cli = { command: 'node', args: [runtime('b')] };
  for (const file of [runtime('a'), ...(withCli ? [runtime('b')] : [])]) p.write(file, 'runtime');
  p.write(p.files.claude, JSON.stringify({ mcpServers: { coagent8: extension, other: { command: 'keep' } } }));
  if (withCli) p.write(p.files.agy, JSON.stringify({ mcpServers: { coagent8: cli } }));
  p.write(p.state, JSON.stringify({ clients: withCli ? ['claude', 'agy'] : ['claude'],
    owned: { claude: fingerprint(extension), ...(withCli ? { agy: fingerprint(cli) } : {}) }, origin: { claude: 'vscode-extension' } }));
  return { ...p, runtime };
}
test('uninstall cleanup removes only extension registrations and runtime copies nothing references', async t => {
  const p = uninstallProfile(t, { withCli: true }), options = { ...p, origin: 'vscode-extension', uninstall: true };
  const preview = await cleanupClients(options);
  assert.deepEqual(Object.fromEntries(preview.results.map(r => [r.client, r.action])), { codex: 'absent', claude: 'remove', agy: 'preserved' });
  const applied = await cleanupClients({ ...options, apply: preview.token });
  assert.equal(applied.stateError, undefined);
  assert.equal(applied.results.find(r => r.client === 'claude').action, 'removed');
  assert.deepEqual(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers, { other: { command: 'keep' } });
  assert.ok(parse(fs.readFileSync(p.files.agy, 'utf8')).mcpServers.coagent8, 'a coagent8 CLI registration survives the extension');
  assert.equal(fs.existsSync(path.dirname(p.runtime('a'))), false, 'the unreferenced runtime copy is deleted');
  assert.ok(fs.existsSync(p.runtime('b')), 'a referenced runtime copy is kept');
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8/setup-backups')), false, 'no private backup in uninstall mode');
  assert.deepEqual(JSON.parse(fs.readFileSync(p.state, 'utf8')), { clients: ['agy'], owned: { agy: fingerprint({ command: 'node', args: [p.runtime('b')] }) }, origin: {} });
});
test('without an extension origin, as in earlier records, uninstall cleanup preserves the entry', async t => {
  const p = uninstallProfile(t, { withCli: false });
  const state = JSON.parse(fs.readFileSync(p.state, 'utf8')); delete state.origin; p.write(p.state, JSON.stringify(state));
  const options = { ...p, origin: 'vscode-extension', uninstall: true };
  const preview = await cleanupClients(options);
  assert.equal(preview.results.find(r => r.client === 'claude').action, 'preserved');
  await cleanupClients({ ...options, apply: preview.token });
  assert.ok(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers.coagent8);
  assert.ok(fs.existsSync(p.runtime('a')), 'its runtime copy is still referenced');
});
test('the bundled vscode:uninstall hook leaves no CoAgent8 registration, runtime or directory behind', async t => {
  const p = uninstallProfile(t, { withCli: false });
  const manifest = require('../../extensions/vscode/package.json');
  assert.equal(manifest.scripts['vscode:uninstall'], 'node ./dist/uninstall.cjs');
  const hook = path.join(p.home, 'hook', 'uninstall.cjs');
  await require('esbuild').build({ entryPoints: [path.resolve(__dirname, '../../extensions/vscode/src/uninstall.ts')], outfile: hook,
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', mainFields: ['module', 'main'] });
  const env = { ...process.env, HOME: p.home, USERPROFILE: p.home };
  for (const key of ['CODEX_HOME', 'CODEX_CONFIG_PATH', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'coagent8_DIR', 'coagent8_CONFIG']) delete env[key];
  const run = require('node:child_process').spawnSync(process.execPath, [hook], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).results.find(r => r.client === 'claude').action, 'removed');
  assert.deepEqual(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers, { other: { command: 'keep' } });
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false, 'the emptied CoAgent8 directory is removed');
});
