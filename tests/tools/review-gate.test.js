const { test } = require('node:test');
const assert = require('node:assert/strict');

const { enforceStateEnvelopeGate } = require('../../src/tools/review-gate.ts');
const { readResult } = require('../helpers/result.cjs');

test('CUR-001 rejects incomplete input, mismatched snapshots, invalid and failed or required unrun checks', () => {
  const { evaluateStateEnvelopeGate } = require('../../src/tools/review-gate.ts');
  const context = { expectedSnapshot: 'fixture#digest', inputComplete: true, requiredChecks: ['typecheck', 'tests'] };
  const envelope = (snapshot, checks) => `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nCHECKS: ${checks}\nEND_REVIEW`;
  for (const [snapshot, checks, binding] of [
    ['wrong', 'typecheck=PASS; tests=PASS', context],
    ['fixture#digest', 'typecheck=PASS; tests=PASS', { ...context, inputComplete: false }],
    ['fixture#digest', 'typecheck=FAIL; tests=PASS', context],
    ['fixture#digest', 'typecheck=PASS; tests=FAIL', context],
    ['fixture#digest', 'typecheck=NOT_RUN; tests=PASS', context],
    ['fixture#digest', 'typecheck=PASS; tests=NOT_RUN', context],
    ['fixture#digest', 'all good', context],
  ]) assert.equal(evaluateStateEnvelopeGate(envelope(snapshot, checks), false, true, binding).verdict, 'BLOCKED');
  assert.equal(evaluateStateEnvelopeGate(envelope('fixture#digest', 'typecheck=NOT_RUN; tests=NOT_RUN'), false, true,
    { ...context, requiredChecks: [] }).verdict, 'READY', 'prose checks remain honestly NOT_RUN');
});

test('enforceStateEnvelopeGate overrides VERDICT: READY to BLOCKED if P1 issue is reported', () => {
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

  const gated = enforceStateEnvelopeGate(reviewOutput, false);
  assert.ok(gated.includes('VERDICT: BLOCKED'), 'P1 defect must force VERDICT: BLOCKED');
  assert.ok(!gated.includes('VERDICT: READY'), 'VERDICT: READY must be overridden');
});

test('enforceStateEnvelopeGate overrides VERDICT: READY to BLOCKED if P2 issue is reported', () => {
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

  const gated = enforceStateEnvelopeGate(reviewOutput, false);
  assert.ok(gated.includes('VERDICT: BLOCKED'), 'P2 defect must force VERDICT: BLOCKED');
  assert.ok(!gated.includes('VERDICT: READY'), 'VERDICT: READY must be overridden');
});

test('enforceStateEnvelopeGate overrides VERDICT: READY to BLOCKED if response was truncated', () => {
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

  const gated = enforceStateEnvelopeGate(truncatedOutput, true);
  assert.ok(gated.includes('VERDICT: BLOCKED'), 'Truncated response must force VERDICT: BLOCKED');
  assert.ok(!gated.includes('VERDICT: READY'));
});

test('enforceStateEnvelopeGate preserves VERDICT: READY when only P3 (nit) is reported and not truncated', () => {
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

  const gated = enforceStateEnvelopeGate(cleanReview, false);
  assert.ok(gated.includes('VERDICT: READY'), 'P3-only review should retain VERDICT: READY');
  assert.ok(!gated.includes('VERDICT: BLOCKED'));
});

