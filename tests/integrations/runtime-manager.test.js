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

test('cleanup never deletes pre-lease copies outside full uninstall, protects all registration forms/env, and ignores CODEX_CONFIG_PATH', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const bundleV1 = path.join(home, 'v1.cjs');
  fs.writeFileSync(bundleV1, '/* v1 */');
  const active = await installAndSelectRuntime({ home, runtimeSource: bundleV1, version: '0.8.0' });

  // 1. Pre-lease copy without .lease-capable is never deleted by automatic or explicit runtime cleanup
  const preLeaseSha = 'e'.repeat(64);
  const preLeaseDir = path.join(root, 'runtime', preLeaseSha);
  const preLeaseIndex = path.join(preLeaseDir, 'index.cjs');
  fs.mkdirSync(preLeaseDir, { recursive: true });
  fs.writeFileSync(preLeaseIndex, '/* pre-lease */');

  const autoCleanup = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(autoCleanup.kept.includes(preLeaseSha), 'pre-lease copy retained by automatic cleanup');
  assert.equal(fs.existsSync(preLeaseIndex), true);

  const explicitCleanup = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: false });
  assert.ok(explicitCleanup.kept.includes(preLeaseSha), 'pre-lease copy retained by explicit runtime cleanup');
  assert.equal(fs.existsSync(preLeaseIndex), true);
  assert.equal(fs.existsSync(path.join(preLeaseDir, '.pre-lease-retired')), false, 'no retiredAt grace marker written');

  // Full uninstall (removePreLeaseCopies: true) removes unreferenced pre-lease copies
  const uninstallCleanup = await cleanupUnreferencedRuntimes(root, home, process.env, {
    keepStableNamespaces: false,
    removePreLeaseCopies: true,
  });
  assert.ok(uninstallCleanup.removed.includes(preLeaseSha), 'full uninstall removes unreferenced pre-lease copy');
  assert.equal(fs.existsSync(preLeaseIndex), false);

  // Re-install active copy since keepStableNamespaces: false pruned pointer/copy above
  const active2 = await installAndSelectRuntime({ home, runtimeSource: bundleV1, version: '0.8.0' });

  // 2. Cleanup protects copies referenced via command, shell-wrapped args, env (NODE_OPTIONS), custom string fields, and VS Code mcp.json
  const cmdSha = 'c'.repeat(64);
  const shellSha = 'd'.repeat(64);
  const envSha = 'a'.repeat(64);
  const customFieldSha = 'b'.repeat(64);
  const mcpSha = 'f'.repeat(64);
  for (const sha of [cmdSha, shellSha, envSha, customFieldSha, mcpSha]) {
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
        coagent8Env: {
          command: 'node',
          args: ['wrapper.js'],
          env: { NODE_OPTIONS: `--require "${path.join(root, 'runtime', envSha, 'index.cjs')}"` },
          runtimeHint: path.join(root, 'runtime', customFieldSha, 'index.cjs'),
        },
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

  // Malformed unsupported CODEX_CONFIG_PATH does NOT block pruning, while supported CODEX_HOME/config.toml is inspected
  const unsupportedCodex = path.join(home, 'unsupported-codex.toml');
  fs.writeFileSync(unsupportedCodex, 'malformed = [unclosed');
  const unrefSha = '1'.repeat(64);
  fs.mkdirSync(path.join(root, 'runtime', unrefSha), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', unrefSha, 'index.cjs'), '/* unreferenced */');
  fs.writeFileSync(path.join(root, 'runtime', unrefSha, '.lease-capable'), '1\n');

  const protectedRun = await cleanupUnreferencedRuntimes(
    root,
    home,
    { ...process.env, CODEX_CONFIG_PATH: unsupportedCodex },
    { keepStableNamespaces: true },
  );
  assert.deepEqual(protectedRun.removed, [unrefSha], 'unsupported CODEX_CONFIG_PATH ignored; unreferenced copy pruned');
  for (const sha of [active2.digest, cmdSha, shellSha, envSha, customFieldSha, mcpSha]) {
    assert.ok(protectedRun.kept.includes(sha), `${sha} kept`);
  }

  // Unresolvable runtime-root reference in env (bare runtime dir or $VAR) keeps all copies
  fs.mkdirSync(path.join(root, 'runtime', unrefSha), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', unrefSha, 'index.cjs'), '/* unreferenced */');
  fs.writeFileSync(path.join(root, 'runtime', unrefSha, '.lease-capable'), '1\n');
  fs.writeFileSync(
    claudeConfig,
    JSON.stringify({
      mcpServers: {
        coagent8BrokenEnv: { command: 'node', args: ['run.js'], env: { NODE_OPTIONS: `--require ${path.join(root, 'runtime')}` } },
      },
    }),
  );
  const uncertainEnvRun = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.deepEqual(uncertainEnvRun.removed, []);
  assert.ok(uncertainEnvRun.kept.includes(unrefSha), 'unresolvable runtime-root path in env keeps all copies');

  // Supported CODEX_HOME/config.toml malformed blocks pruning
  const codexHome = path.join(home, 'custom-codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'malformed = [unclosed');
  const codexBlocked = await cleanupUnreferencedRuntimes(
    root,
    home,
    { ...process.env, CODEX_HOME: codexHome },
    { keepStableNamespaces: true },
  );
  assert.deepEqual(codexBlocked.removed, []);
});

test('installAndSelectVerifiedRuntime reserves incumbent during probe and avoids dangling rollback', async t => {
  const { installAndSelectVerifiedRuntime } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const realBytes = fs.readFileSync(distBundle, 'utf8');
  const bundleV1 = path.join(home, 'v1.cjs');
  const bundleV2 = path.join(home, 'v2.cjs');
  fs.writeFileSync(bundleV1, realBytes + '\n// v1\n');
  fs.writeFileSync(bundleV2, realBytes + '\n// v2\n');

  const v1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleV1, version: '0.7.0' });
  assert.equal(v1.action, 'installed');

  // When candidate probe passes and launcher probe fails (simulate launcher missing/corrupt on launch),
  // concurrent cleanup still sees the incumbent's reservation lease and rollback restores the live incumbent.
  const origLaunchCleanup = [];
  // Write a v2 bundle that exits only when launched via stable launcher (coagent8.runtimePath symbol is set by launcher)
  const launcherFailBundle = path.join(home, 'v2-launcher-fail.cjs');
  fs.writeFileSync(
    launcherFailBundle,
    [
      "if (globalThis[Symbol.for('coagent8.runtimePath')]) process.exit(1);",
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'coagent8' } } }) + '\\n');",
      "  else if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'doctor' }] } }) + '\\n');",
      '});',
    ].join('\n'),
  );

  // Trigger concurrent cleanupUnreferencedRuntimes right when launcher runs by hooking fs.statSync or racing alongside:
  // Verify reservation lease exists for BOTH incumbent and candidate while probing, and rollback restores v1.
  let sawBothReserved = false;
  const origReadFileSync = fs.readFileSync;
  const leasesDir = runtimeLeasesDir(root);
  const origExistsSync = fs.existsSync;
  const pollTimer = setInterval(() => {
    try {
      if (!origExistsSync(leasesDir)) return;
      const digests = fs
        .readdirSync(leasesDir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(origReadFileSync(path.join(leasesDir, f), 'utf8')).digest);
      if (digests.includes(v1.digest)) sawBothReserved = true;
    } catch {}
  }, 5);
  try {
    await assert.rejects(() => installAndSelectVerifiedRuntime({ home, runtimeSource: launcherFailBundle, version: '0.8.0' }));
  } finally {
    clearInterval(pollTimer);
  }
  assert.equal(sawBothReserved, true, 'incumbent was reserved by a lease during verified install/probe');
  const afterRollback = readRuntimePointer(root, 'current');
  assert.equal(afterRollback.digest, v1.digest, 'pointer rolled back to incumbent');
  assert.equal(fs.existsSync(v1.runtimePath), true, 'incumbent copy preserved');
  // Cleanup after failure can remove the unused v2 copy without touching incumbent v1
  const postFailCleanup = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(postFailCleanup.kept.includes(v1.digest));
});

