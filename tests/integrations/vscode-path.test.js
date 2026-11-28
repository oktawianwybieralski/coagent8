const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  enablePathIntegration,
  disablePathIntegration,
  syncPathShim,
  removePathIntegration,
  readPathRecord,
  DefaultWindowsPathAdapter,
} = require('../../src/integrations/vscode-path.ts');

class MockPathAdapter {
  constructor(initialPath = null, initialKind = 'REG_SZ', isWin = true) {
    this.pathValue = initialPath;
    this.pathKind = initialKind;
    this.win = isWin;
    this.writes = [];
    this.broadcasts = [];
    this.readTimeouts = [];
    this.writeTimeouts = [];
    this.readError = null;
    this.writeError = null;
  }
  isWindows() {
    return this.win;
  }
  ownsHome() {
    return true;
  }
  async readUserPath(timeoutMs) {
    this.readTimeouts.push(timeoutMs);
    if (this.readError) throw this.readError;
    if (this.pathValue === null) return null;
    return { value: this.pathValue, kind: this.pathKind };
  }
  async writeUserPath(value, kind, timeoutMs) {
    this.writeTimeouts.push(timeoutMs);
    if (this.writeError) throw this.writeError;
    this.writes.push({ value, kind, timeoutMs });
    this.pathValue = value;
    this.pathKind = kind;
    // A write that reached the registry but reported failure, e.g. a timed-out readback.
    if (this.failAfterWrite) {
      const error = this.failAfterWrite;
      this.failAfterWrite = this.failAfterWriteAgain ? error : null;
      throw error;
    }
  }
  async broadcastEnvironmentChange(timeoutMs) {
    this.broadcasts.push(timeoutMs);
    return this.broadcastResult ?? true;
  }
}

function validFixtureBundle(tag = 'v1') {
  return [
    `/* bundle ${tag} */`,
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "rl.on('line', line => {",
    '  if (!line.trim()) return;',
    '  const msg = JSON.parse(line);',
    "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'coagent8' } } }) + '\\n');",
    "  else if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'doctor' }] } }) + '\\n');",
    '});',
  ].join('\n');
}

function fixture(t, { product = 'Code', prefix = 'coagent8-path-test-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = path.join(root, product, 'User/globalStorage/okidev.coagent8-mcp');
  const installation = path.join(root, product === 'Code' ? '.vscode' : '.vscode-insiders', 'extensions');
  const bundle = path.join(root, 'extension/dist/index.cjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, validFixtureBundle('v1'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, storage, installation, bundle, home };
}

test('Yes adds one entry and the shim and records them', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\Existing\\bin', 'REG_SZ');
  const res = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );

  assert.equal(res.action, 'enabled');
  assert.equal(res.addedToPath, true);

  // Shim created
  const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
  assert.ok(fs.existsSync(shimPath), 'shim file exists on disk');
  const content = fs.readFileSync(shimPath, 'utf8');
  assert.match(content, /@echo off/);
  assert.match(content, /node/);
  assert.match(content, /index\.cjs/);

  // User PATH updated
  assert.equal(adapter.writes.length, 1);
  const expectedEntry = path.join(f.home, '.coagent8', 'bin');
  assert.equal(adapter.pathValue, `C:\\Existing\\bin;${expectedEntry}`);
  assert.equal(adapter.pathKind, 'REG_SZ');
  assert.equal(adapter.broadcasts.length, 1);

  // installs.json record
  const record = readPathRecord(f.home);
  assert.ok(record);
  assert.equal(record.shimPath, shimPath);
  assert.equal(record.pathEntry, expectedEntry);
  assert.equal(record.addedToPath, true);
  assert.ok(record.shimHash);
  assert.deepEqual(record.installations, [f.installation]);
});

test('the real adapter owns only the account profile, whatever HOME or USERPROFILE say', t => {
  const f = fixture(t);
  const adapter = new DefaultWindowsPathAdapter();
  assert.equal(adapter.ownsHome(os.userInfo().homedir), true);
  assert.equal(adapter.ownsHome(f.home), false, 'a fixture home never reaches HKCU\\Environment');
});