test('enforceStateEnvelopeGate handles case variations, partial coverage, and missing verdicts', () => {
  // Case-insensitive verdict with P1
  const caseInsensitiveOutput = 'REVIEW: 1\nverdict: READY\n[P1] security defect\nEND_REVIEW';
  const gatedCase = enforceStateEnvelopeGate(caseInsensitiveOutput, false);
  assert.ok(gatedCase.includes('VERDICT: BLOCKED'));
  assert.ok(!gatedCase.includes('verdict: READY'));

  // Partial coverage overrides READY
  const partialCoverageOutput = 'REVIEW: 1\nCOVERAGE: PARTIAL\nVERDICT: READY\nEND_REVIEW';
  const gatedPartial = enforceStateEnvelopeGate(partialCoverageOutput, false);
  assert.ok(gatedPartial.includes('VERDICT: BLOCKED'));
  assert.ok(!gatedPartial.includes('VERDICT: READY'));

  // Truncated envelope missing VERDICT gets BLOCKED appended
  const truncatedNoVerdict = 'REVIEW: 1\nSNAPSHOT: abc123\nCOVERAGE: COMPLETE\n';
  const gatedTruncated = enforceStateEnvelopeGate(truncatedNoVerdict, true);
  assert.ok(gatedTruncated.includes('VERDICT: BLOCKED'));

  // Enveloped review without verdict gets BLOCKED appended
  const malformedNoVerdict = 'REVIEW: 1\nSNAPSHOT: abc123\nCHECKS: typecheck=PASS; tests=PASS\nEND_REVIEW';
  const gatedMalformed = enforceStateEnvelopeGate(malformedNoVerdict, false);
  assert.ok(gatedMalformed.includes('VERDICT: BLOCKED'));

  // Incomplete envelope with VERDICT: READY alone is forced to BLOCKED
  const readyAlone = enforceStateEnvelopeGate('VERDICT: READY', false);
  assert.equal(readyAlone, 'VERDICT: BLOCKED', 'VERDICT: READY alone must be BLOCKED due to missing envelope fields');

  // Bogus verdict value is forced to BLOCKED
  const readyBogus = enforceStateEnvelopeGate('VERDICT: READY_BOGUS', false);
  assert.equal(readyBogus, 'VERDICT: BLOCKED', 'VERDICT: READY_BOGUS must be BLOCKED');

  // Truncated plain output with requireEnvelope forces VERDICT: BLOCKED
  const truncatedPlain = enforceStateEnvelopeGate('Plain text truncated unexpectedly', true, true);
  assert.ok(truncatedPlain.endsWith('VERDICT: BLOCKED'), 'Truncated response with requireEnvelope must end with VERDICT: BLOCKED');

  // Empty header values are forced to BLOCKED
  const emptyHeaderEnvelope = [
    'REVIEW:',
    'SNAPSHOT:',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'CHECKS:',
    'END_REVIEW',
  ].join('\n');
  const gatedEmptyHeaders = enforceStateEnvelopeGate(emptyHeaderEnvelope, false);
  assert.ok(gatedEmptyHeaders.includes('VERDICT: BLOCKED'), 'Empty header fields must force VERDICT: BLOCKED');

  // Multi-token verdict line is forced to BLOCKED
  const multiTokenVerdict = [
    'REVIEW: 1',
    'SNAPSHOT: abc123',
    'COVERAGE: COMPLETE',
    'VERDICT: READY BLOCKED',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');
  const gatedMultiToken = enforceStateEnvelopeGate(multiTokenVerdict, false);
  assert.ok(gatedMultiToken.includes('VERDICT: BLOCKED'), 'Multi-token verdict line must force VERDICT: BLOCKED');

  // END_REVIEW before other content is forced to BLOCKED
  const prematureEndReview = [
    'END_REVIEW',
    'REVIEW: 1',
    'SNAPSHOT: abc123',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'CHECKS: typecheck=PASS; tests=PASS',
  ].join('\n');
  const gatedPremature = enforceStateEnvelopeGate(prematureEndReview, false);
  assert.ok(gatedPremature.includes('VERDICT: BLOCKED'), 'Premature END_REVIEW must force VERDICT: BLOCKED');

  // Non-enveloped plain output without requireEnvelope is left unchanged
  const plainOutput = 'All systems nominal and operational.';
  const gatedPlain = enforceStateEnvelopeGate(plainOutput, false, false);
  assert.equal(gatedPlain, plainOutput);
});

test('CONSULT-001 & REVIEW: READY envelope with prose containing "VERDICT: BLOCKED" evaluates to structured verdict READY', async () => {
  const { evaluateStateEnvelopeGate } = require('../../src/tools/review-gate.ts');
  const { formatExecutionResult } = require('../../src/tools/result.ts');
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
