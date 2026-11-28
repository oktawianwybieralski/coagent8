const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withAnswerLanguage } = require('../../../src/execution/controller.ts');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-review-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
const { adapterRegistry } = require('../../../src/backends/registry.ts');
require('../../../src/execution/controller.ts').composeExecutionCancellation();
const { handleReview } = require('../../../src/mcp/tools/review.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { readResult } = require('../../helpers/result.cjs');
const { collectReviewInput } = require('../../../src/review/input.ts');
const { createExecutionBudget } = require('../../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../../src/contracts/error.ts');
/** The server verdict and the checks it names as not run. */
const pick = ({ verdict, reason }) => ({ verdict, reason });
const readMark = prompt => {
  const file = /from the file (.+?) \(\d+ lines/.exec(prompt)?.[1];
  return file ? (/\[END OF DIFF (\w+)\]/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '') : '';
};
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('review prompt names the snapshot, asks for the bounded envelope, and a matching answer passes the gate', async () => {
  const repo = path.join(tempDir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  const head = git('rev-parse', '--short', 'HEAD');
  const original = adapterRegistry.agy;
  let prompt = '';
  let diffFile = '';
  let diffContent = '';
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async received => {
      prompt = received;
      diffFile = /from the file (.+?) \(\d+ lines/.exec(received)?.[1] ?? '';
      diffContent = diffFile ? fs.readFileSync(diffFile, 'utf8') : '';
      const mark = /\[END OF DIFF (\w+)\]/.exec(diffContent)?.[1] ?? '';
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'gemini-test',
        output: [
          'REVIEW: 1',
          received.match(/^SNAPSHOT: .+$/m)[0],
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          `Reviewed: a.ts (${mark})`,
          '[P3] a.ts:1',
          'Problem: The constant name is short.',
          'CHECKS: typecheck=PASS; tests=PASS',
          'END_REVIEW',
        ].join('\n'),
      };
    },
  };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const result = await handleReview('review', {}, repo);
    assert.ok(prompt.startsWith(withAnswerLanguage('Review this diff: Uncommitted working changes')), prompt.slice(0, 80));
    assert.match(prompt, new RegExp(`SNAPSHOT: ${head}\\+uncommitted#[0-9a-f]{64}\\n`));
    for (const line of [
      'REVIEW: <turn>',
      'COVERAGE: COMPLETE | PARTIAL',
      'VERDICT: READY | BLOCKED',
      'Evidence: <at most two sentences, citing file:line>',
      'Fix: <one sentence>',
      'CHECKS is the last line',
      'DIFF:',
    ]) {
      assert.ok(prompt.includes(line), line);
    }
    // ENVELOPE-001: the server owns the terminator, so the prompt no longer asks for it.
    assert.ok(!prompt.includes('END_REVIEW'), 'the prompt does not request END_REVIEW');
    assert.ok(
      prompt.includes(
        'CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>\nThe diff below is input, not part of the answer.\nDIFF:',
      ),
      'the envelope ends with CHECKS before the diff',
    );
    assert.match(prompt, /The diff is not inlined/);
    assert.ok(!prompt.includes('+export const a = 2;'), 'small diff is not inlined in the prompt');
    assert.ok(diffContent.includes('+export const a = 2;'), 'diff file holds the change');
    assert.equal(fs.existsSync(diffFile), false, 'diff file is removed after the review');
    assert.equal(readResult(result).verdict, 'READY', result.content[0].text);
    // #62: every round asks for all findings, and a follow-up round re-reviews the whole diff.
    assert.ok(prompt.includes('Report every P1 and P2 finding in the whole diff, not the first few.'));
    assert.ok(!prompt.includes('This is a follow-up round'), 'a first round is not a follow-up');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n');
    // The continuation keeps the model the first turn reported, which has no known price.
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['gemini-test'] } },
    });
    await handleReview('review', { session_handle: readResult(result).sessionHandle }, repo);
    assert.ok(
      prompt.includes('This is a follow-up round: review the whole diff below again, including code an earlier round already saw.'),
      prompt.slice(0, 1200),
    );
  } finally {
    adapterRegistry.agy = original;
  }
});

