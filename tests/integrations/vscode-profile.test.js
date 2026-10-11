const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('jsonc-parser');
const { hasManualVscodeRegistration, profileMcpFile, removeVscodeRegistrations, syncVscodeRegistration, VSCODE_SERVER_NAME } = require('../../src/integrations/vscode-profile.ts');

/**
 * A VS Code profile with the extension's global storage, a bundle and a separate home;
 * `product` and `home` place another installation's profile beside it.
 */
function profile(t, { product = 'Code', home: sharedHome } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8 vscode profile '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storagePath = path.join(root, product, 'User/globalStorage/okidev.coagent8-mcp');
  // The installation's extensions folder, which the uninstall hook knows from its own path.
  const installation = path.join(root, product === 'Code' ? '.vscode' : '.vscode-insiders', 'extensions');
  const bundle = path.join(root, 'extension/dist/index.cjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, 'bundle v1');
  const home = sharedHome ?? path.join(root, 'home');
  const file = profileMcpFile(storagePath);
  const server = { command: 'node', env: { coagent8_DIR: storagePath, coagent8_EDITOR_SETTINGS: '{}' } };
  const sync = (overrides = {}) => syncVscodeRegistration({ storagePath, bundle, server, home, installation, version: '0.6.0', ...overrides });
  const entries = () => parse(fs.readFileSync(file, 'utf8')).servers;
  const remove = () => removeVscodeRegistrations(home, installation);
  return { root, storagePath, bundle, home, installation, file, server, sync, entries, remove };
}

test('the extension keeps one CoAgent8 entry in the profile mcp.json beside the user\'s servers', t => {
  const p = profile(t);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, '{\n  // keep\n  "servers": { "context7": { "type": "http", "url": "https://example.test/mcp" } },\n  "inputs": []\n}\n');
  assert.equal(p.sync(), 'registered');
  const text = fs.readFileSync(p.file, 'utf8');
  assert.match(text, /\/\/ keep/, 'comments survive');
  const entry = p.entries()[VSCODE_SERVER_NAME];
  assert.deepEqual(p.entries().context7, { type: 'http', url: 'https://example.test/mcp' });
  assert.equal(entry.type, 'stdio');
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.env, p.server.env);
  const runtime = entry.args[0];
  assert.ok(runtime.startsWith(path.join(p.storagePath, 'runtime')), 'the bundle copy outlives the extension folder');
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'bundle v1');
  assert.equal(hasManualVscodeRegistration(p.storagePath, []), true, 'the provider steps aside');
  assert.equal(p.sync(), 'current');
  assert.equal(fs.readFileSync(p.file, 'utf8'), text, 'an unchanged definition is not rewritten');

  fs.writeFileSync(p.bundle, 'bundle v2');
  assert.equal(p.sync({ server: { ...p.server, command: 'C:\\Program Files\\nodejs\\node.exe' } }), 'registered');
  const updated = p.entries()[VSCODE_SERVER_NAME];
  assert.equal(updated.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(fs.readFileSync(updated.args[0], 'utf8'), 'bundle v2');
  assert.equal(fs.existsSync(runtime), false, 'the copy the entry no longer starts is removed');
});

test('a user entry is preserved and suppresses the extension entry', t => {
  const p = profile(t);
  assert.equal(p.sync(), 'registered');
  const text = fs.readFileSync(p.file, 'utf8');
  const withManual = text.replace('"servers": {', '"servers": {\n    "my-coagent8": { "command": "node", "args": ["C:/tools/coagent8/index.cjs"] },');
  fs.writeFileSync(p.file, withManual);
  assert.equal(p.sync(), 'manual');
  assert.equal(p.entries()[VSCODE_SERVER_NAME], undefined, 'no second server lists every tool twice');
  assert.ok(p.entries()['my-coagent8']);

  const edited = profile(t);
  edited.sync();
  const servers = edited.entries();
  servers[VSCODE_SERVER_NAME] = { command: 'node', args: ['C:/elsewhere/index.cjs'] };
  fs.writeFileSync(edited.file, JSON.stringify({ servers }));
  assert.equal(edited.sync(), 'manual');
  assert.deepEqual(edited.entries()[VSCODE_SERVER_NAME], { command: 'node', args: ['C:/elsewhere/index.cjs'] }, 'an edited entry is the user\'s');
  assert.deepEqual(edited.remove(), [{ file: edited.file, action: 'preserved' }]);
  assert.ok(edited.entries()[VSCODE_SERVER_NAME]);
});

