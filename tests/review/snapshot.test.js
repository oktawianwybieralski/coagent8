'use strict';

/**
 * #213: the reviewed state in its own work tree.
 *
 * Verifies, on a real Git repository:
 * - uncommitted: staged, unstaged and untracked content, without touching the user's index;
 * - staged: the index only, not unstaged edits;
 * - commit and range: the target revision;
 * - the same state gives the same commit; disposing removes the work tree and its ref;
 * - a second review of the workspace is turned away while the first holds the snapshot;
 * - untracked files over the review bounds skip the snapshot;
 * - a review turn runs in the snapshot, and the work tree is gone afterwards.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-snapshot-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');

const { collectGitScope } = require('../../src/workspace/git.ts');
const {
  materializeReviewSnapshot,
  isSnapshotSkipped,
  claimSnapshot,
  snapshotPath,
  SNAPSHOT_MAX_UNTRACKED_FILE_BYTES,
} = require('../../src/review/snapshot.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

let count = 0;
function repo() {
  const dir = path.join(tempDir, `repo-${++count}`);
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { dir, git };
}

const read = (snapshot, file) => fs.readFileSync(path.join(snapshot.path, file), 'utf8');

async function materialize(dir, scope) {
  const made = await materializeReviewSnapshot(await collectGitScope(scope, dir), dir);
  assert.ok(!isSnapshotSkipped(made), made.skipped);
  return made;
}

test('uncommitted: staged, unstaged and untracked content, and the user index stays as it was', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  git('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'worked\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  const indexBefore = git('ls-files', '-s');
  const snapshot = await materialize(dir, 'uncommitted');
  try {
    assert.equal(read(snapshot, 'a.txt'), 'worked\n');
    assert.equal(read(snapshot, 'new.txt'), 'untracked\n');
    assert.equal(git('ls-files', '-s'), indexBefore, 'the user index is unchanged');
    assert.equal(git('status', '--porcelain'), 'MM a.txt\n?? new.txt'.replace(/\n/g, '\n'));
    const again = await materializeReviewSnapshot(await collectGitScope('uncommitted', dir), dir);
    assert.ok(isSnapshotSkipped(again), 'a second review waits for the first');
  } finally {
    await snapshot.dispose();
  }
  assert.equal(fs.existsSync(snapshot.path), false, 'the work tree is removed');
  assert.equal(git('for-each-ref', 'refs/coagent8'), '', 'the ref is removed');
  assert.ok(!git('worktree', 'list').includes(snapshot.path), 'Git no longer lists it');
  const second = await materialize(dir, 'uncommitted');
  assert.equal(second.commit, snapshot.commit, 'the same state gives the same commit');
  await second.dispose();
});

test('staged: the index only', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  git('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'unstaged\n');
  const snapshot = await materialize(dir, 'staged');
  try {
    assert.equal(read(snapshot, 'a.txt'), 'staged\n');
  } finally {
    await snapshot.dispose();
  }
});

test('commit and range: the target revision', async () => {
  const { dir, git } = repo();
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git('commit', '-qam', 'two');
  const two = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  git('commit', '-qam', 'three');
  for (const [scope, expected] of [
    [two, 'two\n'],
    [`${base}..${two}`, 'two\n'],
    [`${base}...${two}`, 'two\n'],
  ]) {
    const snapshot = await materialize(dir, scope);
    try {
      assert.equal(read(snapshot, 'a.txt'), expected, scope);
    } finally {
      await snapshot.dispose();
    }
  }
});

test('untracked files over the review bounds skip the snapshot', async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(SNAPSHOT_MAX_UNTRACKED_FILE_BYTES + 1));
  const made = await materializeReviewSnapshot(await collectGitScope('uncommitted', dir), dir);
  assert.ok(isSnapshotSkipped(made));
  assert.match(made.skipped, /larger than the review bounds/);
});

test('a claim of a live process holds, and a released claim can be taken again', () => {
  const target = snapshotPath(path.join(tempDir, 'claims'));
  const release = claimSnapshot(target);
  assert.equal(typeof release, 'function');
  assert.equal(claimSnapshot(target), null);
  release();
  const again = claimSnapshot(target);
  assert.equal(typeof again, 'function');
  again();
});

test('a review turn runs in the snapshot, and the snapshot is gone afterwards', async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const { saveConfig } = require('../../src/config.ts');
  const { executeReview } = require('../../src/mcp/tools/review.tool.ts');
  const original = adapterRegistry.agy;
  let seenCwd;
  let seenContent;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      seenCwd = options.cwd;
      seenContent = fs.readFileSync(path.join(options.cwd, 'a.txt'), 'utf8');
      options.onEvent({ type: 'assistant_message', messageId: 'm', text: 'x' });
      return {
        status: 'completed',
        isError: false,
        output: 'x',
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    await executeReview({ backend: 'agy' }, dir);
    assert.equal(seenCwd, snapshotPath(dir));
    assert.equal(seenContent, 'changed\n');
    assert.equal(fs.existsSync(snapshotPath(dir)), false);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a workspace in a subdirectory runs the reviewer in the same subdirectory of the snapshot', async () => {
  const { dir, git } = repo();
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'sub\n');
  git('add', '.');
  git('commit', '-qm', 'sub');
  fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'changed\n');
  const workspace = path.join(dir, 'pkg');
  const made = await materializeReviewSnapshot(await collectGitScope('uncommitted', workspace), workspace);
  assert.ok(!isSnapshotSkipped(made), made.skipped);
  try {
    assert.equal(made.cwd, path.join(made.path, 'pkg'));
    assert.equal(fs.readFileSync(path.join(made.cwd, 'b.txt'), 'utf8'), 'changed\n');
  } finally {
    await made.dispose();
  }
});

test('a repository with checkout filters such as Git LFS keeps the review in the workspace', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.bin filter=fixture\n');
  fs.writeFileSync(path.join(dir, 'x.bin'), 'pointer\n');
  git('-c', 'filter.fixture.clean=cat', '-c', 'filter.fixture.smudge=cat', 'add', '.');
  git('-c', 'filter.fixture.clean=cat', '-c', 'filter.fixture.smudge=cat', 'commit', '-qm', 'filtered');
  const made = await materializeReviewSnapshot(await collectGitScope('uncommitted', dir), dir);
  assert.ok(isSnapshotSkipped(made));
  assert.match(made.skipped, /checkout filters/);
});

test('a claim being written is not taken over, and a stale claim without an owner is', () => {
  const target = snapshotPath(path.join(tempDir, 'claims-empty'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.lock`, '');
  assert.equal(claimSnapshot(target), null, 'a fresh claim without its owner yet holds');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(`${target}.lock`, old, old);
  const release = claimSnapshot(target);
  assert.equal(typeof release, 'function', 'an abandoned one is taken over');
  release();
});

test('a cancelled call still removes its snapshot', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const controller = new AbortController();
  const made = await materializeReviewSnapshot(await collectGitScope('uncommitted', dir), dir, { abortSignal: controller.signal });
  assert.ok(!isSnapshotSkipped(made), made.skipped);
  controller.abort();
  await made.dispose();
  assert.equal(fs.existsSync(made.path), false);
  assert.equal(git('for-each-ref', 'refs/coagent8'), '');
});
