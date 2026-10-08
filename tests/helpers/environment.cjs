// Hermetic environment for the whole test tree. tests/run.cjs passes it to the test runner,
// so every test file and every process a test starts inherits it. Backend CLIs resolve to
// the fixtures, profile and configuration roots point into a disposable directory, and PATH
// keeps only Node.js, Git and the operating system. A test never starts a real Claude, Codex
// or agy installation, its MCP servers or its configured shells.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = 'COAGENT8_TEST_ENVIRONMENT';
const fixtures = path.resolve(__dirname, '../fixtures');

function findOnPath(name, env) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (key ? env[key] : '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (fs.statSync(path.join(dir, name + extension), { throwIfNoEntry: false })?.isFile()) return dir;
    }
  }
  return null;
}

function systemPath(env) {
  if (process.platform !== 'win32') return ['/usr/bin', '/bin'];
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return [path.join(root, 'System32'), root];
}

/**
 * Creates the isolated test environment and its disposable root.
 * @param base - Environment to derive from; only OS essentials and non-profile settings are kept.
 * @returns The environment and the root directory the caller removes after the run.
 */
function createTestEnvironment(base = process.env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tests-'));
  const home = path.join(root, 'home');
  for (const dir of ['home', 'appdata', 'localappdata', 'config', 'coagent8', 'claude', 'codex', 'agy']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toLowerCase() !== 'path') env[key] = value;
  }
  const git = findOnPath('git', base);
  env.PATH = [...new Set([path.dirname(process.execPath), ...(git ? [git] : []), ...systemPath(base)])].join(path.delimiter);
  Object.assign(env, {
    [MARKER]: root,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    coagent8_DIR: path.join(root, 'coagent8'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'),
    CODEX_CONFIG_PATH: path.join(root, 'codex', 'config.toml'),
    GEMINI_CLI_HOME: path.join(root, 'agy'),
    CLAUDE_PATH: path.join(fixtures, 'claude-cli', 'claude.cjs'),
    CODEX_PATH: path.join(fixtures, 'codex-cli', 'codex.cjs'),
    AGY_PATH: path.join(fixtures, 'agy-cli', 'agy.cjs'),
    AGY_PATH: path.join(fixtures, 'agy-cli', 'agy.cjs'),
    // Model prices come from a recorded list, never from the network.
    coagent8_PRICES_URL: path.join(fixtures, 'prices', 'openrouter-models.json'),
  });
  // A suite started from inside a CoAgent8 turn must not inherit the nested-turn guard.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'COAGENT8_NESTED_TURN']) delete env[key];
  return { env, root };
}

module.exports = { MARKER, createTestEnvironment };
