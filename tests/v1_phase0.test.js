const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCliCommand } = require('../src/backends/cli-resolver.ts');
const { extractStructuredGeminiError } = require('../src/backends/gemini.adapter.ts');
const { extractStructuredCodexError } = require('../src/backends/codex.adapter.ts');
const {
  recordQuotaCooldown,
  resetQuotaCooldown,
  readQuotaCache,
  writeQuotaCache,
  BACKOFF_DELAYS_MS,
  inspectQuotas,
} = require('../src/backends/availability.ts');
const { createHistoryWriter, pruneHistoryDirectory, getHistoryDir, deleteHistory } = require('../src/sessions/history.ts');
const { createSession, closeSession } = require('../src/sessions/session.ts');

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

test('Phase 0 Task 0.2: Structured error extraction handles typed envelopes and prevents false 429 lockouts', () => {
  // Gemini typed envelopes
  const gemini429 = extractStructuredGeminiError({ code: 429, message: 'Resource exhausted' });
  assert.equal(gemini429.code, 'RATE_LIMITED');
  assert.equal(gemini429.retryable, true);

  const geminiExhausted = extractStructuredGeminiError({ status: 'RESOURCE_EXHAUSTED', message: 'Quota limit exceeded' });
  assert.equal(geminiExhausted.code, 'RATE_LIMITED');
  assert.equal(geminiExhausted.retryable, true);

  const geminiGrpc8 = extractStructuredGeminiError({ code: 8, status: 'RESOURCE_EXHAUSTED' });
  assert.equal(geminiGrpc8.code, 'RATE_LIMITED');
  assert.equal(geminiGrpc8.retryable, true);

  const geminiGeneric429 = extractStructuredGeminiError({ code: 'generic_failure', status_code: 429, type: 'rate_limit_error' });
  assert.equal(geminiGeneric429.code, 'RATE_LIMITED');
  assert.equal(geminiGeneric429.retryable, true);

  const geminiAuth = extractStructuredGeminiError({ code: 401, message: 'Invalid credentials' });
  assert.equal(geminiAuth.code, 'AUTH_REQUIRED');
  assert.equal(geminiAuth.retryable, false);

  const geminiModel = extractStructuredGeminiError({ code: 404, message: 'Model not found' });
  assert.equal(geminiModel.code, 'MODEL_UNAVAILABLE');

  const geminiSession = extractStructuredGeminiError({ code: 404, message: 'Session conversation not found' });
  assert.equal(geminiSession.code, 'SESSION_INVALID');

  // Gemini 400 with message mentioning 429 in user code must NOT be RATE_LIMITED
  const gemini400With429Msg = extractStructuredGeminiError({ code: 400, message: 'Invalid parameter: port_429 is not allowed' });
  assert.equal(gemini400With429Msg.code, 'PROCESS_ERROR');
  assert.equal(gemini400With429Msg.retryable, false);

  // Gemini string-coded 500 with message mentioning 429 must NOT be RATE_LIMITED
  const gemini500With429 = extractStructuredGeminiError({ code: '500', message: 'Internal server error while evaluating code with 429' });
  assert.equal(gemini500With429.code, 'PROCESS_ERROR');
  assert.equal(gemini500With429.retryable, false);

  // Gemini symbolic codes
  const geminiSym429 = extractStructuredGeminiError({ code: 'insufficient_quota', message: 'Request rejected' });
  assert.equal(geminiSym429.code, 'RATE_LIMITED');
  assert.equal(geminiSym429.retryable, true);

  const geminiSymNon429 = extractStructuredGeminiError({ code: 'invalid_request_error', message: 'HTTP 429 fixture' });
  assert.equal(geminiSymNon429.code, 'PROCESS_ERROR');
  assert.equal(geminiSymNon429.retryable, false);

  // Codex typed envelopes
  const codex429 = extractStructuredCodexError({ code: 'rate_limit_exceeded', message: 'Too many requests' });
  assert.equal(codex429.code, 'RATE_LIMITED');
  assert.equal(codex429.retryable, true);

  const codexQuota = extractStructuredCodexError({ type: 'insufficient_quota', message: 'Out of quota' });
  assert.equal(codexQuota.code, 'RATE_LIMITED');

  const codexGrpc8 = extractStructuredCodexError({ code: 8, status: 'RESOURCE_EXHAUSTED' });
  assert.equal(codexGrpc8.code, 'RATE_LIMITED');
  assert.equal(codexGrpc8.retryable, true);

  const codexGeneric429 = extractStructuredCodexError({ code: 'generic_failure', status_code: 429, type: 'rate_limit_error' });
  assert.equal(codexGeneric429.code, 'RATE_LIMITED');
  assert.equal(codexGeneric429.retryable, true);

  const codexAuth = extractStructuredCodexError({ code: 401, message: 'Unauthorized' });
  assert.equal(codexAuth.code, 'AUTH_REQUIRED');

  const codexModel = extractStructuredCodexError({ code: 'model_not_found', message: 'Model does not exist' });
  assert.equal(codexModel.code, 'MODEL_UNAVAILABLE');

  // Codex 400/invalid_request_error with message mentioning 429 must NOT be RATE_LIMITED
  const codex400With429Msg = extractStructuredCodexError({ code: 400, type: 'invalid_request_error', message: 'Parameter check failed for status 429' });
  assert.equal(codex400With429Msg.code, 'PROCESS_ERROR');
  assert.equal(codex400With429Msg.retryable, false);

  // Codex string-coded 500 with message mentioning 429 must NOT be RATE_LIMITED
  const codex500With429 = extractStructuredCodexError({ code: '500', message: 'Server error: prompt mentions 429 rate limit' });
  assert.equal(codex500With429.code, 'PROCESS_ERROR');
  assert.equal(codex500With429.retryable, false);

  // Codex symbolic codes
  const codexSym429 = extractStructuredCodexError({ code: 'insufficient_quota', message: 'Request rejected' });
  assert.equal(codexSym429.code, 'RATE_LIMITED');
  assert.equal(codexSym429.retryable, true);

  const codexSymNon429 = extractStructuredCodexError({ code: 'invalid_request_error', message: 'HTTP 429 fixture' });
  assert.equal(codexSymNon429.code, 'PROCESS_ERROR');
  assert.equal(codexSymNon429.retryable, false);

  // Normal text messages not containing error patterns are process errors
  const normalError = extractStructuredGeminiError('Syntax error in line 42');
  assert.equal(normalError.code, 'PROCESS_ERROR');
  assert.equal(normalError.retryable, false);
});

