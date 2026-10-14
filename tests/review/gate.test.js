const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateStateEnvelopeGate } = require('../../src/review/gate.ts');
/** Server verdict for a review answer. */
const verdictOf = (output, truncated, requireEnvelope = false) => evaluateStateEnvelopeGate(output, truncated, requireEnvelope).verdict;
const { readResult } = require('../helpers/result.cjs');

test('CUR-001 rejects incomplete input, mismatched snapshots, invalid and failed checks', () => {
  const context = { expectedSnapshot: 'fixture#digest', inputComplete: true, requiredChecks: ['typecheck', 'tests'] };
  const envelope = (snapshot, checks) => `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nCHECKS: ${checks}\nEND_REVIEW`;
  for (const [snapshot, checks, binding] of [
    ['wrong', 'typecheck=PASS; tests=PASS', context],
    ['fixture#digest', 'typecheck=PASS; tests=PASS', { ...context, inputComplete: false }],
    ['fixture#digest', 'typecheck=FAIL; tests=PASS', context],
    ['fixture#digest', 'typecheck=PASS; tests=FAIL', context],
    ['fixture#digest', 'all good', context],
  ]) assert.equal(evaluateStateEnvelopeGate(envelope(snapshot, checks), false, true, binding).verdict, 'BLOCKED');
  assert.equal(evaluateStateEnvelopeGate(envelope('fixture#digest', 'typecheck=NOT_RUN; tests=NOT_RUN'), false, true,
    { ...context, requiredChecks: [] }).verdict, 'READY', 'prose checks remain honestly NOT_RUN');
});

test('a blocked verdict names every cause, the unrun checks and the reviewer reason', () => {
  const context = { expectedSnapshot: 'fixture#digest', inputComplete: true, requiredChecks: ['typecheck', 'tests'] };
  const envelope = (...extra) => ['REVIEW: 1', 'SNAPSHOT: fixture#digest', 'COVERAGE: COMPLETE', 'VERDICT: BLOCKED', ...extra, 'CHECKS: typecheck=PASS; tests=NOT_RUN', 'END_REVIEW'].join('\n');
  assert.equal(evaluateStateEnvelopeGate(envelope(), true, true, context).reason,
    'Output was truncated; Reviewer reported BLOCKED without a [P1/P2] finding or a Blocked reason');
  assert.equal(evaluateStateEnvelopeGate(envelope('Blocked: The diff omits src/review/gate.ts.'), false, true, context).reason,
    'Reviewer reported BLOCKED: The diff omits src/review/gate.ts.');
  const failed = evaluateStateEnvelopeGate(envelope().replace('typecheck=PASS', 'typecheck=FAIL').replace('VERDICT: BLOCKED', 'VERDICT: READY'), false, true, context);
  assert.equal(failed.reason, 'A reported check failed (typecheck=FAIL); the reviewer answered READY');
  assert.equal(evaluateStateEnvelopeGate('', false, true, context).reason, 'Reviewer returned no answer');
  assert.equal(evaluateStateEnvelopeGate('Looks fine to me.', false, true, context).reason, 'Answer has no State Envelope');
});

test('the review answer is shown verbatim in a code block; the server verdict and its override are in the footer', () => {
  const { formatExecutionResult } = require('../../src/mcp/result.ts');
  const answer = ['REVIEW: 1', 'SNAPSHOT: fixture#digest', 'COVERAGE: COMPLETE', 'VERDICT: READY', 'Reviewed: src/review/gate.ts verdict reasons.', 'Example: ```ts', 'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN', 'END_REVIEW'].join('\n');
  const formatted = formatExecutionResult('codex', { status: 'completed', isError: false, output: answer, truncated: false, continuationAvailable: false },
    '', null, { turn: 1, toolCount: 0, durationMs: 10, historyAvailable: false },
    { requireEnvelope: true, reviewContext: { expectedSnapshot: 'fixture#digest', inputComplete: true, requiredChecks: ['typecheck', 'tests'] } });
  const text = formatted.content[0].text;
  assert.ok(text.startsWith('````plaintext\n' + answer + '\n````\n'), "verbatim, fenced longer than the answer's own fence");
  assert.equal(readResult(formatted).answer, answer, 'the caller reads the answer unchanged inside the frame');
  assert.ok(!text.includes('VERDICT: BLOCKED'), 'the reviewer text is not rewritten');
  const { verdict, reason } = readResult(formatted);
  assert.equal(verdict, 'READY');
  assert.equal(reason, 'typecheck and tests not run');
  assert.ok(text.includes('\nVerdict: READY (typecheck and tests not run)'), 'the footer names the unrun checks');
});

