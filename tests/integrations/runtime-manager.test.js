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
  installAndSelectVerifiedRuntime,
  installAndVerifyRuntimeCopy,
  readRuntimePointer,
  readRuntimeStatus,
  rollbackOrPinRuntime,
  runtimeLeasesDir,
  unpinRuntime,
} = require('../../src/integrations/runtime-manager.ts');

const distBundle = path.resolve(__dirname, '../../dist/index.cjs');

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-rt-mgr-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function validMcpBundle(tag = 'v1') {
  return [
    `/* ${tag} */`,
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "rl.on('line', line => {",
    '  if (!line.trim()) return;',
    '  const msg = JSON.parse(line);',
    "  if (msg.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'coagent8' } } }) + '\\n');",
    "  else if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'doctor' }] } }) + '\\n');",
    '});',
  ].join('\n');
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
  fs.writeFileSync(srcA, validMcpBundle('bundle A'));
  fs.writeFileSync(srcB, validMcpBundle('bundle B'));
  fs.writeFileSync(srcC, validMcpBundle('bundle C'));
  const select = opts => installAndSelectVerifiedRuntime({ ...opts, nodePath: process.execPath });

  // 1. Initial prerelease install
  const first = await select({ home, runtimeSource: srcA, version: '0.8.0-beta.1' });
  assert.equal(first.action, 'installed');
  assert.equal(first.namespace, 'current');
  assert.equal(readRuntimePointer(root, 'current').version, '0.8.0-beta.1');

  // 2. Same version and same hash is a no-op
  const noop = await select({ home, runtimeSource: srcA, version: '0.8.0-beta.1' });
  assert.equal(noop.action, 'noop');

  // 3. Equal version with different hash keeps the incumbent and reports it
  const conflict = await select({ home, runtimeSource: srcB, version: '0.8.0-beta.1' });
  assert.equal(conflict.action, 'kept-incumbent');
  assert.equal(readRuntimePointer(root, 'current').digest, first.digest);
  assert.match(conflict.message, /Kept incumbent/);

  // 4. Higher prerelease and release win
  const beta2 = await select({ home, runtimeSource: srcB, version: '0.8.0-beta.2' });
  assert.equal(beta2.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').digest, beta2.digest);

  const release = await select({ home, runtimeSource: srcC, version: '0.8.0' });
  assert.equal(release.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').digest, release.digest);

  // 5. Downgrade guard: prerelease or older version never switches pointer back
  const downgraded = await select({ home, runtimeSource: srcB, version: '0.8.0-beta.2' });
  assert.equal(downgraded.action, 'downgrade-blocked');
  assert.equal(readRuntimePointer(root, 'current').digest, release.digest);

  // 6. Dev builds route to separate 'dev' namespace and leave 'current' untouched
  const devBuild = await select({ home, runtimeSource: srcA, version: '0.9.0-dev.1' });
  assert.equal(devBuild.namespace, 'dev');
  assert.equal(readRuntimePointer(root, 'dev').version, '0.9.0-dev.1');
  assert.equal(readRuntimePointer(root, 'current').version, '0.8.0');
  await assert.rejects(select({ home, runtimeSource: srcA, version: '0.9.0-dev.1', namespace: 'current' }), /explicit opt-in/);

  // 7. Explicit pin / rollback persists pin and blocks auto-upgrade until unpinned
  const pinned = await rollbackOrPinRuntime({
    home,
    digest: beta2.digest,
    version: '0.8.0-beta.2',
    reason: 'test-rollback',
    nodePath: process.execPath,
  });
  assert.equal(pinned.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').pinned.digest, beta2.digest);

  const blockedByPin = await select({ home, runtimeSource: srcC, version: '0.8.0' });
  assert.equal(blockedByPin.action, 'pinned-blocked');
  assert.equal(readRuntimePointer(root, 'current').digest, beta2.digest);

  await unpinRuntime(home, 'current', { nodePath: process.execPath });
  const afterUnpin = await select({ home, runtimeSource: srcC, version: '0.8.0' });
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
  fs.writeFileSync(sourceBundle, validMcpBundle('with helper'));
  fs.writeFileSync(sourceHelper, 'valid-job-helper-bytes');

  const res = await installAndSelectVerifiedRuntime({ home, runtimeSource: sourceBundle, version: '0.8.0', nodePath: process.execPath });
  assert.equal(res.action, 'installed');
  const copiedHelper = path.join(root, 'runtime', res.digest, helperRel);
  assert.equal(fs.readFileSync(copiedHelper, 'utf8'), 'valid-job-helper-bytes');

  // If the target job helper is locked with corrupt bytes, verification fails before switching pointer
  const dist2 = path.join(home, 'dist2');
  const sourceBundle2 = path.join(dist2, 'index.cjs');
  const sourceHelper2 = path.join(dist2, helperRel);
  fs.mkdirSync(path.dirname(sourceHelper2), { recursive: true });
  fs.writeFileSync(sourceBundle2, validMcpBundle('bundle 2'));
  fs.writeFileSync(sourceHelper2, 'expected-helper-v2');
  const digest2 = createHash('sha256').update(fs.readFileSync(sourceBundle2)).digest('hex');
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
  const r0 = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleV0, version: '0.7.0', nodePath: process.execPath });
  const r1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleV1, version: '0.7.1', nodePath: process.execPath });
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
    const r2 = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleV2, version: '0.8.0', nodePath: process.execPath });
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
  fs.writeFileSync(bundleA, validMcpBundle('copy A'));
  fs.writeFileSync(bundleB, validMcpBundle('copy B'));

  const rA = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleA, version: '0.7.0', nodePath: process.execPath });
  const rB = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleB, version: '0.8.0', nodePath: process.execPath });

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

