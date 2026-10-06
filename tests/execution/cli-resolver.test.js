const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveCliCommand, clearCliResolverCache } = require('../../src/execution/cli-resolver.ts');

test('Phase 0 Task 0.1: Windows shim resolves native .exe entrypoints and preserves wrapper flags', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-shim-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const exePath = path.join(dir, 'agy.exe');
  fs.writeFileSync(exePath, 'BINARY_EXE_MOCK');
  try { fs.chmodSync(exePath, 0o755); } catch {}

  // 1. Quoted %~dp0
  const shim1 = path.join(dir, 'agy.cmd');
  fs.writeFileSync(shim1, '@ECHO off\r\n"%~dp0\\agy.exe" %*\r\n');
  const res1 = resolveCliCommand(shim1);
  assert.equal(res1.command, exePath);
  assert.deepEqual(res1.argsPrefix, []);
  assert.equal(res1.source, 'native');

  // 2. Unquoted %~dp0
  const shim2 = path.join(dir, 'agy_unquoted.cmd');
  fs.writeFileSync(shim2, '@ECHO off\r\n%~dp0\\agy.exe %*\r\n');
  const res2 = resolveCliCommand(shim2);
  assert.equal(res2.command, exePath);
  assert.equal(res2.source, 'native');

  // 3. %dp0% style
  const shim3 = path.join(dir, 'agy_dp0.cmd');
  fs.writeFileSync(shim3, '@ECHO off\r\n"%dp0%\\agy.exe" %*\r\n');
  const res3 = resolveCliCommand(shim3);
  assert.equal(res3.command, exePath);
  assert.equal(res3.source, 'native');

  // 4. Absolute path (quoted and unquoted)
  const shim4 = path.join(dir, 'agy_abs.cmd');
  fs.writeFileSync(shim4, `@ECHO off\r\n"${exePath}" %*\r\n`);
  const res4 = resolveCliCommand(shim4);
  assert.equal(res4.command, exePath);
  assert.equal(res4.source, 'native');

  const shim4b = path.join(dir, 'agy_abs_unquoted.cmd');
  fs.writeFileSync(shim4b, `@ECHO off\r\n${exePath} %*\r\n`);
  const res4b = resolveCliCommand(shim4b);
  assert.equal(res4b.command, exePath);
  assert.equal(res4b.source, 'native');

  // 5. Shim pointing only to node.exe without existing JS entrypoint must fail
  const nodeExe = path.join(dir, 'node.exe');
  fs.writeFileSync(nodeExe, 'FAKE_NODE');
  const badShim = path.join(dir, 'bad_npm.cmd');
  fs.writeFileSync(badShim, '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\missing.js" %*\r\n');
  assert.throws(() => resolveCliCommand(badShim), /Unsupported Windows shim/);

  // 6. Native shim with wrapper arguments
  const shimArgs = path.join(dir, 'agy_args.cmd');
  fs.writeFileSync(shimArgs, '@ECHO off\r\n"%~dp0\\agy.exe" --required-flag --opt "val with space" %*\r\n');
  const resArgs = resolveCliCommand(shimArgs);
  assert.equal(resArgs.command, exePath);
  assert.deepEqual(resArgs.argsPrefix, ['--required-flag', '--opt', 'val with space']);

  // 7. Native shim with key-value quotes and post-forward redirection
  const shimKeyVal = path.join(dir, 'agy_keyval.cmd');
  fs.writeFileSync(shimKeyVal, '@ECHO off\r\n"%~dp0\\agy.exe" --label="hello world" %* >nul\r\n');
  const resKeyVal = resolveCliCommand(shimKeyVal);
  assert.equal(resKeyVal.command, exePath);
  assert.deepEqual(resKeyVal.argsPrefix, ['--label=hello world']);

  // 8. Native shim with environment variable
  process.env.TEST_CONFIG_PATH = 'C:\\custom\\config.json';
  const shimEnv = path.join(dir, 'agy_env.cmd');
  fs.writeFileSync(shimEnv, '@ECHO off\r\n"%~dp0\\agy.exe" --config "%TEST_CONFIG_PATH%" %*\r\n');
  const resEnv = resolveCliCommand(shimEnv);
  assert.equal(resEnv.command, exePath);
  assert.deepEqual(resEnv.argsPrefix, ['--config', 'C:\\custom\\config.json']);

  // 9. Native shim with suffix arguments after %* must be rejected
  const shimSuffix = path.join(dir, 'agy_suffix.cmd');
  fs.writeFileSync(shimSuffix, '@ECHO off\r\n"%~dp0\\agy.exe" --prefix %* --suffix\r\n');
  assert.throws(() => resolveCliCommand(shimSuffix), /arguments after %\*.*are not supported/);
});

test('Perf Optimization Area 1: CLI resolution caching with clearCliResolverCache and fast hits', () => {
  clearCliResolverCache();

  // Resolve node executable (guaranteed to exist across platforms)
  const res1 = resolveCliCommand(process.execPath);
  assert.ok(res1);
  assert.equal(res1.source, 'native');

  // Second resolution should return from cache
  const res2 = resolveCliCommand(process.execPath);
  assert.deepEqual(res1, res2);

  // argsPrefix in returned object should be an independent array to prevent mutation pollution
  res2.argsPrefix.push('--mutated');
  const res3 = resolveCliCommand(process.execPath);
  assert.ok(!res3.argsPrefix.includes('--mutated'), 'Cached resolution returned isolated argsPrefix');

  clearCliResolverCache();
});

test('Perf Optimization Area 1: cliCache hit refreshes LRU recency', () => {
  clearCliResolverCache();
  const testNode = process.execPath;
  const env = { PATH: path.dirname(testNode) };
  const cmd = path.basename(testNode);

  // First resolution inserts into cache
  const r1 = resolveCliCommand(cmd, { env });
  assert.equal(r1.command, testNode);

  // Subsequent hit should refresh LRU recency without throwing or altering results
  const r2 = resolveCliCommand(cmd, { env });
  assert.equal(r2.command, testNode);
  clearCliResolverCache();
});