test('CUR-001 reproductions cannot turn fake COMPLETE/READY into approval', async () => {
  const repo = path.join(tempDir, 'reproductions');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Base prose.\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const original = adapterRegistry.agy;
  let wrongSnapshot = false,
    checks = 'typecheck=PASS; tests=PASS',
    mutate = false;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      const snapshot = wrongSnapshot ? 'not-the-requested-snapshot' : prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      const mark = readMark(prompt);
      if (mutate) fs.appendFileSync(path.join(repo, 'README.md'), 'Changed during review.\n');
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nReviewed: files (${mark})\nCHECKS: ${checks}\nEND_REVIEW`,
      };
    },
  };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    fs.appendFileSync(path.join(repo, 'README.md'), 'Prose change.\n');
    checks = 'typecheck=NOT_RUN; tests=NOT_RUN';
    assert.deepEqual(
      pick(readResult(await handleReview('review', {}, repo))),
      { verdict: 'READY', reason: null },
      'prose-only checks may be NOT_RUN',
    );
    fs.writeFileSync(path.join(repo, 'new-prose.md'), 'New prose.\n');
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'READY', 'new prose does not require runtime checks');
    fs.unlinkSync(path.join(repo, 'new-prose.md'));
    fs.writeFileSync(path.join(repo, 'source-\u017b.ts'), 'export const value = 1;\n');
    git('add', '.');
    const quoted = await collectReviewInput('uncommitted', repo, null);
    assert.ok(quoted.info.changedPaths.includes('source-\u017b.ts'));
    assert.deepEqual(
      pick(readResult(await handleReview('review', {}, repo))),
      { verdict: 'READY', reason: 'typecheck and tests not run' },
      'quoted source paths still require checks',
    );
    git('commit', '-qm', 'source fixture');
    git('mv', 'source-\u017b.ts', 'renamed.md');
    assert.deepEqual(
      pick(readResult(await handleReview('review', {}, repo))),
      { verdict: 'READY', reason: 'typecheck and tests not run' },
      'rename sources remain in check classification',
    );
    git('commit', '-qm', 'rename fixture');
    wrongSnapshot = true;
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED');
    wrongSnapshot = false;
    checks = 'typecheck=FAIL; tests=PASS';
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED');
    checks = 'typecheck=PASS; tests=PASS';
    mutate = true;
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED', 'changes during the turn invalidate the snapshot');
    mutate = false;
    fs.writeFileSync(path.join(repo, 'oversized.md'), 'x'.repeat(256 * 1024 + 1));
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED', 'omitted untracked input must block');
    fs.unlinkSync(path.join(repo, 'oversized.md'));
    fs.writeFileSync(path.join(repo, 'large.ts'), 'export const item = 1;\n'.repeat(170000));
    git('add', 'large.ts');
    git('add', 'README.md');
    const input = await collectReviewInput('staged', repo, null);
    assert.equal(input.context.inputComplete, false);
    // Too large even in parts (REVIEW-002): refused before any turn instead of a review that must block.
    await assert.rejects(
      handleReview('review', { scope: 'staged' }, repo),
      err => err.code === 'INPUT_LIMIT' && /too large to review/.test(err.message),
    );
  } finally {
    adapterRegistry.agy = original;
  }
});

test('CUR-013 refuses another tree and staged overlays before any backend probe', async () => {
  const repo = path.join(tempDir, 'tree-binding');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'First tree.\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Current tree.\n');
  git('commit', '-qam', 'current');
  const original = adapterRegistry.agy;
  let probes = 0;
  adapterRegistry.agy = {
    ...original,
    probe: async () => {
      probes++;
      throw new Error('must not probe');
    },
  };
  try {
    for (const scope of [first, 'HEAD~1', `HEAD..${first}`]) {
      await assert.rejects(
        handleReview('review', { scope, backend: 'agy' }, repo),
        error => error.code === 'POLICY_DENIED' && /current workspace/.test(error.message),
      );
    }
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged version.\n');
    git('add', '.');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Another working version.\n');
    await assert.rejects(handleReview('review', { scope: 'staged', backend: 'agy' }, repo), error => error.code === 'POLICY_DENIED');
    git('reset', '--hard', 'HEAD');
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git('update-index', `--${flag}`, 'README.md');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Hidden working change.\n');
      for (const scope of ['uncommitted', 'HEAD'])
        await assert.rejects(
          handleReview('review', { scope, backend: 'agy' }, repo),
          error => error.code === 'POLICY_DENIED' && /Index flags/.test(error.message),
        );
      git('update-index', `--no-${flag}`, 'README.md');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Current tree.\n');
    }
    assert.equal(probes, 0);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('gitlink summaries never establish complete review input, even when dirty contents change without a new summary', async () => {
  const repo = path.join(tempDir, 'gitlinks'),
    child = path.join(repo, 'module');
  fs.mkdirSync(child, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  for (const cwd of [repo, child]) {
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.name', 'Fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  }
  fs.writeFileSync(path.join(child, 'code.ts'), 'export const value = 1;\n');
  git(child, 'add', '.');
  git(child, 'commit', '-qm', 'module');
  const revision = git(child, 'rev-parse', 'HEAD');
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${revision},module`);
  git(repo, 'commit', '-qm', 'gitlink');
  fs.writeFileSync(path.join(child, 'code.ts'), 'export const value = 2;\n');
  const before = await collectReviewInput('uncommitted', repo, null);
  fs.writeFileSync(path.join(child, 'code.ts'), 'export const value = 3;\n');
  const after = await collectReviewInput('uncommitted', repo, null);
  assert.equal(before.info.diff, after.info.diff, 'Git summarizes both dirty versions identically');
  assert.equal(before.context.inputComplete, false);
  assert.equal(after.context.inputComplete, false);
  const { evaluateStateEnvelopeGate } = require('../../../src/review/gate.ts');
  const output = `REVIEW: 1\nSNAPSHOT: ${after.context.expectedSnapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW`;
  assert.equal(evaluateStateEnvelopeGate(output, false, true, after.context).verdict, 'BLOCKED');
});

