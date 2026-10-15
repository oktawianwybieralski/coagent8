/**
 * Isolated environment lifecycle for native acceptance runs (ACCEPT-001b).
 *
 * @remarks
 * Every path the acceptance runner or an isolated instance writes lies under a
 * disposable temporary root it owns. The isolated environment provides explicit
 * child process environment variables while never mutating the runner's own
 * `process.env`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STRIP_PREFIXES = [
  'coagent8_',
  'codex_',
  'claude_',
  'gemini_',
  'npm_',
  'vscode_',
  'electron_',
];

const STRIP_EXACT = new Set([
  'anthropic_api_key',
  'openai_api_key',
  'codex_api_key',
  'gemini_api_key',
  'google_api_key',
  'coagent8_nested_turn',
  'vscode_ipc_hook_cli',
  'electron_run_as_node',
]);

/**
 * Creates a hermetic, disposable environment for acceptance runs.
 *
 * @param options - Configuration options for the environment.
 * @returns The isolated environment descriptor.
 */
function createIsolatedAcceptanceEnvironment(options = {}) {
  const baseDir = options.tempRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-acceptance-'));
  fs.mkdirSync(baseDir, { recursive: true });
  // Canonicalize native realpath once to prevent short-path (C:\Users\RUNNER~1\...) mismatches.
  const root = fs.realpathSync.native(baseDir);

  const home = path.join(root, 'home');
  const appdata = path.join(root, 'appdata');
  const localappdata = path.join(root, 'localappdata');
  const config = path.join(root, 'config');
  const npmPrefix = path.join(root, 'npm-prefix');
  const npmCache = path.join(root, 'npm-cache');
  const vscodeUserData = path.join(root, 'vscode-user-data');
  const vscodeExtensions = path.join(root, 'vscode-extensions');
  const tmp = path.join(root, 'tmp');

  for (const dir of [home, appdata, localappdata, config, npmPrefix, npmCache, vscodeUserData, vscodeExtensions, tmp]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const isolated = {
    root,
    home,
    appdata,
    localappdata,
    config,
    npmPrefix,
    npmCache,
    vscodeUserData,
    vscodeExtensions,
    tmp,
  };

  isolated.childEnv = buildIsolatedChildEnv(isolated, options.parentEnv || process.env);
  return isolated;
}

/**
 * Constructs an explicit child process environment where all user and state roots
 * point into the isolated temporary directory tree.
 *
 * @param isolated - The isolated environment descriptor.
 * @param baseEnv - Parent environment to sanitize.
 * @returns Sanitized environment object for child processes.
 */
function buildIsolatedChildEnv(isolated, baseEnv = process.env) {
  const env = {};

  // Case-insensitive stripping on Windows / POSIX.
  for (const [key, value] of Object.entries(baseEnv)) {
    const lower = key.toLowerCase();
    if (STRIP_PREFIXES.some(prefix => lower.startsWith(prefix))) continue;
    if (STRIP_EXACT.has(lower)) continue;
    if (lower.endsWith('_api_key') || lower.endsWith('_token')) continue;
    env[key] = value;
  }

  // Explicit user home and config overrides
  env.HOME = isolated.home;
  env.USERPROFILE = isolated.home;
  env.APPDATA = isolated.appdata;
  env.LOCALAPPDATA = isolated.localappdata;
  env.XDG_CONFIG_HOME = isolated.config;
  env.XDG_DATA_HOME = path.join(isolated.home, '.local', 'share');
  env.XDG_STATE_HOME = path.join(isolated.home, '.local', 'state');
  env.XDG_CACHE_HOME = path.join(isolated.home, '.cache');

  // Temporary file redirection
  env.TEMP = isolated.tmp;
  env.TMP = isolated.tmp;
  env.TMPDIR = isolated.tmp;

  // npm containment
  env.npm_config_prefix = isolated.npmPrefix;
  env.npm_config_cache = isolated.npmCache;
  env.npm_config_userconfig = path.join(isolated.root, '.npmrc');

  // Codex client containment: points into isolated home
  env.CODEX_HOME = path.join(isolated.home, '.codex');

  // Do not set coagent8_DIR or coagent8_CONFIG so the runtime resolves to
  // isolated.home/.coagent8 naturally, matching standard user installations.

  return env;
}

/**
 * Cleans up the isolated temporary root directory with retries for Windows locks.
 *
 * @param isolated - The isolated environment descriptor.
 */
function cleanupIsolatedEnvironment(isolated) {
  if (!isolated || !isolated.root || !fs.existsSync(isolated.root)) return;
  fs.rmSync(isolated.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

module.exports = {
  createIsolatedAcceptanceEnvironment,
  buildIsolatedChildEnv,
  cleanupIsolatedEnvironment,
};
