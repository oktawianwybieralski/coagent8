const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// DELEGATE-001f2: the server-owned loop. Checks run for real; the turns and the review are stubbed
// where the loop is tested alone, and go through the Codex fixture end to end.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-loop-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
process.env.CODEX_PATH = path.resolve(__dirname, '../../fixtures/codex-cli/codex.cjs');
process.env.CODEX_CONFIG_PATH = path.join(tempDir, 'config.toml');
const { parseCheckCommand, approveChecks, runCheck } = require('../../../src/execution/checks.ts');
const { superviseChange, reviewOnAnotherBackend, LOOP_FIX_ROUNDS } = require('../../../src/execution/loop.ts');
const { handleDelegate, getCanonicalDelegateToolDefinition } = require('../../../src/mcp/tools/delegate.tool.ts');
const { executeDelegation } = require('../../../src/execution/delegation.ts');
const { createExecutionBudget } = require('../../../src/execution/runtime/budget.ts');
const { ToolError } = require('../../../src/contracts/error.ts');

const node = JSON.stringify(process.execPath);
const PASS = `${node} -e "process.exit(0)"`;
const FAIL = `${node} -e "console.error('it broke');process.exitCode=3"`;

const workerResult = (status = 'completed') => ({
  isError: status !== 'completed',
  provider: 'codex',
  result: { status, isError: status !== 'completed', output: 'done', model: 'm' },
  sessionHandle: 'worker',
  meta: {},
  warnings: [],
});
const reviewResult = (verdict, output = '') => ({
  ...workerResult(),
  provider: 'claude',
  sessionHandle: 'reviewer',
  result: { status: 'completed', isError: false, output, model: 'r' },
  review: { verdict },
});
const FINDING = 'VERDICT: BLOCKED\n[P1] a.ts:1\nProblem: wrong\nEvidence: a.ts:1\nFix: do it\nCHECKS: typecheck=NOT_RUN; tests=NOT_RUN';

function steps(overrides = {}) {
  const calls = { fix: [], review: 0 };
  return {
    calls,
    steps: {
      checks: [],
      cwd: tempDir,
      signal: null,
      remainingMs: () => 60000,
      fix: async prompt => {
        calls.fix.push(prompt);
        return workerResult();
      },
      review: async () => {
        calls.review++;
        return reviewResult('READY');
      },
      ...overrides,
    },
  };
}

test('a check is a command with arguments, without a shell', () => {
  assert.deepEqual(parseCheckCommand('npm test'), ['npm', 'test']);
  assert.deepEqual(parseCheckCommand(`node -e "a b" 'c d' e""`), ['node', '-e', 'a b', 'c d', 'e']);
  assert.deepEqual(parseCheckCommand('a "|" b'), ['a', '|', 'b'], 'a quoted operator is an argument');
  for (const bad of ['a && b', 'a | b', 'a; b', 'a > f', 'echo $HOME', 'echo `x`', 'a (b)', '"open', '   ']) {
    assert.throws(
      () => parseCheckCommand(bad),
      err => err.code === 'INPUT_LIMIT',
      bad,
    );
  }
});

test('only the user allows a check: the exact configured entry or the form', async () => {
  await approveChecks(['npm test'], ['npm test'], undefined, null);
  await assert.rejects(approveChecks(['npm test --x'], ['npm test'], undefined, null), err => {
    assert.equal(err.code, 'POLICY_DENIED');
    assert.match(err.message, /allowedChecks/);
    return true;
  });
  await assert.rejects(
    approveChecks(['npm test'], [], async () => false, null),
    err => err.code === 'POLICY_DENIED' && /did not approve/.test(err.message),
  );
  const asked = [];
  await approveChecks(
    ['a', 'b'],
    ['a'],
    async checks => {
      asked.push(...checks);
      return true;
    },
    null,
  );
  assert.deepEqual(asked, ['b'], 'the form lists only what is not allowed yet');
});

test('a check reports its exit, the end of its output, and a start that failed', async () => {
  const passed = await runCheck(PASS, tempDir, null, 60000);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.exitCode, 0);
  const failed = await runCheck(FAIL, tempDir, null, 60000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 3);
  assert.match(failed.tail, /it broke/);
  const long = await runCheck(`${node} -e "for(let i=0;i<5000;i++)console.log('line '+i)"`, tempDir, null, 60000);
  assert.match(long.tail, /line 4999/, 'the tail, not the head');
  assert.doesNotMatch(long.tail, /line 0\n/);
  const missing = await runCheck('coagent8-no-such-command-x', tempDir, null, 60000);
  assert.notEqual(missing.status, 'passed');
});

