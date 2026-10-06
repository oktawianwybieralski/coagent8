const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-phase4-'));
process.env.coagent8_DIR = tempDir;

const {
  createHistoryWriter,
  sessionHistory,
  getHistory,
  getHistoryDir,
} = require('../src/sessions/history.ts');
const {
  stripAnsi,
  stripCliBanners,
  cleanCliOutput,
  enforceStateEnvelopeGate,
  formatExecutionResult,
} = require('../src/tools/common.ts');
const { createToolDefinitions, getAllCallableToolDefinitions } = require('../src/server.ts');
const { collectGitScope } = require('../src/execution/git.ts');

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// =========================================================================
// Task 4.4: Fault-Tolerant JSONL Resilience
// =========================================================================

test('Phase 4 Task 4.4: sessionHistory cleanly ignores corrupted trailing JSONL line from unexpected process crash', async () => {
  const handle = 'syn_sess_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const historyDir = getHistoryDir(tempDir);
  fs.mkdirSync(historyDir, { recursive: true });
  const file = path.join(historyDir, `${handle}.jsonl`);

  const turnId = randomUUID();
  const writer = createHistoryWriter(handle, tempDir, 'gemini', turnId);
  writer.accept({ type: 'turn_started' });
  writer.accept({ type: 'user_message', text: 'Check system health' });
  writer.accept({ type: 'assistant_message', messageId: 'msg-1', text: 'System is healthy and responsive.' });
  await writer.flush();

  // Append an abruptly truncated / partial record mimicking process crash mid-write
  fs.appendFileSync(file, '\n{"eventId":"abruptly_truncated_record_mid_write","sessionHandle":"' + handle, 'utf8');

  // sessionHistory must parse valid events without throwing or failing
  const history = await sessionHistory(handle, tempDir);
  assert.equal(history.sessionHandle, handle);
  assert.equal(history.events.length, 3);
  assert.equal(history.events[0].type, 'turn_started');
  assert.equal(history.events[1].text, 'Check system health');
  assert.equal(history.events[2].text, 'System is healthy and responsive.');

  // getHistory must also cleanly parse valid events
  const direct = await getHistory(handle);
  assert.ok(direct);
  assert.equal(direct.events.length, 3);
});

test('Phase 4 Task 4.4: subsequent append cleanly starts on newline even if previous process crashed with a torn tail', async () => {
  const handle = 'syn_sess_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const historyDir = getHistoryDir(tempDir);
  fs.mkdirSync(historyDir, { recursive: true });
  const file = path.join(historyDir, `${handle}.jsonl`);

  const turnId1 = randomUUID();
  const writer1 = createHistoryWriter(handle, tempDir, 'gemini', turnId1);
  writer1.accept({ type: 'turn_started' });
  writer1.accept({ type: 'user_message', text: 'First query' });
  await writer1.flush();

  // Emulate an incomplete write that terminated without newline
  fs.appendFileSync(file, '{"eventId":"torn_event_without_newline"', 'utf8');

  // Next turn writer appends a new batch
  const turnId2 = randomUUID();
  const writer2 = createHistoryWriter(handle, tempDir, 'gemini', turnId2);
  writer2.accept({ type: 'turn_started' });
  writer2.accept({ type: 'user_message', text: 'Second query' });
  await writer2.flush();

  // The file should cleanly repair the torn tail and include turn 2 events
  const direct = await getHistory(handle);
  assert.ok(direct);
  assert.equal(direct.events.filter(e => e.type === 'user_message').length, 2);
  assert.equal(direct.events.find(e => e.text === 'Second query')?.text, 'Second query');
});

// =========================================================================
// Task 4.4: Deterministic ANSI Escape and CLI Banner Stripping
// =========================================================================

test('Phase 4 Task 4.4: stripAnsi deterministically strips colors, cursor moves, and formatting sequences', () => {
  const coloredText = '\u001b[31mError:\u001b[0m \u001b[1;33mHigh severity\u001b[0m in \u001b[4;36mserver.ts\u001b[0m\u001b[2K\r';
  const stripped = stripAnsi(coloredText);
  assert.equal(stripped, 'Error: High severity in server.ts\r');
});

test('Phase 4 Task 4.4: stripCliBanners deterministically strips npm notices and update box banners', () => {
  const noisyOutput = [
    'npm notice New minor version of npm available! 10.8.0 -> 10.9.0',
    'npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.9.0',
    'npm notice Run npm install -g npm to update!',
    '┌──────────────────────────────────────────────┐',
    '│  A new version of codex CLI is available!    │',
    '│  Run npm i -g @openai/codex to update        │',
    '└──────────────────────────────────────────────┘',
    'REVIEW: 1',
    'SNAPSHOT: abc1234',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
  ].join('\n');

  const cleaned = cleanCliOutput(noisyOutput);
  assert.ok(!cleaned.includes('npm notice'));
  assert.ok(!cleaned.includes('A new version of codex'));
  assert.ok(cleaned.startsWith('REVIEW: 1'));
  assert.ok(cleaned.includes('VERDICT: READY'));
});

// =========================================================================
// Task 4.5: State Envelope Gate Programmatic Enforcement
// =========================================================================

test('Phase 4 Task 4.5: enforceStateEnvelopeGate overrides VERDICT: READY to BLOCKED if P1 issue is reported', () => {
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

test('Phase 4 Task 4.5: enforceStateEnvelopeGate overrides VERDICT: READY to BLOCKED if P2 issue is reported', () => {
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

test('Phase 4 Task 4.5: enforceStateEnvelopeGate overrides VERDICT: READY to BLOCKED if response was truncated', () => {
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

test('Phase 4 Task 4.5: enforceStateEnvelopeGate preserves VERDICT: READY when only P3 (nit) is reported and not truncated', () => {
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

test('Phase 4 Task 4.4: cleanCliOutput preserves Markdown table lines even with pipes and version keywords', () => {
  const tableInput = '| [P2] src/version.ts:10 | Missing version validation |';
  const cleaned = cleanCliOutput(tableInput);
  assert.equal(cleaned, '| [P2] src/version.ts:10 | Missing version validation |');
});

test('Phase 4 Task 4.5: enforceStateEnvelopeGate handles case variations, partial coverage, and missing verdicts', () => {
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

// =========================================================================
// Task 4.1: Brand & Package Verification (Zero omniagent binary)
// =========================================================================

test('Phase 4 Task 4.1: package.json has zero omniagent entry in bin and clean coagent8 release metadata', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, 'coagent8');
  assert.equal(typeof pkg.bin, 'object');
  assert.equal(pkg.bin.omniagent, undefined, 'omniagent entry must be completely purged from bin');
  assert.equal(pkg.bin.coagent8, './dist/index.cjs', 'coagent8 binary must point to dist/index.cjs');
});

test('Phase 4 Task 4.1: package-lock.json has zero omniagent entry in bin', () => {
  const lockPath = path.resolve(__dirname, '..', 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  const rootPkg = lock.packages && lock.packages[''];
  if (rootPkg && rootPkg.bin) {
    assert.equal(rootPkg.bin.omniagent, undefined, 'omniagent entry must be purged from package-lock.json bin');
  }
});