test('unrun checks of a read-only reviewer do not block READY; they are named, and failures and findings still block', () => {
  const context = { expectedSnapshot: 'fixture#digest', inputComplete: true, requiredChecks: ['typecheck', 'tests'] };
  const envelope = (verdict, checks, ...extra) => ['REVIEW: 1', 'SNAPSHOT: fixture#digest', 'COVERAGE: COMPLETE', `VERDICT: ${verdict}`, ...extra, `CHECKS: ${checks}`, 'END_REVIEW'].join('\n');
  assert.deepEqual(evaluateStateEnvelopeGate(envelope('READY', 'typecheck=NOT_RUN; tests=NOT_RUN'), false, true, context),
    { verdict: 'READY', judged: true, reason: 'typecheck and tests not run' });
  assert.deepEqual(evaluateStateEnvelopeGate(envelope('READY', 'typecheck=PASS; tests=NOT_RUN'), false, true, context),
    { verdict: 'READY', judged: true, reason: 'tests not run' });
  assert.deepEqual(evaluateStateEnvelopeGate(envelope('READY', 'typecheck=PASS; tests=PASS'), false, true, context), { verdict: 'READY', judged: true });
  const withFinding = evaluateStateEnvelopeGate(envelope('READY', 'typecheck=NOT_RUN; tests=NOT_RUN', '[P2] src/review/gate.ts:1'), false, true, context);
  assert.equal(withFinding.verdict, 'BLOCKED');
  assert.equal(withFinding.reason, 'Blocker issue [P1/P2] reported; the reviewer answered READY');
  const reviewerBlocked = evaluateStateEnvelopeGate(envelope('BLOCKED', 'typecheck=NOT_RUN; tests=NOT_RUN', 'Blocked: tests are missing.'), false, true, context);
  assert.equal(reviewerBlocked.reason, 'Reviewer reported BLOCKED: tests are missing.');
  const failed = evaluateStateEnvelopeGate(envelope('READY', 'typecheck=NOT_RUN; tests=FAIL'), false, true, context);
  assert.equal(failed.reason, 'A reported check failed (tests=FAIL); the reviewer answered READY');
  const otherCause = evaluateStateEnvelopeGate(envelope('READY', 'typecheck=NOT_RUN; tests=NOT_RUN'), false, true, { ...context, inputComplete: false });
  assert.equal(otherCause.reason, 'Review input is incomplete; the reviewer answered READY');
});