test('recheck failure or workspace mutation during review turn blocks READY verdict', async () => {
  const repo = path.join(tempDir, 'recheck-fail');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 2;\n');

  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      // Simulate workspace change during turn execution
      const mark = readMark(prompt);
      fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 3;\n');
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      return {
        status: 'completed',
        isError: false,
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          `Reviewed: file.ts (${mark})`,
          'CHECKS: typecheck=PASS; tests=PASS',
          'END_REVIEW',
        ].join('\n'),
      };
    },
  };

  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const result = await handleReview('review', {}, repo);
    const { verdict, reason } = readResult(result);
    assert.equal(verdict, 'BLOCKED', 'Mutated workspace during turn MUST block READY');
    assert.match(reason, /Review workspace or input changed during the turn/i);
    assert.match(reason, /the reviewer answered READY/i);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('an untracked binary is named to the reviewer and READY says it was not reviewed (FEEDBACK-060d, FEEDBACK-070d)', async () => {
  const repo = path.join(tempDir, 'untracked-binary');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 2;\n');
  fs.writeFileSync(path.join(repo, 'module.pyc'), Buffer.from([0x55, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0xff, 0x00, 0x01]));

  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      seenPrompt = prompt;
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      const mark = readMark(prompt);
      return {
        status: 'completed',
        isError: false,
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          `Reviewed: file.ts (${mark})`,
          'CHECKS: typecheck=PASS; tests=PASS',
          'END_REVIEW',
        ].join('\n'),
      };
    },
  };
  let seenPrompt = '';

  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const { verdict, reason } = readResult(await handleReview('review', {}, repo));
    assert.equal(verdict, 'READY', 'a binary change no longer makes the input PARTIAL');
    assert.equal(reason, '1 binary file not reviewed');
    assert.match(seenPrompt, /^Collected input: COMPLETE\./m);
    assert.match(seenPrompt, /^Binary files changed .*module\.pyc \(added\)\.$/m);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('handleReview with pre-aborted signal stops before turn and rejects promptly', async () => {
  const repo = path.join(tempDir, 'pre-abort-review');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(handleReview('review', {}, repo, controller.signal), err => {
    assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
    assert.equal(err.code, 'ABORTED');
    return true;
  });
});

test('handleReview with expired budget stops during collection without starting model turn', async () => {
  const repo = path.join(tempDir, 'expired-budget-review');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  let now = 0;
  const budget = createExecutionBudget({ totalBudgetMs: 10, teardownAllowanceMs: 10, clock: () => now });
  now = 15; // Primary execution expired

  let executeCalled = false;
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async () => {
      executeCalled = true;
      throw new Error('Must not execute');
    },
  };

  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    await assert.rejects(handleReview('review', {}, repo, null, null, { budget }), err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    });
    assert.equal(executeCalled, false, 'No model turn should be started');
  } finally {
    budget.dispose();
    adapterRegistry.agy = original;
  }
});

test('handleReview passes remaining monotonic execution time to adapter after Git collection', async () => {
  const repo = path.join(tempDir, 'repo-review-timeout');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  let now = 1000;
  const clock = () => now;
  let receivedTimeoutMs = null;
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => {
      now += 250;
      return { installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } };
    },
    execute: async (prompt, options) => {
      receivedTimeoutMs = options.timeoutMs;
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)?.[1] ?? 'snapshot';
      const mark = readMark(prompt);
      return {
        status: 'completed',
        isError: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nReviewed: checked a.ts (${mark})\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW`,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  // Long in real time too: its own timer must not fire during Git collection under load (#132).
  const budget = createExecutionBudget({ totalBudgetMs: 60000, teardownAllowanceMs: 2000, clock });

  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['fixture-model'] } },
    });
    const result = await handleReview('review', {}, repo, null, null, { budget, clock });
    assert.ok(receivedTimeoutMs !== null, 'Adapter execute should have been called');
    assert.ok(receivedTimeoutMs <= 57750, `Expected remaining timeoutMs <= 57750, got ${receivedTimeoutMs}`);
    assert.ok(receivedTimeoutMs > 0, `Expected positive timeoutMs, got ${receivedTimeoutMs}`);
    assert.equal(readResult(result).verdict, 'READY');
  } finally {
    budget.dispose();
    adapterRegistry.agy = original;
  }
});

test('handleReview verifyReviewSnapshot succeeds during teardown allowance when turn finished near deadline', async () => {
  const repo = path.join(tempDir, 'repo-review-teardown-snapshot');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(repo, 'untracked.ts'), 'export const u = 42;\n');

  let now = 1000;
  const clock = () => now;
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      // Past executionDeadlineMs (46000) and inside teardown allowance (deadlineMs 61000), leaving 11s for real Git recheck under load.
      now = 50000;
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)?.[1] ?? 'snapshot';
      const mark = readMark(prompt);
      return {
        status: 'completed',
        isError: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nReviewed: checked a.ts (${mark})\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW`,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  // Long in real time too: its own timer must not fire under load (#132).
  const budget = createExecutionBudget({ totalBudgetMs: 60000, teardownAllowanceMs: 15000, clock });

  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['fixture-model'] } },
    });
    const context = {
      abortSignal: budget.executionSignal,
      budget,
      timeoutMs: budget.remainingExecutionMs(),
    };
    const result = await handleReview('review', {}, repo, null, null, { budget, clock, context });
    assert.equal(readResult(result).verdict, 'READY');
  } finally {
    budget.dispose();
    adapterRegistry.agy = original;
  }
});