test('enable and remove refuse a home the adapter does not own and change nothing', async t => {
  const f = fixture(t);
  const options = { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' };
  const owned = new MockPathAdapter('C:\\System', 'REG_SZ');
  await enablePathIntegration(options, owned);
  const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
  const record = readPathRecord(f.home);

  const foreign = new MockPathAdapter('C:\\System', 'REG_SZ');
  foreign.ownsHome = () => false;
  await assert.rejects(enablePathIntegration(options, foreign), /does not belong/);
  const removed = await removePathIntegration(f.home, f.installation, 1500, foreign);
  assert.equal(removed.action, 'blocked');
  assert.deepEqual(foreign.writes, [], 'the foreign PATH is never written');
  assert.ok(fs.existsSync(shimPath), 'the shim stays');
  assert.deepEqual(readPathRecord(f.home), record, 'the record stays');
});

test('No and dismissal change nothing and are not asked again', async t => {
  // Verifying configuration state updates for No and dismissal
  const { readSetupState, updateSetupState } = require('../../extensions/vscode/src/configuration.ts');
  const f = fixture(t);

  // Initially undefined
  assert.equal(readSetupState(f.storage).pathPrompt, undefined);

  // User selects No
  await updateSetupState(f.storage, { pathPrompt: 'declined' });
  assert.equal(readSetupState(f.storage).pathPrompt, 'declined');

  // User dismisses
  await updateSetupState(f.storage, { pathPrompt: 'dismissed' });
  assert.equal(readSetupState(f.storage).pathPrompt, 'dismissed');

  // Verify no shim or installs record created
  const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
  assert.equal(fs.existsSync(shimPath), false);
  assert.equal(readPathRecord(f.home), undefined);
});

test('an existing entry is not duplicated', async t => {
  const f = fixture(t);
  const existingEntry = path.join(f.home, '.coagent8', 'bin');
  // Trailing slash normalized
  const adapter = new MockPathAdapter(`C:\\Tools;${existingEntry}\\;C:\\Other`, 'REG_SZ');

  const res = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );

  assert.equal(res.action, 'enabled');
  assert.equal(res.addedToPath, false, 'marked false because it already existed');

  // No write to PATH because it was already present
  assert.equal(adapter.writes.length, 0);
  assert.equal(adapter.broadcasts.length, 0);

  // Record still saved
  const record = readPathRecord(f.home);
  assert.ok(record);
  assert.equal(record.addedToPath, false);
});

test('an expandable PATH keeps its type and other entries', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('%SystemRoot%\\system32;%USERPROFILE%\\bin', 'REG_EXPAND_SZ');

  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );

  assert.equal(adapter.pathKind, 'REG_EXPAND_SZ', 'preserves REG_EXPAND_SZ type');
  const expectedEntry = path.join(f.home, '.coagent8', 'bin');
  assert.equal(adapter.pathValue, `%SystemRoot%\\system32;%USERPROFILE%\\bin;${expectedEntry}`);
});

test('uninstall removes only recorded, unchanged artifacts', async t => {
  // Scenario A: Unmodified shim removed cleanly
  {
    const f = fixture(t);
    const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
    await enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
      adapter,
    );

    const uninstallRes = await removePathIntegration(f.home, f.installation, 1500, adapter);
    assert.equal(uninstallRes.action, 'removed');
    const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
    assert.equal(fs.existsSync(shimPath), false, 'shim deleted');
    assert.equal(adapter.pathValue, 'C:\\System', 'path entry removed');
    assert.equal(readPathRecord(f.home), undefined, 'record removed');
  }

  // Scenario B: User-modified shim is preserved along with PATH entry
  {
    const f = fixture(t);
    const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
    await enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
      adapter,
    );
    const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
    fs.appendFileSync(shimPath, '\r\necho customized\r\n');

    const uninstallRes = await removePathIntegration(f.home, f.installation, 1500, adapter);
    assert.equal(uninstallRes.action, 'preserved');
    assert.ok(fs.existsSync(shimPath), 'customized shim preserved');
    const expectedEntry = path.join(f.home, '.coagent8', 'bin');
    assert.equal(adapter.pathValue, `C:\\System;${expectedEntry}`, 'PATH entry preserved for user shim');
    const record = readPathRecord(f.home);
    assert.equal(record.userRetained, true);
    assert.deepEqual(record.installations, [], 'installations cleared on user retention');
  }

  // Scenario C: Pre-existing PATH entry (addedToPath: false) is preserved on uninstall
  {
    const f = fixture(t);
    const existingEntry = path.join(f.home, '.coagent8', 'bin');
    const adapter = new MockPathAdapter(`C:\\System;${existingEntry}`, 'REG_SZ');
    await enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
      adapter,
    );

    const uninstallRes = await removePathIntegration(f.home, f.installation, 1500, adapter);
    assert.equal(uninstallRes.action, 'removed');
    assert.equal(fs.existsSync(path.join(existingEntry, 'coagent8.cmd')), false, 'shim deleted');
    assert.equal(adapter.pathValue, `C:\\System;${existingEntry}`, 'pre-existing PATH entry kept');
  }

  // Scenario D: Multi-installation isolation (Stable and Insiders)
  {
    const f1 = fixture(t, { product: 'Code' });
    const inst2 = path.join(f1.root, '.vscode-insiders', 'extensions');
    const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');

    // First install (Stable)
    await enablePathIntegration(
      { home: f1.home, storage: f1.storage, installation: f1.installation, bundle: f1.bundle, nodePath: 'node' },
      adapter,
    );

    // Second install (Insiders)
    await enablePathIntegration(
      { home: f1.home, storage: path.join(f1.root, 'Insiders/storage'), installation: inst2, bundle: f1.bundle, nodePath: 'node' },
      adapter,
    );

    const record = readPathRecord(f1.home);
    assert.equal(record.installations.length, 2);

    // Uninstall Stable only
    const res1 = await removePathIntegration(f1.home, f1.installation, 1500, adapter);
    assert.equal(res1.action, 'preserved', 'preserved because Insiders still active');
    assert.ok(fs.existsSync(record.shimPath), 'shim still exists');

    // Uninstall Insiders
    const res2 = await removePathIntegration(f1.home, inst2, 1500, adapter);
    assert.equal(res2.action, 'removed', 'removed now that all installations uninstalled');
    assert.equal(fs.existsSync(record.shimPath), false);
  }
});