test('the server blocks a READY answer if a P1 issue is reported', () => {
  const reviewOutput = [
    'REVIEW: 1',
    'SNAPSHOT: 7f8a9b',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    '',
    '[P1] src/auth.ts:42',
    'Problem: Secret key is logged to stdout without masking.',
    'Evidence: console.log(apiKey) on line 42.',
    'Fix: Replace with redactSecrets(apiKey).',
    '',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  assert.equal(verdictOf(reviewOutput, false), 'BLOCKED', 'P1 defect must block');
  assert.match(evaluateStateEnvelopeGate(reviewOutput, false).reason, /the reviewer answered READY/, 'the override of the visible READY is named');
});

test('the server blocks a READY answer if a P2 issue is reported', () => {
  const reviewOutput = [
    'REVIEW: 1',
    'SNAPSHOT: 7f8a9b',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    '',
    '[P2] src/cache.ts:18',
    'Problem: Cache entries never expire under high memory pressure.',
    'Evidence: No TTL set on Map entries.',
    'Fix: Implement LRU eviction policy.',
    '',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  assert.equal(verdictOf(reviewOutput, false), 'BLOCKED', 'P2 defect must block');
});

test('the server blocks a READY answer if the response was truncated', () => {
  const truncatedOutput = [
    'REVIEW: 1',
    'SNAPSHOT: 7f8a9b',
    'COVERAGE: PARTIAL',
    'VERDICT: READY',
    '',
    '[P3] src/index.ts:5',
    'Problem: Missing JSDoc comment.',
    'Fix: Add comment.',
  ].join('\n');

  assert.equal(verdictOf(truncatedOutput, true), 'BLOCKED', 'Truncated response must block');
});

test('the server keeps READY when only P3 (nit) is reported and not truncated', () => {
  const cleanReview = [
    'REVIEW: 1',
    'SNAPSHOT: 7f8a9b',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    '',
    '[P3] src/index.ts:5',
    'Problem: Variable naming convention preference.',
    'Evidence: const x = 1;',
    'Fix: Rename to const count = 1;',
    '',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  assert.equal(verdictOf(cleanReview, false), 'READY', 'P3-only review should stay READY');
});

test('the server verdict handles case variations, partial coverage, and missing verdicts', () => {
  // Case-insensitive verdict with P1
  const caseInsensitiveOutput = 'REVIEW: 1\nverdict: READY\n[P1] security defect\nEND_REVIEW';
  assert.equal(verdictOf(caseInsensitiveOutput, false), 'BLOCKED');

  // Partial coverage overrides READY
  const partialCoverageOutput = 'REVIEW: 1\nCOVERAGE: PARTIAL\nVERDICT: READY\nEND_REVIEW';
  assert.equal(verdictOf(partialCoverageOutput, false), 'BLOCKED');

  // Truncated envelope missing VERDICT is blocked
  const truncatedNoVerdict = 'REVIEW: 1\nSNAPSHOT: abc123\nCOVERAGE: COMPLETE\n';
  assert.equal(verdictOf(truncatedNoVerdict, true), 'BLOCKED');

  // Enveloped review without verdict is blocked
  const malformedNoVerdict = 'REVIEW: 1\nSNAPSHOT: abc123\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW';
  assert.equal(verdictOf(malformedNoVerdict, false), 'BLOCKED');

  // Incomplete envelope with VERDICT: READY alone is forced to BLOCKED
  assert.equal(verdictOf('VERDICT: READY', false), 'BLOCKED', 'VERDICT: READY alone must be BLOCKED due to missing envelope fields');

  // Bogus verdict value is forced to BLOCKED
  assert.equal(verdictOf('VERDICT: READY_BOGUS', false), 'BLOCKED', 'VERDICT: READY_BOGUS must be BLOCKED');

  // Truncated plain output with requireEnvelope is blocked
  assert.equal(verdictOf('Plain text truncated unexpectedly', true, true), 'BLOCKED', 'Truncated response with requireEnvelope must block');

  // Empty header values are forced to BLOCKED
  const emptyHeaderEnvelope = [
    'REVIEW:',
    'SNAPSHOT:',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'CHECKS:',
    'END_REVIEW',
  ].join('\n');
  assert.equal(verdictOf(emptyHeaderEnvelope, false), 'BLOCKED', 'Empty header fields must block');

  // Multi-token verdict line is forced to BLOCKED
  const multiTokenVerdict = [
    'REVIEW: 1',
    'SNAPSHOT: abc123',
    'COVERAGE: COMPLETE',
    'VERDICT: READY BLOCKED',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');
  assert.equal(verdictOf(multiTokenVerdict, false), 'BLOCKED', 'Multi-token verdict line must block');

  // END_REVIEW before other content is forced to BLOCKED
  const prematureEndReview = [
    'END_REVIEW',
    'REVIEW: 1',
    'SNAPSHOT: abc123',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'CHECKS: typecheck=PASS; tests=PASS',
  ].join('\n');
  assert.equal(verdictOf(prematureEndReview, false), 'BLOCKED', 'Premature END_REVIEW must block');

  // Non-enveloped plain output without requireEnvelope is not a review
  assert.equal(verdictOf('All systems nominal and operational.', false, false), 'NOT_APPLICABLE');
});

test('CONSULT-001 & REVIEW: READY envelope with prose containing "VERDICT: BLOCKED" evaluates to structured verdict READY', async () => {
  const { evaluateStateEnvelopeGate } = require('../../src/review/gate.ts');
  const { formatExecutionResult } = require('../../src/mcp/result.ts');
  const reviewOutput = [
    'REVIEW: 1',
    'SNAPSHOT: sha1234567890',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    '',
    '[P3] docs/README.md:10',
    'Problem: Documentation typo regarding VERDICT: BLOCKED state',
    'Evidence: Mentioning "VERDICT: BLOCKED" in documentation prose should not confuse header parsing',
    'Fix: Correct grammar',
    '',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  const evalResult = evaluateStateEnvelopeGate(reviewOutput, false, true);
  assert.equal(evalResult.verdict, 'READY', 'Quoted verdict in prose must not override header VERDICT: READY');

  const formatted = await formatExecutionResult('agy', {
    status: 'completed',
    isError: false,
    output: reviewOutput,
    truncated: false,
    continuationAvailable: false,
  }, '', null, { turn: 1, toolCount: 0, durationMs: 10, historyAvailable: false }, { requireEnvelope: true });

  const { verdict, reason } = readResult(formatted);
  assert.equal(verdict, 'READY');
  assert.equal(reason, null);
});

test('FEEDBACK-061e: returned envelope carries server turn number, ignoring model-written value', async () => {
  const { formatExecutionResult } = require('../../src/mcp/result.ts');
  const reviewOutput = [
    'REVIEW: 1',
    'SNAPSHOT: sha1234567890',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  // Turn 2 execution where model returned REVIEW: 1
  const formatted = await formatExecutionResult('codex', {
    status: 'completed',
    isError: false,
    output: reviewOutput,
    truncated: false,
    continuationAvailable: false,
  }, '', 'syn_sess_test', { turn: 2, toolCount: 0, durationMs: 10, historyAvailable: false }, { requireEnvelope: true });

  const { answer } = readResult(formatted);
  assert.match(answer, /^REVIEW: 2\r?\n/, 'envelope must carry server turn number 2');
  assert.doesNotMatch(answer, /^REVIEW: 1\r?\n/, 'model-written turn 1 must be replaced');

  // Also verify alignEnvelopeReviewTurn directly with case-insensitivity and whitespace
  const { alignEnvelopeReviewTurn } = require('../../src/review/gate.ts');
  assert.equal(alignEnvelopeReviewTurn('review: 999\nSNAPSHOT: x', 3), 'review: 3\nSNAPSHOT: x');
  assert.equal(alignEnvelopeReviewTurn('  REVIEW:  old-counter  \nSNAPSHOT: x', 4), '  REVIEW: 4\nSNAPSHOT: x');
  assert.equal(alignEnvelopeReviewTurn('plain output without envelope', 2), 'plain output without envelope');
});