test('Issue #20: handleReview on agy recovers automatically from an initial sandbox command denial and passes the State Envelope gate', async () => {
  const repo = path.join(tempDir, 'repo-review-agy-recover');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  const input = await collectReviewInput('uncommitted', repo, null);
  const originalAgyPath = process.env.AGY_PATH;
  process.env.AGY_PATH = path.resolve(__dirname, '../../fixtures/agy-cli/agy.cjs');
  process.env.coagent8_FIXTURE_MODE = 'sandbox-denied-recover';
  process.env.coagent8_FIXTURE_RECOVER_RESPONSE = [
    'REVIEW: 1',
    `SNAPSHOT: ${input.context.expectedSnapshot}`,
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'Reviewed: a.ts ({{READ_MARK}})',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const result = await handleReview('review', { backend: 'agy' }, repo);
    const parsed = readResult(result);
    assert.equal(parsed.status, 'completed', JSON.stringify(result));
    assert.equal(parsed.verdict, 'READY', JSON.stringify(parsed));
  } finally {
    if (originalAgyPath === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = originalAgyPath;
    delete process.env.coagent8_FIXTURE_MODE;
    delete process.env.coagent8_FIXTURE_RECOVER_RESPONSE;
  }
});

test('review mode: async returns a task handle, runs checks/snapshot/gate identically, and exposes verdict via task/wait (#246)', async () => {
  const { handleSession, handleCancelSession } = require('../../../src/mcp/tools/session.tool.ts');
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { runWaitCli } = require('../../../src/sessions/wait-cli.ts');
  const { setTimeout: delay } = require('node:timers/promises');

  const repo = path.join(tempDir, 'repo-review-async');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  const original = adapterRegistry.agy;
  const recordedTimeouts = [];
  let holdExecute = null;
  let mutateDuringTurn = false;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ id: 'agy', installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      recordedTimeouts.push(options.timeoutMs);
      if (holdExecute) {
        const aborted = await new Promise(resolve => {
          holdExecute.resolve = () => resolve(false);
          options.abortSignal?.addEventListener('abort', () => resolve(true), { once: true });
        });
        if (aborted) {
          return {
            status: 'cancelled',
            isError: true,
            truncated: false,
            continuationAvailable: false,
            error: { code: 'ABORTED', message: 'cancelled', retryable: false },
            output: '',
          };
        }
      }
      if (mutateDuringTurn) fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 99;\n');
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      const mark = readMark(prompt);
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: '11111111-2222-3333-4444-555555555566',
        model: 'fixture-model',
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          `Reviewed: a.ts (${mark})`,
          'CHECKS: typecheck=PASS; tests=PASS',
        ].join('\n'),
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'async review finished in time');
      await delay(25);
    }
  };

  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      allowedChecks: ['node -e "process.exit(0)"'],
    });

    // 1. Sync review refuses > 1,800,000 ms naming the limit; async accepts up to 14,400,000 ms and refuses larger.
    await assert.rejects(
      handleReview('review', { timeout_ms: 1_800_001 }, repo),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('1800000'),
    );
    await assert.rejects(
      handleReview('review', { mode: 'async', timeout_ms: 14_400_001 }, repo),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('14400000'),
    );

    // 2. Async review returns a task handle immediately while running, then stores result + server verdict.
    holdExecute = {};
    const started = await handleReview(
      'review',
      { mode: 'async', checks: ['node -e "process.exit(0)"'], timeout_ms: 7_200_000 },
      repo,
      null,
      null,
      { clientName: 'claude-code' },
    );
    const { taskHandle, sessionHandle, wakeup, waitArgv, timeoutMs, timeoutBound } = started.structuredContent;
    assert.match(taskHandle, /^task_[a-f0-9]{32}$/);
    assert.match(sessionHandle, /^syn_sess_/);
    assert.equal(wakeup, 'background_wait');
    assert.equal(timeoutMs, 7_200_000);
    assert.equal(timeoutBound, 'timeout_ms');
    assert.equal(waitArgv[2], 'wait');
    assert.equal(readTask(taskHandle).state, 'running');
    assert.ok(recordedTimeouts.at(-1) > 7_000_000 && recordedTimeouts.at(-1) <= 7_200_000);

    holdExecute.resolve();
    holdExecute = null;
    const finished = await waitTask(taskHandle);
    assert.equal(finished.state, 'completed');
    assert.equal(finished.review?.verdict, 'READY');
    assert.match(finished.result.text, /Verdict: READY/);
    assert.match(finished.result.text, /Budget: 7200000 ms \(timeout_ms\)/);

    const taskRead = await handleSession({ action: 'task', task_handle: taskHandle }, repo);
    assert.equal(taskRead.structuredContent.state, 'completed');
    assert.equal(taskRead.structuredContent.review?.verdict, 'READY');
    assert.match(taskRead.content[0].text, /Verdict: READY/);

    const chunks = [];
    const exitCode = await runWaitCli([taskHandle], { write: c => chunks.push(String(c)) }, { write: () => {} });
    assert.equal(exitCode, 0);
    assert.match(chunks.join(''), /Verdict: READY/);

    // 3. Snapshot verification in async mode blocks READY if workspace mutates during the turn.
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n');
    mutateDuringTurn = true;
    const mutatedStart = await handleReview('review', { mode: 'async' }, repo);
    mutateDuringTurn = false;
    assert.equal(mutatedStart.structuredContent.timeoutMs, 3_600_000);
    assert.equal(mutatedStart.structuredContent.timeoutBound, 'async_default');
    const mutatedDone = await waitTask(mutatedStart.structuredContent.taskHandle);
    assert.equal(mutatedDone.state, 'completed');
    assert.equal(mutatedDone.review?.verdict, 'BLOCKED');
    assert.match(mutatedDone.result.text, /Verdict: BLOCKED/);
    assert.match(mutatedDone.result.text, /Review workspace or input changed during the turn/i);

    // 4. Async review can be cancelled cleanly via session_handle.
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 4;\n');
    holdExecute = {};
    const cancelStart = await handleReview('review', { mode: 'async' }, repo);
    await handleCancelSession({ session_handle: cancelStart.structuredContent.sessionHandle, workspace_path: repo });
    holdExecute = null;
    const cancelDone = await waitTask(cancelStart.structuredContent.taskHandle);
    assert.equal(cancelDone.state, 'cancelled');
    assert.match(cancelDone.result.text, /Verdict: BLOCKED/);
  } finally {
    await stopActiveDelegations();
    adapterRegistry.agy = original;
  }
});

