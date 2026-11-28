'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NESTED_TURN_ENV,
  TURN_ISOLATED_PATH_ENV_VARS,
  TURN_STRIPPED_PATH_ENV_VARS,
  turnEnvironment,
} = require('../../src/execution/nested-turn.ts');
const { agyEnvironment, execute: executeAgy } = require('../../src/backends/agy/adapter.ts');
const { claudeTurnEnvironment, executeClaude } = require('../../src/backends/claude/adapter.ts');
const { codexLaunchEnvironment } = require('../../src/backends/codex/app-server.ts');
const { execute: executeCodex } = require('../../src/backends/codex/adapter.ts');

function canonicalExistingPath(target) {
  let current = path.resolve(target);
  const missing = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch (err) {
      const parent = path.dirname(current);
      if ((err.code !== 'ENOENT' && err.code !== 'ENOTDIR') || parent === current) {
        throw err;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInsideDir(target, parent) {
  const realParent = canonicalExistingPath(parent);
  const realTarget = canonicalExistingPath(target);
  const normalize = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(normalize(realParent), normalize(realTarget));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertDisposableTurnEnv(env, serverEnv, label) {
  assert.equal(env[NESTED_TURN_ENV], '1', `${label}: sets nested-turn guard`);
  for (const key of TURN_ISOLATED_PATH_ENV_VARS) {
    assert.ok(env[key], `${label}: ${key} is explicitly set`);
    assert.notEqual(env[key], serverEnv[key], `${label}: ${key} does not inherit server value`);
  }
  for (const key of TURN_STRIPPED_PATH_ENV_VARS) {
    assert.equal(env[key], undefined, `${label}: ${key} is stripped`);
    assert.equal(
      Object.keys(env).filter(candidate => candidate.toLowerCase() === key.toLowerCase()).length,
      0,
      `${label}: case variants of ${key} are stripped`,
    );
  }
  assert.ok(isInsideDir(env.coagent8_DIR, os.tmpdir()), `${label}: coagent8_DIR lives inside os.tmpdir()`);
  for (const key of ['coagent8_CONFIG', 'coagent8_QUOTA_CACHE', 'coagent8_SESSIONS_DIR', 'coagent8_SESSIONS', 'coagent8_END_NOTES_DIR']) {
    assert.ok(isInsideDir(env[key], env.coagent8_DIR), `${label}: ${key} lives inside disposable turn dir`);
  }
}

test('turnEnvironment replaces every CoAgent8 path variable with a shared per-process disposable directory and preserves backend profiles (#248)', t => {
  const serverBase = {
    PATH: process.env.PATH,
    HOME: '/fake/user/home',
    USERPROFILE: 'C:\\Users\\RealUser',
    CLAUDE_CONFIG_DIR: '/fake/user/claude',
    CODEX_HOME: '/fake/user/codex',
    CODEX_CONFIG_PATH: '/fake/user/codex/config.toml',
    GEMINI_CLI_HOME: '/fake/user/gemini',
    coagent8_DIR: '/fake/user/.coagent8',
    COAGENT8_DIR: '/fake/user/.coagent8-upper',
    coagent8_CONFIG: '/fake/user/.coagent8/config.json',
    COAGENT8_CONFIG: '/fake/user/.coagent8/config-upper.json',
    coagent8_QUOTA_CACHE: '/fake/user/.coagent8/quota-cache.json',
    coagent8_SESSIONS_DIR: '/fake/user/.coagent8/sessions',
    coagent8_SESSIONS: '/fake/user/.coagent8/sessions.json',
    coagent8_END_NOTES_DIR: '/fake/user/.coagent8/end-notes',
    coagent8_EXTENSION_PATHS: '{"claude":"/fake/user/ext"}',
    COAGENT8_EXTENSION_PATHS: '{"codex":"/fake/user/ext-upper"}',
    CoAgent8_Extension_Paths: '{"agy":"/fake/user/ext-mixed"}',
  };

  const first = turnEnvironment(serverBase);
  const second = turnEnvironment({});

  t.after(() => {
    fs.rmSync(first.coagent8_DIR, { recursive: true, force: true });
  });

  assertDisposableTurnEnv(first, serverBase, 'first turn');
  assertDisposableTurnEnv(second, {}, 'empty base turn');
  assert.equal(first.coagent8_DIR, second.coagent8_DIR, 'turns in the same process reuse the disposable directory');

  // Case-insensitive duplicate keys from the server environment are dropped.
  assert.equal(Object.keys(first).filter(k => k.toLowerCase() === 'coagent8_dir').length, 1);
  assert.equal(Object.keys(first).filter(k => k.toLowerCase() === 'coagent8_config').length, 1);

  // Backend profile variables stay intact.
  assert.equal(first.HOME, serverBase.HOME);
  assert.equal(first.USERPROFILE, serverBase.USERPROFILE);
  assert.equal(first.CLAUDE_CONFIG_DIR, serverBase.CLAUDE_CONFIG_DIR);
  assert.equal(first.CODEX_HOME, serverBase.CODEX_HOME);
  assert.equal(first.CODEX_CONFIG_PATH, serverBase.CODEX_CONFIG_PATH);
  assert.equal(first.GEMINI_CLI_HOME, serverBase.GEMINI_CLI_HOME);
});

test('turnEnvironment removes its disposable directory on process exit and prunes stale coagent8-turn-* directories only for dead PIDs (#248)', t => {
  const scratchTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-turn-cleanup-'));
  const liveChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const exitedChild = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  const deadPid = exitedChild.pid;
  assert.ok(deadPid && liveChild.pid, 'expected valid child PIDs');

  const deadStaleDir = path.join(scratchTmp, `coagent8-turn-${deadPid}-stale`);
  const deadFreshDir = path.join(scratchTmp, `coagent8-turn-${deadPid}-fresh`);
  const liveStaleDir = path.join(scratchTmp, `coagent8-turn-${liveChild.pid}-live`);
  fs.mkdirSync(deadStaleDir, { recursive: true });
  fs.mkdirSync(deadFreshDir, { recursive: true });
  fs.mkdirSync(liveStaleDir, { recursive: true });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(deadStaleDir, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(liveStaleDir, twoDaysAgo, twoDaysAgo);

  t.after(() => {
    try {
      liveChild.kill();
    } catch {
      // Already exited.
    }
    fs.rmSync(scratchTmp, { recursive: true, force: true });
  });

  const nestedTurnModule = path.resolve(__dirname, '../../src/execution/nested-turn.ts');
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const { turnEnvironment } = require(process.argv[1]);
const scratch = process.argv[2];
const ownStale = path.join(scratch, 'coagent8-turn-' + process.pid + '-own');
fs.mkdirSync(ownStale, { recursive: true });
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
fs.utimesSync(ownStale, twoDaysAgo, twoDaysAgo);
const a = turnEnvironment();
const b = turnEnvironment();
console.log(JSON.stringify({ a: a.coagent8_DIR, b: b.coagent8_DIR, ownStaleExists: fs.existsSync(ownStale) }));
`;
  const run = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', script, nestedTurnModule, scratchTmp], {
    env: { ...process.env, TMP: scratchTmp, TEMP: scratchTmp, TMPDIR: scratchTmp },
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(run.status, 0, `child process failed: ${run.stderr}`);
  const { a, b, ownStaleExists } = JSON.parse(run.stdout.trim());
  assert.equal(a, b, 'child process reuses one directory across turns');
  assert.ok(isInsideDir(a, scratchTmp), 'created inside os.tmpdir()');
  assert.equal(ownStaleExists, true, 'current process directory is never pruned');
  assert.equal(fs.existsSync(a), false, 'disposable directory is removed on process exit');
  assert.equal(fs.existsSync(deadStaleDir), false, 'stale coagent8-turn-* directory of a dead PID older than a day is pruned');
  assert.equal(fs.existsSync(deadFreshDir), true, 'recent coagent8-turn-* directory is kept');
  assert.equal(fs.existsSync(liveStaleDir), true, 'old coagent8-turn-* directory of a live PID is kept');
});

test('every backend turn (agy, claude, codex) receives disposable CoAgent8 paths, not the server paths (#248)', async t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-turn-backends-'));
  const serverDataDir = path.join(workDir, 'server-data');
  const serverConfig = path.join(workDir, 'server-config.json');
  const serverQuota = path.join(workDir, 'server-quota.json');
  const serverSessionsDir = path.join(workDir, 'server-sessions');
  const serverSessions = path.join(workDir, 'server-sessions.json');
  const serverEndNotes = path.join(workDir, 'server-end-notes');
  const claudeProfile = path.join(workDir, 'claude-profile');
  const codexHome = path.join(workDir, 'codex-home');
  fs.mkdirSync(serverDataDir, { recursive: true });
  fs.mkdirSync(claudeProfile, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const previous = { ...process.env };
  const turnDirs = [];

  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    for (const dir of turnDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  process.env.coagent8_DIR = serverDataDir;
  process.env.coagent8_CONFIG = serverConfig;
  process.env.coagent8_QUOTA_CACHE = serverQuota;
  process.env.coagent8_SESSIONS_DIR = serverSessionsDir;
  process.env.coagent8_SESSIONS = serverSessions;
  process.env.coagent8_END_NOTES_DIR = serverEndNotes;
  process.env.CLAUDE_CONFIG_DIR = claudeProfile;
  process.env.CODEX_HOME = codexHome;

  // Unit check of each backend's turn environment builder.
  const agyBuilt = turnEnvironment(agyEnvironment());
  const claudeBuilt = claudeTurnEnvironment();
  const codexBuilt = codexLaunchEnvironment(turnEnvironment());
  turnDirs.push(agyBuilt.coagent8_DIR, claudeBuilt.coagent8_DIR, codexBuilt.coagent8_DIR);
  assertDisposableTurnEnv(agyBuilt, process.env, 'agy builder');
  assertDisposableTurnEnv(claudeBuilt, process.env, 'claude builder');
  assertDisposableTurnEnv(codexBuilt, process.env, 'codex builder');
  if (process.platform === 'win32') {
    assert.equal(agyBuilt.USERPROFILE, path.join(serverDataDir, 'agy-profile'));
  }
  assert.equal(claudeBuilt.CLAUDE_CONFIG_DIR, claudeProfile);
  assert.equal(codexBuilt.CODEX_HOME, codexHome);

  // Live fixture check: execute a turn on each backend and inspect the spawned process env.
  const agyCapture = path.join(workDir, 'agy-capture.json');
  process.env.AGY_PATH = path.resolve(__dirname, '../fixtures/agy-cli/agy.cjs');
  process.env.coagent8_FIXTURE_CAPTURE = agyCapture;
  const agyRes = await executeAgy('Reply OK', { cwd: workDir, model: 'gemini-3.8-flash-high' });
  assert.equal(agyRes.status, 'completed', JSON.stringify(agyRes));
  const agyEnv = JSON.parse(fs.readFileSync(agyCapture, 'utf8')).coagent8Env;
  turnDirs.push(agyEnv.coagent8_DIR);
  assertDisposableTurnEnv(agyEnv, process.env, 'agy spawned turn');
  if (process.platform === 'win32') {
    assert.equal(agyEnv.USERPROFILE, path.join(serverDataDir, 'agy-profile'));
  }

  const claudeCapture = path.join(workDir, 'claude-capture.json');
  process.env.CLAUDE_PATH = path.resolve(__dirname, '../fixtures/claude-cli/claude.cjs');
  process.env.CLAUDE_FIXTURE_CAPTURE = claudeCapture;
  const claudeRes = await executeClaude('Reply OK', { cwd: workDir, model: 'claude-sonnet-4-6' });
  assert.equal(claudeRes.status, 'completed', JSON.stringify(claudeRes));
  const claudeEnv = JSON.parse(fs.readFileSync(claudeCapture, 'utf8')).coagent8Env;
  turnDirs.push(claudeEnv.coagent8_DIR);
  assertDisposableTurnEnv(claudeEnv, process.env, 'claude spawned turn');
  assert.equal(claudeEnv.CLAUDE_CONFIG_DIR, claudeProfile);

  const codexCapture = path.join(workDir, 'codex-capture.json');
  process.env.CODEX_PATH = path.resolve(__dirname, '../fixtures/codex-cli/codex.cjs');
  process.env.CODEX_FIXTURE_CAPTURE = codexCapture;
  const codexRes = await executeCodex('Reply OK', { cwd: workDir, model: 'gpt-6.1-sol' });
  assert.equal(codexRes.status, 'completed', JSON.stringify(codexRes));
  const codexEnv = JSON.parse(fs.readFileSync(codexCapture, 'utf8')).coagent8Env;
  turnDirs.push(codexEnv.coagent8_DIR);
  assertDisposableTurnEnv(codexEnv, process.env, 'codex spawned turn');
  assert.equal(codexEnv.CODEX_HOME, codexHome);
});

test('regression (#248): a test script run by hand inside a turn cannot modify the user config file', t => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-turn-regression-'));
  const fakeUserHome = path.join(workDir, 'fake-user-home');
  const fakeCoAgent8Dir = path.join(fakeUserHome, '.coagent8');
  const fakeUserConfig = path.join(fakeCoAgent8Dir, 'config.json');
  fs.mkdirSync(fakeCoAgent8Dir, { recursive: true });

  const originalBytes = JSON.stringify(
    {
      schemaVersion: 1,
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude'] },
    },
    null,
    2,
  );
  fs.writeFileSync(fakeUserConfig, originalBytes, 'utf8');

  const serverEnv = {
    ...process.env,
    HOME: fakeUserHome,
    USERPROFILE: fakeUserHome,
    coagent8_DIR: fakeCoAgent8Dir,
    coagent8_CONFIG: fakeUserConfig,
  };
  // The server itself does not run inside `node --test`; deleting NODE_TEST_CONTEXT lets the spawned `tsx --test` run its file.
  delete serverEnv.NODE_TEST_CONTEXT;
  const turnEnv = turnEnvironment(serverEnv);

  const handRunTest = path.join(workDir, 'hand-repro.test.js');
  const configModule = path.resolve(__dirname, '../../src/config.ts');
  fs.writeFileSync(
    handRunTest,
    `
const test = require('node:test');
const assert = require('node:assert/strict');
const { saveConfig, getConfigFile } = require(${JSON.stringify(configModule)});
test('hand-run repro writes config without setting coagent8_CONFIG', async () => {
  const saved = await saveConfig({ defaultBackend: 'agy', routing: { allowedBackends: ['agy'] } });
  assert.equal(saved.defaultBackend, 'agy');
  assert.equal(getConfigFile(), process.env.coagent8_CONFIG);
});
`,
    'utf8',
  );

  t.after(() => {
    fs.rmSync(turnEnv.coagent8_DIR, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // Simulate running `node --test` (via tsx) directly by hand inside an agent turn.
  const run = spawnSync(process.execPath, [require.resolve('tsx/cli'), '--test', handRunTest], {
    env: turnEnv,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(run.status, 0, `hand-run test inside turn failed:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stdout, /pass 1\b/, `expected child test to execute:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.equal(fs.readFileSync(fakeUserConfig, 'utf8'), originalBytes, 'fake user config must remain byte-for-byte unchanged');
  const turnWritten = JSON.parse(fs.readFileSync(turnEnv.coagent8_CONFIG, 'utf8'));
  assert.equal(turnWritten.defaultBackend, 'agy', 'write landed in the disposable per-turn config file');
});
