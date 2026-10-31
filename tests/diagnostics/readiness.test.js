const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideReadiness, SUCCESS_EVIDENCE_MS } = require('../../src/diagnostics/readiness.ts');

// AX-005a: each fact decides one state, in order; unknown is never shown as failed.
const now = Date.parse('2026-10-19T12:00:00Z');
const base = {
  installed: true,
  allowed: true,
  executionSupported: true,
  readOnlyVerified: true,
  authStatus: 'unknown',
  quotaMeasuredNow: false,
};
const state = facts => decideReadiness({ ...base, ...facts }, now).state;

test('AX-005a: the decision table distinguishes every failure from an unproven sign-in', () => {
  assert.equal(state({ installed: false }), 'not_installed');
  assert.equal(state({ allowed: false, authStatus: 'authenticated' }), 'not_allowed');
  assert.equal(state({ readOnlyVerified: false, authStatus: 'authenticated' }), 'profile_unverified', 'sandbox rejection');
  assert.equal(state({ executionSupported: false }), 'profile_unverified');
  assert.equal(state({ authStatus: 'unauthenticated' }), 'signed_out', 'expired login');
  assert.equal(
    state({ authStatus: 'authenticated', quota: { status: 'rate_limited', headroomPercent: null, cooldownUntil: '2026-10-19T13:00:00Z' } }),
    'rate_limited',
  );
  assert.equal(
    state({ authStatus: 'authenticated', quota: { status: 'rate_limited', headroomPercent: null, cooldownUntil: '2026-10-19T11:00:00Z' } }),
    'ready',
    'an expired cooldown no longer limits',
  );
  assert.equal(
    state({ authStatus: 'authenticated', quota: { status: 'operational', headroomPercent: 0, resetsAt: '2026-10-20T00:00:00Z' } }),
    'quota_exhausted',
    'quota disabled or used up',
  );
  assert.equal(
    state({ authStatus: 'authenticated', quota: { status: 'rate_limited', headroomPercent: 0, cooldownUntil: null } }),
    'quota_exhausted',
    'a measured zero quota has no cooldown',
  );
  assert.equal(state({ authStatus: 'authenticated' }), 'ready');
  assert.equal(state({ quotaMeasuredNow: true }), 'ready', 'a quota measured now needs a signed-in CLI');
  assert.equal(state({}), 'sign_in_unverified', 'agy before its first turn: unknown, not failed');
});

test('AX-005b: a turn completed within a day on this installation is sign-in evidence for its model', () => {
  const recent = decideReadiness({ ...base, lastSuccess: { model: 'gemini-3.8-flash', observedAt: now - 60_000 } }, now);
  assert.equal(recent.state, 'ready');
  assert.match(recent.evidence, /A turn on gemini-3\.8-flash completed at 2026-10-19T11:59:00\.000Z on this installation\./);
  assert.deepEqual(recent.lastSuccess, { model: 'gemini-3.8-flash', at: '2026-10-19T11:59:00.000Z' });
  const old = decideReadiness({ ...base, lastSuccess: { model: 'gemini-3.8-flash', observedAt: now - SUCCESS_EVIDENCE_MS - 1 } }, now);
  assert.equal(old.state, 'sign_in_unverified', 'a day-old success no longer proves sign-in');
  assert.ok(old.lastSuccess, 'but it is still reported');
  // A success never overrides contrary evidence.
  assert.equal(
    decideReadiness({ ...base, authStatus: 'unauthenticated', lastSuccess: { model: 'm', observedAt: now } }, now).state,
    'signed_out',
  );
});