test('Phase 0 Task 0.3: Adaptive cooldown backoff escalates on retry failure and resets on success', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-backoff-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.coagent8_DIR = dir;
  process.env.coagent8_QUOTA_CACHE = path.join(dir, 'quota-cache.json');

  // Step 1: First rate limit hit -> 15s (level 0)
  const before1 = Date.now();
  await recordQuotaCooldown('codex');
  let cache = readQuotaCache();
  assert.ok(cache);
  assert.equal(cache.data.codex.status, 'rate_limited');
  assert.equal(cache.data.codex.cooldownLevel, 0);
  const diff1 = Date.parse(cache.data.codex.cooldownUntil) - before1;
  assert.ok(diff1 >= 14000 && diff1 <= 16000, `Expected ~15s diff, got ${diff1}ms`);

  // Simulate cooldown expiry: status resets to operational for probe, lastCooldownAt is preserved
  cache.data.codex.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await writeQuotaCache(cache.data);
  await inspectQuotas(true, { codex: { installed: true, executionSupported: true } });
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'operational');
  assert.equal(cache.data.codex.cooldownUntil, null);
  assert.equal(cache.data.codex.cooldownLevel, 0);
  assert.ok(cache.data.codex.lastCooldownAt);

  // Step 2: Probe fails with rate limit -> escalates to level 1 (45s) despite cooldownUntil having been null!
  const before2 = Date.now();
  await recordQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'rate_limited');
  assert.equal(cache.data.codex.cooldownLevel, 1);
  const diff2 = Date.parse(cache.data.codex.cooldownUntil) - before2;
  assert.ok(diff2 >= 44000 && diff2 <= 46000, `Expected ~45s diff, got ${diff2}ms`);

  // Simulate second cooldown expiry
  cache.data.codex.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await writeQuotaCache(cache.data);
  await inspectQuotas(true, { codex: { installed: true, executionSupported: true } });

  // Step 3: Second retry probe fails -> escalates to level 2 (180s)
  const before3 = Date.now();
  await recordQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.cooldownLevel, 2);
  const diff3 = Date.parse(cache.data.codex.cooldownUntil) - before3;
  assert.ok(diff3 >= 179000 && diff3 <= 181000, `Expected ~180s diff, got ${diff3}ms`);

  // Simulate cooldown expiry: status becomes operational, but backoff level is still 2
  cache.data.codex.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await writeQuotaCache(cache.data);
  await inspectQuotas(true, { codex: { installed: true, executionSupported: true } });
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'operational');
  assert.equal(cache.data.codex.cooldownLevel, 2);

  // Step 4: Successful turn resets backoff level to 0 and clears lastCooldownAt
  await resetQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'operational');
  assert.equal(cache.data.codex.cooldownUntil, null);
  assert.equal(cache.data.codex.cooldownLevel, 0);
  assert.equal(cache.data.codex.lastCooldownAt, null);

  // Subsequent rate limit starts fresh at 15s (level 0)
  const before4 = Date.now();
  await recordQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.cooldownLevel, 0);
  const diff4 = Date.parse(cache.data.codex.cooldownUntil) - before4;
  assert.ok(diff4 >= 14000 && diff4 <= 16000, `Expected reset to ~15s diff, got ${diff4}ms`);

  // Active rate limit must NOT be reset by a concurrent/stale success
  await resetQuotaCooldown('codex');
  cache = readQuotaCache();
  assert.equal(cache.data.codex.status, 'rate_limited');
  assert.ok(cache.data.codex.cooldownUntil);
});

