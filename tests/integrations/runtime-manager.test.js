const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { connect } = require('../helpers/stdio.cjs');
const { compareSemver, newerVersion, isDevSemver } = require('../../src/integrations/runtime-version.ts');
const {
  cleanupUnreferencedRuntimes,
  coagentRootForHome,
  installAndSelectRuntime,
  installAndVerifyRuntimeCopy,
  readRuntimePointer,
  readRuntimeStatus,
  rollbackOrPinRuntime,
  runtimeLeasesDir,
  selectRuntimePointer,
  unpinRuntime,
} = require('../../src/integrations/runtime-manager.ts');

const distBundle = path.resolve(__dirname, '../../dist/index.cjs');

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-rt-mgr-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('full SemVer precedence including prereleases and build metadata', () => {
  const ordered = [
    '0.7.0',
    '0.8.0-alpha',
    '0.8.0-alpha.1',
    '0.8.0-alpha.beta',
    '0.8.0-beta',
    '0.8.0-beta.2',
    '0.8.0-beta.11',
    '0.8.0-rc.1',
    '0.8.0',
    '0.8.1',
  ];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareSemver(ordered[i], ordered[j]), i < j ? -1 : i > j ? 1 : 0, `${ordered[i]} vs ${ordered[j]}`);
      assert.equal(newerVersion(ordered[i], ordered[j]), i > j, `newerVersion(${ordered[i]}, ${ordered[j]})`);
    }
  }
  assert.equal(compareSemver('0.8.0+build.1', '0.8.0+build.2'), 0);
  assert.equal(newerVersion('0.8.0+build.2', '0.8.0+build.1'), false);
  assert.equal(compareSemver('1.0.0-9', '1.0.0-10'), -1);
  assert.equal(compareSemver('1.0.0-9007199254740992', '1.0.0-9007199254740993'), -1);
  assert.equal(compareSemver('1.0.0-9007199254740993', '1.0.0-9007199254740992'), 1);
  assert.equal(compareSemver('1.0.0-9007199254740992', '1.0.0-90071992547409920'), -1);
  assert.equal(isDevSemver('0.8.0-dev.1'), true);
  assert.equal(isDevSemver('0.8.0+dev'), true);
  assert.equal(isDevSemver('0.8.0-beta.1'), false);
  assert.equal(isDevSemver('0.8.0'), false);
});

