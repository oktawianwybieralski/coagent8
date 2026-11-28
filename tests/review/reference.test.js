'use strict';

/**
 * #214, #247: every review diff is read by the reviewer from a file, never inlined.
 *
 * Verifies:
 * - the gate blocks a review that does not quote the end mark of its diff file (or has an empty
 *   token), and leaves it unjudged so an unchanged repeat may run again;
 * - both small and large diffs send a file reference instead of inlining the diff; the file,
 *   outside the reviewed tree and removed afterwards, holds exactly the collected diff and ends
 *   with a mark the prompt does not show; READY needs the mark;
 * - every scope (uncommitted, staged, commit, branch, range) gets its diff as a file and requires
 *   the end mark;
 * - reviews without a snapshot work tree (.gitattributes filter, untracked file over bounds,
 *   submodule/gitlink, concurrent snapshot lock) still write the diff to a file under c8wt and
 *   require the end mark, with no inline fallback;
 * - failure to write the diff file refuses with a clear error before starting any turn;
 * - split reviews without a snapshot work tree still deliver every part as a file with its own mark.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-reference-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');

const reviewTool = require('../../src/mcp/tools/review.tool.ts');
const { executeReview } = reviewTool;
const { evaluateStateEnvelopeGate } = require('../../src/review/gate.ts');
const { collectGitScope } = require('../../src/workspace/git.ts');
const { snapshotRoot, snapshotPath, withReviewSnapshot, SNAPSHOT_MAX_UNTRACKED_FILE_BYTES } = require('../../src/review/snapshot.ts');
const { REVIEW_PART_CHARS } = require('../../src/review/parts.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { saveConfig } = require('../../src/config.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const envelope = (snapshot, reviewed) =>
  [
    'REVIEW: 1',
    `SNAPSHOT: ${snapshot}`,
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    `Reviewed: ${reviewed}`,
    'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN',
  ].join('\n');

test('the gate blocks a review that did not quote the end mark of its diff file, and leaves it unjudged', () => {
  const context = { expectedSnapshot: 's', inputComplete: true, requiredChecks: [], readToken: '0123456789abcdef' };
  const unread = evaluateStateEnvelopeGate(envelope('s', 'the change'), false, true, context, { completed: true });
  assert.equal(unread.verdict, 'BLOCKED');
  assert.match(unread.reason, /did not quote the end mark/);
  assert.equal(unread.judged, false, 'an unchanged repeat may run again');
  const emptyToken = evaluateStateEnvelopeGate(
    envelope('s', 'the change'),
    false,
    true,
    { ...context, readToken: '' },
    { completed: true },
  );
  assert.equal(emptyToken.verdict, 'BLOCKED');
  assert.match(emptyToken.reason, /did not quote the end mark/);
  assert.equal(emptyToken.judged, false);
  const read = evaluateStateEnvelopeGate(envelope('s', 'the change, mark 0123456789abcdef'), false, true, context, { completed: true });
  assert.equal(read.verdict, 'READY');
});

test('INLINE_DIFF_CHARS is removed (#247)', () => {
  assert.equal('INLINE_DIFF_CHARS' in reviewTool, false);
});

function repo() {
  const dir = fs.mkdtempSync(path.join(tempDir, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { dir, git };
}

function fixture(quoteMark) {
  const seen = [];
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      const file = /from the file (.+?) \(\d+ lines/.exec(prompt)?.[1];
      const content = file ? fs.readFileSync(file, 'utf8') : null;
      const mark = content ? /\[END OF DIFF (\w+)\]\n$/.exec(content)?.[1] : null;
      seen.push({ prompt, file, content, mark, cwd: options.cwd });
      const snapshot = /SNAPSHOT: (\S+)/.exec(prompt)[1];
      const shouldQuote = typeof quoteMark === 'function' ? quoteMark(seen.length, prompt) : quoteMark;
      const text = envelope(snapshot, shouldQuote && mark ? `the change, mark ${mark}` : 'the change');
      options.onEvent({ type: 'assistant_message', messageId: 'm', text });
      return {
        status: 'completed',
        isError: false,
        output: text,
        nativeSessionId: `11111111-2222-3333-4444-55555555555${seen.length % 10}`,
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  return { seen, restore: () => (adapterRegistry.agy = original) };
}

test('both small and large changes are read from a file of exactly the collected diff, and READY needs its end mark', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const big = 'x'.repeat(80) + '\n';
  for (const [label, writeFiles] of [
    [
      'small',
      dir => {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'small change\n');
      },
    ],
    [
      'large',
      dir => {
        fs.writeFileSync(path.join(dir, 'a.txt'), big.repeat(600));
        fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
      },
    ],
  ]) {
    for (const [quoteMark, verdict] of [
      [true, 'READY'],
      [false, 'BLOCKED'],
    ]) {
      const { dir } = repo();
      writeFiles(dir);
      const collected = (await collectGitScope('uncommitted', dir)).diff;
      const f = fixture(quoteMark);
      try {
        const outcome = await executeReview({ backend: 'agy' }, dir);
        const [{ prompt, file, content, mark }] = f.seen;
        assert.match(prompt, /The diff is not inlined/, label);
        assert.match(prompt, /^- a\.txt$/m, label);
        assert.ok(!prompt.includes('small change'), `${label}: small diff text is not in the prompt`);
        assert.ok(!prompt.includes(big.repeat(3)), `${label}: large diff text is not in the prompt`);
        assert.ok(mark && !prompt.includes(mark), `${label}: the prompt does not show the mark`);
        assert.equal(
          content,
          `${collected}${collected.endsWith('\n') ? '' : '\n'}[END OF DIFF ${mark}]\n`,
          `${label}: exactly the collected diff, then the mark`,
        );
        assert.ok(!file.startsWith(dir), `${label}: the diff file is outside the reviewed tree`);
        assert.equal(fs.existsSync(file), false, `${label}: the diff file is removed after the review`);
        assert.equal(outcome.review.verdict, verdict, `${label} quote=${quoteMark}`);
        if (!quoteMark) assert.equal(outcome.review.judged, false, `${label}: unread stays unjudged`);
      } finally {
        f.restore();
      }
    }
  }
});

test('every scope (uncommitted, staged, commit, branch, range) sends its diff as a file and requires the end mark', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const { dir, git } = repo();
  const baseBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'branch-commit-change\n');
  git('commit', '-qam', 'feature change');
  const commit = git('rev-parse', 'HEAD');
  const scopes = [
    { scope: 'commit', arg: commit, needle: '+branch-commit-change' },
    { scope: 'branch', arg: baseBranch, needle: '+branch-commit-change' },
    { scope: 'range', arg: `${base}..${commit}`, needle: '+branch-commit-change' },
  ];
  for (const entry of scopes) {
    for (const [quoteMark, expected] of [
      [false, 'BLOCKED'],
      [true, 'READY'],
    ]) {
      const f = fixture(quoteMark);
      try {
        const outcome = await executeReview({ backend: 'agy', scope: entry.arg }, dir);
        const [{ prompt, file, content }] = f.seen;
        assert.match(prompt, /The diff is not inlined/, entry.scope);
        assert.ok(!prompt.includes(entry.needle), `${entry.scope} diff is not inlined`);
        assert.ok(content.includes(entry.needle), `${entry.scope} diff is in file`);
        assert.equal(fs.existsSync(file), false, `${entry.scope} diff file cleaned up`);
        assert.equal(outcome.review.verdict, expected, `${entry.scope} quote=${quoteMark}`);
      } finally {
        f.restore();
      }
    }
  }

  // Staged scope (clean working tree matching index).
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged-only-change\n');
  git('add', 'a.txt');
  for (const [quoteMark, expected] of [
    [false, 'BLOCKED'],
    [true, 'READY'],
  ]) {
    const f = fixture(quoteMark);
    try {
      const outcome = await executeReview({ backend: 'agy', scope: 'staged' }, dir);
      const [{ prompt, file, content }] = f.seen;
      assert.match(prompt, /The diff is not inlined/, 'staged');
      assert.ok(!prompt.includes('+staged-only-change'), 'staged diff is not inlined');
      assert.ok(content.includes('+staged-only-change'), 'staged diff is in file');
      assert.equal(fs.existsSync(file), false);
      assert.equal(outcome.review.verdict, expected, `staged quote=${quoteMark}`);
    } finally {
      f.restore();
    }
  }

  // Uncommitted scope.
  fs.writeFileSync(path.join(dir, 'b.txt'), 'uncommitted-change\n');
  for (const [quoteMark, expected] of [
    [false, 'BLOCKED'],
    [true, 'READY'],
  ]) {
    const f = fixture(quoteMark);
    try {
      const outcome = await executeReview({ backend: 'agy', scope: 'uncommitted' }, dir);
      const [{ prompt, file, content }] = f.seen;
      assert.match(prompt, /The diff is not inlined/, 'uncommitted');
      assert.ok(!prompt.includes('+uncommitted-change'), 'uncommitted diff is not inlined');
      assert.ok(content.includes('+uncommitted-change'), 'uncommitted diff is in file');
      assert.equal(fs.existsSync(file), false);
      assert.equal(outcome.review.verdict, expected, `uncommitted quote=${quoteMark}`);
    } finally {
      f.restore();
    }
  }
});

test('reviews without a snapshot work tree still write the diff to a file under c8wt and require the end mark', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

  // 1. Repository with a checkout filter in .gitattributes runs in workspace without a snapshot.
  {
    const { dir, git } = repo();
    git('config', 'filter.fixture.clean', 'cat');
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=fixture\n');
    git('add', '.gitattributes');
    git('commit', '-qm', 'attr');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'no-snapshot-filter-change\n');
    for (const [quoteMark, verdict] of [
      [false, 'BLOCKED'],
      [true, 'READY'],
    ]) {
      const f = fixture(quoteMark);
      try {
        const outcome = await executeReview({ backend: 'agy' }, dir);
        const [{ prompt, file, content, cwd }] = f.seen;
        assert.equal(cwd, dir, 'ran in workspace when snapshot was skipped');
        assert.ok(
          outcome.warnings.some(w => /checkout filter/.test(w)),
          'reports snapshot skip warning',
        );
        assert.match(prompt, /The diff is not inlined/);
        assert.match(prompt, /your working directory is the workspace holding the reviewed state/);
        assert.ok(!prompt.includes('+no-snapshot-filter-change'), 'never falls back to inline');
        assert.ok(content.includes('+no-snapshot-filter-change'));
        assert.ok(file.startsWith(snapshotRoot()), 'diff file lives in disposable c8wt dir');
        assert.equal(fs.existsSync(file), false, 'diff file is removed after the review');
        assert.equal(outcome.review.verdict, verdict);
      } finally {
        f.restore();
      }
    }
  }

  // 2. Concurrent review holding the snapshot lock forces second review into workspace, still via file.
  {
    const { dir } = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'locked-workspace-change\n');
    const info = await collectGitScope('uncommitted', dir);
    await withReviewSnapshot(info, dir, undefined, async outerSnapshot => {
      assert.ok(outerSnapshot, 'outer review holds snapshot');
      const f = fixture(true);
      try {
        const outcome = await executeReview({ backend: 'agy' }, dir);
        const [{ prompt, file, content, cwd }] = f.seen;
        assert.equal(cwd, dir, 'second review ran in workspace');
        assert.ok(outcome.warnings.some(w => /another review/.test(w)));
        assert.match(prompt, /The diff is not inlined/);
        assert.ok(!prompt.includes('+locked-workspace-change'));
        assert.ok(content.includes('+locked-workspace-change'));
        assert.equal(fs.existsSync(file), false);
        assert.equal(outcome.review.verdict, 'READY');
      } finally {
        f.restore();
      }
    });
  }

  // 3. Untracked file over snapshot bounds keeps review in workspace, still via file (inputComplete=false blocks READY, but file is still used).
  {
    const { dir } = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'oversized-untracked-sibling\n');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(SNAPSHOT_MAX_UNTRACKED_FILE_BYTES + 1, 0x61));
    const f = fixture(true);
    try {
      const outcome = await executeReview({ backend: 'agy' }, dir);
      const [{ prompt, file, content, cwd }] = f.seen;
      assert.equal(cwd, dir);
      assert.ok(outcome.warnings.some(w => /larger than the review bounds/.test(w)));
      assert.match(prompt, /The diff is not inlined/);
      assert.ok(!prompt.includes('+oversized-untracked-sibling'));
      assert.ok(content.includes('+oversized-untracked-sibling'));
      assert.equal(fs.existsSync(file), false);
      assert.equal(outcome.review.verdict, 'BLOCKED');
    } finally {
      f.restore();
    }
  }

  // 4. Repository with a nested repository (gitlink) skips snapshot, still writes diff file.
  {
    const { dir, git } = repo();
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    execFileSync('git', ['init', '-q'], { cwd: nested, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x.invalid', 'commit', '-q', '--allow-empty', '-m', 'n'], {
      cwd: nested,
      windowsHide: true,
    });
    git('add', 'nested');
    git('commit', '-qm', 'gitlink');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'nested-repo-change\n');
    const f = fixture(true);
    try {
      const outcome = await executeReview({ backend: 'agy' }, dir);
      const [{ prompt, file, content, cwd }] = f.seen;
      assert.equal(cwd, dir);
      assert.ok(outcome.warnings.some(w => /nested repositories/.test(w)));
      assert.match(prompt, /The diff is not inlined/);
      assert.ok(!prompt.includes('+nested-repo-change'));
      assert.ok(content.includes('+nested-repo-change'));
      assert.equal(fs.existsSync(file), false);
    } finally {
      f.restore();
    }
  }
});

test('split review without a snapshot work tree still gives every part a diff file and requires its end mark', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const { dir, git } = repo();
  git('config', 'filter.fixture.clean', 'cat');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.ts filter=fixture\n');
  git('add', '.gitattributes');
  git('commit', '-qm', 'attr');
  const line = 'export const value = "' + 'x'.repeat(60) + '";\n';
  for (const name of ['one.ts', 'two.ts']) {
    fs.writeFileSync(path.join(dir, name), line.repeat(Math.ceil((REVIEW_PART_CHARS * 0.7) / line.length)));
  }

  const f = fixture(true);
  try {
    const outcome = await executeReview({ backend: 'agy' }, dir);
    assert.equal(f.seen.length, 3, '2 parts + 1 synthesis');
    for (const partCall of f.seen.slice(0, 2)) {
      assert.equal(partCall.cwd, dir, 'part ran in workspace');
      assert.match(partCall.prompt, /The diff is not inlined/);
      assert.ok(!partCall.prompt.includes('export const value ='), 'part diff is not inlined');
      assert.ok(partCall.content.includes('export const value ='), 'part diff is in file');
      assert.ok(partCall.mark, 'part diff file had end mark');
      assert.equal(fs.existsSync(partCall.file), false, 'part diff file removed');
    }
    assert.equal(outcome.review.verdict, 'READY');
  } finally {
    f.restore();
  }
});

test('refuses cleanly with no inline fallback if writing the diff file fails', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'cannot-inline-this\n');
  const f = fixture(true);
  const previousTmp = process.env.TMP;
  const previousTemp = process.env.TEMP;
  // Point os.tmpdir() on Windows/Unix to a regular file so snapshotRoot() mkdir fails cleanly.
  const blocker = path.join(tempDir, 'not-a-dir');
  fs.writeFileSync(blocker, 'file');
  process.env.TMP = blocker;
  process.env.TEMP = blocker;
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = blocker;
  try {
    await assert.rejects(
      executeReview({ backend: 'agy' }, dir),
      err => err.code === 'PROCESS_ERROR' && /Could not write the review diff file/.test(err.message),
    );
    assert.equal(f.seen.length, 0, 'no model turn started and no inline fallback occurred');
    assert.equal(fs.existsSync(snapshotPath(dir)), false);
  } finally {
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    f.restore();
  }
});
