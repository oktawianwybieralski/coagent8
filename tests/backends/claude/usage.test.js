const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeUsage, resolveUsageReset } = require('../../../src/backends/claude/usage.ts');
const { summarizeQuotaWindows } = require('../../../src/backends/quota.ts');
const recorded = require('../../fixtures/claude-cli/recordings/usage-subscription.json');

// 2026-10-05 18:55 UTC = 14:55 in America/New_York (EDT, UTC-4).
const NOW = Date.UTC(2026, 9, 5, 18, 55);

test('Claude /usage parser reads the recorded session and weekly limits and picks the bottleneck', () => {
  const quota = parseClaudeUsage(recorded.result, NOW);
  assert.equal(quota.measured, true);
  assert.equal(quota.usedPercent, 40);
  assert.equal(quota.headroomPercent, 60);
  assert.equal(quota.window, 'session');
  assert.equal(quota.resetsAt, '2026-10-05T23:20:00.000Z');
  assert.deepEqual(quota.buckets.map(b => [b.id, b.window, b.remainingFraction, b.resetTime]),
    [['session', 'session', 0.6, '2026-10-05T23:20:00.000Z'], ['week', 'weekly', 0.85, '2026-10-06T18:15:00.000Z']]);
});

test('Claude /usage parser ignores model-specific weekly limits, API billing text and malformed lines', () => {
  const text = 'Current session: 10% used · resets 9:30pm (America/New_York)\nCurrent week (Opus): 100% used · resets Oct 9, 1:00am (America/New_York)\nCurrent week (all models): 140% used';
  const quota = parseClaudeUsage(text, NOW);
  assert.deepEqual(quota.buckets.map(b => b.id), ['session']);
  assert.equal(quota.headroomPercent, 90);
  assert.equal(parseClaudeUsage('You are currently using API billing.', NOW), undefined);
  assert.equal(parseClaudeUsage('The model said: Current session: 50% used', NOW), undefined, 'lines must be anchored');
});

test('Claude /usage reset labels resolve across time zones, missing dates and year boundaries', () => {
  assert.equal(resolveUsageReset('9:30pm', 'America/New_York', NOW), '2026-10-06T01:30:00.000Z');
  assert.equal(resolveUsageReset('8:00am', 'America/New_York', NOW), '2026-10-06T12:00:00.000Z', 'a past time without a date is tomorrow');
  assert.equal(resolveUsageReset('Jan 2, 12am', 'America/New_York', Date.UTC(2026, 11, 30)), '2027-01-02T05:00:00.000Z');
  assert.equal(resolveUsageReset('Oct 6, 2:15pm', 'Not/A_Zone', NOW), null);
  assert.equal(resolveUsageReset('tomorrow', 'America/New_York', NOW), null);
});

test('Quota summary is shared: empty input is unmeasured and headroom is bounded', () => {
  assert.equal(summarizeQuotaWindows([]), undefined);
  const quota = summarizeQuotaWindows([{ id: 'a', name: 'A', window: '5h', remainingFraction: 1.2, resetTime: '' }]);
  assert.equal(quota.headroomPercent, 100);
  assert.equal(quota.resetsAt, null);
});