test('an entry the user edited keeps the runtime copy but is no longer the extension\'s', t => {
  for (const edit of [{ command: 'C:/tools/node.exe' }, { env: { coagent8_DIR: 'C:/mine' } }]) {
    const p = profile(t);
    assert.equal(p.sync(), 'registered');
    const servers = p.entries();
    servers[VSCODE_SERVER_NAME] = { ...servers[VSCODE_SERVER_NAME], ...edit };
    fs.writeFileSync(p.file, JSON.stringify({ servers }, null, 2));
    const text = fs.readFileSync(p.file, 'utf8');
    assert.equal(p.sync(), 'manual', `an entry with an edited ${Object.keys(edit)[0]} is the user's`);
    assert.equal(fs.readFileSync(p.file, 'utf8'), text, 'synchronization does not overwrite it');
    assert.deepEqual(p.remove(), [{ file: p.file, action: 'preserved' }]);
    assert.equal(fs.readFileSync(p.file, 'utf8'), text, 'uninstall does not remove it');
  }
});

test('an interrupted rewrite leaves the entry, old or new, the extension\'s', t => {
  const p = profile(t);
  p.sync();
  const record = path.join(p.home, '.coagent8/vscode-mcp.json');
  fs.writeFileSync(p.bundle, 'bundle v2');
  // Fail the write of mcp.json after the record step, as a crash between the two would.
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === p.file) throw new Error('interrupted');
    return rename(from, to);
  });
  assert.throws(() => p.sync({ server: { ...p.server, command: 'C:/tools/node.exe' } }), /interrupted/);
  t.mock.restoreAll();
  assert.ok(JSON.parse(fs.readFileSync(record, 'utf8'))[p.file].pending, 'the record names the entry being written');
  assert.equal(p.sync(), 'registered', 'the old entry is still the extension\'s');
  assert.equal(p.sync(), 'current');
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8'))[p.file].pending, undefined, 'a completed write clears it');
});

test('consecutive interrupted rewrites keep the entry on disk the extension\'s', t => {
  const p = profile(t);
  p.sync();
  const record = path.join(p.home, '.coagent8/vscode-mcp.json');
  const rename = fs.renameSync;
  // First rewrite: mcp.json is written, its final record write is not.
  let recordWrites = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === record && ++recordWrites === 2) throw new Error('interrupted');
    return rename(from, to);
  });
  assert.throws(() => p.sync({ server: { ...p.server, command: 'C:/tools/b.exe' } }), /interrupted/);
  t.mock.restoreAll();
  assert.equal(p.entries()[VSCODE_SERVER_NAME].command, 'C:/tools/b.exe');
  // Second rewrite to another entry: interrupted before mcp.json is written.
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === p.file) throw new Error('interrupted');
    return rename(from, to);
  });
  assert.throws(() => p.sync({ server: { ...p.server, command: 'C:/tools/c.exe' } }), /interrupted/);
  t.mock.restoreAll();
  assert.equal(p.sync(), 'registered', 'the entry left by the first rewrite is still the extension\'s');
});

test('an edit or removal racing a rewrite stays the user\'s when synchronization retries', t => {
  for (const [race, expected] of [['edit', 'manual'], ['remove', 'declined']]) {
    const p = profile(t);
    p.sync();
    fs.writeFileSync(p.bundle, 'bundle v2');
    const servers = p.entries();
    const user = race === 'edit' ? { servers: { [VSCODE_SERVER_NAME]: { ...servers[VSCODE_SERVER_NAME], command: 'C:/tools/node.exe' } } } : { servers: {} };
    // The user saves mcp.json while the extension prepares its write, as another window would.
    const writeFileSync = fs.writeFileSync;
    let raced = false;
    t.mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (!raced && String(target).startsWith(p.file + '.')) { raced = true; writeFileSync(p.file, JSON.stringify(user)); }
      return writeFileSync(target, ...rest);
    });
    assert.equal(p.sync(), expected, race);
    t.mock.restoreAll();
    assert.ok(raced, race);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.file, 'utf8')), user, `the ${race} is preserved`);
  }
});

