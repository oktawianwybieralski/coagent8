'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeGitRef, collectGitScope, GIT_DIFF_PATHSPEC_EXCLUSIONS } = require('../src/execution/git.ts');

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
