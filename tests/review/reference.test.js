'use strict';

/**
 * #214: a large diff is read by the reviewer from a file in the snapshot, not inlined.
 *
 * Verifies:
 * - the gate blocks a reviewer that did not name every file it was to read, by whole names only,
 *   and leaves such a review unjudged so an unchanged repeat may run again;
 * - a large change sends a file reference and the file list, the file holds exactly the collected
 *   diff, and READY needs every file named;
 * - a small change stays inlined.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-reference-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');

const { INLINE_DIFF_CHARS, executeReview } = require('../../src/mcp/tools/review.tool.ts');
const { evaluateStateEnvelopeGate, namesFile } = require('../../src/review/gate.ts');
const { collectGitScope } = require('../../src/workspace/git.ts');
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

test('a file is named only as a whole path', () => {
  assert.equal(namesFile('Reviewed: src/a.tsx.', 'src/a.ts'), false);
  assert.equal(namesFile('Reviewed: src/a.ts and src/a.tsx.', 'src/a.ts'), true);
  assert.equal(namesFile('Reviewed: src/a.ts.', 'src/a.ts'), true);
  assert.equal(namesFile('[P2] src/a.ts:12', 'src/a.ts'), true);
  assert.equal(namesFile('Reviewed: lib/src/a.ts', 'src/a.ts'), false);
  assert.equal(namesFile('Reviewed: [src/a.ts](x) and **src/b.ts**', 'src/b.ts'), true);
  assert.equal(namesFile('Reviewed: [src/a.ts](x)', 'src/a.ts'), true);
  assert.equal(namesFile('VERDICT: READY', 'READY'), false, 'an envelope field names no file');
  assert.equal(namesFile('Reviewed: a.ts,b.ts', 'a.ts'), false, 'a comma inside a name is no boundary');
  assert.equal(namesFile('Reviewed: a.ts, b.ts', 'a.ts'), true);
});

test('the gate blocks a reviewer that did not name every file, and leaves the review unjudged', () => {
  const context = { expectedSnapshot: 's', inputComplete: true, requiredChecks: [], filesToName: ['src/a.ts', 'src/b.ts'] };
  const missing = evaluateStateEnvelopeGate(envelope('s', 'src/a.ts and src/b.tsx'), false, true, context, { completed: true });
  assert.equal(missing.verdict, 'BLOCKED');
  assert.match(missing.reason, /did not name 1 of the changed files.*src\/b\.ts/);
  assert.equal(missing.judged, false, 'an unchanged repeat may run again');
  const named = evaluateStateEnvelopeGate(envelope('s', 'src/a.ts and src/b.ts'), false, true, context, { completed: true });
  assert.equal(named.verdict, 'READY');
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
  return dir;
}

function fixture(answer) {
  const seen = [];
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      const file = /from the file (.+?) \(\d+ lines/.exec(prompt)?.[1];
      seen.push({ prompt, file, diff: file ? fs.readFileSync(file, 'utf8') : null });
      const snapshot = /SNAPSHOT: (\S+)/.exec(prompt)[1];
      const text = answer(snapshot);
      options.onEvent({ type: 'assistant_message', messageId: 'm', text });
      return {
        status: 'completed',
        isError: false,
        output: text,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  return { seen, restore: () => (adapterRegistry.agy = original) };
}

test('a large change is read from a file holding exactly the collected diff, and READY needs every file named', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const big = 'x'.repeat(80) + '\n';
  for (const [names, verdict] of [
    ['a.txt and b.txt', 'READY'],
    ['a.txt only', 'BLOCKED'],
  ]) {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), big.repeat(Math.ceil(INLINE_DIFF_CHARS / big.length) + 10));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    const collected = (await collectGitScope('uncommitted', dir)).diff;
    const f = fixture(snapshot => envelope(snapshot, names));
    try {
      const outcome = await executeReview({ backend: 'agy' }, dir);
      const [{ prompt, diff }] = f.seen;
      assert.match(prompt, /The diff is not inlined/);
      assert.match(prompt, /^- a\.txt$/m);
      assert.ok(!prompt.includes(big.repeat(3)), 'the diff text is not in the prompt');
      assert.equal(diff, collected, 'the file holds exactly the collected diff');
      assert.ok(!f.seen[0].file.startsWith(dir), 'the diff file is outside the reviewed tree');
      assert.equal(fs.existsSync(f.seen[0].file), false, 'the diff file is removed after the review');
      assert.equal(outcome.review.verdict, verdict, names);
    } finally {
      f.restore();
    }
  }
});

test('a small change stays inlined', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'small change\n');
  const f = fixture(snapshot => envelope(snapshot, 'a.txt'));
  try {
    await executeReview({ backend: 'agy' }, dir);
    assert.ok(!/The diff is not inlined/.test(f.seen[0].prompt));
    assert.match(f.seen[0].prompt, /\+small change/);
  } finally {
    f.restore();
  }
});

test('lowercase envelope fields name no file either', () => {
  assert.equal(namesFile('verdict: READY', 'READY'), false);
});