test('verified runtime selection rejects missing copy and holds lock through selection', async t => {
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const srcA = path.join(home, 'a.cjs');
  const srcB = path.join(home, 'b.cjs');
  fs.writeFileSync(srcA, validMcpBundle('copy A'));
  fs.writeFileSync(srcB, validMcpBundle('copy B'));

  const copyA = installAndVerifyRuntimeCopy({ home, runtimeSource: srcA, version: '0.7.0' });
  fs.rmSync(copyA.runtimeDir, { recursive: true, force: true });
  await assert.rejects(
    () => rollbackOrPinRuntime({ home, digest: copyA.digest, version: '0.7.0', nodePath: process.execPath }),
    /not installed/,
  );
  assert.equal(readRuntimePointer(root, 'current'), null, 'missing target never writes a dangling pointer');

  // installAndSelectVerifiedRuntime holds runtime-lock across install and selection
  const resB = await installAndSelectVerifiedRuntime({ home, runtimeSource: srcB, version: '0.8.0', nodePath: process.execPath });
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
  fs.writeFileSync(bundleV1, validMcpBundle('v1'));
  const active = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleV1, version: '0.8.0', nodePath: process.execPath });

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
  const active2 = await installAndSelectVerifiedRuntime({ home, runtimeSource: bundleV1, version: '0.8.0', nodePath: process.execPath });

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

  // Reusing the unmarked copy via installAndVerifyRuntimeCopy and installAndSelectVerifiedRuntime never adds .lease-capable.
  installAndVerifyRuntimeCopy({ home, runtimeSource: v1Source, version: '0.7.0' });
  assert.equal(fs.existsSync(path.join(v1Dir, '.lease-capable')), false, 'installAndVerifyRuntimeCopy keeps unmarked copy pre-lease');
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

test('rollbackOrPinRuntime probes before pinning and keeps incumbent when installed copy or source bundle fails probe', async t => {
  const runtimeMgr = require('../../src/integrations/runtime-manager.ts');
  assert.equal(runtimeMgr.selectRuntimePointer, undefined, 'unverified selectRuntimePointer is not exported');
  assert.equal(runtimeMgr.installAndSelectRuntime, undefined, 'unverified installAndSelectRuntime is not exported');

  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const v1 = path.join(home, 'v1.cjs');
  const v2 = path.join(home, 'v2.cjs');
  const broken = path.join(home, 'broken.cjs');
  fs.writeFileSync(v1, validMcpBundle('v1'));
  fs.writeFileSync(v2, validMcpBundle('v2'));
  fs.writeFileSync(broken, 'process.exit(1);\n');

  const res1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1, version: '0.7.0', nodePath: process.execPath });
  const res2 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath });
  const brokenCopy = installAndVerifyRuntimeCopy({ home, runtimeSource: broken, version: '0.6.0' });

  // Pinning a broken already-installed copy rejects and leaves healthy incumbent 0.8.0 unpinned and untouched.
  await assert.rejects(
    () => rollbackOrPinRuntime({ home, digest: brokenCopy.digest, version: '0.6.0', nodePath: process.execPath }),
    /Probe process exited/,
  );
  const afterDigestFail = readRuntimePointer(root, 'current');
  assert.equal(afterDigestFail.digest, res2.digest);
  assert.equal(afterDigestFail.pinned, undefined);

  // Pinning a broken source bundle rejects and leaves incumbent 0.8.0 untouched.
  await assert.rejects(
    () => rollbackOrPinRuntime({ home, runtimeSource: broken, version: '0.6.0', nodePath: process.execPath }),
    /Probe process exited/,
  );
  const afterSourceFail = readRuntimePointer(root, 'current');
  assert.equal(afterSourceFail.digest, res2.digest);
  assert.equal(afterSourceFail.pinned, undefined);

  // Pinning a healthy installed copy succeeds and records pin.
  const pinned = await rollbackOrPinRuntime({
    home,
    digest: res1.digest,
    version: '0.7.0',
    reason: 'verified-rollback',
    nodePath: process.execPath,
  });
  assert.equal(pinned.action, 'updated');
  assert.ok(pinned.tools.includes('doctor'));
  assert.equal(readRuntimePointer(root, 'current').pinned.digest, res1.digest);
});