test('the output of a check is redacted before it is cut', async () => {
  const script = [
    "console.log('-----BEGIN RSA PRIVATE KEY-----');",
    "for (let i = 0; i < 3000; i++) console.log('c2VjcmV0'.repeat(9));",
    "console.log('-----END RSA PRIVATE KEY-----');",
    "console.log('after the key');",
    'process.exitCode = 1;',
  ].join('');
  const file = path.join(tempDir, 'leaky.js');
  fs.writeFileSync(file, script);
  const leaky = await runCheck(`${node} ${JSON.stringify(file)}`, tempDir, null, 60000);
  assert.equal(leaky.status, 'failed');
  assert.doesNotMatch(leaky.tail, /c2VjcmV0/);
  assert.match(leaky.tail, /after the key/);
});

test('the end of a very long output line stays', async () => {
  const file = path.join(tempDir, 'long-line.js');
  fs.writeFileSync(file, "console.log('x'.repeat(20000) + ' the real failure');process.exitCode = 1;");
  const long = await runCheck(`${node} ${JSON.stringify(file)}`, tempDir, null, 60000);
  assert.match(long.tail, /the real failure/);
});

test('a spent budget is a timeout before the check starts', async () => {
  const spent = await runCheck(PASS, tempDir, null, 0);
  assert.equal(spent.status, 'timed_out');
  assert.equal(spent.durationMs, 0);
});

test('a check that outlives its budget is timed out', async () => {
  const slow = await runCheck(`${node} -e "setTimeout(()=>{},30000)"`, tempDir, null, 300);
  assert.equal(slow.status, 'timed_out');
});

test('passing checks and a READY review end the loop without a fix round', async () => {
  const { calls, steps: s } = steps({ checks: [PASS, PASS] });
  const result = await superviseChange(workerResult(), s);
  assert.equal(result.loop.outcome, 'passed');
  assert.equal(result.loop.fixRounds, 0);
  assert.equal(result.loop.checks.length, 2);
  assert.equal(result.loop.review.verdict, 'READY');
  assert.equal(result.loop.review.sessionHandle, 'reviewer');
  assert.equal(calls.review, 1);
  assert.equal(calls.fix.length, 0);
});

test('a failed check goes back to the worker, stops later checks, and runs again after the fix', async () => {
  const marker = path.join(tempDir, 'fixed');
  const flaky = `${node} -e "process.exit(require('fs').existsSync(${JSON.stringify(marker).replaceAll('"', "'")})?0:3)"`;
  const { calls, steps: s } = steps({
    checks: [flaky, PASS],
    fix: async prompt => {
      calls.fix.push(prompt);
      fs.writeFileSync(marker, '');
      return workerResult();
    },
  });
  const calledFix = s.fix;
  const result = await superviseChange(workerResult(), { ...s, fix: calledFix });
  assert.equal(result.loop.outcome, 'passed');
  assert.equal(result.loop.fixRounds, 1);
  assert.equal(result.loop.checks.length, 2, 'the evidence is of the last round');
  assert.match(calls.fix[0], /FIX ROUND 1/);
  assert.match(calls.fix[0], /exit 3/);
  assert.equal(calls.review, 1, 'no review of a change whose checks fail');
});

test('the fix rounds are bounded and the failure is the outcome', async () => {
  const { calls, steps: s } = steps({ checks: [FAIL] });
  const result = await superviseChange(workerResult(), s);
  assert.equal(result.loop.outcome, 'checks_failed');
  assert.equal(calls.fix.length, LOOP_FIX_ROUNDS);
  assert.equal(calls.review, 0);
  assert.match(result.loop.checks[0].tail, /it broke/);
});

test('review findings go back to the worker, and checks and review run again', async () => {
  let reviews = 0;
  const { calls, steps: s } = steps({
    review: async () => (++reviews === 1 ? reviewResult('BLOCKED', FINDING) : reviewResult('READY')),
  });
  const result = await superviseChange(workerResult(), s);
  assert.equal(result.loop.outcome, 'passed');
  assert.equal(result.loop.fixRounds, 1);
  assert.match(calls.fix[0], /\[P1\] a\.ts:1/);
  assert.doesNotMatch(calls.fix[0], /^CHECKS:/m);
  assert.equal(reviews, 2);
});