test('extension update keeps the shim working via stable path, migrates legacy shims, and repairs dangling shims', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  const { readRuntimePointer } = require('../../src/integrations/runtime-manager.ts');
  const root = path.join(f.home, '.coagent8');

  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node', version: '0.7.0' },
    adapter,
  );

  const initialRecord = readPathRecord(f.home);
  const shimPath = initialRecord.shimPath;
  const initialContent = fs.readFileSync(shimPath, 'utf8');
  assert.ok(initialRecord.runtime.endsWith(path.join('runtime', 'current', 'index.cjs')));
  assert.equal(readRuntimePointer(root, 'current').version, '0.7.0');

  // Update extension with newer bundle -> shim stays at stable path (noop), pointer updates to 0.8.0
  const newBundle = path.join(f.root, 'extension-v2/dist/index.cjs');
  fs.mkdirSync(path.dirname(newBundle), { recursive: true });
  fs.writeFileSync(newBundle, validFixtureBundle('v2 - new code'));

  const syncRes = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: 'node', version: '0.8.0' },
    adapter,
  );
  assert.equal(syncRes.action, 'noop');
  assert.equal(fs.readFileSync(shimPath, 'utf8'), initialContent, 'stable shim path does not change on update');
  assert.equal(readRuntimePointer(root, 'current').version, '0.8.0');

  // Downgrade guard: an older extension never switches pointer back to 0.7.0
  const downgradeSync = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node', version: '0.7.0' },
    adapter,
  );
  assert.equal(downgradeSync.action, 'noop');
  assert.equal(readRuntimePointer(root, 'current').version, '0.8.0');

  // Legacy dangling shim (pointing at deleted <sha256>/index.cjs) is repaired and migrated to stable path
  const { hash } = require('../../src/integrations/setup-storage.ts');
  const missingLegacy = path.join(root, 'runtime', 'd'.repeat(64), 'index.cjs');
  const legacyShim = `@echo off\r\n"node" "${missingLegacy}" %*\r\n`;
  fs.writeFileSync(shimPath, legacyShim);
  const installs = JSON.parse(fs.readFileSync(path.join(root, 'installs.json'), 'utf8'));
  const prevRecord = installs.pathV2 ?? installs.path;
  installs.path = {
    shimPath: prevRecord.shimPath,
    pathEntry: prevRecord.pathEntry,
    runtime: missingLegacy,
    addedToPath: prevRecord.addedToPath,
    shimHash: hash(legacyShim),
    installations: prevRecord.installations,
  };
  delete installs.pathV2;
  fs.writeFileSync(path.join(root, 'installs.json'), JSON.stringify(installs, null, 2));

  const repaired = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: 'node', version: '0.8.0' },
    adapter,
  );
  assert.equal(repaired.action, 'updated');
  assert.equal(fs.readFileSync(shimPath, 'utf8'), initialContent, 'repaired shim points at stable launcher');
  assert.ok(fs.existsSync(path.join(root, 'runtime', 'current', 'index.cjs')));
  assert.ok(fs.existsSync(path.join(root, 'runtime', readRuntimePointer(root, 'current').digest, 'index.cjs')));

  // Migrated ownership representation in installs.json is unrecognizable to old writers (no legacy `path` key)
  const migratedInstalls = JSON.parse(fs.readFileSync(path.join(root, 'installs.json'), 'utf8'));
  assert.equal(migratedInstalls.path, undefined, 'legacy path record removed so old writers cannot recognize or overwrite shim');
  assert.equal(typeof migratedInstalls.pathV2?.shimDigest, 'string');
  assert.equal(migratedInstalls.pathV2?.shimHash, undefined);
  assert.ok(readPathRecord(f.home), 'current reader still reads migrated ownership record');

  // If user modifies the shim, update will NOT overwrite it
  fs.appendFileSync(shimPath, '\r\n:: user edit\r\n');
  const syncModified = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: 'node', version: '0.9.0' },
    adapter,
  );
  assert.equal(syncModified.action, 'preserved', 'user modified shim is preserved during update');
  assert.match(fs.readFileSync(shimPath, 'utf8'), /:: user edit/);
});

