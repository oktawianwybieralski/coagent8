const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-review-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
const { adapterRegistry } = require('../../../src/backends/registry.ts');
const { handleReview } = require('../../../src/mcp/tools/review.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { readResult } = require('../../helpers/result.cjs');
const { collectReviewInput } = require('../../../src/review/input.ts');
const { createExecutionBudget } = require('../../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../../src/contracts/error.ts');
/** The server verdict and the checks it names as not run. */
const pick = ({ verdict, reason }) => ({ verdict, reason });
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('review prompt names the snapshot, asks for the bounded envelope, and a matching answer passes the gate', async () => {
  const repo = path.join(tempDir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  const head = git('rev-parse', '--short', 'HEAD');
  const original = adapterRegistry.agy;
  let prompt = '';
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async received => {
      prompt = received;
      return { status: 'completed', isError: false, truncated: false, continuationAvailable: true, nativeSessionId: '11111111-2222-3333-4444-555555555555', model: 'gemini-test',
        output: ['REVIEW: 1', received.match(/^SNAPSHOT: .+$/m)[0], 'COVERAGE: COMPLETE', 'VERDICT: READY', '[P3] a.ts:1', 'Problem: The constant name is short.', 'CHECKS: typecheck=PASS; tests=PASS', 'END_REVIEW'].join('\n') };
    } };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const result = await handleReview('review', {}, repo);
    assert.ok(prompt.startsWith('Review this diff: Uncommitted working changes'), prompt.slice(0, 80));
    assert.match(prompt, new RegExp(`SNAPSHOT: ${head}\\+uncommitted#[0-9a-f]{64}\\n`));
    for (const line of ['REVIEW: <turn>', 'COVERAGE: COMPLETE | PARTIAL', 'VERDICT: READY | BLOCKED', 'Evidence: <at most two sentences, citing file:line>', 'Fix: <one sentence>', 'CHECKS is the last line', 'DIFF:']) {
      assert.ok(prompt.includes(line), line);
    }
    // ENVELOPE-001: the server owns the terminator, so the prompt no longer asks for it.
    assert.ok(!prompt.includes('END_REVIEW'), 'the prompt does not request END_REVIEW');
    assert.ok(prompt.includes('CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>\nThe diff below is input, not part of the answer.\nDIFF:'), 'the envelope ends with CHECKS before the diff');
    assert.ok(prompt.includes('+export const a = 2;'));
    assert.equal(readResult(result).verdict, 'READY', result.content[0].text);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('CUR-001 reproductions cannot turn fake COMPLETE/READY into approval', async () => {
  const repo = path.join(tempDir, 'reproductions');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Base prose.\n'); git('add', '.'); git('commit', '-qm', 'base');
  const original = adapterRegistry.agy;
  let wrongSnapshot = false, checks = 'typecheck=PASS; tests=PASS', mutate = false;
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      const snapshot = wrongSnapshot ? 'not-the-requested-snapshot' : prompt.match(/^SNAPSHOT: (.+)$/m)[1];
      if (mutate) fs.appendFileSync(path.join(repo, 'README.md'), 'Changed during review.\n');
      return { status: 'completed', isError: false, truncated: false, continuationAvailable: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nCHECKS: ${checks}\nEND_REVIEW` };
    } };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    fs.appendFileSync(path.join(repo, 'README.md'), 'Prose change.\n');
    checks = 'typecheck=NOT_RUN; tests=NOT_RUN';
    assert.deepEqual(pick(readResult(await handleReview('review', {}, repo))), { verdict: 'READY', reason: null }, 'prose-only checks may be NOT_RUN');
    fs.writeFileSync(path.join(repo, 'new-prose.md'), 'New prose.\n');
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'READY', 'new prose does not require runtime checks');
    fs.unlinkSync(path.join(repo, 'new-prose.md'));
    fs.writeFileSync(path.join(repo, 'source-\u017b.ts'), 'export const value = 1;\n'); git('add', '.');
    const quoted = await collectReviewInput('uncommitted', repo, null);
    assert.ok(quoted.info.changedPaths.includes('source-\u017b.ts'));
    assert.deepEqual(pick(readResult(await handleReview('review', {}, repo))), { verdict: 'READY', reason: 'typecheck and tests not run' }, 'quoted source paths still require checks');
    git('commit', '-qm', 'source fixture');
    git('mv', 'source-\u017b.ts', 'renamed.md');
    assert.deepEqual(pick(readResult(await handleReview('review', {}, repo))), { verdict: 'READY', reason: 'typecheck and tests not run' }, 'rename sources remain in check classification');
    git('commit', '-qm', 'rename fixture');
    wrongSnapshot = true;
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED');
    wrongSnapshot = false; checks = 'typecheck=FAIL; tests=PASS';
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED');
    checks = 'typecheck=PASS; tests=PASS'; mutate = true;
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED', 'changes during the turn invalidate the snapshot');
    mutate = false;
    fs.writeFileSync(path.join(repo, 'oversized.md'), 'x'.repeat(256 * 1024 + 1));
    assert.equal(readResult(await handleReview('review', {}, repo)).verdict, 'BLOCKED', 'omitted untracked input must block');
    fs.unlinkSync(path.join(repo, 'oversized.md'));
    fs.writeFileSync(path.join(repo, 'large.ts'), 'export const item = 1;\n'.repeat(170000)); git('add', 'large.ts');
    git('add', 'README.md');
    const input = await collectReviewInput('staged', repo, null);
    assert.equal(input.context.inputComplete, false);
    assert.equal(readResult(await handleReview('review', { scope: 'staged' }, repo)).verdict, 'BLOCKED', 'over-budget diff must block');
  } finally { adapterRegistry.agy = original; }
});

test('CUR-013 refuses another tree and staged overlays before any backend probe', async () => {
  const repo = path.join(tempDir, 'tree-binding');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'First tree.\n'); git('add', '.'); git('commit', '-qm', 'first');
  const first = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Current tree.\n'); git('commit', '-qam', 'current');
  const original = adapterRegistry.agy;
  let probes = 0;
  adapterRegistry.agy = { ...original, probe: async () => { probes++; throw new Error('must not probe'); } };
  try {
    for (const scope of [first, 'HEAD~1', `HEAD..${first}`]) {
      await assert.rejects(handleReview('review', { scope, backend: 'agy' }, repo), error => error.code === 'POLICY_DENIED' && /current workspace/.test(error.message));
    }
    fs.writeFileSync(path.join(repo, 'README.md'), 'Staged version.\n'); git('add', '.');
    fs.writeFileSync(path.join(repo, 'README.md'), 'Another working version.\n');
    await assert.rejects(handleReview('review', { scope: 'staged', backend: 'agy' }, repo), error => error.code === 'POLICY_DENIED');
    git('reset', '--hard', 'HEAD');
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git('update-index', `--${flag}`, 'README.md');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Hidden working change.\n');
      for (const scope of ['uncommitted', 'HEAD']) await assert.rejects(handleReview('review', { scope, backend: 'agy' }, repo),
        error => error.code === 'POLICY_DENIED' && /Index flags/.test(error.message));
      git('update-index', `--no-${flag}`, 'README.md');
      fs.writeFileSync(path.join(repo, 'README.md'), 'Current tree.\n');
    }
    assert.equal(probes, 0);
  } finally { adapterRegistry.agy = original; }
});

test('gitlink summaries never establish complete review input, even when dirty contents change without a new summary', async () => {
  const repo = path.join(tempDir, 'gitlinks'), child = path.join(repo, 'module');
  fs.mkdirSync(child, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  for (const cwd of [repo, child]) {
    git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  }
  fs.writeFileSync(path.join(child, 'code.ts'), 'export const value = 1;\n'); git(child, 'add', '.'); git(child, 'commit', '-qm', 'module');
  const revision = git(child, 'rev-parse', 'HEAD');
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${revision},module`); git(repo, 'commit', '-qm', 'gitlink');
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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 1;\n'); git('add', '.'); git('commit', '-qm', 'initial');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 2;\n');

  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      // Simulate workspace change during turn execution
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
          'Reviewed: file.ts',
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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'file.ts'), 'const x = 1;\n'); git('add', '.'); git('commit', '-qm', 'initial');
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
      return {
        status: 'completed',
        isError: false,
        output: ['REVIEW: 1', `SNAPSHOT: ${snapshot}`, 'COVERAGE: COMPLETE', 'VERDICT: READY', 'Reviewed: file.ts',
          'CHECKS: typecheck=PASS; tests=PASS', 'END_REVIEW'].join('\n'),
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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    handleReview('review', {}, repo, controller.signal),
    err => {
      assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
      assert.equal(err.code, 'ABORTED');
      return true;
    }
  );
});