test('the report holds only the evidence of the last round', async () => {
  let runs = 0;
  const marker = path.join(tempDir, 'broken');
  const check = `${node} -e "process.exit(require('fs').existsSync(${JSON.stringify(marker).replaceAll('"', "'")})?3:0)"`;
  const { steps: s } = steps({
    checks: [check],
    review: async () => {
      runs++;
      return reviewResult('BLOCKED', FINDING);
    },
    fix: async () => {
      fs.writeFileSync(marker, '');
      return workerResult();
    },
  });
  const result = await superviseChange(workerResult(), s);
  assert.equal(runs, 1);
  assert.equal(result.loop.outcome, 'checks_failed');
  assert.equal(result.loop.review, undefined, 'the earlier verdict is of a change that is gone');
});

test('a review block without a finding ends the loop, since the worker has nothing to fix', async () => {
  const { calls, steps: s } = steps({ review: async () => reviewResult('BLOCKED', 'VERDICT: BLOCKED\nBlocked: partial coverage') });
  const result = await superviseChange(workerResult(), s);
  assert.equal(result.loop.outcome, 'review_blocked');
  assert.equal(calls.fix.length, 0);
});

test('a model that needs approval ends the loop as needs_input and keeps the last result', async () => {
  const denied = async () => {
    throw new ToolError('POLICY_DENIED', 'needs approval');
  };
  let result = await superviseChange(workerResult(), steps({ review: denied }).steps);
  assert.equal(result.loop.outcome, 'needs_input');
  assert.equal(result.result.status, 'completed');
  result = await superviseChange(workerResult(), steps({ checks: [FAIL], fix: denied }).steps);
  assert.equal(result.loop.outcome, 'needs_input');
  assert.match(result.loop.detail, /needs approval/);
});

test('a stopped worker turn ends the loop the same way, and a failed fix turn leaves no old evidence', async () => {
  for (const status of ['cancelled', 'timed_out']) {
    const result = await superviseChange(workerResult(status), steps().steps);
    assert.equal(result.loop.outcome, status);
  }
  const { steps: s } = steps({
    checks: [FAIL],
    fix: async () => workerResult('failed'),
  });
  const result = await superviseChange(workerResult(), s);
  assert.equal(result.loop.outcome, 'worker_failed');
  assert.deepEqual(result.loop.checks, [], 'that check saw a change the failed turn may have altered');
});

test('a failed worker turn stops the loop, and so does a broken review', async () => {
  const { calls, steps: s } = steps({ checks: [PASS] });
  let result = await superviseChange(workerResult('failed'), s);
  assert.equal(result.loop.outcome, 'worker_failed');
  assert.equal(result.loop.checks.length, 0);
  assert.equal(calls.review, 0);
  result = await superviseChange(
    workerResult(),
    steps({
      review: async () => {
        throw new Error('no reviewer');
      },
    }).steps,
  );
  assert.equal(result.loop.outcome, 'review_failed');
});

test('a review moves on from a backend out of quota, never to the writer', async () => {
  const limited = { ...reviewResult('BLOCKED'), result: { status: 'failed', error: { code: 'RATE_LIMITED' } } };
  const order = ['agy', 'claude'];
  const seen = [];
  const pick = async excluded => {
    assert.ok(excluded.has('codex'), 'the writer does not review');
    const next = order.find(id => !excluded.has(id));
    if (!next) throw new ToolError('CLI_NOT_FOUND', 'none left');
    return next;
  };
  const reviewed = await reviewOnAnotherBackend('codex', pick, async backend => {
    seen.push(backend);
    return backend === 'agy' ? limited : reviewResult('READY');
  });
  assert.deepEqual(seen, ['agy', 'claude']);
  assert.equal(reviewed.review.verdict, 'READY');
  assert.equal(await reviewOnAnotherBackend('codex', pick, async () => limited), limited, 'with none left, the limit is the answer');
  await assert.rejects(
    reviewOnAnotherBackend(
      'codex',
      async () => {
        throw new ToolError('CLI_NOT_FOUND', 'no other CLI');
      },
      async () => limited,
    ),
    /no other CLI/,
  );
});

test('cancellation while choosing the next reviewer is not reported as a quota failure', async () => {
  const limited = { ...reviewResult('BLOCKED'), result: { status: 'failed', error: { code: 'RATE_LIMITED' } } };
  let picks = 0;
  await assert.rejects(
    reviewOnAnotherBackend(
      'codex',
      async () => {
        if (++picks > 1) throw new ToolError('ABORTED', 'stopped');
        return 'agy';
      },
      async () => limited,
    ),
    err => err.code === 'ABORTED',
  );
});