test('enablePathIntegration refuses to overwrite unowned file or modified shim', async t => {
  const f = fixture(t);
  const binDir = path.join(f.home, '.coagent8', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, 'coagent8.cmd');
  fs.writeFileSync(shimPath, 'echo unowned');

  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  await assert.rejects(
    () =>
      enablePathIntegration(
        { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
        adapter,
      ),
    /Cannot overwrite unowned file/,
  );
  assert.equal(adapter.writes.length, 0);
  assert.equal(fs.readFileSync(shimPath, 'utf8'), 'echo unowned');
});

test('removePathIntegration reports blocked, retains installation and restores shim if registry removal fails, then succeeds on retry', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );

  const initialRecord = readPathRecord(f.home);
  assert.ok(initialRecord);
  const shimPath = initialRecord.shimPath;
  assert.ok(fs.existsSync(shimPath), 'shim exists before removal attempt');

  // Simulate registry failure
  adapter.writeUserPath = async () => {
    throw new Error('Registry access denied');
  };
  const res = await removePathIntegration(f.home, f.installation, 1500, adapter);
  assert.equal(res.action, 'blocked');
  assert.match(res.message, /Registry access denied/);

  // Ownership record and installation list preserved for retry
  const preservedRecord = readPathRecord(f.home);
  assert.ok(preservedRecord, 'ownership record preserved for recovery');
  assert.deepEqual(preservedRecord.installations, [f.installation], 'installation retained so subsequent uninstall can retry');
  assert.ok(fs.existsSync(shimPath), 'shim restored on registry failure');

  // Fix adapter and retry removal
  adapter.writeUserPath = async (val, kind) => {
    adapter.writes.push({ value: val, kind });
    adapter.pathValue = val;
    adapter.pathKind = kind;
  };

  const retryRes = await removePathIntegration(f.home, f.installation, 1500, adapter);
  assert.equal(retryRes.action, 'removed', 'retry succeeds once registry write works');
  assert.equal(readPathRecord(f.home), undefined, 'record removed after successful retry');
  assert.equal(fs.existsSync(shimPath), false, 'shim deleted after successful retry');
});

test('syncPathShim restores previous shim content if record write fails', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );

  const initialRecord = readPathRecord(f.home);
  const originalShimContent = fs.readFileSync(initialRecord.shimPath, 'utf8');

  const newBundle = path.join(f.root, 'extension-v2/dist/index.cjs');
  fs.mkdirSync(path.dirname(newBundle), { recursive: true });
  fs.writeFileSync(newBundle, validFixtureBundle('new runtime bundle'));

  // Intercept renameSync targeting installs.json to test record write failure rollback
  const origRename = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    if (String(newPath).endsWith('installs.json')) {
      throw new Error('Disk write failed');
    }
    return origRename(oldPath, newPath);
  };

  try {
    await assert.rejects(
      () =>
        syncPathShim(
          { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: process.execPath },
          adapter,
        ),
      /Disk write failed/,
    );
  } finally {
    fs.renameSync = origRename;
  }

  assert.equal(fs.readFileSync(initialRecord.shimPath, 'utf8'), originalShimContent, 'previous shim content restored');
});