test('updater lock serializes concurrent failing updates, restores pin on unpin launcher failure, and releases lock on success', async t => {
  const { runtimePointerPath, runtimeUpdateLockResource } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const updateLease = `${runtimeUpdateLockResource(root)}.lease`;

  // 1. Successful updates work and release the updater lock so subsequent updates succeed.
  const v1 = path.join(home, 'v1.cjs');
  const v2 = path.join(home, 'v2.cjs');
  const v3 = path.join(home, 'v3.cjs');
  fs.writeFileSync(v1, validMcpBundle('v1'));
  fs.writeFileSync(v2, validMcpBundle('v2'));
  fs.writeFileSync(v3, validMcpBundle('v3'));

  const res1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1, version: '0.7.0', nodePath: process.execPath });
  assert.equal(res1.action, 'installed');
  assert.equal(fs.existsSync(updateLease), false, 'updater lock released after first install');

  const res2 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath });
  assert.equal(res2.action, 'updated');
  assert.equal(fs.existsSync(updateLease), false, 'updater lock released after update');

  const res3 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v3, version: '0.9.0', nodePath: process.execPath });
  assert.equal(res3.action, 'updated');
  assert.equal(fs.existsSync(updateLease), false, 'updater lock released after second update');
  assert.equal(readRuntimePointer(root, 'current').digest, res3.digest);

  // 2. Two concurrent installAndSelectVerifiedRuntime calls whose launcher probes fail both leave the original pointer unchanged.
  const launcherFail = tag =>
    [`/* ${tag} */`, "if (globalThis[Symbol.for('coagent8.runtimePath')]) process.exit(1);", validMcpBundle(tag)].join('\n');
  const failA = path.join(home, 'fail-a.cjs');
  const failB = path.join(home, 'fail-b.cjs');
  fs.writeFileSync(failA, launcherFail('failA'));
  fs.writeFileSync(failB, launcherFail('failB'));

  const results = await Promise.allSettled([
    installAndSelectVerifiedRuntime({ home, runtimeSource: failA, version: '1.0.0', nodePath: process.execPath }),
    installAndSelectVerifiedRuntime({ home, runtimeSource: failB, version: '1.1.0', nodePath: process.execPath }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  assert.equal(fs.existsSync(updateLease), false, 'updater lock released after concurrent failures');
  const pointerAfterConcurrent = readRuntimePointer(root, 'current');
  assert.equal(pointerAfterConcurrent.digest, res3.digest, 'original pointer preserved across concurrent failing updates');
  assert.equal(pointerAfterConcurrent.version, '0.9.0');

  // 3. unpinRuntime with a failing launcher probe leaves the pinned pointer byte-identical (and action is not noop).
  const pointerFile = runtimePointerPath(root, 'current');
  const failUnpinMarker = path.join(home, 'fail-unpin-marker');
  const pinOnlyBundle = path.join(home, 'pin-only.cjs');
  fs.writeFileSync(
    pinOnlyBundle,
    [
      `const fs = require('node:fs');`,
      `if (globalThis[Symbol.for('coagent8.runtimePath')] && fs.existsSync(${JSON.stringify(failUnpinMarker)})) {`,
      `  process.exit(1);`,
      `}`,
      validMcpBundle('pin-only'),
    ].join('\n'),
  );
  const pinned = await rollbackOrPinRuntime({
    home,
    runtimeSource: pinOnlyBundle,
    version: '0.8.5',
    reason: 'test-unpin-rollback',
    nodePath: process.execPath,
  });
  assert.equal(pinned.action, 'updated');
  assert.equal(readRuntimePointer(root, 'current').pinned.digest, pinned.digest);
  const pinnedBytes = fs.readFileSync(pointerFile);

  fs.writeFileSync(failUnpinMarker, '1');
  await assert.rejects(() => unpinRuntime(home, 'current', { nodePath: process.execPath }), /Probe process exited/);
  assert.equal(fs.existsSync(updateLease), false, 'updater lock released after failed unpin');
  assert.deepEqual(fs.readFileSync(pointerFile), pinnedBytes, 'pinned pointer.json stays byte-identical when unpin launcher probe fails');

  // Also verify installAndSelectVerifiedRuntime({ ..., unpin: true }) preserves pin on failure rather than returning noop.
  await assert.rejects(
    () =>
      installAndSelectVerifiedRuntime({
        home,
        runtimeSource: pinOnlyBundle,
        version: '0.8.5',
        allowDevInCurrent: true,
        unpin: true,
        nodePath: process.execPath,
      }),
    /Probe process exited/,
  );
  assert.deepEqual(fs.readFileSync(pointerFile), pinnedBytes, 'pinned pointer.json stays byte-identical on unpin option failure');
});

test('cleanupUnreferencedRuntimes with keepStableNamespaces false waits for runtime-update lock and keeps update pointer', async t => {
  const { withFileLock } = require('../../src/storage/lock.ts');
  const { runtimePointerPath, runtimeUpdateLockResource, stableLauncherPath } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);

  const v1 = path.join(home, 'v1.cjs');
  fs.writeFileSync(v1, validMcpBundle('v1'));
  const v1Copy = installAndVerifyRuntimeCopy({ home, runtimeSource: v1, version: '0.7.0' });

  // Hold runtime-update lock to simulate an in-progress update transaction.
  let releaseUpdate;
  let updateHeld;
  const updateGate = new Promise(resolve => {
    releaseUpdate = resolve;
  });
  const updateAcquired = new Promise(resolve => {
    updateHeld = resolve;
  });

  const updaterTask = withFileLock(runtimeUpdateLockResource(root), async () => {
    updateHeld();
    await updateGate;
    // Publish pointer and register a host reference to the stable launcher before releasing runtime-update.
    fs.mkdirSync(path.dirname(runtimePointerPath(root, 'current')), { recursive: true });
    fs.writeFileSync(
      runtimePointerPath(root, 'current'),
      JSON.stringify({ schemaVersion: 1, digest: v1Copy.digest, version: '0.7.0', updatedAt: new Date().toISOString() }, null, 2),
    );
    fs.writeFileSync(stableLauncherPath(root, 'current'), '/* launcher */');
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { coagent8: { command: 'node', args: [stableLauncherPath(root, 'current'), 'mcp'] } } }),
    );
  });
  await updateAcquired;

  let cleanupDone = false;
  const cleanupTask = cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: false }).then(res => {
    cleanupDone = true;
    return res;
  });

  // Cleanup must block on runtime-update rather than running immediately under runtime-lock alone.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(cleanupDone, false, 'cleanup with keepStableNamespaces: false waits for in-progress runtime-update');

  releaseUpdate();
  await updaterTask;
  const cleanupRes = await cleanupTask;
  assert.equal(cleanupDone, true);
  assert.ok(cleanupRes.kept.includes(v1Copy.digest), 'published copy is kept after update completes');
  assert.equal(readRuntimePointer(root, 'current')?.digest, v1Copy.digest, 'pointer published by update is preserved');
});

