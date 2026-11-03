const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// REVIEW-002: a diff too large for one turn is reviewed in parts, then in one synthesis turn.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-parts-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
const { splitReviewDiff, REVIEW_PART_CHARS } = require('../../src/review/parts.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { handleReview } = require('../../src/mcp/tools/review.tool.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const fileDiff = (name, hunks) =>
  `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n` +
  hunks.map((lines, i) => `@@ -${i * 10 + 1},1 +${i * 10 + 1},${lines.length} @@\n${lines.map(l => `+${l}\n`).join('')}`).join('');

test('a diff that fits stays one part', () => {
  const diff = fileDiff('a.ts', [['x']]);
  assert.deepEqual(splitReviewDiff(diff), [{ paths: ['a.ts'], text: diff }]);
});

test('an untracked file is split by lines under its own header', () => {
  const diff =
    '--- UNTRACKED FILE SNAPSHOT (workspace scope) ---\n\n--- new.ts ---\n' + Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join('');
  const parts = splitReviewDiff(diff, ['new.ts'], 120);
  assert.ok(parts.length > 2);
  const lines = text => text.split('\n').filter(line => /^line \d+$/.test(line));
  assert.deepEqual(
    parts.flatMap(part => lines(part.text)),
    lines(diff),
  );
  for (const part of parts.slice(1)) assert.match(part.text, /^--- new\.ts ---$/m);
  assert.ok(parts.every(part => part.paths.includes('new.ts') || part.paths.includes('(diff preamble)')));
});

test('every part stays within the budget, a long line is cut, and nothing is lost or repeated', () => {
  const longLine = 'q'.repeat(700);
  const diff =
    fileDiff('long.ts', [[longLine, 'tail']]) +
    'diff --git a/bin.png b/bin.png\nBinary files a/bin.png and b/bin.png differ\n' +
    '--- UNTRACKED FILE SNAPSHOT (workspace scope) ---\n\n--- new.ts ---\nconst a = 1;\n--- fake.ts ---\ndiff --git a/x b/x\nconst b = 2;\n';
  const parts = splitReviewDiff(diff, ['long.ts', 'bin.png', 'new.ts'], 250);
  for (const part of parts) assert.ok(part.text.length <= 250, `part of ${part.text.length}`);
  assert.equal(
    parts
      .map(part => part.text)
      .join('')
      .split('q').length - 1,
    700,
    'the long line is kept whole across pieces',
  );
  assert.ok(
    parts.some(part => /Binary files a\/bin\.png/.test(part.text)),
    'a block without hunks is kept',
  );
  const newPart = parts.find(part => part.paths.includes('new.ts'));
  assert.ok(!parts.some(part => part.paths.includes('fake.ts')), 'a marker line inside a file is content');
  assert.match(newPart.text, /--- fake\.ts ---\ndiff --git a\/x b\/x\nconst b = 2;/);
});

test('every line of a diff lands in exactly one part, in order, with its file header', () => {
  const diff = [
    fileDiff('a.ts', [Array.from({ length: 30 }, (_, i) => `a${i}`)]),
    fileDiff('big.ts', [Array.from({ length: 80 }, (_, i) => `b${i}`), Array.from({ length: 40 }, (_, i) => `c${i}`)]),
    fileDiff('z.ts', [['z']]),
  ].join('');
  const parts = splitReviewDiff(diff, [], 300);
  assert.ok(parts.length > 3);
  for (const part of parts) {
    assert.ok(part.text.length <= 300 || /continued/.test(part.text) === false, 'within the budget');
    for (const block of part.text.split(/(?=^diff --git )/m))
      assert.match(block, /^diff --git a\//, 'each piece starts with its file header');
  }
  const added = text => text.split('\n').filter(line => /^\+[abcz]\d*$/.test(line));
  assert.deepEqual(
    parts.flatMap(part => added(part.text)),
    added(diff),
    'nothing lost, nothing repeated, same order',
  );
  assert.ok(
    parts.some(part => /\(continued\)/.test(part.text)),
    'a hunk larger than a part is continued',
  );
  assert.deepEqual([...new Set(parts.flatMap(part => part.paths))], ['a.ts', 'big.ts', 'z.ts']);
});

function bigRepo() {
  const repo = fs.mkdtempSync(path.join(tempDir, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const line = 'export const value = "' + 'x'.repeat(60) + '";\n';
  for (const name of ['one.ts', 'two.ts'])
    fs.writeFileSync(path.join(repo, name), line.repeat(Math.ceil((REVIEW_PART_CHARS * 0.7) / line.length)));
  return repo;
}

function stubReviewer(answer) {
  const prompts = [];
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      prompts.push(prompt);
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)?.[1] ?? 'snapshot';
      return {
        status: 'completed',
        isError: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\n${answer(prompt, prompts.length)}\nCHECKS: typecheck=PASS; tests=PASS`,
        nativeSessionId: `11111111-2222-3333-4444-55555555555${prompts.length % 10}`,
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  return prompts;
}

async function setup() {
  await saveConfig({
    defaultBackend: 'agy',
    routing: { strategy: 'fixed', allowedBackends: ['agy'] },
    governance: { models: { allow: ['fixture-model'] } },
  });
}

test('a large change is reviewed in parts, each in its own session, then in one synthesis turn', async () => {
  const original = adapterRegistry.agy;
  try {
    await setup();
    const repo = bigRepo();
    const prompts = stubReviewer(() => 'VERDICT: READY\nReviewed: the part.');
    const result = readResult(await handleReview('review', {}, repo, null, null));
    assert.equal(prompts.length, 3, 'two parts and the synthesis');
    assert.match(prompts[0], /reviewed in 2 parts; you have part 1/);
    assert.match(prompts[0], /^SNAPSHOT: .+\/part-1-of-2$/m);
    assert.doesNotMatch(prompts[2], /^DIFF:/m, 'the synthesis gets findings, not the diff');
    assert.match(prompts[2], /Part 1 \(READY\):/);
    assert.equal(result.verdict, 'READY');
    assert.match(result.answer, /Reviewed in 2 parts:/);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a part that is not READY keeps the review BLOCKED, whatever the synthesis says', async () => {
  const original = adapterRegistry.agy;
  try {
    await setup();
    const repo = bigRepo();
    stubReviewer((prompt, n) =>
      n === 1
        ? 'VERDICT: BLOCKED\nReviewed: the part.\n[P1] one.ts:1\nProblem: wrong.\nEvidence: one.ts:1.\nFix: fix it.'
        : 'VERDICT: READY\nReviewed: the part.',
    );
    const result = readResult(await handleReview('review', {}, repo, null, null));
    assert.equal(result.verdict, 'BLOCKED');
    assert.match(result.reason, /part 1 did not end READY/);
  } finally {
    adapterRegistry.agy = original;
  }
});