test('non-ASCII and unicode PATH entries are preserved without corruption', async t => {
  const f = fixture(t);
  const unicodePath = 'C:\\Narzędzia\\bin;C:\\Zażółć\\Gęślą\\Jaźń;%USERPROFILE%\\bin';
  const adapter = new MockPathAdapter(unicodePath, 'REG_EXPAND_SZ');

  const res = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );

  assert.equal(res.action, 'enabled');
  assert.equal(res.addedToPath, true);
  const expectedEntry = path.join(f.home, '.coagent8', 'bin');
  assert.equal(adapter.pathValue, `${unicodePath};${expectedEntry}`);
  assert.equal(adapter.pathKind, 'REG_EXPAND_SZ');

  // Uninstall removes only the added entry, keeping non-ASCII and expandable vars intact
  const uninst = await removePathIntegration(f.home, f.installation, 1500, adapter);
  assert.equal(uninst.action, 'removed');
  assert.equal(adapter.pathValue, unicodePath);
  assert.equal(adapter.pathKind, 'REG_EXPAND_SZ');
});

test('enablePathIntegration fails closed and preserves user PATH when registry read fails', async t => {
  const f = fixture(t);
  const initialPath = 'C:\\Important\\Bin;C:\\System32';
  const adapter = new MockPathAdapter(initialPath, 'REG_SZ');
  adapter.readError = new Error('Simulated registry query failure');

  await assert.rejects(
    () =>
      enablePathIntegration(
        { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
        adapter,
      ),
    /Simulated registry query failure/,
  );

  assert.equal(adapter.writes.length, 0, 'no registry writes attempted');
  assert.equal(adapter.pathValue, initialPath, 'user PATH completely preserved');
});

test('removePathIntegration allocates remaining deadline budget to registry operations', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  const enableRes = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );
  assert.equal(enableRes.action, 'enabled');

  const deadline = Date.now() + 3800;
  const uninst = await removePathIntegration(f.home, f.installation, 1500, adapter, deadline);
  assert.equal(uninst.action, 'removed');

  // Verify that timeouts passed to readUserPath and writeUserPath are NOT capped at 1000ms
  const readTimeout = adapter.readTimeouts[adapter.readTimeouts.length - 1];
  const writeTimeout = adapter.writeTimeouts[adapter.writeTimeouts.length - 1];
  assert.ok(readTimeout > 2000, `readTimeout should be > 2000ms, got ${readTimeout}`);
  assert.ok(writeTimeout > 2000, `writeTimeout should be > 2000ms, got ${writeTimeout}`);
  assert.equal(adapter.broadcasts[adapter.broadcasts.length - 1], 1500, 'the uninstall broadcast is bounded to 1500 ms');
});

