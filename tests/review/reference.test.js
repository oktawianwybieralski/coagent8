'use strict';

/**
 * #214: a large diff is read by the reviewer in the snapshot, not inlined.
 *
 * Verifies:
 * - the command that shows each scope's diff in its snapshot;
 * - the gate blocks a reviewer that did not name every file it was to read;
 * - a large change sends a reference and the file list instead of the diff, and READY needs every file named;
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

const { diffCommand, diffReference, INLINE_DIFF_CHARS, executeReview } = require('../../src/mcp/tools/review.tool.ts');
const { evaluateStateEnvelopeGate } = require('../../src/review/gate.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { saveConfig } = require('../../src/config.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('the diff command per scope, in the snapshot where HEAD is the reviewed commit', () => {
  assert.equal(diffCommand({ type: 'uncommitted' }, ['a.ts'], false), 'git show --format= HEAD --');
  assert.equal(diffCommand({ type: 'staged' }, ['a.ts', 'b c.ts'], true), 'git show --format= HEAD -- "a.ts" "b c.ts"');
  assert.equal(diffCommand({ type: 'commit', revision: 'abc' }, [], false), 'git show --format= HEAD --');
  assert.equal(diffCommand({ type: 'range', revision: 'a...b' }, ['x'], true), 'git diff a...b -- "x"');
  assert.equal(diffCommand({ type: 'branch', revision: 'main' }, [], false), 'git diff main...HEAD');
  const reference = diffReference({ type: 'uncommitted' }, ['a.ts', 'b.ts'], false);
  assert.match(reference, /not inlined/);
  assert.match(reference, /^- a\.ts$/m);
  assert.match(reference, /^- b\.ts$/m);
});

const envelope = (snapshot, reviewed) =>
  [
    'REVIEW: 1',
    `SNAPSHOT: ${snapshot}`,
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    `Reviewed: ${reviewed}`,
    'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN',
  ].join('\n');

test('the gate blocks a reviewer that did not name every file it was to read', () => {
  const context = { expectedSnapshot: 's', inputComplete: true, requiredChecks: [], filesToName: ['src/a.ts', 'src/b.ts'] };
  const missing = evaluateStateEnvelopeGate(envelope('s', 'src/a.ts'), false, true, context, { completed: true });
  assert.equal(missing.verdict, 'BLOCKED');
  assert.match(missing.reason, /did not name 1 of the changed files.*src\/b\.ts/);
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
  const prompts = [];
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      prompts.push(prompt);
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
  return { prompts, restore: () => (adapterRegistry.agy = original) };
}

test('a large change is read by reference, and READY needs every changed file named', async () => {
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const big = 'x'.repeat(80) + '\n';
  for (const [names, verdict] of [
    ['a.txt and b.txt', 'READY'],
    ['a.txt only', 'BLOCKED'],
  ]) {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), big.repeat(Math.ceil(INLINE_DIFF_CHARS / big.length) + 10));
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    const f = fixture(snapshot => envelope(snapshot, names));
    try {
      const outcome = await executeReview({ backend: 'agy' }, dir);
      const prompt = f.prompts[0];
      assert.match(prompt, /The diff is not inlined/);
      assert.match(prompt, /git show --format= HEAD --/);
      assert.match(prompt, /^- a\.txt$/m);
      assert.ok(!prompt.includes(big.repeat(3)), 'the diff text is not in the prompt');
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
    assert.ok(!/The diff is not inlined/.test(f.prompts[0]));
    assert.match(f.prompts[0], /\+small change/);
  } finally {
    f.restore();
  }
});