test('pointer precedence, equal-version hash guard, downgrade guard, dev namespace, and explicit pin/rollback', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const srcA = path.join(home, 'bundle-a.cjs');
  const srcB = path.join(home, 'bundle-b.cjs');
  const srcC = path.join(home, 'bundle-c.cjs');
  fs.writeFileSync(srcA, '/* bundle A */');
  fs.writeFileSync(srcB, '/* bundle B */');
  fs.writeFileSync(srcC, '/* bundle C */');

  // 1. Initial prerelease install
  const first = await installAndSelectRuntime({ home, runtimeSource: srcA, version: '0.8.0-beta.1' });
  assert.equal(first.action, 'installed');
  assert.equal(first.namespace, 'current');
  assert.equal(readRuntimePointer(root, 'current').version, '0.8.0-beta.1');

  // 2. Same version and same hash is a no-op
  const noop = await installAndSelectRuntime({ home, runtimeSource: srcA, version: '0.8.0-beta.1' });
  assert.equal(noop.action, 'noop');

  // 3. Equal version with different hash keeps the incumbent and reports it
  const conflict = await installAndSelectRuntime({ home, runtimeSource: srcB, version: '0.8.0-beta.1' });
  assert.equal(conflict.action, 'kept-incumbent');
  assert.equal(readRuntimePointer(root, 'current').digest, first.digest);
  assert.match(conflict.message, /Kept incumbent/);

  // 4. Higher prerelease and release win
  const beta2 = await installAndSelectRuntime({ home, runtimeSource: srcB, version: '0.8.0-beta.2' });
  assert.equal(beta2.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').digest, beta2.digest);

  const release = await installAndSelectRuntime({ home, runtimeSource: srcC, version: '0.8.0' });
  assert.equal(release.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').digest, release.digest);

  // 5. Downgrade guard: prerelease or older version never switches pointer back
  const downgraded = await installAndSelectRuntime({ home, runtimeSource: srcB, version: '0.8.0-beta.2' });
  assert.equal(downgraded.action, 'downgrade-blocked');
  assert.equal(readRuntimePointer(root, 'current').digest, release.digest);

  // 6. Dev builds route to separate 'dev' namespace and leave 'current' untouched
  const devBuild = await installAndSelectRuntime({ home, runtimeSource: srcA, version: '0.9.0-dev.1' });
  assert.equal(devBuild.namespace, 'dev');
  assert.equal(readRuntimePointer(root, 'dev').version, '0.9.0-dev.1');
  assert.equal(readRuntimePointer(root, 'current').version, '0.8.0');
  await assert.rejects(
    installAndSelectRuntime({ home, runtimeSource: srcA, version: '0.9.0-dev.1', namespace: 'current' }),
    /explicit opt-in/,
  );

  // 7. Explicit pin / rollback persists pin and blocks auto-upgrade until unpinned
  const pinned = await rollbackOrPinRuntime({ home, digest: beta2.digest, version: '0.8.0-beta.2', reason: 'test-rollback' });
  assert.equal(pinned.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').pinned.digest, beta2.digest);

  const blockedByPin = await installAndSelectRuntime({ home, runtimeSource: srcC, version: '0.8.0' });
  assert.equal(blockedByPin.action, 'pinned-blocked');
  assert.equal(readRuntimePointer(root, 'current').digest, beta2.digest);

  await unpinRuntime(home, 'current');
  const afterUnpin = await installAndSelectRuntime({ home, runtimeSource: srcC, version: '0.8.0' });
  assert.equal(afterUnpin.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').digest, release.digest);
});

test('runtime verification checks job helper SHA-256 before switching pointer', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const distDir = path.join(home, 'dist');
  const helperRel = path.join(`win32-${process.arch}`, 'coagent8-job.exe');
  const sourceBundle = path.join(distDir, 'index.cjs');
  const sourceHelper = path.join(distDir, helperRel);
  fs.mkdirSync(path.dirname(sourceHelper), { recursive: true });
  fs.writeFileSync(sourceBundle, '/* bundle with helper */');
  fs.writeFileSync(sourceHelper, 'valid-job-helper-bytes');

  const res = await installAndSelectRuntime({ home, runtimeSource: sourceBundle, version: '0.8.0' });
  assert.equal(res.action, 'installed');
  const copiedHelper = path.join(root, 'runtime', res.digest, helperRel);
  assert.equal(fs.readFileSync(copiedHelper, 'utf8'), 'valid-job-helper-bytes');

  // If the target job helper is locked with corrupt bytes, verification fails before switching pointer
  const dist2 = path.join(home, 'dist2');
  const sourceBundle2 = path.join(dist2, 'index.cjs');
  const sourceHelper2 = path.join(dist2, helperRel);
  fs.mkdirSync(path.dirname(sourceHelper2), { recursive: true });
  fs.writeFileSync(sourceBundle2, '/* bundle 2 */');
  fs.writeFileSync(sourceHelper2, 'expected-helper-v2');
  const digest2 = createHash('sha256').update('/* bundle 2 */').digest('hex');
  const targetHelper2 = path.join(root, 'runtime', digest2, helperRel);
  fs.mkdirSync(path.dirname(targetHelper2), { recursive: true });
  fs.writeFileSync(targetHelper2, 'corrupt-locked-helper');

  const origRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === targetHelper2) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return origRename(from, to);
  });
  assert.throws(() => installAndVerifyRuntimeCopy({ home, runtimeSource: sourceBundle2, version: '0.8.1' }), /verification failed/);
  assert.equal(readRuntimePointer(root, 'current').digest, res.digest, 'pointer never switches on helper verification failure');
});

