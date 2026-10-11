'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRateLimitError, parseResetTimestamp } = require('../../src/backends/rate-limit.ts');

test('rate-limit: isRateLimitError detects usage limit, hit your usage limit, and spend cap', () => {
  assert.equal(isRateLimitError("You've hit your usage limit. Try again at 2026-10-09T21:10:00.000Z."), true);
  assert.equal(isRateLimitError('Your organization has reached its spend cap.'), true);
  assert.equal(isRateLimitError('Error: usage limit reached for current model'), true);
  assert.equal(isRateLimitError('Exceeded your current quota, please check your plan.'), true);
  assert.equal(isRateLimitError('Regular compiler syntax error at line 42'), false);
});

test('rate-limit: parseResetTimestamp parses exact and relative timestamps bounded to 7 days', () => {
  const futureIso = new Date(Date.now() + 3600 * 1000).toISOString();
  const res1 = parseResetTimestamp(`You hit your usage limit. Try again at ${futureIso}.`);
  assert.ok(res1);
  assert.ok(res1.cooldownMs > 0 && res1.cooldownMs <= 3600 * 1000 + 100);

  const res2 = parseResetTimestamp('Rate limit exceeded. Try again in 2 hours, 30 minutes.');
  assert.ok(res2);
  const expectedMs = (2 * 3600 + 30 * 60) * 1000;
  assert.equal(res2.cooldownMs, expectedMs);

  const noReset = parseResetTimestamp('Random error with no time');
  assert.equal(noReset, null);
});

test('rate-limit: relative resets read milliseconds before minutes and decimal values (AUD-P2-1)', () => {
  assert.equal(parseResetTimestamp('Try again in 20ms.').cooldownMs, 20);
  assert.equal(parseResetTimestamp('Try again in 1.5s.').cooldownMs, 1500);
  assert.equal(parseResetTimestamp('Try again in 2h30m.').cooldownMs, 9000000);
  assert.equal(parseResetTimestamp('try again in 5 minutes and 3 seconds').cooldownMs, 303000);
  assert.equal(parseResetTimestamp('Try again in 3 days.').cooldownMs, 3 * 24 * 3600 * 1000);
});