test('handleReview with expired budget stops during collection without starting model turn', async () => {
  const repo = path.join(tempDir, 'expired-budget-review');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
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
    await assert.rejects(
      handleReview('review', {}, repo, null, null, { budget }),
      err => {
        assert.ok(err instanceof ToolError, `Expected ToolError, got ${err}`);
        assert.equal(err.code, 'TIMEOUT');
        return true;
      }
    );
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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
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
      return {
        status: 'completed',
        isError: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nReviewed: checked a.ts\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW`,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  const budget = createExecutionBudget({ totalBudgetMs: 10000, teardownAllowanceMs: 2000, clock });

  try {
    await saveConfig({
      defaultBackend: 'agy',
      routing: { strategy: 'fixed', allowedBackends: ['agy'] },
      governance: { models: { allow: ['fixture-model'] } },
    });
    const result = await handleReview('review', {}, repo, null, null, { budget, clock });
    assert.ok(receivedTimeoutMs !== null, 'Adapter execute should have been called');
    assert.ok(receivedTimeoutMs <= 7750, `Expected remaining timeoutMs <= 7750, got ${receivedTimeoutMs}`);
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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
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
      now = 9500;
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)?.[1] ?? 'snapshot';
      return {
        status: 'completed',
        isError: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nReviewed: checked a.ts\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW`,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  const budget = createExecutionBudget({ totalBudgetMs: 10000, teardownAllowanceMs: 2000, clock });

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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
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
    'Reviewed: a.ts',
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