test('enablePathIntegration rolls back shim and record when writeUserPath fails', async t => {
  const f = fixture(t);
  const initialPath = 'C:\\Important\\Bin';
  const adapter = new MockPathAdapter(initialPath, 'REG_SZ');
  adapter.writeError = new Error('Simulated registry write failure');

  await assert.rejects(
    () =>
      enablePathIntegration(
        { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
        adapter,
      ),
    /Simulated registry write failure/,
  );

  const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
  assert.equal(fs.existsSync(shimPath), false, 'shim rolled back on write failure');
  const record = readPathRecord(f.home);
  assert.equal(record, undefined, 'ownership record rolled back on write failure');
  assert.equal(adapter.pathValue, initialPath, 'user PATH unchanged');
});

test('a write that reached the registry before failing is taken out again and rolled back', async t => {
  const f = fixture(t);
  const initialPath = 'C:\\Important\\Bin';
  const adapter = new MockPathAdapter(initialPath, 'REG_SZ');
  adapter.failAfterWrite = new Error('Simulated readback timeout');
  await assert.rejects(
    enablePathIntegration({ home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' }, adapter),
    /Simulated readback timeout/,
  );
  assert.equal(adapter.pathValue, initialPath, 'the entry that reached the registry is removed');
  assert.equal(fs.existsSync(path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd')), false);
  assert.equal(readPathRecord(f.home), undefined);
});

test('an entry that may remain after a failed write stays recorded so it can be removed later', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\Important\\Bin', 'REG_SZ');
  adapter.failAfterWrite = new Error('Simulated readback timeout');
  adapter.failAfterWriteAgain = true;
  await assert.rejects(
    enablePathIntegration({ home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' }, adapter),
    /may remain and is still recorded for removal/,
  );
  const record = readPathRecord(f.home);
  assert.ok(record, 'the ownership record stays');
  assert.equal(record.addedToPath, true);
  assert.ok(fs.existsSync(record.shimPath), 'the shim stays');

  adapter.failAfterWrite = null;
  const removed = await removePathIntegration(f.home, f.installation, 1500, adapter);
  assert.equal(removed.action, 'removed');
  assert.equal(adapter.pathValue, 'C:\\Important\\Bin', 'a later removal takes the entry out');
});

test('a broadcast that is not delivered is reported, not treated as a failure', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  adapter.broadcastResult = false;
  const enabled = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );
  assert.equal(enabled.action, 'enabled');
  assert.equal(enabled.environmentNotified, false);
  assert.equal(adapter.broadcasts[0], 5000, 'enable allows five seconds for PowerShell to start and broadcast');
  const removed = await removePathIntegration(f.home, f.installation, 1500, adapter);
  assert.equal(removed.action, 'removed');
  assert.equal(removed.environmentNotified, false);
});

test('the real broadcast reports a PowerShell that cannot start instead of throwing', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const adapter = new DefaultWindowsPathAdapter(path.join(f.root, 'missing-powershell.exe'));
  assert.equal(await adapter.broadcastEnvironmentChange(500), false);
});

test('removePathIntegration prunes unreferenced runtime copies on removal', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  const enableRes = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter,
  );
  assert.equal(enableRes.action, 'enabled');

  const record = readPathRecord(f.home);
  assert.ok(record.runtime, 'runtime copy established');
  assert.equal(fs.existsSync(record.runtime), true, 'runtime exists on disk');
  const runtimeDir = path.dirname(record.runtime);

  const uninst = await removePathIntegration(f.home, f.installation, 1500, adapter);
  assert.equal(uninst.action, 'removed');
  const root = path.join(f.home, '.coagent8');
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false, 'unreferenced runtime copies and stable launcher pruned on uninstall');
  assert.equal(fs.existsSync(root), false, '~/.coagent8 completely removed when nothing remains');
});

test('pruneUnreferencedRuntimes throws on corrupt installs.json and deletes no runtime copies', async t => {
  const f = fixture(t);
  const root = path.join(f.home, '.coagent8');
  const runtimes = path.join(root, 'runtime');
  const dummySha = 'a'.repeat(64);
  const dummyRuntimeDir = path.join(runtimes, dummySha);
  fs.mkdirSync(dummyRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(dummyRuntimeDir, 'index.cjs'), 'dummy runtime');

  // Corrupt installs.json
  const installsFile = path.join(root, 'installs.json');
  fs.writeFileSync(installsFile, 'not valid json {{{');

  const { pruneUnreferencedRuntimes } = require('../../src/integrations/cleanup.ts');
  await assert.rejects(() => pruneUnreferencedRuntimes(root, f.home), /Malformed installs.json/);

  assert.equal(fs.existsSync(dummyRuntimeDir), true, 'runtime preserved when installs.json is corrupt');
});

test('pruneUnreferencedRuntimes keeps every runtime when the PATH record has no readable runtime', async t => {
  const f = fixture(t);
  const root = path.join(f.home, '.coagent8');
  const dummyRuntimeDir = path.join(root, 'runtime', 'b'.repeat(64));
  fs.mkdirSync(dummyRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(dummyRuntimeDir, 'index.cjs'), 'dummy runtime');
  const { pruneUnreferencedRuntimes } = require('../../src/integrations/cleanup.ts');
  for (const record of [{ path: { shimPath: 'x', shimHash: 'y', installations: [] } }, { path: { runtime: 7 } }, { path: null }, []]) {
    fs.writeFileSync(path.join(root, 'installs.json'), JSON.stringify(record));
    await assert.rejects(() => pruneUnreferencedRuntimes(root, f.home), /Malformed/);
    assert.equal(fs.existsSync(dummyRuntimeDir), true, `runtime kept for ${JSON.stringify(record)}`);
  }
});