test('cleanupUnreferencedRuntimes enforces a single deadline across runtime-update and runtime-lock', async t => {
  const { LockTimeoutError, withFileLock } = require('../../src/storage/lock.ts');
  const { runtimeLockResource, runtimeUpdateLockResource } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);

  // Hold runtime-update for 300ms and runtime-lock for 250ms; with a 400ms single budget cleanup must fail near 400ms, not 800ms.
  let releaseUpdate;
  let updateHeld;
  const updateGate = new Promise(resolve => {
    releaseUpdate = resolve;
  });
  const updateAcquired = new Promise(resolve => {
    updateHeld = resolve;
  });
  const updateHolder = withFileLock(runtimeUpdateLockResource(root), async () => {
    updateHeld();
    await updateGate;
  });
  await updateAcquired;

  let releaseRuntime;
  let runtimeHeld;
  const runtimeGate = new Promise(resolve => {
    releaseRuntime = resolve;
  });
  const runtimeAcquired = new Promise(resolve => {
    runtimeHeld = resolve;
  });
  const runtimeHolder = withFileLock(runtimeLockResource(root), async () => {
    runtimeHeld();
    await runtimeGate;
  });
  await runtimeAcquired;

  setTimeout(() => releaseUpdate(), 300);
  setTimeout(() => releaseRuntime(), 650);

  const started = Date.now();
  await assert.rejects(
    () => cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: false, leaseTimeoutMs: 400 }),
    err => err instanceof LockTimeoutError,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 600, `expected single-budget timeout under 600ms, took ${elapsed}ms`);

  releaseUpdate();
  releaseRuntime();
  await Promise.all([updateHolder, runtimeHolder]);
});