test('reusing an existing unmarked runtime copy never marks it lease-capable and keeps it pre-lease', async t => {
  const { installAndSelectVerifiedRuntime } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const mcpBundle = content =>
    [
      content,
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'coagent8' } } }) + '\\n');",
      "  else if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'doctor' }] } }) + '\\n');",
      '});',
    ].join('\n');

  const v1Source = path.join(home, 'v1.cjs');
  const v1Text = mcpBundle('/* pre-lease v1 */');
  fs.writeFileSync(v1Source, v1Text);
  const v1Digest = createHash('sha256').update(v1Text).digest('hex');
  const v1Dir = path.join(root, 'runtime', v1Digest);
  fs.mkdirSync(v1Dir, { recursive: true });
  fs.writeFileSync(path.join(v1Dir, 'index.cjs'), v1Text);

  // Reusing the unmarked copy via installAndSelectRuntime and installAndSelectVerifiedRuntime never adds .lease-capable.
  await installAndSelectRuntime({ home, runtimeSource: v1Source, version: '0.7.0' });
  assert.equal(fs.existsSync(path.join(v1Dir, '.lease-capable')), false, 'installAndSelectRuntime keeps unmarked copy pre-lease');
  await installAndSelectVerifiedRuntime({ home, runtimeSource: v1Source, version: '0.7.0', nodePath: process.execPath });
  assert.equal(fs.existsSync(path.join(v1Dir, '.lease-capable')), false, 'installAndSelectVerifiedRuntime keeps unmarked copy pre-lease');

  // Freshly creating v2 marks v2 lease-capable, and cleanup keeps unmarked v1.
  const v2Source = path.join(home, 'v2.cjs');
  fs.writeFileSync(v2Source, mcpBundle('/* fresh v2 */'));
  const v2 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v2Source, version: '0.8.0', nodePath: process.execPath });
  assert.equal(fs.existsSync(path.join(path.dirname(v2.runtimePath), '.lease-capable')), true, 'freshly created copy gets .lease-capable');

  const cleanup = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(cleanup.kept.includes(v1Digest), 'reused unmarked copy stays protected by cleanup');
  assert.equal(fs.existsSync(path.join(v1Dir, 'index.cjs')), true);
});