test('stable launcher runs in-process, preserves immutable getRuntimePath() for child commands, and holds a lease protecting active servers from cleanup', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const bundleV0 = path.join(home, 'v0.cjs');
  const bundleV1 = path.join(home, 'v1.cjs');
  const bundleV2 = path.join(home, 'v2.cjs');
  const realBytes = fs.readFileSync(distBundle, 'utf8');
  fs.writeFileSync(bundleV0, realBytes + '\n// v0\n');
  fs.writeFileSync(bundleV1, realBytes + '\n// v1\n');
  fs.writeFileSync(bundleV2, realBytes + '\n// v2\n');

  // Install v0, then upgrade to v1
  const r0 = await installAndSelectRuntime({ home, runtimeSource: bundleV0, version: '0.7.0' });
  const r1 = await installAndSelectRuntime({ home, runtimeSource: bundleV1, version: '0.7.1' });
  const launcher = r1.launcherPath;
  assert.equal(launcher, path.join(root, 'runtime', 'current', 'index.cjs'));

  // Verify doctor --json via stable launcher reports the resolved immutable <sha256>/index.cjs path
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    coagent8_DIR: path.join(home, 'data'),
    coagent8_CONFIG: path.join(home, 'config.json'),
  };
  const docRun = cp.spawnSync(process.execPath, [launcher, 'doctor', '--scope', 'health', '--json'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(docRun.status, 0, docRun.stderr);
  const docJson = JSON.parse(docRun.stdout);
  assert.equal(
    docJson.runtime_path,
    path.join('~', '.coagent8', 'runtime', r1.digest, 'index.cjs'),
    'getRuntimePath() resolves to immutable copy, not launcher',
  );
  assert.notEqual(docJson.runtime_path, launcher);

  // Start an MCP server through the stable launcher while pointer points at v1
  const conn = connect(process.execPath, [launcher, 'mcp'], { cwd: home, env: childEnv });
  try {
    const init = await conn.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stable-launcher-test', version: '1' },
    });
    assert.equal(init.result.serverInfo.name, 'coagent8');
    conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // While v1 server is running, it holds an active per-process lease for r1.digest
    const statusWhileRunning = readRuntimeStatus(home, 'current');
    assert.ok(
      statusWhileRunning.activeLeases.some(lease => lease.pid === conn.proc.pid && lease.digest === r1.digest),
      'running server holds active runtime lease',
    );

    // Upgrade pointer to v2 while v1 server is still open
    const r2 = await installAndSelectRuntime({ home, runtimeSource: bundleV2, version: '0.8.0' });
    assert.equal(readRuntimePointer(root, 'current').digest, r2.digest);

    // Cleanup removes unused v0, NEVER deletes v1 (active lease) or v2 (active pointer)
    const duringRun = await cleanupUnreferencedRuntimes(root, home, childEnv, { keepStableNamespaces: true });
    assert.equal(fs.existsSync(r0.runtimePath), false, 'unused v0 removed');
    assert.equal(fs.existsSync(r1.runtimePath), true, 'running server v1 preserved by lease');
    assert.equal(fs.existsSync(r2.runtimePath), true, 'pointer target v2 preserved');
    assert.ok(duringRun.removed.includes(r0.digest));
    assert.ok(duringRun.kept.includes(r1.digest));
    assert.ok(duringRun.kept.includes(r2.digest));

    // New invocation through stable launcher uses v2 while old chat keeps v1
    const v2Doc = cp.spawnSync(process.execPath, [launcher, 'doctor', '--scope', 'health', '--json'], {
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    assert.equal(v2Doc.status, 0, v2Doc.stderr);
    assert.equal(
      JSON.parse(v2Doc.stdout).runtime_path,
      path.join('~', '.coagent8', 'runtime', r2.digest, 'index.cjs'),
      'new process uses v2',
    );

    // Close the v1 server cleanly -> its lease is released
    conn.proc.stdin.end();
    await conn.waitForExit(5000);
  } finally {
    await conn.cleanup();
  }

  // Once the v1 server exited, cleanup removes v1
  const afterExit = await cleanupUnreferencedRuntimes(root, home, childEnv, { keepStableNamespaces: true });
  assert.ok(afterExit.removed.includes(r1.digest));
  assert.equal(fs.existsSync(r1.runtimePath), false, 'released v1 runtime removed');
  assert.equal(
    fs.existsSync(readRuntimePointer(root, 'current').digest ? path.join(root, 'runtime', readRuntimePointer(root, 'current').digest) : ''),
    true,
  );
});

