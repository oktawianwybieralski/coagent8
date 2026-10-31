const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-executable-'));
process.env.coagent8_CONFIG = path.join(directory, 'config.json');
const { validateConfig, recordBackendExecutable, setBackendExecutable, readBackendExecutable } = require('../../src/config.ts');
const { backendCommand, probeCommand } = require('../../src/backends/executable.ts');
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('backends.<id>.executable accepts an absolute path, ~/ or vscode-extension and keeps the default model', () => {
  const absolute = path.resolve(directory, 'codex.exe');
  for (const executable of [absolute, '~/.local/bin/claude.exe', '~\\.local\\bin\\claude.exe', 'vscode-extension']) {
    assert.deepEqual(validateConfig({ backends: { claude: { executable, defaultModel: 'opus' } } }).backends.claude, {
      defaultModel: 'opus',
      executable,
    });
  }
  for (const executable of ['claude', 'relative/claude', '', '~', 5, `${absolute}\0`, `/${'x'.repeat(1024)}`]) {
    assert.throws(
      () => validateConfig({ backends: { claude: { executable } } }),
      /backends\.claude\.executable must be/,
      JSON.stringify(executable),
    );
  }
});

test('the command comes from the environment override, then the configuration, then the CLI name', () => {
  const home = path.join(directory, 'home');
  assert.equal(backendCommand('codex', undefined, {}, home), 'codex');
  assert.equal(backendCommand('agy', undefined, {}, home), 'agy');
  assert.equal(backendCommand('claude', '~/.local/bin/claude.exe', {}, home), path.join(home, '.local/bin/claude.exe'));
  assert.equal(
    backendCommand('claude', path.resolve('/configured/claude'), { CLAUDE_PATH: 'override' }, home),
    'override',
    'the environment wins',
  );
  const agy = path.join(home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  assert.throws(
    () => backendCommand('agy', 'vscode-extension', { PATH: '' }, home),
    /vscode-extension.*no agy executable/,
    'no fallback to another installation',
  );
  fs.mkdirSync(path.dirname(agy), { recursive: true });
  fs.writeFileSync(agy, '');
  fs.chmodSync(agy, 0o755);
  assert.equal(backendCommand('agy', 'vscode-extension', { PATH: '', PATHEXT: '.EXE' }, home), agy);
});

test('a probe reports a configured executable that is missing instead of throwing', async () => {
  await setBackendExecutable('codex', 'vscode-extension');
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_PATH: process.env.CODEX_PATH,
    coagent8_EXTENSION_PATHS: process.env.coagent8_EXTENSION_PATHS,
  };
  try {
    process.env.HOME = process.env.USERPROFILE = path.join(directory, 'empty-home');
    process.env.coagent8_EXTENSION_PATHS = '{}';
    delete process.env.CODEX_PATH;
    const result = probeCommand('codex', 'OpenAI Codex CLI');
    assert.ok('unresolved' in result);
    assert.equal(result.unresolved.installed, false);
    assert.match(result.unresolved.authEvidence[0], /backends\.codex\.executable is "vscode-extension"/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await setBackendExecutable('codex', undefined);
  }
});

test('the first recorded executable is kept until the user changes it', async () => {
  const file = path.join(directory, 'recorded.json');
  assert.equal(await recordBackendExecutable('claude', 'vscode-extension', file), true);
  assert.equal(
    await recordBackendExecutable('claude', path.resolve('/other/claude'), file),
    false,
    'a later registration does not overwrite it',
  );
  assert.equal(readBackendExecutable('claude', file), 'vscode-extension');
  await setBackendExecutable('claude', '~/.local/bin/claude.exe', file);
  assert.equal(readBackendExecutable('claude', file), '~/.local/bin/claude.exe');
  await setBackendExecutable('claude', undefined, file);
  assert.equal(readBackendExecutable('claude', file), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).backends, { claude: {} });
});

test('the Antigravity backend is agy; gemini names only its models', () => {
  assert.deepEqual(validateConfig({ backends: { agy: { defaultModel: 'gemini-3.8-flash-high' } } }).backends, {
    agy: { defaultModel: 'gemini-3.8-flash-high' },
  });
  assert.throws(() => validateConfig({ backends: { gemini: {} } }), /Invalid backends entry 'gemini'/);
  assert.throws(() => validateConfig({ routing: { allowedBackends: ['gemini'] } }), /Invalid entry in allowedBackends: 'gemini'/);
});
