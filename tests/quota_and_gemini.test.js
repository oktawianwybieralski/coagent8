'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { isRateLimitError, parseResetTimestamp } = require('../src/backends/rate-limit.ts');
const { classifyCodexError, extractStructuredCodexError } = require('../src/backends/codex-errors.ts');
const { parseGeminiUsage, probe: probeGemini } = require('../src/backends/gemini.adapter.ts');
const { inspectQuotas, recordQuotaCooldown, resetQuotaCooldown } = require('../src/backends/availability.ts');
const { runDoctor } = require('../src/diagnostics/doctor.ts');
const { resolveBackend } = require('../src/backends/routing.ts');
const { saveConfig, loadConfig } = require('../src/config.ts');
const { adapterRegistry } = require('../src/backends/registry.ts');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-quota-test-'));
process.env.coagent8_DIR = testDir;
process.env.coagent8_QUOTA_CACHE = path.join(testDir, 'quota-cache.json');

test.after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

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

test('codex-errors: classifies usage limit and spend cap as RATE_LIMITED', () => {
  const err1 = classifyCodexError("You've hit your usage limit. Try again later.");
  assert.equal(err1.code, 'RATE_LIMITED');
  assert.equal(err1.retryable, true);

  const err2 = classifyCodexError('Account spend cap reached.');
  assert.equal(err2.code, 'RATE_LIMITED');
  assert.equal(err2.retryable, true);

  const structErr = extractStructuredCodexError({
    error: { message: 'Daily usage limit exceeded for codex-pro' },
  });
  assert.equal(structErr.code, 'RATE_LIMITED');
});

test('gemini-adapter: parseGeminiUsage parses agy usage groups and computes bottleneck headroom', () => {
  const samplePayload = {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                remaining_fraction: 0.512,
                reset_time: '2026-10-05T17:31:49Z',
              },
              {
                id: 'gemini-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                remaining_fraction: 0.723,
                reset_time: '2026-10-05T17:35:23Z',
              },
            ],
          },
        ],
      },
    },
  };

  const quota = parseGeminiUsage(samplePayload);
  assert.ok(quota);
  assert.equal(quota.measured, true);
  assert.equal(quota.headroomPercent, 51);
  assert.equal(quota.usedPercent, 49);
  assert.equal(quota.resetsAt, '2026-10-05T17:31:49Z');
  assert.equal(quota.window, 'weekly');
  assert.equal(quota.buckets.length, 2);
});

test('doctor: runDoctor excludes exhausted/rate-limited providers from ready_backends', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = {
        ...original[id],
        inspectQuota: async () => undefined,
        probe: async () => ({
          id,
          installed: true,
          executionSupported: true,
          authStatus: 'authenticated',
          capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
        }),
      };
    }

    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'gemini'] } });

    // Mark codex as rate limited
    await recordQuotaCooldown('codex', 60000, 'Usage limit reached');

    const report = await runDoctor();
    assert.ok(!report.ready_backends.includes('codex'));
    assert.ok(report.ready_backends.includes('claude'));
    assert.ok(report.ready_backends.includes('gemini'));
    assert.ok(report.recommendations.some(r => r.includes('codex: usage limit reached or rate limited')));
  } finally {
    Object.assign(adapterRegistry, original);
  }
});

test('routing: resolveBackend auto mode is strictly read-only and does not mutate config', async () => {
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = {
        id,
        name: id,
        probe: async () => ({ installed: id === 'gemini', executionSupported: id === 'gemini' }),
        execute: async () => { throw new Error('Not executed'); },
      };
    }

    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const resolved = await resolveBackend('auto');
    assert.equal(resolved.id, 'gemini');
    assert.equal(loadConfig().defaultBackend, null); // Strictly read-only; no silent mutation!
  } finally {
    Object.assign(adapterRegistry, original);
  }
});