test('Phase 0 Task 0.4: History streaming flush skips directory scan and enforces TOTAL_LIMIT', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-history-scan-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.coagent8_DIR = dir;
  const sess = createSession('gemini', dir);
  const writer = createHistoryWriter(sess.sessionHandle, dir, 'gemini', 'turn-1');

  // First flush initializes and triggers retention check
  writer.accept({ type: 'turn_started' });
  await writer.flush();

  const historyDir = path.resolve(getHistoryDir());
  const fsp = require('node:fs/promises');
  let historyDirScans = 0;
  const origReaddir = fsp.readdir;
  fsp.readdir = async (...args) => {
    if (args[0] && path.resolve(String(args[0])) === historyDir) {
      historyDirScans++;
    }
    return origReaddir.apply(fsp, args);
  };

  try {
    // Perform multiple rapid streaming flushes (simulating 250ms streaming updates)
    for (let i = 1; i <= 5; i++) {
      writer.accept({ type: 'assistant_delta', messageId: 'msg-1', text: `chunk ${i} ` });
      await writer.flush();
    }
    // Zero directory scans of history directory during subsequent streaming flushes!
    assert.equal(historyDirScans, 0, `Expected 0 history directory scans during streaming flushes, got ${historyDirScans}`);
  } finally {
    fsp.readdir = origReaddir;
  }

  // Session close invokes pruneHistoryDirectory
  let closedHistoryDirScans = 0;
  fsp.readdir = async (...args) => {
    if (args[0] && path.resolve(String(args[0])) === historyDir) {
      closedHistoryDirScans++;
    }
    return origReaddir.apply(fsp, args);
  };
  try {
    await closeSession(sess.sessionHandle, dir);
    assert.ok(closedHistoryDirScans > 0, 'Expected history directory scan during session close');
  } finally {
    fsp.readdir = origReaddir;
  }
});

test('Phase 0 Task 0.4: Concurrent writers strictly enforce 100MB TOTAL_LIMIT', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-history-concurrent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.coagent8_DIR = dir;
  const historyDir = getHistoryDir();
  fs.mkdirSync(historyDir, { recursive: true });

  const TOTAL_LIMIT = 100 * 1024 * 1024;
  const sess1 = createSession('gemini', dir);
  const writer1 = createHistoryWriter(sess1.sessionHandle, dir, 'gemini', 'turn-1');
  writer1.accept({ type: 'turn_started' });
  await writer1.flush(); // Initial flush initializes capacity tracking

  // Simulate a concurrent writer updating .capacity.meta to near the limit (TOTAL_LIMIT - 500 bytes)
  fs.writeFileSync(path.join(historyDir, '.capacity.meta'), JSON.stringify({ totalBytes: TOTAL_LIMIT - 500 }));

  // Next streaming flush adds 10KB, which would push total over 100MB
  writer1.accept({ type: 'assistant_message', messageId: 'm1', text: 'x'.repeat(10000) });
  await assert.rejects(
    async () => { await writer1.flush(); },
    /History total limit reached\./
  );

  // Deleting history updates capacity metadata
  await deleteHistory(sess1.sessionHandle, dir);
  const metaAfterDel = JSON.parse(fs.readFileSync(path.join(historyDir, '.capacity.meta'), 'utf8'));
  assert.ok(metaAfterDel.totalBytes < TOTAL_LIMIT - 500);
});