test('a workspace that registers CoAgent8 gets no second profile entry; an existing one is kept for the other windows', t => {
  const p = profile(t);
  const workspace = path.join(p.root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/mcp.json'), JSON.stringify({ servers: { coagent8: { command: 'node', args: ['C:/tools/coagent8/index.cjs'] } } }));
  const record = path.join(p.home, '.coagent8/vscode-mcp.json');
  assert.equal(p.sync({ folders: [workspace] }), 'manual', 'the workspace provides CoAgent8');
  assert.equal(fs.existsSync(p.file), false, 'no profile entry duplicates it');
  assert.equal(fs.existsSync(record), false, 'nothing is recorded, so another window still adds the entry');
  assert.equal(p.sync({ folders: [workspace], restore: true }), 'registered', 'a restore the user asked for adds it');
  // The profile entry serves every window of the profile; one workspace never removes it.
  const text = fs.readFileSync(p.file, 'utf8');
  assert.equal(p.sync({ folders: [workspace] }), 'current');
  assert.equal(fs.readFileSync(p.file, 'utf8'), text);
  assert.equal(p.sync({ folders: [] }), 'current', 'and windows without one keep it');
});

test('windows running different builds never rewrite the shared entry in turn', t => {
  const p = profile(t);
  const older = path.join(p.root, 'older/dist/index.cjs');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.writeFileSync(older, 'bundle v0');
  assert.equal(p.sync({ bundle: older, version: '0.5.0' }), 'registered');
  // The updated window activates and writes its build.
  assert.equal(p.sync({ version: '0.6.0' }), 'registered');
  const text = fs.readFileSync(p.file, 'utf8');
  const runtime = p.entries()[VSCODE_SERVER_NAME].args[0];
  // The window not yet reloaded reacts to that write, and later to a settings change.
  assert.equal(p.sync({ bundle: older, version: '0.5.0', adopt: true }), 'current');
  assert.equal(p.sync({ bundle: older, version: '0.5.0' }), 'current', 'an older build never replaces a newer one');
  assert.equal(fs.readFileSync(p.file, 'utf8'), text);
  assert.ok(fs.existsSync(runtime), 'nor deletes its runtime copy');
  assert.equal(p.sync({ version: '0.6.0', adopt: true }), 'current');
});

test('an older window keeps a newer build\'s entry while that build\'s rewrite is interrupted', t => {
  const record = home => path.join(home, '.coagent8/vscode-mcp.json');
  const older = p => {
    const bundle = path.join(p.root, 'older/dist/index.cjs');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, 'bundle v0');
    return { bundle, version: '0.5.0' };
  };
  const rename = fs.renameSync;
  // Interrupted before mcp.json is written: the entry on disk is the newer build's earlier one.
  // Interrupted after it: the entry on disk is the one the record names as pending.
  for (const [moment, failing] of [['before', p => p.file], ['after', p => record(p.home)]]) {
    const p = profile(t);
    assert.equal(p.sync(), 'registered');
    let writes = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === failing(p) && (moment === 'before' || ++writes === 2)) throw new Error('interrupted');
      return rename(from, to);
    });
    assert.throws(() => p.sync({ server: { ...p.server, command: 'C:/tools/node.exe' } }), /interrupted/);
    t.mock.restoreAll();
    const text = fs.readFileSync(p.file, 'utf8');
    const runtime = p.entries()[VSCODE_SERVER_NAME].args[0];
    assert.equal(p.sync(older(p)), 'current', moment);
    assert.equal(fs.readFileSync(p.file, 'utf8'), text, moment);
    assert.ok(fs.existsSync(runtime), moment);
  }
});

