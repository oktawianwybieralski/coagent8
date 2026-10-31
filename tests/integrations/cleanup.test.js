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
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_CONFIG_PATH: undefined,
    GEMINI_CLI_HOME: undefined,
    coagent8_DIR: path.join(home, '.coagent8'),
    SETUP_FIXTURE_HOME: home,
  };
  const state = path.join(home, '.coagent8/setup.json');
  const files = {
    codex: path.join(home, '.codex/config.toml'),
    claude: path.join(home, '.claude.json'),
    agy: path.join(home, '.gemini/config/mcp_config.json'),
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  return { home, env, state, files, write };
}
test('isolated setup -> CLI removal -> cleanup preserves other servers, backups and referenced runtimes; repeated cleanup is idempotent', async t => {
  const p = profile(t),
    fixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const originals = {
    codex: '# keep\n[mcp_servers.other]\ncommand="keep"\nargs=[]\n',
    claude: '// keep\n{"mcpServers":{"other":{"command":"keep"}},"token":"synthetic-secret"}',
    agy: '{"mcpServers":{"other":{"command":"keep"}}}',
  };
  for (const client of Object.keys(p.files)) p.write(p.files[client], originals[client]);
  const installed = await setupClients({
    ...p,
    cwd: p.home,
    runtimeSource: path.resolve(__dirname, '../../dist/index.cjs'),
    clients: ['codex', 'claude', 'agy'],
    env: { ...p.env, CODEX_PATH: fixture, CLAUDE_PATH: fixture, AGY_PATH: fixture },
  });
  assert.ok(
    installed.every(result => result.action === 'installed'),
    JSON.stringify(installed),
  );
  const snapshots = Object.fromEntries(Object.entries(p.files).map(([client, file]) => [client, fs.readFileSync(file, 'utf8')]));
  const runtime = parse(snapshots.claude).mcpServers.coagent8.args[0];
  // No CLI is needed to clean an owned registration after extension/CLI removal.
  const options = { ...p, env: { ...p.env, CODEX_PATH: 'absent', CLAUDE_PATH: 'absent', AGY_PATH: 'absent' } };
  const preview = await cleanupClients(options);
  assert.ok(
    preview.results.every(result => result.action === 'remove'),
    JSON.stringify(preview),
  );
  for (const [client, file] of Object.entries(p.files))
    assert.equal(fs.readFileSync(file, 'utf8'), snapshots[client], 'preview is read-only');
  const applied = await cleanupClients({ ...options, apply: preview.token });
  assert.ok(
    applied.results.every(result => result.action === 'removed'),
    JSON.stringify(applied),
  );
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
    return fs
      .readdirSync(root)
      .filter(file => file.endsWith('.config'))
      .map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  });
  for (const snapshot of Object.values(snapshots)) assert.ok(backups.includes(snapshot), 'private backups contain exact pre-cleanup bytes');
  const again = await cleanupClients(options);
  assert.ok(again.results.every(result => result.action === 'absent'));
  await cleanupClients({ ...options, apply: again.token });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.state, 'utf8')).owned, {});
});
test('cleanup preserves manual, legacy and independently edited entries, histories and credentials', async t => {
  const p = profile(t),
    owned = { command: 'owned', args: [] };
  p.write(p.state, JSON.stringify({ clients: ['claude'], owned: { claude: fingerprint(owned) } }));
  const manual = '{"mcpServers":{"coagent8":{"command":"manual","args":[]},"omniagent":{"command":"legacy"}},"credentials":"keep"}';
  p.write(p.files.agy, manual);
  const edited = JSON.stringify({ mcpServers: { coagent8: { ...owned, args: ['independent-edit'] } } });
  p.write(p.files.claude, edited);
  const history = path.join(p.home, '.claude/history.jsonl');
  p.write(history, 'keep history');
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
  const p = profile(t),
    entry = { command: 'owned', args: [] };
  p.write(p.state, JSON.stringify({ clients: ['claude'], owned: { claude: fingerprint(entry) } }));
  p.write(p.files.claude, JSON.stringify({ mcpServers: { coagent8: entry } }));
  const preview = await cleanupClients(p);
  const changed = JSON.stringify({ mcpServers: { coagent8: entry }, unrelated: 'new-value' });
  p.write(p.files.claude, changed);
  await assert.rejects(cleanupClients({ ...p, apply: preview.token }), /preview changed/);
  assert.equal(fs.readFileSync(p.files.claude, 'utf8'), changed);
});
test('cleanup reports malformed client files individually while removing another owned entry', async t => {
  const p = profile(t),
    entry = { command: 'owned', args: [] };
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
  const supported =
    '# keep\n[mcp_servers."coagent8"]\ncommand="node"\nargs=[]\n[mcp_servers.coagent8.env]\nKEY="keep-in-backup"\n[mcp_servers.other]\ncommand="other"\n';
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
  const p = profile(t),
    entry = { command: 'owned', args: [] };
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
  const p = profile(t),
    runtime = name => path.join(p.home, '.coagent8/runtime', name.repeat(64), 'index.cjs');
  const extension = { command: 'node', args: [runtime('a')] },
    cli = { command: 'node', args: [runtime('b')] };
  for (const file of [runtime('a'), ...(withCli ? [runtime('b')] : [])]) p.write(file, 'runtime');
  p.write(p.files.claude, JSON.stringify({ mcpServers: { coagent8: extension, other: { command: 'keep' } } }));
  if (withCli) p.write(p.files.agy, JSON.stringify({ mcpServers: { coagent8: cli } }));
  p.write(
    p.state,
    JSON.stringify({
      clients: withCli ? ['claude', 'agy'] : ['claude'],
      owned: { claude: fingerprint(extension), ...(withCli ? { agy: fingerprint(cli) } : {}) },
      origin: { claude: 'vscode-extension' },
    }),
  );
  return { ...p, runtime };
}
test('uninstall cleanup removes only extension registrations and runtime copies nothing references', async t => {
  const p = uninstallProfile(t, { withCli: true }),
    options = { ...p, origin: 'vscode-extension', uninstall: true };
  const preview = await cleanupClients(options);
  assert.deepEqual(Object.fromEntries(preview.results.map(r => [r.client, r.action])), {
    codex: 'absent',
    claude: 'remove',
    agy: 'preserved',
  });
  const applied = await cleanupClients({ ...options, apply: preview.token });
  assert.equal(applied.stateError, undefined);
  assert.equal(applied.results.find(r => r.client === 'claude').action, 'removed');
  assert.deepEqual(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers, { other: { command: 'keep' } });
  assert.ok(parse(fs.readFileSync(p.files.agy, 'utf8')).mcpServers.coagent8, 'a coagent8 CLI registration survives the extension');
  assert.equal(fs.existsSync(path.dirname(p.runtime('a'))), false, 'the unreferenced runtime copy is deleted');
  assert.ok(fs.existsSync(p.runtime('b')), 'a referenced runtime copy is kept');
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8/setup-backups')), false, 'no private backup in uninstall mode');
  assert.deepEqual(JSON.parse(fs.readFileSync(p.state, 'utf8')), {
    clients: ['agy'],
    owned: { agy: fingerprint({ command: 'node', args: [p.runtime('b')] }) },
    origin: {},
  });
});
test('backups written for the extension are tagged and removed on uninstall; coagent8 CLI backups stay', async t => {
  const p = uninstallProfile(t, { withCli: true });
  const options = { ...p, clients: ['claude'] };
  const preview = await cleanupClients({ ...options, actor: 'vscode-extension' });
  await cleanupClients({ ...options, actor: 'vscode-extension', apply: preview.token });
  const backups = path.join(p.home, '.coagent8/setup-backups');
  assert.deepEqual(
    fs.readdirSync(backups).map(name => name.startsWith('vscode-extension-')),
    [true],
    'the removal backup is tagged',
  );
  p.write(path.join(backups, 'cli-made', 'agy.config'), 'original');
  p.write(path.join(backups, 'vscode-extension-earlier', 'claude.config'), 'original');
  const uninstall = { ...p, origin: 'vscode-extension', uninstall: true };
  await cleanupClients({ ...uninstall, apply: (await cleanupClients(uninstall)).token });
  assert.deepEqual(fs.readdirSync(backups), ['cli-made'], 'only the CLI backup remains');
});
test('without an extension origin, as in earlier records, uninstall cleanup preserves the entry', async t => {
  const p = uninstallProfile(t, { withCli: false });
  const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
  delete state.origin;
  p.write(p.state, JSON.stringify(state));
  const options = { ...p, origin: 'vscode-extension', uninstall: true };
  const preview = await cleanupClients(options);
  assert.equal(preview.results.find(r => r.client === 'claude').action, 'preserved');
  await cleanupClients({ ...options, apply: preview.token });
  assert.ok(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers.coagent8);
  assert.ok(fs.existsSync(p.runtime('a')), 'its runtime copy is still referenced');
});
/** Bundles the vscode:uninstall hook as the extension ships it. */
async function buildHook(hook) {
  await require('esbuild').build({
    entryPoints: [path.resolve(__dirname, '../../extensions/vscode/src/uninstall.ts')],
    outfile: hook,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    mainFields: ['module', 'main'],
  });
}
/** Runs the hook as VS Code does: with Node, in the given home, killed after five seconds. */
function runHook(hook, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ['CODEX_HOME', 'CODEX_CONFIG_PATH', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'coagent8_DIR', 'coagent8_CONFIG'])
    delete env[key];
  return require('node:child_process').spawnSync(process.execPath, [hook], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
}
test('the bundled vscode:uninstall hook leaves no CoAgent8 registration, runtime or directory behind', async t => {
  const p = uninstallProfile(t, { withCli: false });
  const manifest = require('../../extensions/vscode/package.json');
  assert.equal(manifest.scripts['vscode:uninstall'], 'node ./dist/uninstall.cjs');
  const hook = path.join(p.home, 'hook', 'uninstall.cjs');
  await buildHook(hook);
  const run = runHook(hook, p.home);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).results.find(r => r.client === 'claude').action, 'removed');
  assert.deepEqual(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers, { other: { command: 'keep' } });
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false, 'the emptied CoAgent8 directory is removed');
});
test('while a window holds the profile lease, the vscode:uninstall hook still removes its registrations within its time limit', async t => {
  const { withFileLock } = require('../../src/storage/lock.ts');
  const p = uninstallProfile(t, { withCli: false });
  const hook = path.join(p.home, 'hook', 'uninstall.cjs');
  await buildHook(hook);
  let release, acquired;
  const held = new Promise(resolve => {
    release = resolve;
  });
  const leased = new Promise(resolve => {
    acquired = resolve;
  });
  const holder = withFileLock(path.join(p.home, '.coagent8', 'vscode-mcp'), async () => {
    acquired();
    await held;
  });
  await leased;
  const run = runHook(hook, p.home);
  release();
  await holder;
  assert.equal(run.signal, null, 'VS Code does not kill the hook at its five-second limit');
  assert.equal(run.status, 1, 'the profile entries it could not remove are reported');
  const output = JSON.parse(run.stdout);
  assert.match(output.profileError, /lock/);
  assert.equal(output.results.find(r => r.client === 'claude').action, 'removed', 'the client registrations are still removed');
  assert.deepEqual(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers, { other: { command: 'keep' } });
});
test('while setup holds its lease, the vscode:uninstall hook reports the registrations it kept within its time limit', async t => {
  const { withFileLock } = require('../../src/storage/lock.ts');
  const p = uninstallProfile(t, { withCli: false });
  const hook = path.join(p.home, 'hook', 'uninstall.cjs');
  await buildHook(hook);
  let release, acquired;
  const held = new Promise(resolve => {
    release = resolve;
  });
  const leased = new Promise(resolve => {
    acquired = resolve;
  });
  const holder = withFileLock(path.join(p.home, '.coagent8', 'setup'), async () => {
    acquired();
    await held;
  });
  await leased;
  const run = runHook(hook, p.home);
  release();
  await holder;
  assert.equal(run.signal, null, 'VS Code does not kill the hook at its five-second limit');
  assert.equal(run.status, 1, 'the registrations it could not remove are reported');
  const output = JSON.parse(run.stdout);
  assert.match(output.cleanupError, /lock/);
  assert.deepEqual(output.profiles, [], 'the profile cleanup result is still reported');
  assert.ok(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers.coagent8, 'no registration is removed without the lease');
});
test('the vscode:uninstall hook removes the profile entries of its own installation only', async t => {
  const { syncVscodeRegistration } = require('../../src/integrations/vscode-profile.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8 hook installations '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bundle = path.join(home, 'bundle.cjs');
  fs.writeFileSync(bundle, 'bundle');
  const installed = async product => {
    const storagePath = path.join(home, 'AppData', 'Roaming', product, 'User', 'globalStorage', 'okidev.coagent8-mcp');
    const installation = path.join(home, product === 'Code' ? '.vscode' : '.vscode-insiders', 'extensions');
    assert.equal(
      await syncVscodeRegistration({ storagePath, bundle, server: { command: 'node', env: {} }, home, installation, version: '0.6.0' }),
      'registered',
    );
    return path.join(home, 'AppData', 'Roaming', product, 'User', 'mcp.json');
  };
  const stable = await installed('Code'),
    insiders = await installed('Code - Insiders');
  // Laid out as VS Code installs it: <extensions folder>/<extension>/dist/uninstall.cjs.
  const hook = path.join(home, '.vscode', 'extensions', 'okidev.coagent8-mcp-0.6.0', 'dist', 'uninstall.cjs');
  await buildHook(hook);
  const run = runHook(hook, home);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(JSON.parse(run.stdout).profiles, [{ file: stable, action: 'removed' }]);
  assert.deepEqual(parse(fs.readFileSync(stable, 'utf8')).servers, {});
  assert.ok(parse(fs.readFileSync(insiders, 'utf8')).servers.CoAgent8, 'Insiders keeps its entry');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.coagent8', 'vscode-mcp.json'), 'utf8'))), [insiders]);
});
test('the uninstall recognizes its installation recorded through a link under its canonical path', async t => {
  const { syncVscodeRegistration, removeVscodeRegistrations } = require('../../src/integrations/vscode-profile.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-linked-installation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bundle = path.join(home, 'bundle.cjs');
  fs.writeFileSync(bundle, 'bundle');
  const canonical = path.join(home, 'extensions');
  fs.mkdirSync(canonical);
  // VS Code names the folder through a link (macOS /var); the hook's own location is canonical.
  const linked = path.join(home, 'linked-extensions');
  fs.symlinkSync(canonical, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const storagePath = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'okidev.coagent8-mcp');
  assert.equal(
    await syncVscodeRegistration({
      storagePath,
      bundle,
      server: { command: 'node', env: {} },
      home,
      installation: linked,
      version: '0.6.0',
    }),
    'registered',
  );
  const file = path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
  assert.deepEqual(await removeVscodeRegistrations(home, fs.realpathSync.native(canonical), 5000), [{ file, action: 'removed' }]);
  assert.deepEqual(parse(fs.readFileSync(file, 'utf8')).servers, {});
});
test('an installation folder that cannot be resolved does not stop the uninstall of another', async t => {
  const { syncVscodeRegistration, removeVscodeRegistrations } = require('../../src/integrations/vscode-profile.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-unreadable-installation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bundle = path.join(home, 'bundle.cjs');
  fs.writeFileSync(bundle, 'bundle');
  const register = async (product, installation) => {
    fs.mkdirSync(installation, { recursive: true });
    const storagePath = path.join(home, 'AppData', 'Roaming', product, 'User', 'globalStorage', 'okidev.coagent8-mcp');
    assert.equal(
      await syncVscodeRegistration({ storagePath, bundle, server: { command: 'node', env: {} }, home, installation, version: '0.6.0' }),
      'registered',
    );
    return path.join(home, 'AppData', 'Roaming', product, 'User', 'mcp.json');
  };
  const own = path.join(home, 'own-extensions'),
    unreadable = path.join(home, 'unreadable-extensions');
  const stable = await register('Code', own),
    insiders = await register('Code - Insiders', unreadable);
  const realpath = fs.realpathSync.native;
  fs.realpathSync.native = target => {
    if (path.resolve(target) === unreadable)
      throw Object.assign(new Error(`EACCES: permission denied, realpath '${target}'`), { code: 'EACCES' });
    return realpath(target);
  };
  try {
    assert.deepEqual(await removeVscodeRegistrations(home, own, 5000), [{ file: stable, action: 'removed' }]);
  } finally {
    fs.realpathSync.native = realpath;
  }
  assert.ok(parse(fs.readFileSync(insiders, 'utf8')).servers.CoAgent8, 'the other installation keeps its entry');
});
test('without its ownership record, an entry setup wrote is recognized by its shape; the uninstall removes the extension ones', async t => {
  // As found on 2026-10-10: setup.json and the runtime copies were gone, the entries stayed.
  const p = profile(t);
  const storage = path.join(p.home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'okidev.coagent8-mcp');
  const runtime = name => path.join(p.home, '.coagent8', 'runtime', name.repeat(64), 'index.cjs');
  const env = { coagent8_CONFIG: path.join(p.home, '.coagent8', 'config.json'), coagent8_DIR: storage };
  p.write(
    p.files.codex,
    `[mcp_servers.other]\ncommand = "keep"\n\n[mcp_servers.coagent8]\ntool_timeout_sec = 1800\ncommand = 'node'\nargs = ['${runtime('a')}']\n\n[mcp_servers.coagent8.env]\ncoagent8_CONFIG = '${env.coagent8_CONFIG}'\ncoagent8_DIR = '${storage}'\n`,
  );
  p.write(
    p.files.claude,
    JSON.stringify({ mcpServers: { coagent8: { command: 'node', args: [runtime('a')], env }, other: { command: 'keep' } } }),
  );
  const cli = { command: 'node', args: [runtime('b')] };
  p.write(p.files.agy, JSON.stringify({ mcpServers: { coagent8: cli } }));
  const uninstall = { ...p, origin: 'vscode-extension', uninstall: true };
  const preview = await cleanupClients(uninstall);
  assert.deepEqual(Object.fromEntries(preview.results.map(r => [r.client, r.action])), {
    codex: 'remove',
    claude: 'remove',
    agy: 'preserved',
  });
  assert.match(
    preview.results.find(r => r.client === 'agy').message,
    /outside the VS Code extension/,
    'no extension data directory: a coagent8 CLI registration',
  );
  const applied = await cleanupClients({ ...uninstall, apply: preview.token });
  assert.equal(applied.stateError, undefined);
  assert.equal(toml(fs.readFileSync(p.files.codex, 'utf8')).mcp_servers.coagent8, undefined);
  assert.equal(toml(fs.readFileSync(p.files.codex, 'utf8')).mcp_servers.other.command, 'keep');
  assert.deepEqual(parse(fs.readFileSync(p.files.claude, 'utf8')).mcpServers, { other: { command: 'keep' } });
  const cleanup = await cleanupClients({ ...p, clients: ['agy'] });
  assert.equal(cleanup.results[0].action, 'remove', 'coagent8 cleanup recognizes the CLI registration');
  // Any field or variable setup does not write keeps an entry the user's.
  for (const edited of [
    { ...cli, cwd: p.home },
    { ...cli, env: { EXTRA: '1' } },
    { ...cli, args: ['--inspect', path.join(p.home, 'index.cjs')] },
  ]) {
    p.write(p.files.agy, JSON.stringify({ mcpServers: { coagent8: edited } }));
    assert.equal((await cleanupClients({ ...p, clients: ['agy'] })).results[0].action, 'preserved', JSON.stringify(edited));
  }
});
