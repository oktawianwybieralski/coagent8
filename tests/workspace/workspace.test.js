const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chooseWorkspace } = require('../../src/paths.ts');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-workspace-'));
const project = path.join(base, 'project'), other = path.join(base, 'other');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(other);
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('workspace: an explicit path wins over client roots and the server directory', () => {
  assert.deepEqual(chooseWorkspace(other, [project], project), { path: path.resolve(other), source: 'argument' });
  assert.throws(() => chooseWorkspace(path.join(base, 'missing'), [project], project), /does not exist/);
});

test('workspace: one client root is used; several resolve to the root containing the server directory', () => {
  assert.deepEqual(chooseWorkspace(undefined, [project], os.homedir()), { path: path.resolve(project), source: 'client_root' });
  assert.deepEqual(chooseWorkspace(undefined, [other, project], path.join(project, 'src')), { path: path.resolve(project), source: 'client_root' });
  assert.throws(() => chooseWorkspace(undefined, [other, project], base), /2 workspace roots; pass workspace_path/);
  assert.deepEqual(chooseWorkspace(undefined, [path.join(base, 'gone'), project], base), { path: path.resolve(project), source: 'client_root' }, 'missing roots are ignored');
});

test('workspace: without roots the server directory is used unless it is the home, a filesystem root or a system directory', () => {
  assert.deepEqual(chooseWorkspace(undefined, null, project), { path: path.resolve(project), source: 'server_directory' });
  assert.throws(() => chooseWorkspace(undefined, null, os.homedir()), /home or a system directory; pass workspace_path/);
  assert.throws(() => chooseWorkspace(undefined, [], path.parse(project).root), /pass workspace_path/);
  if (process.platform === 'win32' && process.env.SystemRoot) {
    assert.throws(() => chooseWorkspace(undefined, null, path.join(process.env.SystemRoot, 'System32')), /pass workspace_path/);
  }
});