test('cleanup reclaims dead PID leases, handles aged PID reuse checks, and preserves copies when references are unreadable', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const bundleA = path.join(home, 'a.cjs');
  const bundleB = path.join(home, 'b.cjs');
  fs.writeFileSync(bundleA, '/* copy A */');
  fs.writeFileSync(bundleB, '/* copy B */');

  const rA = await installAndSelectRuntime({ home, runtimeSource: bundleA, version: '0.7.0' });
  const rB = await installAndSelectRuntime({ home, runtimeSource: bundleB, version: '0.8.0' });

  // Dead PID lease for rA does not protect rA
  const leasesDir = runtimeLeasesDir(root);
  fs.mkdirSync(leasesDir, { recursive: true });
  const deadLease = path.join(leasesDir, '2147483647-dead.json');
  fs.writeFileSync(
    deadLease,
    JSON.stringify({
      schemaVersion: 1,
      pid: 2147483647,
      token: 'dead',
      digest: rA.digest,
      execPath: process.execPath,
      createdAt: Date.now(),
    }),
  );

  // Corrupt/unreadable lease counts as uncertain -> keeps ALL copies
  const corruptLease = path.join(leasesDir, 'corrupt.json');
  fs.writeFileSync(corruptLease, '{ malformed');
  const withCorrupt = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.deepEqual(withCorrupt.removed, [], 'corrupt lease prevents deletion');
  assert.equal(fs.existsSync(rA.runtimePath), true);
  fs.rmSync(corruptLease);

  // Dead lease is reclaimed and rA removed
  const afterDead = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(afterDead.removed.includes(rA.digest));
  assert.equal(fs.existsSync(deadLease), false);
  assert.equal(fs.existsSync(rA.runtimePath), false);

  // Aged lease with live PID (current test process) checked via checkProcessIdentity
  const rA2 = await installAndVerifyRuntimeCopy({ home, runtimeSource: bundleA, version: '0.7.0' });
  fs.mkdirSync(leasesDir, { recursive: true });
  const agedLease = path.join(leasesDir, `${process.pid}-aged.json`);
  fs.writeFileSync(
    agedLease,
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: 'aged',
      digest: rA2.digest,
      execPath: process.execPath,
      createdAt: Date.now() - 120_000,
    }),
  );
  const past = new Date(Date.now() - 120_000);
  fs.utimesSync(agedLease, past, past);

  // Uncertain identity check keeps rA2
  const uncertainRes = await cleanupUnreferencedRuntimes(root, home, process.env, {
    keepStableNamespaces: true,
    checkProcessIdentity: () => 'uncertain',
  });
  assert.ok(uncertainRes.kept.includes(rA2.digest));
  assert.equal(fs.existsSync(rA2.runtimePath), true);

  // Dead identity check (PID reused) reclaims aged lease and removes rA2
  const reusedRes = await cleanupUnreferencedRuntimes(root, home, process.env, {
    keepStableNamespaces: true,
    checkProcessIdentity: () => 'dead',
  });
  assert.ok(reusedRes.removed.includes(rA2.digest));
  assert.equal(fs.existsSync(rA2.runtimePath), false);
  assert.equal(fs.existsSync(rB.runtimePath), true);
});

test('selectRuntimePointer re-verifies target exists and installAndSelectRuntime holds lock through selection', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const srcA = path.join(home, 'a.cjs');
  const srcB = path.join(home, 'b.cjs');
  fs.writeFileSync(srcA, '/* copy A */');
  fs.writeFileSync(srcB, '/* copy B */');

  const copyA = installAndVerifyRuntimeCopy({ home, runtimeSource: srcA, version: '0.7.0' });
  fs.rmSync(copyA.runtimeDir, { recursive: true, force: true });
  await assert.rejects(() => selectRuntimePointer(copyA), /missing before pointer selection/);
  assert.equal(readRuntimePointer(root, 'current'), null, 'missing target never writes a dangling pointer');

  // installAndSelectRuntime holds runtime-lock across install and selection, so cleanup cannot delete in between
  const resB = await installAndSelectRuntime({ home, runtimeSource: srcB, version: '0.8.0' });
  assert.equal(resB.action, 'installed');
  assert.equal(fs.existsSync(resB.runtimePath), true);
  assert.equal(readRuntimePointer(root, 'current').digest, resB.digest);
});

test('direct runtime lease waits for runtime lock, writes lease, and fails safely if lease creation fails', async t => {
  const { withFileLock } = require('../../src/storage/lock.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const bundleBytes = fs.readFileSync(distBundle);
  const digest = createHash('sha256').update(bundleBytes).digest('hex');
  const directDir = path.join(root, 'runtime', digest);
  const directPath = path.join(directDir, 'index.cjs');
  fs.mkdirSync(directDir, { recursive: true });
  fs.writeFileSync(directPath, bundleBytes);

  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    coagent8_DIR: path.join(home, 'data'),
    coagent8_CONFIG: path.join(home, 'config.json'),
  };

  // Hold runtime-lock briefly while launching direct runtime; child waits for lock and succeeds
  let releaseLock;
  let markHeld;
  const heldPromise = new Promise(resolve => {
    markHeld = resolve;
  });
  const lockGate = new Promise(resolve => {
    releaseLock = resolve;
  });
  const lockTask = withFileLock(path.join(root, 'runtime-lock'), async () => {
    markHeld();
    await lockGate;
  });
  await heldPromise;
  setTimeout(releaseLock, 250);

  const conn = connect(process.execPath, [directPath, 'mcp'], { cwd: home, env: childEnv });
  try {
    const init = await conn.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'direct-lease-test', version: '1' },
    });
    assert.equal(init.result.serverInfo.name, 'coagent8');
    await lockTask;
    const status = readRuntimeStatus(home, 'current');
    assert.ok(status.activeLeases.some(lease => lease.pid === conn.proc.pid && lease.digest === digest));
    conn.proc.stdin.end();
    await conn.waitForExit(5000);
  } finally {
    await conn.cleanup();
  }

  // If leases directory is blocked (cannot publish lease), direct runtime fails safely instead of running unleased
  const leasesFile = runtimeLeasesDir(root);
  fs.rmSync(leasesFile, { recursive: true, force: true });
  fs.writeFileSync(leasesFile, 'blocked');
  const failRun = cp.spawnSync(process.execPath, [directPath, 'wait', 'missing-handle'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  assert.notEqual(failRun.status, 0);
  assert.match(failRun.stderr, /Failed to acquire runtime lease/);
});