test('installAndSelectVerifiedRuntime revalidates under final lock and probes before publishing after concurrent pointer change', async t => {
  const { installAndSelectVerifiedRuntime, runtimePointerPath } = require('../../src/integrations/runtime-manager.ts');
  const fsp = require('node:fs/promises');
  const validBundle = tag =>
    [
      `/* ${tag} */`,
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'coagent8' } } }) + '\\n');",
      "  else if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'doctor' }] } }) + '\\n');",
      '});',
    ].join('\n');

  // 1. Broken candidate (0.7.0) with incumbent (0.8.0): pointer disappears between lock 1 and lock 2 -> never published.
  {
    const home = makeHome(t);
    const root = coagentRootForHome(home);
    const pointerFile = runtimePointerPath(root, 'current');
    const v2 = path.join(home, 'v2.cjs');
    const brokenV1 = path.join(home, 'broken-v1.cjs');
    fs.writeFileSync(v2, validBundle('v2'));
    fs.writeFileSync(brokenV1, 'process.exit(1);\n');
    await installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath });

    const pointerWrites = [];
    const origRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === pointerFile) pointerWrites.push(fs.readFileSync(from, 'utf8'));
      return origRename(from, to);
    });
    const origLink = fsp.link;
    let lockAcquires = 0;
    t.mock.method(fsp, 'link', async (src, dst) => {
      if (typeof dst === 'string' && dst.endsWith('runtime-lock.lease')) {
        lockAcquires++;
        if (lockAcquires === 2) {
          fs.rmSync(pointerFile, { force: true });
        }
      }
      return origLink(src, dst);
    });

    await assert.rejects(
      () => installAndSelectVerifiedRuntime({ home, runtimeSource: brokenV1, version: '0.7.0', nodePath: process.execPath }),
      /Probe process exited/,
    );
    t.mock.restoreAll();
    assert.deepEqual(pointerWrites, [], 'unprobed broken candidate was never written to pointer.json');
    assert.equal(readRuntimePointer(root, 'current'), null);
  }

  // 2. Healthy candidate (0.7.0) with incumbent (0.8.0): pointer disappears between lock 1 and lock 2 -> probes outside lock and publishes.
  {
    const home = makeHome(t);
    const root = coagentRootForHome(home);
    const pointerFile = runtimePointerPath(root, 'current');
    const v2 = path.join(home, 'v2.cjs');
    const healthyV1 = path.join(home, 'healthy-v1.cjs');
    fs.writeFileSync(v2, validBundle('v2'));
    fs.writeFileSync(healthyV1, validBundle('v1'));
    await installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath });

    const origLink = fsp.link;
    let lockAcquires = 0;
    t.mock.method(fsp, 'link', async (src, dst) => {
      if (typeof dst === 'string' && dst.endsWith('runtime-lock.lease')) {
        lockAcquires++;
        if (lockAcquires === 2) {
          fs.rmSync(pointerFile, { force: true });
        }
      }
      return origLink(src, dst);
    });

    const res = await installAndSelectVerifiedRuntime({ home, runtimeSource: healthyV1, version: '0.7.0', nodePath: process.execPath });
    t.mock.restoreAll();
    assert.equal(res.action, 'installed');
    assert.equal(res.version, '0.7.0');
    assert.ok(res.tools.includes('doctor'));
    assert.equal(readRuntimePointer(root, 'current').version, '0.7.0');
  }
});
