/**
 * Isolated environment lifecycle for native acceptance runs (ACCEPT-001b).
 *
 * @remarks
 * Every path the acceptance runner or an isolated instance writes lies under a
 * disposable temporary root it creates itself. The isolated environment provides
 * explicit child process environment variables while never mutating the runner's
 * own `process.env`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Parent variables with these prefixes configure clients, credentials or the editor and are dropped. */
const STRIP_PREFIXES = [
  'coagent8_',
  'codex_',
  'claude_',
  'gemini_',
  'agy_',
  'npm_',
  'vscode_',
  'electron_',
  'git_config',
  'aws_',
  'azure_',
];

/** Credential suffixes dropped from any variable name. */
const STRIP_SUFFIXES = ['_api_key', '_token', '_secret', '_password', '_credentials'];

/**
 * Parent variables dropped by exact name: Node.js preload and coverage settings
 * (they can load or write files outside the isolated root), credential file
 * overrides and the Windows home drive split.
 */
const STRIP_EXACT = new Set([
  'anthropic_api_key',
  'openai_api_key',
  'node_options',
  'node_path',
  'node_v8_coverage',
  'node_repl_history',
  'node_compile_cache',
  'google_application_credentials',
  'cloudsdk_config',
  'homedrive',
  'homepath',
]);

/**
 * Creates a hermetic, disposable environment for acceptance runs.
 *
 * @param options - `tempParent` is the directory under which a fresh root is
 * created (default: the system temporary directory); `parentEnv` is the
 * environment to sanitize (default: `process.env`).
 * @returns The isolated environment descriptor.
 * @remarks The root is always a new directory from `mkdtemp`, so cleanup only ever
 * removes a tree this runner created.
 */
function createIsolatedAcceptanceEnvironment(options = {}) {
  const parent = options.tempParent || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  // Canonicalize native realpath once to prevent short-path (C:\Users\RUNNER~1\...) mismatches.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'coagent8-acceptance-')));

  const isolated = {
    root,
    home: path.join(root, 'home'),
    appdata: path.join(root, 'appdata'),
    localappdata: path.join(root, 'localappdata'),
    config: path.join(root, 'config'),
    npmPrefix: path.join(root, 'npm-prefix'),
    npmCache: path.join(root, 'npm-cache'),
    vscodeUserData: path.join(root, 'vscode-user-data'),
    vscodeExtensions: path.join(root, 'vscode-extensions'),
    tmp: path.join(root, 'tmp'),
  };
  for (const [key, dir] of Object.entries(isolated)) {
    if (key !== 'root') fs.mkdirSync(dir, { recursive: true });
  }

  isolated.childEnv = buildIsolatedChildEnv(isolated, options.parentEnv || process.env);
  return isolated;
}

function isStripped(lower) {
  return (
    STRIP_EXACT.has(lower) ||
    STRIP_PREFIXES.some(prefix => lower.startsWith(prefix)) ||
    STRIP_SUFFIXES.some(suffix => lower.endsWith(suffix))
  );
}

/**
 * Constructs an explicit child process environment where all user and state roots
 * point into the isolated temporary directory tree.
 *
 * @param isolated - The isolated environment descriptor.
 * @param baseEnv - Parent environment to sanitize.
 * @returns Sanitized environment object for child processes.
 * @remarks Names compare case-insensitively: Windows treats `Temp` and `TEMP` as one
 * variable, so a parent spelling of an overridden name is dropped instead of
 * competing with the override.
 */
function buildIsolatedChildEnv(isolated, baseEnv = process.env) {
  const overrides = {
    // Explicit user home and config overrides
    HOME: isolated.home,
    USERPROFILE: isolated.home,
    APPDATA: isolated.appdata,
    LOCALAPPDATA: isolated.localappdata,
    XDG_CONFIG_HOME: isolated.config,
    XDG_DATA_HOME: path.join(isolated.home, '.local', 'share'),
    XDG_STATE_HOME: path.join(isolated.home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(isolated.home, '.cache'),
    // Temporary file redirection
    TEMP: isolated.tmp,
    TMP: isolated.tmp,
    TMPDIR: isolated.tmp,
    // npm containment
    npm_config_prefix: isolated.npmPrefix,
    npm_config_cache: isolated.npmCache,
    npm_config_userconfig: path.join(isolated.root, '.npmrc'),
    // Codex client containment: points into isolated home
    CODEX_HOME: path.join(isolated.home, '.codex'),
  };
  // coagent8_DIR and coagent8_CONFIG stay unset so the runtime resolves to
  // isolated.home/.coagent8 naturally, matching standard user installations.
  const overridden = new Set(Object.keys(overrides).map(key => key.toLowerCase()));

  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const lower = key.toLowerCase();
    if (value === undefined || overridden.has(lower) || isStripped(lower)) continue;
    env[key] = value;
  }
  return Object.assign(env, overrides);
}

/**
 * Returns the executable search path of an environment, whatever the key's spelling.
 *
 * @param env - Environment object.
 * @returns The search path, or an empty string.
 */
function searchPathOf(env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

/**
 * Removes the isolated root this runner created, with retries for Windows locks.
 *
 * @param isolated - The isolated environment descriptor.
 */
function cleanupIsolatedEnvironment(isolated) {
  if (!isolated || !isolated.root) return;
  fs.rmSync(isolated.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

module.exports = {
  createIsolatedAcceptanceEnvironment,
  buildIsolatedChildEnv,
  cleanupIsolatedEnvironment,
  searchPathOf,
};