test('staged launcher probe leaves pointer.json byte-identical on failure, rejects invalid stage args, and cleanup removes stale staged files', async t => {
  const { runtimePointerPath, stableLauncherPath } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const pointerFile = runtimePointerPath(root, 'current');
  const stagedFile = path.join(path.dirname(pointerFile), 'pointer.next.json');

  const launcherFail = path.join(home, 'launcher-fail.cjs');
  fs.writeFileSync(
    launcherFail,
    ["if (globalThis[Symbol.for('coagent8.runtimePath')]) process.exit(1);", validMcpBundle('v2-launcher-fail')].join('\n'),
  );

  // 1. No incumbent: failing staged launcher probe never creates pointer.json and cleans up pointer.next.json.
  await assert.rejects(
    () => installAndSelectVerifiedRuntime({ home, runtimeSource: launcherFail, version: '0.7.0', nodePath: process.execPath }),
    /Probe process exited/,
  );
  assert.equal(fs.existsSync(pointerFile), false, 'pointer.json is never created on staged launcher probe failure');
  assert.equal(fs.existsSync(stagedFile), false, 'pointer.next.json cleaned up after failure');

  // 2. Existing incumbent: failing staged launcher probe performs zero writes to pointer.json and leaves it byte-identical.
  const v1 = path.join(home, 'v1.cjs');
  fs.writeFileSync(v1, validMcpBundle('v1'));
  const res1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1, version: '0.7.0', nodePath: process.execPath });
  const beforeBytes = fs.readFileSync(pointerFile);

  const pointerRenames = [];
  const origRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === pointerFile) pointerRenames.push(to);
    return origRename(from, to);
  });
  await assert.rejects(
    () => installAndSelectVerifiedRuntime({ home, runtimeSource: launcherFail, version: '0.8.0', nodePath: process.execPath }),
    /Probe process exited/,
  );
  t.mock.restoreAll();
  assert.deepEqual(pointerRenames, [], 'pointer.json was never written during failing staged probe');
  assert.deepEqual(fs.readFileSync(pointerFile), beforeBytes, 'pointer.json remained byte-identical');
  assert.equal(fs.existsSync(stagedFile), false, 'pointer.next.json cleaned up after failure');

  // 3. Stale pointer.next.json left by a crashed updater is removed by cleanupUnreferencedRuntimes.
  fs.writeFileSync(stagedFile, JSON.stringify({ stale: true }));
  const cleanupRes = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(cleanupRes.kept.includes(res1.digest));
  assert.equal(fs.existsSync(stagedFile), false, 'stale pointer.next.json removed during cleanup');

  // 4. Launcher rejects arbitrary/traversal --probe-pointer arguments.
  const launcher = stableLauncherPath(root, 'current');
  const badArg = cp.spawnSync(process.execPath, [launcher, '--probe-pointer=../evil.json', 'mcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  assert.notEqual(badArg.status, 0);
  assert.match(badArg.stderr, /invalid staged pointer name/);

  // 5. Failing staged pointer write cleans up reservation leases and propagates the error.
  const v2 = path.join(home, 'v2.cjs');
  fs.writeFileSync(v2, validMcpBundle('v2-staged-write-fail'));
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('pointer.next.json')) {
      throw new Error('Simulated staged write failure');
    }
    return origRename(from, to);
  });
  await assert.rejects(
    () => installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath }),
    /Simulated staged write failure/,
  );
  t.mock.restoreAll();
  const remainingLeases = fs.existsSync(runtimeLeasesDir(root)) ? fs.readdirSync(runtimeLeasesDir(root)) : [];
  assert.deepEqual(remainingLeases, [], 'no reservation leases leaked when staged pointer write fails');
  assert.deepEqual(fs.readFileSync(pointerFile), beforeBytes, 'pointer.json untouched on staged write failure');

  // 6. Directory at pointer.next.json makes staged write and staged rmSync fail without leaking leases or masking the write error.
  fs.mkdirSync(stagedFile, { recursive: true });
  const v3 = path.join(home, 'v3.cjs');
  fs.writeFileSync(v3, validMcpBundle('v3-staged-dir'));
  await assert.rejects(
    () => installAndSelectVerifiedRuntime({ home, runtimeSource: v3, version: '0.9.0', nodePath: process.execPath }),
    err => err instanceof Error && err.code !== 'ERR_FS_EISDIR',
  );
  const remainingLeasesAfterDir = fs.existsSync(runtimeLeasesDir(root)) ? fs.readdirSync(runtimeLeasesDir(root)) : [];
  assert.deepEqual(remainingLeasesAfterDir, [], 'no reservation leases leaked when pointer.next.json is a directory');
  assert.deepEqual(fs.readFileSync(pointerFile), beforeBytes, 'pointer.json untouched when pointer.next.json is a directory');
});