test('consecutive interrupted rewrites keep the version of the build that wrote the entry on disk', t => {
  const p = profile(t);
  const older = path.join(p.root, 'older/dist/index.cjs');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.writeFileSync(older, 'bundle v0');
  assert.equal(p.sync({ bundle: older, version: '0.5.0' }), 'registered');
  const record = path.join(p.home, '.coagent8/vscode-mcp.json');
  const rename = fs.renameSync;
  // The update writes mcp.json, then its final record write is interrupted.
  let writes = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === record && ++writes === 2) throw new Error('interrupted');
    return rename(from, to);
  });
  assert.throws(() => p.sync(), /interrupted/);
  t.mock.restoreAll();
  // A settings change of the updated window is interrupted before mcp.json.
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === p.file) throw new Error('interrupted');
    return rename(from, to);
  });
  assert.throws(() => p.sync({ server: { ...p.server, command: 'C:/tools/node.exe' } }), /interrupted/);
  t.mock.restoreAll();
  const text = fs.readFileSync(p.file, 'utf8');
  const runtime = p.entries()[VSCODE_SERVER_NAME].args[0];
  assert.equal(p.sync({ bundle: older, version: '0.5.0' }), 'current', 'the older window keeps the updated entry');
  assert.equal(fs.readFileSync(p.file, 'utf8'), text);
  assert.ok(fs.existsSync(runtime));
});

test('a write by another window of the same build is adopted, not rewritten in turn', t => {
  const p = profile(t);
  const other = { ...p.server, env: { ...p.server.env, coagent8_EXTENSION_PATHS: '{"codex":"C:/other"}' } };
  assert.equal(p.sync(), 'registered');
  assert.equal(p.sync({ server: other }), 'registered', 'the other window writes its environment');
  const text = fs.readFileSync(p.file, 'utf8');
  assert.equal(p.sync({ adopt: true }), 'current', 'this window reacts to that file change without writing back');
  assert.equal(fs.readFileSync(p.file, 'utf8'), text);
  assert.equal(p.sync(), 'registered', 'its own trigger, such as a settings change, still writes');
});

test('an entry the user removed in VS Code stays removed until restored', t => {
  const p = profile(t);
  p.sync();
  fs.writeFileSync(p.file, JSON.stringify({ servers: {} }));
  assert.equal(p.sync(), 'declined');
  assert.equal(p.sync(), 'declined');
  assert.deepEqual(p.entries(), {});
  assert.equal(p.sync({ restore: true }), 'registered');
  assert.ok(p.entries()[VSCODE_SERVER_NAME]);
});

test('uninstall removes unchanged entries and the record; an interrupted record still identifies the entry', t => {
  const p = profile(t);
  p.sync();
  const record = path.join(p.home, '.coagent8/vscode-mcp.json');
  assert.ok(fs.existsSync(record));
  fs.rmSync(record);
  assert.equal(p.sync(), 'current', 'the entry shape identifies it without the record');
  assert.ok(fs.existsSync(record), 'the record is written again');
  assert.deepEqual(p.remove(), [{ file: p.file, action: 'removed' }]);
  assert.deepEqual(p.entries(), {});
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(p.remove(), [], 'a repeated cleanup is a no-op');
});

test('uninstall removes only the entries of its own VS Code installation and keeps the records of others', t => {
  const stable = profile(t);
  const insiders = profile(t, { product: 'Code - Insiders', home: stable.home });
  assert.equal(stable.sync(), 'registered');
  assert.equal(insiders.sync(), 'registered');
  const record = path.join(stable.home, '.coagent8/vscode-mcp.json');
  assert.deepEqual(stable.remove(), [{ file: stable.file, action: 'removed' }]);
  assert.deepEqual(stable.entries(), {});
  assert.ok(insiders.entries()[VSCODE_SERVER_NAME], 'the other installation keeps its entry');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(record, 'utf8'))), [insiders.file], 'and its record');
  assert.equal(insiders.sync(), 'current', 'which still identifies the entry');
  assert.deepEqual(insiders.remove(), [{ file: insiders.file, action: 'removed' }]);
  assert.equal(fs.existsSync(record), false);
});

test('a malformed profile mcp.json is preserved', t => {
  const p = profile(t);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, '{ "servers": ');
  assert.throws(() => p.sync(), /Malformed/);
  assert.equal(fs.readFileSync(p.file, 'utf8'), '{ "servers": ');
});
