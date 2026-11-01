'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeGitRef,
  collectGitScope,
  GIT_DIFF_PATHSPEC_EXCLUSIONS,
  runGit,
  boundGitTimeout,
  snapshotId,
  assertReviewWorkspace,
} = require('../../src/workspace/git.ts');
const { activeProcesses } = require('../../src/execution/process.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../src/contracts/error.ts');

test('sanitizeGitRef accepts valid git references', () => {
  assert.equal(sanitizeGitRef('main'), 'main');
  assert.equal(sanitizeGitRef('origin/main'), 'origin/main');
  assert.equal(sanitizeGitRef('feature/v1.0-auth'), 'feature/v1.0-auth');
  assert.equal(sanitizeGitRef('HEAD~1'), 'HEAD~1');
  assert.equal(sanitizeGitRef('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
});

test('sanitizeGitRef rejects invalid or dangerous git references', () => {
  assert.throws(() => sanitizeGitRef('--output=foo'), /cannot be empty or start with a dash/);
  assert.throws(() => sanitizeGitRef('; rm -rf /'), /invalid characters/);
  assert.throws(() => sanitizeGitRef('main | evil'), /invalid characters/);
  assert.throws(() => sanitizeGitRef(''), /cannot be empty/);
  assert.throws(() => sanitizeGitRef(null), /must be a string/);
});

test('collectGitScope resolves uncommitted scope without throwing', async () => {
  const scope = await collectGitScope('uncommitted', process.cwd());
  assert.equal(scope.type, 'uncommitted');
  assert.ok(typeof scope.diff === 'string');
});

test('collectGitScope resolves staged scope', async () => {
  const scope = await collectGitScope('staged', process.cwd());
  assert.equal(scope.type, 'staged');
  assert.ok(typeof scope.diff === 'string');
});

test('collectGitScope names the reason when Git refuses the repository or there is none (FEEDBACK-060a)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-refused-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = path.join(root, 'plain');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(plain);
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  for (const scope of ['staged', 'uncommitted']) {
    await assert.rejects(
      collectGitScope(scope, plain),
      err =>
        err instanceof ToolError &&
        err.code === 'INPUT_LIMIT' &&
        /Review needs a Git repository/.test(err.message) &&
        /not a git repository/i.test(err.message) &&
        !/cached/.test(err.message),
    );
  }
  // Git's own test switch reproduces a repository owned by another account (dubious ownership).
  // CI runners trust every directory (safe.directory=*) in their system or global Git
  // configuration, which skips the ownership check, so neither is read here.
  const emptyConfig = path.join(root, 'empty.gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const isolated = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
  const saved = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolated);
  try {
    await assert.rejects(
      collectGitScope('staged', repo),
      err => err instanceof ToolError && err.code === 'INPUT_LIMIT' && /dubious ownership/.test(err.message) && !/cached/.test(err.message),
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal((await collectGitScope('staged', repo)).type, 'staged');
});

test('collectGitScope excludes dist/**, *.map, and lockfiles from diff and untracked discovery', async () => {
  assert.ok(GIT_DIFF_PATHSPEC_EXCLUSIONS.includes(':(exclude)dist/**'));
  assert.ok(GIT_DIFF_PATHSPEC_EXCLUSIONS.includes(':(exclude)*.map'));
  assert.ok(GIT_DIFF_PATHSPEC_EXCLUSIONS.includes(':(exclude)*-lock.json'));
  assert.ok(GIT_DIFF_PATHSPEC_EXCLUSIONS.includes(':(exclude)package-lock.json'));
  assert.ok(GIT_DIFF_PATHSPEC_EXCLUSIONS.includes(':(exclude)pnpm-lock.yaml'));
  assert.ok(GIT_DIFF_PATHSPEC_EXCLUSIONS.includes(':(exclude)yarn.lock'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-diff-exclude-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  try {
    git('init', '-q');
    git('config', 'user.name', 'DiffFixture');
    git('config', 'user.email', 'diff@example.invalid');

    fs.mkdirSync(path.join(root, 'dist'));
    fs.mkdirSync(path.join(root, 'src'));

    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'dist', 'index.cjs'), 'bundle v1\n');
    fs.writeFileSync(path.join(root, 'dist', 'index.cjs.map'), 'map v1\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

    git('add', '.');
    git('commit', '-qm', 'initial commit');

    // 1. Modify tracked source file and build artifacts
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'dist', 'index.cjs'), 'bundle v2 modified\n');
    fs.writeFileSync(path.join(root, 'dist', 'index.cjs.map'), 'map v2 modified\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"name":"modified"}\n');

    // 2. Add untracked files
    fs.writeFileSync(path.join(root, 'src', 'new-feature.ts'), 'export const b = 2;\n');
    fs.writeFileSync(path.join(root, 'dist', 'untracked-bundle.cjs'), 'untracked bundle\n');
    fs.writeFileSync(path.join(root, 'untracked.map'), 'untracked map\n');

    const uncommitted = await collectGitScope('uncommitted', root);
    assert.equal(uncommitted.type, 'uncommitted');
    // Source changes MUST be included
    assert.ok(uncommitted.diff.includes('export const a = 2;'), 'Expected modified src/app.ts in diff');
    assert.ok(uncommitted.diff.includes('export const b = 2;'), 'Expected untracked src/new-feature.ts in diff');
    // Build artifacts, maps, and lockfiles MUST NOT be included
    assert.ok(!uncommitted.diff.includes('bundle v2 modified'), 'dist/index.cjs should be excluded');
    assert.ok(!uncommitted.diff.includes('map v2 modified'), 'dist/index.cjs.map should be excluded');
    assert.ok(!uncommitted.diff.includes('untracked bundle'), 'dist/untracked-bundle.cjs should be excluded');
    assert.ok(!uncommitted.diff.includes('untracked map'), 'untracked.map should be excluded');
    assert.ok(!uncommitted.diff.includes('modified'), 'package-lock.json should be excluded');

    // Test staged scope exclusion
    git('add', '.');
    const staged = await collectGitScope('staged', root);
    assert.equal(staged.type, 'staged');
    assert.ok(staged.diff.includes('export const a = 2;'));
    assert.ok(staged.diff.includes('export const b = 2;'));
    assert.ok(!staged.diff.includes('bundle v2 modified'));
    assert.ok(!staged.diff.includes('map v2 modified'));
    assert.ok(!staged.diff.includes('modified'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('boundGitTimeout clamps timeout correctly across context, budget, and default', () => {
  assert.equal(boundGitTimeout(undefined, 15000), 15000);
  assert.equal(boundGitTimeout({ timeoutMs: 5000 }, 15000), 5000);
  assert.equal(boundGitTimeout({ timeoutMs: 25000 }, 15000), 15000);

  const budget = createExecutionBudget({ totalBudgetMs: 3000, teardownAllowanceMs: 1000 });
  try {
    const bounded = boundGitTimeout({ budget }, 15000);
    assert.ok(bounded > 0 && bounded <= 2000, `bounded timeout should be <= 2000, got ${bounded}`);
  } finally {
    budget.dispose();
  }

  const expiredBudget = createExecutionBudget({ totalBudgetMs: 10, teardownAllowanceMs: 10 });
  try {
    const bounded = boundGitTimeout({ budget: expiredBudget }, 15000);
    assert.equal(bounded, 0);
  } finally {
    expiredBudget.dispose();
  }
});

test('runGit pre-flight abortion rejects immediately with ToolError(ABORTED) and spawns 0 processes', async () => {
  const initialActive = activeProcesses.size;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(runGit(['status'], process.cwd(), controller.signal), err => {
    assert.ok(err instanceof ToolError, 'Expected ToolError');
    assert.equal(err.code, 'ABORTED');
    assert.match(err.message, /cancelled before launch/i);
    return true;
  });
  assert.equal(activeProcesses.size, initialActive);
});

test('runGit pre-flight budget expiry rejects with ToolError(TIMEOUT) and spawns 0 processes', async () => {
  const initialActive = activeProcesses.size;
  let simulatedTime = 0;
  const budget = createExecutionBudget({
    totalBudgetMs: 50,
    teardownAllowanceMs: 50,
    clock: () => simulatedTime,
  });
  simulatedTime = 60; // Advance clock beyond deadline

  try {
    await assert.rejects(runGit(['status'], process.cwd(), null, 15000, undefined, { budget }), err => {
      assert.ok(err instanceof ToolError, 'Expected ToolError');
      assert.equal(err.code, 'TIMEOUT');
      assert.match(err.message, /Execution budget expired/i);
      return true;
    });
    assert.equal(activeProcesses.size, initialActive);
  } finally {
    budget.dispose();
  }
});

test('runGit abort during execution terminates process tree and cleans up without leaks', async () => {
  const initialActive = activeProcesses.size;
  const controller = new AbortController();

  const promise = runGit(['status'], process.cwd(), controller.signal);
  controller.abort();

  await assert.rejects(promise, err => {
    assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
    assert.equal(err.code, 'ABORTED');
    return true;
  });
  // Ensure child process was terminated and activeProcesses is clean
  assert.equal(activeProcesses.size, initialActive);
});

test('runGit budget executionSignal aborts Git command, cleans up process tree, and throws ToolError(TIMEOUT)', async () => {
  const initialActive = activeProcesses.size;
  let now = 0;
  const budget = createExecutionBudget({
    totalBudgetMs: 20,
    teardownAllowanceMs: 10,
    clock: () => now,
  });

  try {
    now = 15; // Primary execution deadline has expired!
    await assert.rejects(runGit(['status'], process.cwd(), null, 15000, undefined, { budget }), err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    });
    assert.equal(activeProcesses.size, initialActive);
  } finally {
    budget.dispose();
  }
});

test('collectGitScope with abortSignal cancels promptly and leaves no active processes', async () => {
  const initialActive = activeProcesses.size;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(collectGitScope('uncommitted', process.cwd(), controller.signal), err => {
    assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
    assert.equal(err.code, 'ABORTED');
    return true;
  });
  assert.equal(activeProcesses.size, initialActive);
});

test('collectGitScope with expired budget rejects with ToolError(TIMEOUT) and leaves no active processes', async () => {
  const initialActive = activeProcesses.size;
  let now = 0;
  const budget = createExecutionBudget({
    totalBudgetMs: 10,
    teardownAllowanceMs: 10,
    clock: () => now,
  });
  now = 15;

  try {
    await assert.rejects(collectGitScope('uncommitted', process.cwd(), null, { budget }), err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    });
    assert.equal(activeProcesses.size, initialActive);
  } finally {
    budget.dispose();
  }
});

test('snapshotId rethrows ToolError(ABORTED) / ToolError(TIMEOUT) and does not fall back to no-commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-snap-abort-'));
  const controller = new AbortController();
  controller.abort();

  try {
    const fakeScope = {
      type: 'uncommitted',
      label: 'test',
      diff: '',
      nativeArgs: null,
      inputComplete: true,
      omissions: [],
      changedPaths: [],
    };
    await assert.rejects(snapshotId(fakeScope, root, controller.signal), err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'ABORTED');
      return true;
    });

    let now = 0;
    const budget = createExecutionBudget({ totalBudgetMs: 10, teardownAllowanceMs: 10, clock: () => now });
    now = 15;
    try {
      await assert.rejects(snapshotId(fakeScope, root, null, { budget }), err => {
        assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      });
    } finally {
      budget.dispose();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assertReviewWorkspace propagates cancellation and preserves foreign-tree rejection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-assert-tree-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const controller = new AbortController();
  controller.abort();

  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'a.txt'), 'init\n');
    git('add', '.');
    git('commit', '-qm', 'initial');

    const fakeScope = {
      type: 'commit',
      revision: 'HEAD',
      label: 'commit HEAD',
      diff: '',
      nativeArgs: null,
      inputComplete: true,
      omissions: [],
      changedPaths: [],
    };

    // 1. Cancellation propagation
    await assert.rejects(assertReviewWorkspace(fakeScope, root, controller.signal), err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'ABORTED');
      return true;
    });

    // 2. Foreign-tree rejection preserves POLICY_DENIED
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'dirty\n');
    await assert.rejects(assertReviewWorkspace(fakeScope, root, null), err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /Review target does not match the files in the current workspace/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