test('review mode: async fails closed on failed server check and invalid State Envelope (#246)', async () => {
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { setTimeout: delay } = require('node:timers/promises');

  const repo = path.join(tempDir, 'repo-review-async-gates');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  const original = adapterRegistry.agy;
  let invalidEnvelope = false;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ id: 'agy', installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      const mark = readMark(prompt);
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: `gate-${invalidEnvelope ? 'invalid' : 'check'}`,
        model: 'fixture-model',
        output: invalidEnvelope
          ? 'Looks good to me! VERDICT: READY'
          : [
              'REVIEW: 1',
              `SNAPSHOT: ${snapshot}`,
              'COVERAGE: COMPLETE',
              'VERDICT: READY',
              `Reviewed: a.ts (${mark})`,
              'CHECKS: typecheck=PASS; tests=PASS',
            ].join('\n'),
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'async review finished in time');
      await delay(25);
    }
  };

  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      allowedChecks: ['node -e "process.exit(1)"'],
    });

    // 1. A failing server check prevents READY in async mode even when the model claims READY and PASS.
    const failedCheckStart = await handleReview(
      'review',
      { mode: 'async', checks: ['node -e "process.exit(1)"'], instructions: 'Check gate failure' },
      repo,
    );
    const failedCheckDone = await waitTask(failedCheckStart.structuredContent.taskHandle);
    assert.equal(failedCheckDone.state, 'completed');
    assert.equal(failedCheckDone.review?.verdict, 'BLOCKED');
    assert.match(failedCheckDone.result.text, /Verdict: BLOCKED/);

    // 2. An invalid State Envelope prevents READY in async mode.
    invalidEnvelope = true;
    const invalidEnvStart = await handleReview('review', { mode: 'async', instructions: 'Envelope gate failure' }, repo);
    const invalidEnvDone = await waitTask(invalidEnvStart.structuredContent.taskHandle);
    assert.equal(invalidEnvDone.state, 'completed');
    assert.equal(invalidEnvDone.review?.verdict, 'BLOCKED');
    assert.match(invalidEnvDone.result.text, /Verdict: BLOCKED/);
  } finally {
    await stopActiveDelegations();
    adapterRegistry.agy = original;
  }
});

