'use strict';

/**
 * #213: the reviewed state in its own work tree.
 *
 * Verifies, on a real Git repository:
 * - uncommitted: staged, unstaged and untracked content, without touching the user's index;
 * - staged: the index only, not unstaged edits;
 * - commit and range: the target revision;
 * - the same state gives the same commit; afterwards the work tree and its ref are gone;
 * - a second review of the workspace runs in the workspace while the first holds the snapshot;
 * - untracked files over the review bounds, and any filter attribute, keep the review in the workspace;
 * - a workspace in a subdirectory runs in the same subdirectory, and a revision without it falls back;
 * - a cancelled call still removes its snapshot;
 * - a review turn runs in the snapshot.
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
const { withReviewSnapshot, snapshotPath, SNAPSHOT_MAX_UNTRACKED_FILE_BYTES } = require('../../src/review/snapshot.ts');

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

/** Runs `fn` in the snapshot of a scope and returns what it saw, then checks that nothing stayed behind. */
async function inSnapshot(dir, scope, fn, workspace = dir, context) {
  const seen = await withReviewSnapshot(await collectGitScope(scope, workspace), workspace, context, async (snapshot, skipped) =>
    fn(snapshot, skipped),
  );
  assert.equal(fs.existsSync(snapshotPath(workspace)), false, 'the work tree is removed');
  assert.equal(execFileSync('git', ['for-each-ref', 'refs/coagent8'], { cwd: dir, encoding: 'utf8' }).trim(), '', 'the ref is removed');
  return seen;
}

const read = (snapshot, file) => fs.readFileSync(path.join(snapshot.cwd, file), 'utf8');

test('uncommitted: staged, unstaged and untracked content, and the user index stays as it was', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  git('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'worked\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  const indexBefore = git('ls-files', '-s');
  const first = await inSnapshot(dir, 'uncommitted', async (snapshot, skipped) => {
    assert.ok(snapshot, skipped);
    assert.equal(read(snapshot, 'a.txt'), 'worked\n');
    assert.equal(read(snapshot, 'new.txt'), 'untracked\n');
    // A second review of the workspace meanwhile runs in the workspace.
    const nested = await withReviewSnapshot(await collectGitScope('uncommitted', dir), dir, undefined, async (inner, why) => ({
      inner,
      why,
    }));
    assert.equal(nested.inner, undefined);
    assert.match(nested.why, /another review/);
    return snapshot.commit;
  });
  assert.equal(git('ls-files', '-s'), indexBefore, 'the user index is unchanged');
  const second = await inSnapshot(dir, 'uncommitted', async snapshot => snapshot.commit);
  assert.equal(second, first, 'the same state gives the same commit');
});

test('staged: the index only', async () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  git('add', 'a.txt');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'unstaged\n');
  assert.equal(await inSnapshot(dir, 'staged', async snapshot => read(snapshot, 'a.txt')), 'staged\n');
});

test('commit and range: the target revision', async () => {
  const { dir, git } = repo();
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git('commit', '-qam', 'two');
  const two = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
  git('commit', '-qam', 'three');
  for (const scope of [two, `${base}..${two}`, `${base}...${two}`]) {
    assert.equal(await inSnapshot(dir, scope, async snapshot => read(snapshot, 'a.txt')), 'two\n', scope);
  }
});

test('untracked files over the review bounds keep the review in the workspace', async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(SNAPSHOT_MAX_UNTRACKED_FILE_BYTES + 1));
  const why = await inSnapshot(dir, 'uncommitted', async (snapshot, skipped) => (assert.equal(snapshot, undefined), skipped));
  assert.match(why, /larger than the review bounds/);
});

test('a filter attribute anywhere keeps the review in the workspace, before any filter runs', async () => {
  const { dir, git } = repo();
  // A filter that would fail loudly if Git ran it.
  git('config', 'filter.fixture.clean', 'false');
  git('config', 'filter.fixture.required', 'true');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.bin filter=fixture\n');
  fs.writeFileSync(path.join(dir, 'x.bin'), 'content\n');
  const why = await inSnapshot(dir, 'uncommitted', async (snapshot, skipped) => (assert.equal(snapshot, undefined), skipped));
  assert.match(why, /checkout filter/);
  const { dir: other, git: otherGit } = repo();
  const infoAttributes = otherGit('rev-parse', '--git-path', 'info/attributes');
  fs.mkdirSync(path.dirname(path.resolve(other, infoAttributes)), { recursive: true });
  fs.writeFileSync(path.resolve(other, infoAttributes), '*.txt filter=fixture\n');
  fs.writeFileSync(path.join(other, 'a.txt'), 'changed\n');
  const whyInfo = await inSnapshot(other, 'uncommitted', async (snapshot, skipped) => (assert.equal(snapshot, undefined), skipped));
  assert.match(whyInfo, /checkout filter/, 'info/attributes counts too');
});

test('a workspace in a subdirectory runs in the same subdirectory; a revision without it falls back', async () => {
  const { dir, git } = repo();
  const base = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'sub\n');
  git('add', '.');
  git('commit', '-qm', 'sub');
  fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'changed\n');
  const workspace = path.join(dir, 'pkg');
  const seen = await inSnapshot(
    dir,
    'uncommitted',
    async snapshot => ({ cwd: snapshot.cwd, root: snapshot.path, content: read(snapshot, 'b.txt') }),
    workspace,
  );
  assert.equal(seen.cwd, path.join(seen.root, 'pkg'));
  assert.equal(seen.content, 'changed\n');
  const why = await inSnapshot(dir, base, async (snapshot, skipped) => (assert.equal(snapshot, undefined), skipped), workspace);
  assert.match(why, /no such subdirectory/);
});

test('a cancelled call still removes its snapshot', async () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  const controller = new AbortController();
  await inSnapshot(
    dir,
    'uncommitted',
    async snapshot => {
      assert.ok(snapshot);
      controller.abort();
    },
    dir,
    { abortSignal: controller.signal },
  );
});

test('a review turn runs in the snapshot', async () => {
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

test('in a subdirectory workspace, untracked files elsewhere in the repository count against the bounds', async () => {
  const { dir } = repo();
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', 'b.txt'), 'sub\n');
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(SNAPSHOT_MAX_UNTRACKED_FILE_BYTES + 1));
  const workspace = path.join(dir, 'pkg');
  const why = await inSnapshot(dir, 'uncommitted', async (snapshot, skipped) => (assert.equal(snapshot, undefined), skipped), workspace);
  assert.match(why, /larger than the review bounds/);
});

test('a skipped snapshot still removes what a crashed review left', async () => {
  const { dir, git } = repo();
  const target = snapshotPath(dir);
  const key = path.basename(target);
  git('update-ref', `refs/coagent8/review/${key}`, 'HEAD');
  git('worktree', 'add', '--detach', target, 'HEAD');
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(SNAPSHOT_MAX_UNTRACKED_FILE_BYTES + 1));
  await inSnapshot(dir, 'uncommitted', async snapshot => assert.equal(snapshot, undefined));
});
