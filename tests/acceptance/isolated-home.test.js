/**
 * Acceptance test for isolated user home (ACCEPT-001b, row 2.15).
 *
 * @remarks
 * Proves that isolated instances and the runner never write to the user's real
 * client registrations or `~/.coagent8/config.json`. Seeds a fake real home with
 * existing registrations and settings, runs the isolated install and registration
 * flow, and asserts that the fake real home remains completely untouched and
 * byte-identical.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  createIsolatedAcceptanceEnvironment,
  cleanupIsolatedEnvironment,
} = require('../../tooling/acceptance/environment.cjs');
const { setupClients } = require('../../src/integrations/setup.ts');

function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Recursively snapshots every file in a directory tree. */
function snapshotTree(dir) {
  const map = new Map();
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(dir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        map.set(relPath, {
          size: content.length,
          hash: hashBuffer(content),
          content,
        });
      }
    }
  }
  walk(dir);
  return map;
}

test('isolated instances and runner never touch real home registrations or config (ACCEPT-001b)', async t => {
  // 1. Seed a fake "real" home with existing client registrations and config
  const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-fake-real-home-'));
  const realHomeCanonical = fs.realpathSync.native(fakeRealHome);

  t.after(() => {
    fs.rmSync(fakeRealHome, { recursive: true, force: true, maxRetries: 5 });
  });

  const realClaudeConfig = path.join(realHomeCanonical, '.claude.json');
  const realCodexDir = path.join(realHomeCanonical, '.codex');
  const realCodexConfig = path.join(realCodexDir, 'config.toml');
  const realGeminiConfigDir = path.join(realHomeCanonical, '.gemini', 'config');
  const realGeminiConfig = path.join(realGeminiConfigDir, 'mcp_config.json');
  const realCoAgent8Dir = path.join(realHomeCanonical, '.coagent8');
  const realCoAgent8Config = path.join(realCoAgent8Dir, 'config.json');

  fs.mkdirSync(realCodexDir, { recursive: true });
  fs.mkdirSync(realGeminiConfigDir, { recursive: true });
  fs.mkdirSync(realCoAgent8Dir, { recursive: true });

  const seededClaude = '{\n  "mcpServers": {\n    "real-unrelated": {\n      "command": "node",\n      "args": ["real-claude.js"]\n    }\n  }\n}\n';
  const seededCodex = '# Real Codex Configuration\nmodel = "gpt-real"\n\n[mcp_servers.real_unrelated]\ncommand = "real-codex"\nargs = []\n';
  const seededGemini = '{\n  "mcpServers": {\n    "real-unrelated": {\n      "command": "real-gemini",\n      "args": []\n    }\n  }\n}\n';
  const seededCoAgent8 = '{\n  "realSetting": "keep-intact",\n  "doNotTouch": true\n}\n';

  fs.writeFileSync(realClaudeConfig, seededClaude, 'utf8');
  fs.writeFileSync(realCodexConfig, seededCodex, 'utf8');
  fs.writeFileSync(realGeminiConfig, seededGemini, 'utf8');
  fs.writeFileSync(realCoAgent8Config, seededCoAgent8, 'utf8');

  // 2. Snapshot the fake real home before running isolated operations
  const preSnapshot = snapshotTree(realHomeCanonical);
  assert.equal(preSnapshot.size, 4, 'Must have snapshotted 4 seeded files');

  // 3. Create a parent environment hostilely pointing to the fake real home
  const hostileParentEnv = {
    ...process.env,
    HOME: realHomeCanonical,
    USERPROFILE: realHomeCanonical,
    coagent8_DIR: realCoAgent8Dir,
    COAGENT8_DIR: realCoAgent8Dir,
    coagent8_CONFIG: realCoAgent8Config,
    CODEX_HOME: realCodexDir,
    CLAUDE_CONFIG_DIR: realHomeCanonical,
    GEMINI_CLI_HOME: realHomeCanonical,
    npm_config_prefix: path.join(realHomeCanonical, 'npm-global'),
    npm_config_cache: path.join(realHomeCanonical, 'npm-cache'),
    NPM_CONFIG_CACHE: path.join(realHomeCanonical, 'npm-cache'),
    VSCODE_IPC_HOOK_CLI: 'fake-ipc-socket',
  };

  // 4. Create the isolated environment using the hostile parent environment
  const isolated = createIsolatedAcceptanceEnvironment({
    parentEnv: hostileParentEnv,
  });

  t.after(() => {
    cleanupIsolatedEnvironment(isolated);
  });

  // 5. Run the isolated installation and registration flow
  const cliFixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const runtimeSource = path.resolve(__dirname, '../../dist/index.cjs');

  const setupEnv = {
    ...isolated.childEnv,
    CODEX_PATH: cliFixture,
    CLAUDE_PATH: cliFixture,
    AGY_PATH: cliFixture,
    SETUP_FIXTURE_HOME: isolated.home,
  };

  const workspace = path.join(isolated.home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const results = await setupClients({
    home: isolated.home,
    cwd: workspace,
    env: setupEnv,
    runtimeSource,
    clients: ['codex', 'claude', 'agy'],
  });

  // Verify isolated instance set up its registrations in the isolated home
  assert.ok(results.length >= 3, 'Setup clients must return results for all clients');
  assert.ok(fs.existsSync(path.join(isolated.home, '.codex', 'config.toml')), 'Codex registration in isolated home');
  assert.ok(fs.existsSync(path.join(isolated.home, '.claude.json')), 'Claude registration in isolated home');
  assert.ok(fs.existsSync(path.join(isolated.home, '.gemini', 'config', 'mcp_config.json')), 'agy registration in isolated home');
  assert.ok(fs.existsSync(path.join(isolated.home, '.coagent8')), 'CoAgent8 directory in isolated home');

  // 6. Assert that the fake real home is completely untouched and byte-identical
  const postSnapshot = snapshotTree(realHomeCanonical);
  assert.equal(postSnapshot.size, preSnapshot.size, 'No new files or removed files in fake real home');

  for (const [relPath, preRecord] of preSnapshot.entries()) {
    const postRecord = postSnapshot.get(relPath);
    assert.ok(postRecord, `File ${relPath} must still exist in fake real home`);
    assert.equal(postRecord.hash, preRecord.hash, `File ${relPath} must have identical SHA-256 hash`);
    assert.deepEqual(postRecord.content, preRecord.content, `File ${relPath} must be byte-identical`);
  }
});

test('isolated child process resolves isolated home from child environment without explicit home option', async t => {
  const fakeRealHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-fake-real-home2-'));
  const realHomeCanonical = fs.realpathSync.native(fakeRealHome);

  t.after(() => {
    fs.rmSync(fakeRealHome, { recursive: true, force: true, maxRetries: 5 });
  });

  const realClaudeConfig = path.join(realHomeCanonical, '.claude.json');
  fs.writeFileSync(realClaudeConfig, '{\n  "mcpServers": {\n    "real-unrelated": {\n      "command": "node"\n    }\n  }\n}\n', 'utf8');
  const preSnapshot = snapshotTree(realHomeCanonical);

  const hostileParentEnv = {
    ...process.env,
    HOME: realHomeCanonical,
    USERPROFILE: realHomeCanonical,
  };

  const isolated = createIsolatedAcceptanceEnvironment({
    parentEnv: hostileParentEnv,
  });

  t.after(() => {
    cleanupIsolatedEnvironment(isolated);
  });

  const cliFixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const runtimeSource = path.resolve(__dirname, '../../dist/index.cjs');
  const setupModule = path.resolve(__dirname, '../../src/integrations/setup.ts');

  // Child script invokes setupClients without passing options.home
  const childScript = `
    const { setupClients } = require(${JSON.stringify(setupModule)});
    async function main() {
      const results = await setupClients({
        cwd: process.cwd(),
        runtimeSource: ${JSON.stringify(runtimeSource)},
        clients: ['claude'],
      });
      if (!results || results.length === 0) process.exit(2);
      process.exit(0);
    }
    main().catch(err => {
      console.error(err);
      process.exit(1);
    });
  `;

  const childScriptPath = path.join(isolated.root, 'child-setup-runner.cjs');
  fs.writeFileSync(childScriptPath, childScript, 'utf8');

  const cp = require('node:child_process');
  const res = cp.spawnSync(process.execPath, ['-r', require.resolve('tsx/cjs'), childScriptPath], {
    cwd: isolated.home,
    env: {
      ...isolated.childEnv,
      CLAUDE_PATH: cliFixture,
      SETUP_FIXTURE_HOME: isolated.home,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });

  assert.equal(res.status, 0, `Child setup must exit 0: ${res.stderr || res.stdout}`);
  assert.ok(fs.existsSync(path.join(isolated.home, '.claude.json')), 'Child must write registration in isolated home');

  const postSnapshot = snapshotTree(realHomeCanonical);
  assert.equal(postSnapshot.size, preSnapshot.size, 'Fake real home must remain untouched');
  for (const [relPath, preRecord] of preSnapshot.entries()) {
    const postRecord = postSnapshot.get(relPath);
    assert.ok(postRecord);
    assert.equal(postRecord.hash, preRecord.hash);
  }
});

test('isolated child environment drops preload, coverage, credential and shadowing parent variables', () => {
  const { buildIsolatedChildEnv } = require('../../tooling/acceptance/environment.cjs');
  const isolated = {
    root: path.join(os.tmpdir(), 'iso'), home: path.join(os.tmpdir(), 'iso', 'home'), appdata: 'a', localappdata: 'l',
    config: 'c', npmPrefix: 'p', npmCache: 'n', tmp: path.join(os.tmpdir(), 'iso', 'tmp'),
  };
  const env = buildIsolatedChildEnv(isolated, {
    Path: '/usr/bin',
    NODE_OPTIONS: '--require /real/home/preload.js',
    NODE_V8_COVERAGE: '/real/home/coverage',
    GOOGLE_APPLICATION_CREDENTIALS: '/real/home/gcloud.json',
    AWS_SECRET_ACCESS_KEY: 'secret',
    GH_TOKEN: 'token',
    DB_PASSWORD: 'pw',
    AGY_PATH: '/real/agy',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\Users\real',
    Temp: '/real/tmp',
    UserProfile: '/real/home',
    GIT_CONFIG_GLOBAL: '/real/home/.gitconfig',
  });
  for (const key of ['NODE_OPTIONS', 'NODE_V8_COVERAGE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN',
    'DB_PASSWORD', 'AGY_PATH', 'HOMEDRIVE', 'HOMEPATH', 'Temp', 'UserProfile', 'GIT_CONFIG_GLOBAL']) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach the child`);
  }
  assert.equal(env.Path, '/usr/bin');
  assert.equal(env.TEMP, isolated.tmp);
  assert.equal(env.USERPROFILE, isolated.home);
});