test('post-publication cleanup failures never fail selection and surface redacted cleanupWarning', async t => {
  const { readRuntimePointer, runtimePointerPath } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const pointerFile = runtimePointerPath(root, 'current');
  const stagedFile = path.join(path.dirname(pointerFile), 'pointer.next.json');
  const origRmSync = fs.rmSync;

  // 1. Staged-pointer removal failure after publication resolves with active pointer and cleanupWarning.
  const v1 = path.join(home, 'v1-staged-rm-fail.cjs');
  fs.writeFileSync(v1, validMcpBundle('v1-staged-rm-fail'));
  t.mock.method(fs, 'rmSync', (target, opts) => {
    if (String(target) === stagedFile) {
      throw new Error('Simulated staged cleanup failure token=secret-value-123');
    }
    return origRmSync(target, opts);
  });
  const res1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1, version: '0.7.0', nodePath: process.execPath });
  t.mock.restoreAll();
  origRmSync(stagedFile, { force: true });

  assert.equal(res1.version, '0.7.0');
  assert.equal(readRuntimePointer(root, 'current')?.digest, res1.digest, 'new pointer is active after staged cleanup failure');
  assert.match(res1.cleanupWarning ?? '', /Failed to remove staged runtime pointer/);
  assert.doesNotMatch(res1.cleanupWarning ?? '', /secret-value-123/, 'cleanupWarning redacts sensitive tokens');

  // 2. Reservation-lease removal failure after successful publish resolves with active pointer and cleanupWarning.
  const v2 = path.join(home, 'v2-lease-rm-fail.cjs');
  fs.writeFileSync(v2, validMcpBundle('v2-lease-rm-fail'));
  const leasesPrefix = `${runtimeLeasesDir(root)}${path.sep}`;
  t.mock.method(fs, 'rmSync', (target, opts) => {
    const targetStr = String(target);
    if (targetStr.startsWith(leasesPrefix) && !targetStr.includes('.tmp.')) {
      throw new Error('Simulated lease cleanup failure');
    }
    return origRmSync(target, opts);
  });
  const res2 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath });
  t.mock.restoreAll();

  assert.equal(res2.version, '0.8.0');
  assert.equal(readRuntimePointer(root, 'current')?.digest, res2.digest, 'new pointer is active after lease cleanup failure');
  assert.match(res2.cleanupWarning ?? '', /Failed to release runtime reservation lease: Simulated lease cleanup failure/);
});