test('cleanup conservatively retains unreferenced pre-lease copies until grace expires and protects all registration forms', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const bundleV1 = path.join(home, 'v1.cjs');
  fs.writeFileSync(bundleV1, '/* v1 */');
  const active = await installAndSelectRuntime({ home, runtimeSource: bundleV1, version: '0.8.0' });

  // 1. Pre-lease copy without .lease-capable is conservatively retained until grace expires
  const preLeaseSha = 'e'.repeat(64);
  const preLeaseDir = path.join(root, 'runtime', preLeaseSha);
  const preLeaseIndex = path.join(preLeaseDir, 'index.cjs');
  fs.mkdirSync(preLeaseDir, { recursive: true });
  fs.writeFileSync(preLeaseIndex, '/* pre-lease */');

  const firstCleanup = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(firstCleanup.kept.includes(preLeaseSha), 'pre-lease copy retained on first cleanup');
  assert.equal(fs.existsSync(preLeaseIndex), true);

  // Backdate .pre-lease-retired past retention window -> now removed
  const retiredMarker = path.join(preLeaseDir, '.pre-lease-retired');
  const { PRE_LEASE_RETENTION_MS } = require('../../src/integrations/runtime-manager.ts');
  fs.writeFileSync(retiredMarker, JSON.stringify({ retiredAt: Date.now() - PRE_LEASE_RETENTION_MS - 1000 }));
  const secondCleanup = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(secondCleanup.removed.includes(preLeaseSha), 'pre-lease copy removed after grace expires');
  assert.equal(fs.existsSync(preLeaseIndex), false);

  // 2. Cleanup protects copies referenced via command field, shell-wrapped args, and VS Code mcp.json, and aborts on uncertain entries
  const cmdSha = 'c'.repeat(64);
  const shellSha = 'd'.repeat(64);
  const mcpSha = 'f'.repeat(64);
  for (const sha of [cmdSha, shellSha, mcpSha]) {
    const dir = path.join(root, 'runtime', sha);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.cjs'), '/* copy */');
    fs.writeFileSync(path.join(dir, '.lease-capable'), '1\n');
  }

  const claudeConfig = path.join(home, '.claude.json');
  fs.writeFileSync(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        coagent8Direct: { command: path.join(root, 'runtime', cmdSha, 'index.cjs') },
        coagent8Shell: { command: 'sh', args: ['-c', `"${path.join(root, 'runtime', shellSha, 'index.cjs')}" mcp`] },
      },
    }),
  );
  const profileMcp = path.join(home, 'User', 'mcp.json');
  fs.mkdirSync(path.dirname(profileMcp), { recursive: true });
  fs.writeFileSync(
    profileMcp,
    JSON.stringify({ servers: { CoAgent8: { command: 'node', args: [path.join(root, 'runtime', mcpSha, 'index.cjs'), 'mcp'] } } }),
  );
  fs.writeFileSync(path.join(root, 'vscode-mcp.json'), JSON.stringify({ [profileMcp]: { entry: 'x', installation: 'y' } }));

  const protectedRun = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.deepEqual(protectedRun.removed, []);
  for (const sha of [active.digest, cmdSha, shellSha, mcpSha]) {
    assert.ok(protectedRun.kept.includes(sha), `${sha} kept`);
  }

  // Unparseable / undetermined reference in host config preserves all copies
  const unrefSha = '1'.repeat(64);
  fs.mkdirSync(path.join(root, 'runtime', unrefSha), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', unrefSha, 'index.cjs'), '/* unreferenced */');
  fs.writeFileSync(path.join(root, 'runtime', unrefSha, '.lease-capable'), '1\n');
  fs.writeFileSync(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        coagent8Broken: { command: 'sh', args: ['-c', `"${path.join(root, 'runtime', '$VER', 'index.cjs')}"`] },
      },
    }),
  );
  const uncertainRun = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.deepEqual(uncertainRun.removed, []);
  assert.ok(uncertainRun.kept.includes(unrefSha), 'undetermined reference keeps all copies');
});