test(
  'Windows PATH shim executes the real bundle across an extension update without changing shim bytes',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = fixture(t, { prefix: 'coagent8 path test ' });
    const cp = require('node:child_process');
    const distBundle = path.resolve(__dirname, '../../dist/index.cjs');
    const bundleV1 = path.join(f.root, 'ext-v1', 'dist', 'index.cjs');
    const bundleV2 = path.join(f.root, 'ext-v2', 'dist', 'index.cjs');
    const distText = fs.readFileSync(distBundle, 'utf8');
    fs.mkdirSync(path.dirname(bundleV1), { recursive: true });
    fs.mkdirSync(path.dirname(bundleV2), { recursive: true });
    fs.writeFileSync(bundleV1, distText + '\n// v1\n');
    fs.writeFileSync(bundleV2, distText + '\n// v2\n');

    const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
    await enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: bundleV1, nodePath: process.execPath, version: '0.7.0' },
      adapter,
    );
    const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
    assert.ok(shimPath.includes(' '), 'shim path contains a space to verify safe cmd quoting');
    const shimBytesBefore = fs.readFileSync(shimPath, 'utf8');
    const childEnv = { ...process.env, HOME: f.home, USERPROFILE: f.home, coagent8_DIR: path.join(f.home, 'data') };

    const run1 = cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', shimPath, 'doctor', '--scope', 'health', '--json'], {
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(run1.status, 0, run1.stderr);
    const rt1 = JSON.parse(run1.stdout).runtime_path;

    const syncRes = await syncPathShim(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: bundleV2, nodePath: process.execPath, version: '0.8.0' },
      adapter,
    );
    assert.equal(syncRes.action, 'noop');
    assert.equal(fs.readFileSync(shimPath, 'utf8'), shimBytesBefore, 'shim bytes unchanged on update');

    const run2 = cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', shimPath, 'doctor', '--scope', 'health', '--json'], {
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(run2.status, 0, run2.stderr);
    const rt2 = JSON.parse(run2.stdout).runtime_path;
    assert.notEqual(rt2, rt1, 'shim invokes the newly updated runtime copy');
  },
);

