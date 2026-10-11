const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('jsonc-parser');
const { hasManualVscodeRegistration, profileMcpFile, removeVscodeRegistrations, syncVscodeRegistration, VSCODE_SERVER_NAME } = require('../../src/integrations/vscode-profile.ts');

/** A VS Code profile with the extension's global storage, a bundle and a separate home. */
function profile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8 vscode profile '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storagePath = path.join(root, 'Code/User/globalStorage/okidev.coagent8-mcp');
  const bundle = path.join(root, 'extension/dist/index.cjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, 'bundle v1');
  const home = path.join(root, 'home');
  const file = profileMcpFile(storagePath);
  const server = { command: 'node', env: { coagent8_DIR: storagePath, coagent8_EDITOR_SETTINGS: '{}' } };
  const sync = (overrides = {}) => syncVscodeRegistration({ storagePath, bundle, server, home, ...overrides });
  const entries = () => parse(fs.readFileSync(file, 'utf8')).servers;
  return { root, storagePath, bundle, home, file, server, sync, entries };
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
  assert.deepEqual(removeVscodeRegistrations(edited.home), [{ file: edited.file, action: 'preserved' }]);
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
    assert.deepEqual(removeVscodeRegistrations(p.home), [{ file: p.file, action: 'preserved' }]);
    assert.equal(fs.readFileSync(p.file, 'utf8'), text, 'uninstall does not remove it');
  }
});

test('an interrupted rewrite leaves an entry recognized by its shape', t => {
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
  assert.equal(fs.existsSync(record), false, 'no stale digest outlives the rewrite');
  assert.equal(p.sync(), 'registered', 'the old entry is still the extension\'s');
  assert.equal(p.sync(), 'current');
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
  assert.deepEqual(removeVscodeRegistrations(p.home), [{ file: p.file, action: 'removed' }]);
  assert.deepEqual(p.entries(), {});
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(removeVscodeRegistrations(p.home), [], 'a repeated cleanup is a no-op');
});

test('a malformed profile mcp.json is preserved', t => {
  const p = profile(t);
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, '{ "servers": ');
  assert.throws(() => p.sync(), /Malformed/);
  assert.equal(fs.readFileSync(p.file, 'utf8'), '{ "servers": ');
});