test('cancellation during a check ends the task as cancelled', async () => {
  const controller = new AbortController();
  const running = superviseChange(
    workerResult(),
    steps({ checks: [`${node} -e "setTimeout(()=>{},30000)"`], signal: controller.signal }).steps,
  );
  setTimeout(() => controller.abort(), 200);
  const result = await running;
  assert.equal(result.loop.outcome, 'cancelled');
  assert.equal(result.result.status, 'cancelled');
  assert.equal(result.isError, true);
});

function fixtureRepo() {
  const repo = fs.mkdtempSync(path.join(tempDir, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return repo;
}
const approve = { askConsent: async () => ({ approved: true, remember: false }) };
const MODEL = 'gpt-6.1-sol';

test('the tool refuses a check before any turn when the user cannot approve it', async () => {
  const repo = fixtureRepo();
  await assert.rejects(
    handleDelegate(
      { task: 'Change it', backend: 'codex', model: MODEL, loop: true, checks: ['npm test'], mode: 'sync' },
      repo,
      null,
      null,
      approve,
    ),
    err => err.code === 'POLICY_DENIED' && /allowedChecks/.test(err.message),
  );
  await assert.rejects(
    handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL, loop: true, checks: ['a && b'], mode: 'sync' }, repo, null, null, {
      ...approve,
      askChecks: async () => true,
    }),
    err => err.code === 'INPUT_LIMIT',
  );
  assert.equal(fs.existsSync(path.join(repo, '.git', 'coagent8-writer.json')), false, 'no writer slot was taken');
});

test('the tool reports the loop apart from the worker, and a failed check is not a passed change', async () => {
  const repo = fixtureRepo();
  const asked = [];
  const result = await handleDelegate(
    { task: 'Change it', backend: 'codex', model: MODEL, loop: true, checks: [FAIL], mode: 'sync' },
    repo,
    null,
    null,
    {
      ...approve,
      askChecks: async checks => {
        asked.push(...checks);
        return true;
      },
    },
  );
  const text = result.content.map(part => part.text).join('\n');
  assert.deepEqual(asked, [FAIL]);
  assert.match(text, /Loop by CoAgent8: checks_failed, 2 fix round\(s\)\./);
  assert.match(text, /it broke/);
  assert.match(text, /Review: not run\./);
  assert.match(text, /Observed by CoAgent8/);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'coagent8-writer.json')), false, 'the writer is released at the end');
});

test('a later turn has its own time limit, also without a limit on the task', async () => {
  const repo = fixtureRepo();
  let stopped;
  const started = Date.now();
  try {
    await executeDelegation('Change it', 'Change it', { backend: 'codex', model: MODEL }, repo, [], null, null, {
      ...approve,
      requireEnvelope: false,
      loopTurnMs: 1500,
      supervise: async (first, turn) => {
        process.env.CODEX_FIXTURE_MODE = 'interruptible';
        stopped = await turn.fix('Now hang');
        return stopped;
      },
    });
  } finally {
    delete process.env.CODEX_FIXTURE_MODE;
  }
  assert.equal(stopped.result.status, 'timed_out');
  assert.ok(Date.now() - started < 30000);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'coagent8-writer.json')), false);
});

test('a task budget spent before a fix turn ends the task as timed out', async () => {
  const repo = fixtureRepo();
  const budget = createExecutionBudget({ totalBudgetMs: 120000 });
  const context = { abortSignal: budget.executionSignal, budget, timeoutMs: budget.remainingExecutionMs() };
  try {
    const result = await executeDelegation('Change it', 'Change it', { backend: 'codex', model: MODEL }, repo, [], null, null, {
      ...approve,
      requireEnvelope: false,
      budget,
      context,
      supervise: (first, turn) => {
        // What the worker's first turn left: nothing.
        budget.remainingExecutionMs = () => 0;
        return superviseChange(first, {
          checks: [FAIL],
          cwd: repo,
          signal: turn.signal,
          remainingMs: () => 60000,
          fix: turn.fix,
          review: async () => reviewResult('READY'),
        });
      },
    });
    assert.equal(result.loop.outcome, 'timed_out');
    assert.equal(result.result.status, 'timed_out');
    assert.equal(result.isError, true);
    assert.equal(result.loop.fixRounds, 0);
  } finally {
    budget.dispose();
  }
  assert.equal(fs.existsSync(path.join(repo, '.git', 'coagent8-writer.json')), false);
});

test('the tool definition offers the loop', () => {
  assert.equal(getCanonicalDelegateToolDefinition().inputSchema.properties.loop.type, 'boolean');
});