test('multi-part async review charges root calls, preserves continuation via synthesis, and cancels cleanly during later parts (#246)', async () => {
  const { handleCancelSession } = require('../../../src/mcp/tools/session.tool.ts');
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { readRoot } = require('../../../src/sessions/roots.ts');
  const { atomicWrite } = require('../../../src/storage/lock.ts');
  const { randomUUID } = require('node:crypto');
  const { setTimeout: delay } = require('node:timers/promises');

  const repo = path.join(tempDir, 'repo-review-multipart-async');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'part1.ts'), 'export const base1 = 1;\n');
  fs.writeFileSync(path.join(repo, 'part2.ts'), 'export const base2 = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');

  const makeLargeContent = prefix =>
    Array.from({ length: 1800 }, (_, i) => `export const ${prefix}_${i} = "${prefix}-${i}-padding-text-to-split-parts";`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'part1.ts'), makeLargeContent('p1'));
  fs.writeFileSync(path.join(repo, 'part2.ts'), makeLargeContent('p2'));

  const original = adapterRegistry.agy;
  let executeCalls = 0;
  let holdOnTurn = null;
  let heldEnteredResolve = null;
  let releaseHeldTurn = null;

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ id: 'agy', installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      const callIndex = ++executeCalls;
      if (holdOnTurn === callIndex) {
        heldEnteredResolve?.();
        const aborted = await new Promise(resolve => {
          releaseHeldTurn = () => resolve(false);
          options.abortSignal?.addEventListener('abort', () => resolve(true), { once: true });
        });
        if (aborted) {
          return {
            status: 'cancelled',
            isError: true,
            truncated: false,
            continuationAvailable: false,
            error: { code: 'ABORTED', message: 'cancelled', retryable: false },
            output: '',
          };
        }
      }
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      const refMatch = prompt.match(/Read all of it from the file (\S+)/);
      let readMark = 'inline';
      if (refMatch) {
        const refContent = fs.readFileSync(refMatch[1], 'utf8');
        const markMatch = refContent.match(/\[END OF DIFF ([a-f0-9]+)\]/);
        if (markMatch) readMark = markMatch[1];
      }
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: options.nativeSessionId || randomUUID(),
        model: 'fixture-model',
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          `Reviewed: checked diff (${readMark})`,
          'CHECKS: typecheck=PASS; tests=PASS',
        ].join('\n'),
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'multi-part async review finished in time');
      await delay(25);
    }
  };

  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['fixture-model'] } },
      rootLimits: { maxMinutes: 10, graceMinutes: 5 },
    });

    // 1. Multi-part async review charges all part turns and synthesis to the root, and binds all sessions.
    const started = await handleReview('review', { mode: 'async', instructions: 'Multi-part full review' }, repo);
    const finished = await waitTask(started.structuredContent.taskHandle);
    assert.equal(finished.state, 'completed');
    assert.equal(finished.review?.verdict, 'READY', finished.result.text);
    assert.equal(executeCalls, 3, '2 parts + 1 synthesis turn must execute');
    assert.notEqual(finished.sessionHandle, started.structuredContent.sessionHandle, 'synthesis session differs from initial part session');

    const root = readRoot(finished.rootHandle);
    assert.equal(root.calls, 3, 'all part turns and synthesis must be charged to the root');
    assert.equal(root.tasks[0].sessionHandle, started.structuredContent.sessionHandle);
    assert.ok(root.tasks[0].sessionHandles?.includes(finished.sessionHandle), 'synthesis session must be recorded on the root task');
    assert.equal(root.tasks[0].sessionHandles.length, 2, 'part 2 and synthesis sessions are bound to the root task');

    // 2. Continuing the completed multi-part review through its synthesis session stays on the original root and uses grace.
    const rootFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${finished.rootHandle}.json`);
    const at = minutesAgo => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const seeded = readRoot(finished.rootHandle);
    seeded.tasks[0].startedAt = at(20);
    seeded.tasks[0].endedAt = at(9); // 11m running time -> past 10m maxMinutes, 4m left in 5m grace
    await atomicWrite(rootFile, JSON.stringify(seeded));

    const continued = await handleReview(
      'review',
      { mode: 'async', session_handle: finished.sessionHandle, instructions: 'Follow-up after fix' },
      repo,
    );
    assert.equal(continued.structuredContent.rootHandle, finished.rootHandle, 'must stay on original root');
    assert.equal(continued.structuredContent.timeoutBound, 'root_grace', 'must retain continuation classification');
    assert.ok(continued.structuredContent.timeoutMs <= 240_000 && continued.structuredContent.timeoutMs > 200_000);
    const continuedDone = await waitTask(continued.structuredContent.taskHandle);
    assert.equal(continuedDone.state, 'completed');
    const updatedRoot = readRoot(finished.rootHandle);
    assert.equal(updatedRoot.tasks.at(-1).continuation, true);
    assert.equal(updatedRoot.calls, 6, 'continued multi-part review charges its turns on the same root');

    // Reset root running time so fresh multi-part runs can start on new roots.
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['fixture-model'] } },
    });

    // 3. Cancelling a multi-part async review during Part 2 via its returned session_handle stops Part 2 and synthesis.
    executeCalls = 0;
    holdOnTurn = 2;
    const part2EnteredA = new Promise(resolve => {
      heldEnteredResolve = resolve;
    });
    const cancelBySessionStart = await handleReview(
      'review',
      { mode: 'async', instructions: 'Cancel during part 2 via session_handle' },
      repo,
    );
    await part2EnteredA;
    const cancelBySessionRes = await handleCancelSession({
      session_handle: cancelBySessionStart.structuredContent.sessionHandle,
      workspace_path: repo,
    });
    assert.equal(cancelBySessionRes.structuredContent.cancelled, true);
    const cancelBySessionDone = await waitTask(cancelBySessionStart.structuredContent.taskHandle);
    assert.equal(cancelBySessionDone.state, 'cancelled');
    assert.equal(executeCalls, 2, 'synthesis must not run after cancelling during Part 2');
    assert.match(cancelBySessionDone.result.text, /Verdict: BLOCKED/);

    // 4. Cancelling a multi-part async review during Part 2 via task_handle stops the entire background task.
    executeCalls = 0;
    holdOnTurn = 2;
    const part2EnteredB = new Promise(resolve => {
      heldEnteredResolve = resolve;
    });
    const cancelByTaskStart = await handleReview('review', { mode: 'async', instructions: 'Cancel during part 2 via task_handle' }, repo);
    await part2EnteredB;
    const cancelByTaskRes = await handleCancelSession({
      task_handle: cancelByTaskStart.structuredContent.taskHandle,
      workspace_path: repo,
    });
    assert.equal(cancelByTaskRes.structuredContent.cancelled, true);
    const cancelByTaskDone = await waitTask(cancelByTaskStart.structuredContent.taskHandle);
    assert.equal(cancelByTaskDone.state, 'cancelled');
    assert.equal(executeCalls, 2, 'synthesis must not run after task_handle cancel during Part 2');
    assert.match(cancelByTaskDone.result.text, /Verdict: BLOCKED/);
  } finally {
    releaseHeldTurn?.();
    await stopActiveDelegations();
    adapterRegistry.agy = original;
  }
});

test('MCP server deducts pre-launch setup and consent time from async deadline and transfers cancellation ownership (#246)', async () => {
  const { createServer } = require('../../../src/mcp/server.ts');
  const { getConfigFile } = require('../../../src/config.ts');
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { ElicitRequestSchema, ListRootsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const { pathToFileURL } = require('node:url');
  const { randomUUID } = require('node:crypto');
  const { setTimeout: delay } = require('node:timers/promises');

  const repo = path.join(tempDir, 'repo-review-mcp-prelaunch-budget');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  let now = 10_000;
  const clock = () => now;
  let rootsAdvanceMs = 1_000;
  let elicitAdvanceMs = 5_000;
  let holdExecute = null;
  const recordedTimeouts = [];
  let executeCalls = 0;

  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ id: 'agy', installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async (prompt, options) => {
      executeCalls++;
      recordedTimeouts.push(options.timeoutMs);
      if (holdExecute) {
        const aborted = await new Promise(resolve => {
          holdExecute.resolve = () => resolve(false);
          options.abortSignal?.addEventListener('abort', () => resolve(true), { once: true });
        });
        if (aborted) {
          return {
            status: 'cancelled',
            isError: true,
            truncated: false,
            continuationAvailable: false,
            error: { code: 'ABORTED', message: 'cancelled', retryable: false },
            output: '',
          };
        }
      }
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      const mark = readMark(prompt);
      return {
        status: 'completed',
        isError: false,
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: randomUUID(),
        model: 'fixture-model',
        output: [
          'REVIEW: 1',
          `SNAPSHOT: ${snapshot}`,
          'COVERAGE: COMPLETE',
          'VERDICT: READY',
          `Reviewed: a.ts (${mark})`,
          'CHECKS: typecheck=PASS; tests=PASS',
        ].join('\n'),
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'async review finished in time');
      await delay(25);
    }
  };

  const previousHostConsentEnv = process.env.COAGENT8_HOST_EXECUTION;
  delete process.env.COAGENT8_HOST_EXECUTION;

  const server = createServer({ clock });
  const client = new Client({ name: 'claude-code', version: '1' }, { capabilities: { roots: {}, elicitation: { form: {} } } });
  let onElicit = async () => {
    now += elicitAdvanceMs;
    return { action: 'accept', content: { approve: true } };
  };
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    now += rootsAdvanceMs;
    return { roots: [{ uri: pathToFileURL(repo).href }] };
  });
  client.setRequestHandler(ElicitRequestSchema, async req => onElicit(req));

  const resetConfig = async () => {
    fs.rmSync(getConfigFile(), { force: true });
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['fixture-model'] } },
    });
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // 1. Pre-launch time (roots/list + host consent) is deducted from the async task deadline,
    //    and aborting the caller's request signal after launch does not cancel the background task.
    await resetConfig();
    holdExecute = {};
    const requestAbort = new AbortController();
    const started = await client.callTool(
      {
        name: 'review',
        arguments: { mode: 'async', timeout_ms: 30_000, instructions: 'Pre-launch deduction check' },
      },
      undefined,
      { signal: requestAbort.signal },
    );
    assert.equal(started.structuredContent.timeoutMs, 24_000, '6000 ms spent before launch must be deducted from 30000 ms');
    assert.ok(
      recordedTimeouts[0] > 0 && recordedTimeouts[0] <= 24_000,
      `adapter must receive remaining budget <= 24000 ms, got ${recordedTimeouts[0]}`,
    );

    requestAbort.abort();
    await delay(100);
    assert.equal(readTask(started.structuredContent.taskHandle).state, 'running', 'abort after start must not cancel task');
    holdExecute.resolve();
    holdExecute = null;
    const finished = await waitTask(started.structuredContent.taskHandle);
    assert.equal(finished.state, 'completed');

    // 2. Aborting before the turn starts cancels the start and starts no model turn.
    await resetConfig();
    const callsBeforeAbort = executeCalls;
    const earlyAbort = new AbortController();
    onElicit = async () => {
      earlyAbort.abort();
      await delay(50);
      return { action: 'accept', content: { approve: true } };
    };
    const abortedRes = await client
      .callTool(
        {
          name: 'review',
          arguments: { mode: 'async', timeout_ms: 30_000, instructions: 'Early abort check' },
        },
        undefined,
        { signal: earlyAbort.signal },
      )
      .catch(err => err);
    assert.equal(executeCalls, callsBeforeAbort, 'no model turn may start when cancelled before launch');
    assert.ok(abortedRes instanceof Error || abortedRes?.isError === true);

    // 3. Exhausting the budget during host consent fails with TIMEOUT before any model turn starts.
    await resetConfig();
    const callsBeforeTimeout = executeCalls;
    onElicit = async () => {
      now += 35_000;
      return { action: 'accept', content: { approve: true } };
    };
    const timedOutRes = await client.callTool({
      name: 'review',
      arguments: { mode: 'async', timeout_ms: 30_000, instructions: 'Pre-launch timeout check' },
    });
    assert.equal(timedOutRes.isError, true);
    assert.equal(readResult(timedOutRes).error?.code, 'TIMEOUT');
    assert.equal(executeCalls, callsBeforeTimeout, 'no model turn may start when pre-launch budget expires');

    // 4. Direct handleReview call with a pre-elapsed caller budget deducts setup time and detaches requestSignal on turn start.
    await saveConfig({ hostExecution: 'accepted' });
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n');
    const { createExecutionBudget } = require('../../../src/execution/runtime/budget.ts');
    const directAbort = new AbortController();
    const directBudget = createExecutionBudget({ totalBudgetMs: 20_000, parentSignal: directAbort.signal, clock });
    now += 4_000;
    holdExecute = {};
    try {
      const directStarted = await handleReview(
        'review',
        { mode: 'async', timeout_ms: 20_000, instructions: 'Direct pre-launch budget deduction' },
        repo,
        directAbort.signal,
        null,
        { budget: directBudget, clock },
      );
      assert.equal(directStarted.structuredContent.timeoutMs, 16_000);
      assert.ok(recordedTimeouts.at(-1) > 0 && recordedTimeouts.at(-1) <= 16_000);
      directAbort.abort();
      await delay(50);
      assert.equal(readTask(directStarted.structuredContent.taskHandle).state, 'running');
      holdExecute.resolve();
      holdExecute = null;
      const directDone = await waitTask(directStarted.structuredContent.taskHandle);
      assert.equal(directDone.state, 'completed');
    } finally {
      directBudget.dispose();
    }
  } finally {
    holdExecute?.resolve?.();
    await stopActiveDelegations();
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    adapterRegistry.agy = original;
    if (previousHostConsentEnv === undefined) delete process.env.COAGENT8_HOST_EXECUTION;
    else process.env.COAGENT8_HOST_EXECUTION = previousHostConsentEnv;
  }
});