test('atomicWriteText ignores temp-removal failure after rename, preserves pre-rename errors, and cleanup ignores trailing rmdir failure', async t => {
  const { cleanupUnreferencedRuntimes, runtimeLeasesDir, runtimePointerPath } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);
  const pointerFile = runtimePointerPath(root, 'current');
  const origRmSync = fs.rmSync;
  const origRenameSync = fs.renameSync;
  const origRmdirSync = fs.rmdirSync;

  // 1. Temp removal throws after renameSync succeeds: install/publish resolves and pointer.json has new content.
  const v1 = path.join(home, 'v1-atomic-rm.cjs');
  fs.writeFileSync(v1, validMcpBundle('v1-atomic-rm'));
  t.mock.method(fs, 'rmSync', (target, opts) => {
    if (String(target).startsWith(`${pointerFile}.tmp.`)) {
      throw new Error('Simulated post-rename temp removal failure');
    }
    return origRmSync(target, opts);
  });
  const res1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1, version: '0.7.0', nodePath: process.execPath });
  t.mock.restoreAll();
  assert.equal(readRuntimePointer(root, 'current')?.digest, res1.digest);
  assert.equal(readRuntimePointer(root, 'current')?.version, '0.7.0');

  // 2. Rename fails and temp cleanup also fails: original rename error propagates unmasked.
  const v2 = path.join(home, 'v2-atomic-pre.cjs');
  fs.writeFileSync(v2, validMcpBundle('v2-atomic-pre'));
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === pointerFile) {
      throw new Error('Simulated pre-rename failure');
    }
    return origRenameSync(from, to);
  });
  t.mock.method(fs, 'rmSync', (target, opts) => {
    if (String(target).startsWith(`${pointerFile}.tmp.`)) {
      throw new Error('Simulated temp rm masking error');
    }
    return origRmSync(target, opts);
  });
  await assert.rejects(
    () => installAndSelectVerifiedRuntime({ home, runtimeSource: v2, version: '0.8.0', nodePath: process.execPath }),
    /Simulated pre-rename failure/,
  );
  t.mock.restoreAll();
  assert.equal(readRuntimePointer(root, 'current')?.digest, res1.digest, 'incumbent pointer stayed unchanged');

  // 3. cleanupUnreferencedRuntimes still resolves and returns warnings if trailing empty-dir rmdirSync throws EBUSY.
  fs.mkdirSync(runtimeLeasesDir(root), { recursive: true });
  t.mock.method(fs, 'rmdirSync', (target, opts) => {
    if (String(target) === runtimeLeasesDir(root)) {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }
    return origRmdirSync(target, opts);
  });
  const cleanupRes = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  t.mock.restoreAll();
  assert.ok(cleanupRes.kept.includes(res1.digest));
  assert.match(cleanupRes.warnings?.[0] ?? '', /Failed to remove empty runtime leases directory/);

  // 4. cleanupUnreferencedRuntimes returns a warning when removing staged pointer.next.json fails (e.g. non-empty directory).
  const stagedDir = path.join(path.dirname(pointerFile), 'pointer.next.json');
  fs.mkdirSync(stagedDir, { recursive: true });
  fs.writeFileSync(path.join(stagedDir, 'stale.txt'), 'keep');
  const stagedWarnRes = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  assert.ok(stagedWarnRes.kept.includes(res1.digest));
  assert.ok(
    stagedWarnRes.warnings?.some(warning => /Failed to remove staged pointer for current/.test(warning)),
    `expected staged pointer removal warning, got: ${JSON.stringify(stagedWarnRes.warnings)}`,
  );

  // 5. cleanupUnreferencedRuntimes returns a warning and keeps the digest when removeRuntimeDirectory returns false (EBUSY).
  const lockedDigest = 'f'.repeat(64);
  const lockedDir = path.join(root, 'runtime', lockedDigest);
  fs.mkdirSync(lockedDir, { recursive: true });
  fs.writeFileSync(path.join(lockedDir, 'index.cjs'), 'locked');
  fs.writeFileSync(path.join(lockedDir, '.lease-capable'), '1\n');
  t.mock.method(fs, 'rmSync', (target, opts) => {
    if (String(target) === lockedDir) {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }
    return origRmSync(target, opts);
  });
  const ebusyRes = await cleanupUnreferencedRuntimes(root, home, process.env, { keepStableNamespaces: true });
  t.mock.restoreAll();
  assert.ok(ebusyRes.kept.includes(lockedDigest), 'in-use copy stays in kept');
  assert.ok(
    ebusyRes.warnings?.some(warning => new RegExp(`Retained unreferenced runtime copy ${lockedDigest.slice(0, 12)}`).test(warning)),
    `expected in-use retention warning, got: ${JSON.stringify(ebusyRes.warnings)}`,
  );
});

test('corrupted incumbent index.cjs triggers repair for equal-version, older, and pinned replacements', async t => {
  const { rollbackOrPinRuntime } = require('../../src/integrations/runtime-manager.ts');
  const home = makeHome(t);
  const root = coagentRootForHome(home);

  // 1. Install 0.8.0 as incumbent, then corrupt its index.cjs on disk.
  const v1 = path.join(home, 'v1.cjs');
  fs.writeFileSync(v1, validMcpBundle('incumbent-0.8.0-a'));
  const res1 = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1, version: '0.8.0', nodePath: process.execPath });
  fs.writeFileSync(res1.runtimePath, 'corrupted incumbent bytes');

  // Equal-version different-digest candidate repairs the damaged incumbent instead of keeping it.
  const v1b = path.join(home, 'v1b.cjs');
  fs.writeFileSync(v1b, validMcpBundle('candidate-0.8.0-b'));
  const resEqual = await installAndSelectVerifiedRuntime({ home, runtimeSource: v1b, version: '0.8.0', nodePath: process.execPath });
  assert.equal(resEqual.action, 'updated');
  assert.equal(resEqual.digest, readRuntimePointer(root, 'current')?.digest);

  // 2. Corrupt the new incumbent, then install an older 0.7.0 candidate (downgrade guard must not retain corrupted copy).
  fs.writeFileSync(resEqual.runtimePath, 'corrupted incumbent bytes 2');
  const vOlder = path.join(home, 'vOlder.cjs');
  fs.writeFileSync(vOlder, validMcpBundle('candidate-0.7.0'));
  const resOlder = await installAndSelectVerifiedRuntime({ home, runtimeSource: vOlder, version: '0.7.0', nodePath: process.execPath });
  assert.equal(resOlder.action, 'updated');
  assert.equal(resOlder.digest, readRuntimePointer(root, 'current')?.digest);

  // 3. Pin a copy, corrupt its index.cjs, and install an older replacement: damaged pin does not block repair.
  await rollbackOrPinRuntime({ home, digest: resOlder.digest, version: '0.7.0', reason: 'test-pin', nodePath: process.execPath });
  assert.ok(readRuntimePointer(root, 'current')?.pinned, 'pin is recorded before corruption');
  fs.writeFileSync(resOlder.runtimePath, 'corrupted pinned bytes');
  const vOldest = path.join(home, 'vOldest.cjs');
  fs.writeFileSync(vOldest, validMcpBundle('candidate-0.6.0'));
  const resPinnedRepair = await installAndSelectVerifiedRuntime({
    home,
    runtimeSource: vOldest,
    version: '0.6.0',
    nodePath: process.execPath,
  });
  assert.equal(resPinnedRepair.action, 'updated');
  const repairedPointer = readRuntimePointer(root, 'current');
  assert.equal(repairedPointer?.digest, resPinnedRepair.digest);
  assert.equal(repairedPointer?.pinned, undefined, 'damaged pin is cleared upon repair');
});

