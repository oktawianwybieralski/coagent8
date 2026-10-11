const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { MARKER } = require('./helpers/environment.cjs');
const { resolveCliCommand, resolveBundledClaude, resolveManagedAgy, clearCliResolverCache } = require('../src/execution/cli-resolver.ts');

const root = process.env[MARKER];
const fixtures = path.resolve(__dirname, 'fixtures');

test('tests run inside the hermetic environment created by tests/run.cjs', () => {
  assert.ok(root, 'run the suite through `npm test` (tests/run.cjs), not `node --test` directly');
  assert.equal(path.relative(root, os.homedir()).startsWith('..'), false, 'the profile root is disposable');
});

test('backend CLIs resolve to fixtures and real installations are unreachable', () => {
  clearCliResolverCache();
  assert.equal(process.env.CLAUDE_PATH, path.join(fixtures, 'claude-cli', 'claude.cjs'));
  assert.equal(process.env.CODEX_PATH, path.join(fixtures, 'codex-cli', 'codex.cjs'));
  assert.equal(process.env.AGY_PATH, path.join(fixtures, 'agy-cli', 'agy.cjs'));
  // On Windows the PowerShells live outside the kept System32 and Windows folders. On POSIX
  // the kept /usr/bin is the operating system's and may hold pwsh (GitHub's Ubuntu runners);
  // no source launches a PowerShell (process.test.js, layer 3).
  const shells = process.platform === 'win32' ? ['pwsh', 'powershell'] : [];
  for (const name of ['claude', 'codex', 'agy', ...shells]) {
    assert.throws(() => resolveCliCommand(name), { code: 'CLI_NOT_FOUND' }, `${name} must not resolve on the test PATH`);
  }
  assert.equal(resolveBundledClaude(), null);
  assert.equal(resolveManagedAgy(), null);
});
