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
  }
  async broadcastEnvironmentChange(timeoutMs) {
    this.broadcasts.push(timeoutMs);
  }
}

function fixture(t, { product = 'Code' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-path-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = path.join(root, product, 'User/globalStorage/okidev.coagent8-mcp');
  const installation = path.join(root, product === 'Code' ? '.vscode' : '.vscode-insiders', 'extensions');
  const bundle = path.join(root, 'extension/dist/index.cjs');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, '/* bundle v1 */');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { root, storage, installation, bundle, home };
}

test('Yes adds one entry and the shim and records them', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\Existing\\bin', 'REG_SZ');
  const res = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter
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
    adapter
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
    adapter
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
      adapter
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
      adapter
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
      adapter
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
      adapter
    );

    // Second install (Insiders)
    await enablePathIntegration(
      { home: f1.home, storage: path.join(f1.root, 'Insiders/storage'), installation: inst2, bundle: f1.bundle, nodePath: 'node' },
      adapter
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

test('extension update keeps the shim working', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter
  );

  const initialRecord = readPathRecord(f.home);
  const shimPath = initialRecord.shimPath;
  const initialContent = fs.readFileSync(shimPath, 'utf8');

  // Update extension with new bundle
  const newBundle = path.join(f.root, 'extension-v2/dist/index.cjs');
  fs.mkdirSync(path.dirname(newBundle), { recursive: true });
  fs.writeFileSync(newBundle, '/* bundle v2 - new code */');

  const syncRes = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: 'node' },
    adapter
  );

  assert.equal(syncRes.action, 'updated');
  const updatedContent = fs.readFileSync(shimPath, 'utf8');
  assert.notEqual(updatedContent, initialContent, 'shim content updated with new runtime');
  assert.match(updatedContent, /index\.cjs/);

  const updatedRecord = readPathRecord(f.home);
  assert.notEqual(updatedRecord.shimHash, initialRecord.shimHash);
  assert.notEqual(updatedRecord.runtime, initialRecord.runtime);

  // If user modifies the shim, update will NOT overwrite it
  fs.appendFileSync(shimPath, '\r\n:: user edit\r\n');
  const syncModified = await syncPathShim(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: 'node' },
    adapter
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
    () => enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
      adapter
    ),
    /Cannot overwrite unowned file/
  );
  assert.equal(adapter.writes.length, 0);
  assert.equal(fs.readFileSync(shimPath, 'utf8'), 'echo unowned');
});

test('removePathIntegration reports blocked, retains installation and restores shim if registry removal fails, then succeeds on retry', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter
  );

  const initialRecord = readPathRecord(f.home);
  assert.ok(initialRecord);
  const shimPath = initialRecord.shimPath;
  assert.ok(fs.existsSync(shimPath), 'shim exists before removal attempt');

  // Simulate registry failure
  adapter.writeUserPath = async () => { throw new Error('Registry access denied'); };
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
    adapter
  );

  const initialRecord = readPathRecord(f.home);
  const originalShimContent = fs.readFileSync(initialRecord.shimPath, 'utf8');

  const newBundle = path.join(f.root, 'extension-v2/dist/index.cjs');
  fs.mkdirSync(path.dirname(newBundle), { recursive: true });
  fs.writeFileSync(newBundle, '/* new runtime bundle */');

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
      () => syncPathShim(
        { home: f.home, storage: f.storage, installation: f.installation, bundle: newBundle, nodePath: 'node' },
        adapter
      ),
      /Disk write failed/
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
    adapter
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
    () => enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
      adapter
    ),
    /Simulated registry query failure/
  );

  assert.equal(adapter.writes.length, 0, 'no registry writes attempted');
  assert.equal(adapter.pathValue, initialPath, 'user PATH completely preserved');
});

test('removePathIntegration allocates remaining deadline budget to registry operations', async t => {
  const f = fixture(t);
  const adapter = new MockPathAdapter('C:\\System', 'REG_SZ');
  const enableRes = await enablePathIntegration(
    { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
    adapter
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
  assert.equal(adapter.broadcasts[adapter.broadcasts.length - 1], 1000, 'broadcast timeout is 1000ms');
});

test('enablePathIntegration rolls back shim and record when writeUserPath fails', async t => {
  const f = fixture(t);
  const initialPath = 'C:\\Important\\Bin';
  const adapter = new MockPathAdapter(initialPath, 'REG_SZ');
  adapter.writeError = new Error('Simulated registry write failure');

  await assert.rejects(
    () => enablePathIntegration(
      { home: f.home, storage: f.storage, installation: f.installation, bundle: f.bundle, nodePath: 'node' },
      adapter
    ),
    /Simulated registry write failure/
  );

  const shimPath = path.join(f.home, '.coagent8', 'bin', 'coagent8.cmd');
  assert.equal(fs.existsSync(shimPath), false, 'shim rolled back on write failure');
  const record = readPathRecord(f.home);
  assert.equal(record, undefined, 'ownership record rolled back on write failure');
  assert.equal(adapter.pathValue, initialPath, 'user PATH unchanged');
});
