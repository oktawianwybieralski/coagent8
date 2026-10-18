/**
 * Backend CLIs and sign-in for native acceptance scenarios (ACCEPT-001a2).
 *
 * @remarks
 * The isolated home has no backend installation or sign-in. Each CLI is resolved in the
 * parent context, as the user's own runtime would resolve it, and handed to the scenario
 * servers through its `*_PATH` override. Sign-in reaches a scenario server only with the
 * operator's `--with-backend-auth`: the backend roots then point at the user's real ones
 * in place. Credentials are never copied, because a refresh in a copy would rotate the
 * refresh token and sign the user's own clients out. In-place use shares writable backend
 * state (credentials, settings, histories and caches) with the user's desktop clients;
 * installation and the runtime probe never receive it.
 */
require('tsx/cjs');
const fs = require('node:fs');
const path = require('node:path');
const { backendCommand } = require('../../src/backends/executable.ts');
const { readBackendExecutable } = require('../../src/config.ts');
const { resolveBundledClaude, resolveBundledCodex, resolveManagedAgy } = require('../../src/execution/cli-resolver.ts');
const { searchPathOf } = require('./environment.cjs');

const BACKENDS = ['codex', 'claude', 'agy'];
const PATH_VARIABLES = { codex: 'CODEX_PATH', claude: 'CLAUDE_PATH', agy: 'AGY_PATH' };

function findExecutable(name, env) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of searchPathOf(env).split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const full = path.join(dir.replace(/^"|"$/g, ''), name + extension);
      if (fs.statSync(full, { throwIfNoEntry: false })?.isFile()) return full;
    }
  }
  return null;
}

/**
 * Value of a parent variable, whatever the spelling of its name.
 */
function parentValue(env, name) {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * Resolves each backend's CLI in the parent context.
 *
 * @param parentEnv - The runner's environment, before isolation.
 * @param realHome - The user's home.
 * @returns Per backend an absolute path, or `null` with the reason it was not found.
 */
function resolveBackendCommands(parentEnv, realHome) {
  const configFile = parentValue(parentEnv, 'coagent8_CONFIG')
    || path.join(parentValue(parentEnv, 'coagent8_DIR') || path.join(realHome, '.coagent8'), 'config.json');
  const resolved = {};
  for (const id of BACKENDS) {
    try {
      const configured = fs.existsSync(configFile) ? readBackendExecutable(id, configFile) : undefined;
      const override = parentValue(parentEnv, PATH_VARIABLES[id]);
      const command = backendCommand(id, configured, override ? { [PATH_VARIABLES[id]]: override } : {}, realHome);
      // As the runtime's resolver: an explicit path (relative to the parent's working
      // directory), else PATH; only automatic discovery falls back to the vendor
      // extension's copy (Codex, Claude Code) or the managed agy installation.
      const explicit = Boolean(override || configured);
      let full = path.isAbsolute(command) ? command
        : explicit && /[\\/]/.test(command) ? path.resolve(command)
          : findExecutable(command, parentEnv);
      if (!full && !explicit) {
        const vendor = id === 'claude' ? resolveBundledClaude(realHome, parentEnv) : id === 'codex' ? resolveBundledCodex(realHome, parentEnv) : resolveManagedAgy(realHome, parentEnv);
        // A *_PATH override carries one executable; a launcher with arguments cannot pass.
        if (vendor && !vendor.argsPrefix.length) full = vendor.command;
      }
      resolved[id] = full && fs.existsSync(full)
        ? { command: full, reason: null }
        : { command: null, reason: `${id} CLI not found in its configuration, on the parent PATH or as a vendor copy.` };
    } catch (error) {
      resolved[id] = { command: null, reason: error.message };
    }
  }
  return resolved;
}

/**
 * Environment additions for a scenario server.
 *
 * @param commands - Result of {@link resolveBackendCommands}.
 * @param options - `withBackendAuth` points the backend roots at the user's real ones;
 * `parentEnv` and `realHome` locate them, honoring roots the user configured.
 */
function scenarioBackendEnv(commands, options) {
  const env = {};
  for (const id of BACKENDS) if (commands[id]?.command) env[PATH_VARIABLES[id]] = commands[id].command;
  if (options.withBackendAuth) {
    const { parentEnv, realHome } = options;
    env.CODEX_HOME = parentValue(parentEnv, 'CODEX_HOME') || path.join(realHome, '.codex');
    env.CLAUDE_CONFIG_DIR = parentValue(parentEnv, 'CLAUDE_CONFIG_DIR') || path.join(realHome, '.claude');
    env.GEMINI_CLI_HOME = parentValue(parentEnv, 'GEMINI_CLI_HOME') || realHome;
  }
  return env;
}

module.exports = { BACKENDS, resolveBackendCommands, scenarioBackendEnv };