test('enablePathIntegration probes runtime before switching pointer, keeps incumbent on failure, and reports a clear error', async t => {
  const { readRuntimePointer, coagentRootForHome } = require('../../src/integrations/runtime-manager.ts');

  // 1. No incumbent: broken bundle fails verification before publishing pointer, shim, record, or PATH.
  {
    const f = fixture(t);
    const brokenBundle = path.join(f.root, 'broken/dist/index.cjs');
    fs.mkdirSync(path.dirname(brokenBundle), { recursive: true });
    fs.writeFileSync(brokenBundle, 'process.exit(1);\n');
    const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');

    await assert.rejects(
      () =>
        enablePathIntegration(
          {
            home: f.home,
            storage: f.storage,
            installation: f.installation,
            bundle: brokenBundle,
            nodePath: process.execPath,
            version: '0.8.0',
          },
          adapter,
        ),
      /Runtime verification failed:.*Probe process exited/,
    );
    const root = coagentRootForHome(f.home);
    assert.equal(readRuntimePointer(root, 'current'), null, 'no pointer published for unverified bundle');
    assert.equal(fs.existsSync(path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd')), false, 'no shim written');
    assert.equal(readPathRecord(f.home), undefined, 'no installs.json path record written');
    assert.equal(adapter.writes.length, 0, 'PATH untouched');
  }

  // 2. Existing healthy incumbent (0.7.0): newer broken bundle (0.8.0) keeps incumbent pointer and existing PATH/shim intact.
  {
    const f = fixture(t);
    const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
    await enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: process.execPath, version: '0.7.0' },
      adapter,
    );
    const root = coagentRootForHome(f.home);
    const incumbentBefore = readRuntimePointer(root, 'current');
    assert.equal(incumbentBefore.version, '0.7.0');
    const recordBefore = readPathRecord(f.home);
    const shimBefore = fs.readFileSync(recordBefore.shimPath, 'utf8');
    const writesBefore = adapter.writes.length;

    const brokenNewer = path.join(f.root, 'ext-v2/dist/index.cjs');
    fs.mkdirSync(path.dirname(brokenNewer), { recursive: true });
    fs.writeFileSync(
      brokenNewer,
      [
        "const rl = require('node:readline').createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        '  if (!line.trim()) return;',
        '  const msg = JSON.parse(line);',
        "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'other-server' } } }) + '\\n');",
        '});',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        enablePathIntegration(
          {
            home: f.home,
            storage: f.storage,
            installation: path.join(f.root, '.vscode-insiders', 'extensions'),
            bundle: brokenNewer,
            nodePath: process.execPath,
            version: '0.8.0',
          },
          adapter,
        ),
      /Runtime verification failed:.*not CoAgent8/,
    );
    assert.deepEqual(readRuntimePointer(root, 'current'), incumbentBefore, 'incumbent pointer preserved on probe failure');
    assert.equal(fs.readFileSync(recordBefore.shimPath, 'utf8'), shimBefore, 'shim preserved');
    assert.deepEqual(readPathRecord(f.home), recordBefore, 'path record preserved');
    assert.equal(adapter.writes.length, writesBefore, 'no extra PATH write');
  }
});

test('syncPathShim keeps healthy retained incumbent and refuses to publish unverified bundle when incumbent is missing', async t => {
  const {
    installAndSelectVerifiedRuntime,
    readRuntimePointer,
    coagentRootForHome,
    runtimePointerPath,
  } = require('../../src/integrations/runtime-manager.ts');
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  const root = coagentRootForHome(f.home);

  // Establish 0.7.0 PATH shim via older installation, then a newer 0.8.0 installation becomes the incumbent pointer.
  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: process.execPath, version: '0.7.0' },
    adapter,
  );
  const v2Bundle = path.join(f.root, 'ext-v2/dist/index.cjs');
  fs.mkdirSync(path.dirname(v2Bundle), { recursive: true });
  fs.writeFileSync(v2Bundle, validFixtureBundle('v2'));
  const v2 = await installAndSelectVerifiedRuntime({
    home: f.home,
    runtimeSource: v2Bundle,
    version: '0.8.0',
    nodePath: process.execPath,
  });
  assert.equal(readRuntimePointer(root, 'current').digest, v2.digest);

  // Syncing the older 0.7.0 installation keeps the retained 0.8.0 incumbent and probes the launcher.
  const syncRetained = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: process.execPath, version: '0.7.0' },
    adapter,
  );
  assert.equal(syncRetained.action, 'noop');
  assert.equal(readRuntimePointer(root, 'current').digest, v2.digest, 'retained 0.8.0 incumbent preserved');

  // Migrating a legacy shim during older 0.7.0 sync also preserves the retained 0.8.0 incumbent and records 0.8.0.
  const { hash } = require('../../src/integrations/setup-storage.ts');
  const shimPath = readPathRecord(f.home).shimPath;
  const legacyTarget = path.join(root, 'runtime', 'c'.repeat(64), 'index.cjs');
  const legacyShim = `@echo off\r\n"${process.execPath}" "${legacyTarget}" %*\r\n`;
  fs.writeFileSync(shimPath, legacyShim);
  const installs = JSON.parse(fs.readFileSync(path.join(root, 'installs.json'), 'utf8'));
  const prevRecord = installs.pathV2 ?? installs.path;
  installs.path = {
    shimPath: prevRecord.shimPath,
    pathEntry: prevRecord.pathEntry,
    runtime: legacyTarget,
    addedToPath: prevRecord.addedToPath,
    shimHash: hash(legacyShim),
    installations: prevRecord.installations,
  };
  delete installs.pathV2;
  fs.writeFileSync(path.join(root, 'installs.json'), JSON.stringify(installs, null, 2));
  const syncMigrated = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: process.execPath, version: '0.7.0' },
    adapter,
  );
  assert.equal(syncMigrated.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').digest, v2.digest, 'retained 0.8.0 incumbent preserved across legacy shim migration');
  assert.equal(readPathRecord(f.home).version, '0.8.0', 'migrated PATH record reflects retained incumbent version');

  // If the incumbent pointer disappears and the bundle for syncPathShim fails probe, syncPathShim never publishes it.
  fs.rmSync(runtimePointerPath(root, 'current'), { force: true });
  const brokenBundle = path.join(f.root, 'broken/dist/index.cjs');
  fs.mkdirSync(path.dirname(brokenBundle), { recursive: true });
  fs.writeFileSync(brokenBundle, 'process.exit(1);\n');
  await assert.rejects(
    () =>
      syncPathShim(
        {
          home: f.home,
          storage: f.storage,
          installation: f.installation,
          bundle: brokenBundle,
          nodePath: process.execPath,
          version: '0.9.0',
        },
        adapter,
      ),
    /Runtime verification failed:.*Probe process exited/,
  );
  assert.equal(readRuntimePointer(root, 'current'), null, 'unverified bundle is not published by syncPathShim');
});