test('reused runtime copy atomically rebuilds missing or stale skills without rewriting index.cjs', async t => {
  const home = makeHome(t);
  const pkgRoot = path.join(home, 'pkg');
  const distDir = path.join(pkgRoot, 'dist');
  const skillsDir = path.join(pkgRoot, 'skills');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'coagent8-review'), { recursive: true });
  const sourceBundle = path.join(distDir, 'index.cjs');
  fs.writeFileSync(sourceBundle, validMcpBundle('skills-sync-bundle'));
  fs.writeFileSync(path.join(skillsDir, 'coagent8-review', 'SKILL.md'), 'review v1\n');
  fs.writeFileSync(path.join(skillsDir, 'coagent8-review', 'extra.txt'), 'extra v1\n');

  const initial = await installAndSelectVerifiedRuntime({
    home,
    runtimeSource: sourceBundle,
    version: '0.8.0',
    nodePath: process.execPath,
  });
  const copyDir = path.dirname(initial.runtimePath);
  const copySkills = path.join(copyDir, 'skills');
  assert.equal(fs.readFileSync(path.join(copySkills, 'coagent8-review', 'SKILL.md'), 'utf8'), 'review v1\n');
  assert.equal(fs.readFileSync(path.join(copySkills, 'coagent8-review', 'extra.txt'), 'utf8'), 'extra v1\n');

  // Track any rename targeting index.cjs so we assert index.cjs is untouched while skills rebuild.
  const indexRenames = [];
  const origRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === initial.runtimePath) indexRenames.push(to);
    return origRename(from, to);
  });

  // 1. Delete a file inside copy skills (partial copy): next install restores it without touching index.cjs.
  fs.rmSync(path.join(copySkills, 'coagent8-review', 'extra.txt'));
  await installAndSelectVerifiedRuntime({
    home,
    runtimeSource: sourceBundle,
    version: '0.8.0',
    nodePath: process.execPath,
  });
  assert.equal(fs.readFileSync(path.join(copySkills, 'coagent8-review', 'extra.txt'), 'utf8'), 'extra v1\n');
  assert.deepEqual(indexRenames, [], 'index.cjs was not rewritten when syncing missing skill file');

  // 2. Update/remove/add skills in source with the same bundle: reused copy skills match updated source atomically.
  fs.writeFileSync(path.join(skillsDir, 'coagent8-review', 'SKILL.md'), 'review v2\n');
  fs.rmSync(path.join(skillsDir, 'coagent8-review', 'extra.txt'));
  fs.mkdirSync(path.join(skillsDir, 'coagent8-extra'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'coagent8-extra', 'SKILL.md'), 'extra skill\n');

  await installAndSelectVerifiedRuntime({
    home,
    runtimeSource: sourceBundle,
    version: '0.8.0',
    nodePath: process.execPath,
  });
  t.mock.restoreAll();

  assert.equal(fs.readFileSync(path.join(copySkills, 'coagent8-review', 'SKILL.md'), 'utf8'), 'review v2\n');
  assert.equal(fs.existsSync(path.join(copySkills, 'coagent8-review', 'extra.txt')), false, 'removed source skill file is gone');
  assert.equal(fs.readFileSync(path.join(copySkills, 'coagent8-extra', 'SKILL.md'), 'utf8'), 'extra skill\n');
  assert.deepEqual(indexRenames, [], 'index.cjs was never touched across skills rebuild');
  const leftoverSiblings = fs.readdirSync(copyDir).filter(name => name.startsWith('skills.tmp.') || name.startsWith('skills.old.'));
  assert.deepEqual(leftoverSiblings, [], 'no temp/old skills sibling directories left behind');
});
