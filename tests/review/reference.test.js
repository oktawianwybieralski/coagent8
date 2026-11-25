'use strict';

/**
 * #214: a large diff is read by the reviewer from a file, not inlined.
 *
 * Verifies:
 * - the gate blocks a review that does not quote the end mark of its diff file, and leaves it
 *   unjudged so an unchanged repeat may run again;
 * - a large change sends a file reference instead of the diff; the file, outside the reviewed tree
 *   and removed afterwards, holds exactly the collected diff and ends with a mark the prompt does
 *   not show; READY needs the mark;
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
const { evaluateStateEnvelopeGate } = require('../../src/review/gate.ts');
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

test('the gate blocks a review that did not quote the end mark of its diff file, and leaves it unjudged', () => {
  const context = { expectedSnapshot: 's', inputComplete: true, requiredChecks: [], readToken: '0123456789abcdef' };
  const unread = evaluateStateEnvelopeGate(envelope('s', 'the change'), false, true, context, { completed: true });
  assert.equal(unread.verdict, 'BLOCKED');
  assert.match(unread.reason, /did not quote the end mark/);
  assert.equal(unread.judged, false, 'an unchanged repeat may run again');
  const read = evaluateStateEnvelopeGate(envelope('s', 'the change, mark 0123456789abcdef'), false, true, context, { completed: true });
  assert.equal(read.verdict, 'READY');
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

function fixture(quoteMark) {
  const seen = [];
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      const file = /from the file (.+?) \(\d+ lines/.exec(prompt)?.[1];
      const content = file ? fs.readFileSync(file, 'utf8') : null;
      const mark = content ? /\[END OF DIFF (\w+)\]\n$/.exec(content)?.[1] : null;
      seen.push({ prompt, file, content, mark });
      const snapshot = /SNAPSHOT: (\S+)/.exec(prompt)[1];
      const text = envelope(snapshot, quoteMark && mark ? `the change, mark ${mark}` : 'the change');
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

test('a large change is read from a file of exactly the collected diff, and READY needs its end mark', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const big = 'x'.repeat(80) + '\n';
  for (const [quoteMark, verdict] of [
    [true, 'READY'],
    [false, 'BLOCKED'],
  ]) {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), big.repeat(Math.ceil(INLINE_DIFF_CHARS / big.length) + 10));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    const collected = (await collectGitScope('uncommitted', dir)).diff;
    const f = fixture(quoteMark);
    try {
      const outcome = await executeReview({ backend: 'agy' }, dir);
      const [{ prompt, file, content, mark }] = f.seen;
      assert.match(prompt, /The diff is not inlined/);
      assert.match(prompt, /^- a\.txt$/m);
      assert.ok(!prompt.includes(big.repeat(3)), 'the diff text is not in the prompt');
      assert.ok(mark && !prompt.includes(mark), 'the prompt does not show the mark');
      assert.equal(
        content,
        `${collected}${collected.endsWith('\n') ? '' : '\n'}[END OF DIFF ${mark}]\n`,
        'exactly the collected diff, then the mark',
      );
      assert.ok(!file.startsWith(dir), 'the diff file is outside the reviewed tree');
      assert.equal(fs.existsSync(file), false, 'the diff file is removed after the review');
      assert.equal(outcome.review.verdict, verdict, String(quoteMark));
    } finally {
      f.restore();
    }
  }
});

test('a small change stays inlined', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'small change\n');
  const f = fixture(true);
  try {
    await executeReview({ backend: 'agy' }, dir);
    assert.ok(!/The diff is not inlined/.test(f.seen[0].prompt));
    assert.match(f.seen[0].prompt, /\+small change/);
  } finally {
    f.restore();
  }
});
