'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-diagnostics-doctor-'));
process.env.coagent8_DIR = tempDir;

const { runDoctor } = require('../../src/diagnostics/doctor.ts');
const { recordQuotaCooldown } = require('../../src/backends/availability.ts');
const { saveConfig } = require('../../src/config.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');

process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'quota-cache.json');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('runDoctor returns structured diagnostic report for all three CLIs', async () => {
  const report = await runDoctor();

  assert.ok(report);
  assert.ok(['operational', 'partially_configured', 'degraded_no_active_backends'].includes(report.status));
  assert.ok(Array.isArray(report.active_backends));
  assert.equal(report.security_policy, undefined, 'no hardcoded policy claims (AUD-P2-8)');

  // Backends
  assert.ok(report.backends.codex);
  assert.ok(report.backends.claude);
  assert.ok(report.backends.gemini);

  assert.equal(report.backends.codex.id, 'codex');
  assert.equal(report.backends.claude.id, 'claude');
  assert.equal(report.backends.gemini.id, 'gemini');

  // Verify recommendations exist if any backend is missing
  if (!report.backends.codex.installed || !report.backends.claude.installed || !report.backends.gemini.installed) {
    assert.ok(report.recommendations.length > 0);
  }
});

test('doctor does not classify installation and unverified authentication evidence as ready', async () => {
  const { adapterRegistry } = require('../../src/backends/registry.ts');
  const original = { ...adapterRegistry };
  try {
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = { ...original[id], inspectQuota: async () => undefined, probe: async () => ({ id, installed: true, executionSupported: true,
        authStatus: 'unknown', authEvidence: ['Synthetic auth file present (not verified)'],
        capabilities: { readOnlyVerified: true, resume: false, streaming: false, reasoningEffort: false } }) };
    }
    const report = await runDoctor();
    assert.deepEqual(report.ready_backends, []);
    assert.equal(report.status, 'partially_configured');
    // A quota the CLI itself measured (agy and Claude `/usage`) proves a signed-in CLI.
    adapterRegistry.gemini.inspectQuota = async () => ({ measured: true, headroomPercent: 40, usedPercent: 60, window: 'weekly', resetsAt: null });
    assert.deepEqual((await runDoctor()).ready_backends, ['gemini']);
  } finally { Object.assign(adapterRegistry, original); }
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

test('doctor summary is a few lines, backend filter keeps other cached quotas, full report has quotas once', async () => {
  const { formatDoctorSummary } = require('../../src/diagnostics/doctor.ts');
  const { inspectQuotas } = require('../../src/backends/availability.ts');
  const { handleDoctor } = require('../../src/tools/doctor.tool.ts');
  const original = { ...adapterRegistry };
  const quotaReads = [];
  const quotaCache = process.env.coagent8_QUOTA_CACHE;
  process.env.coagent8_QUOTA_CACHE = path.join(tempDir, 'doctor-summary-quota-cache.json');
  try {
    for (const id of ['codex', 'claude', 'gemini']) {
      adapterRegistry[id] = {
        ...original[id],
        inspectQuota: async () => { quotaReads.push(id); return { measured: true, window: '5h', usedPercent: 40, headroomPercent: 60, resetsAt: '2026-10-07T12:00:00Z' }; },
        probe: async () => ({
          id, installed: true, version: `${id} 1.0.0`, executionSupported: true, authStatus: 'authenticated',
          config: { defaultModel: `${id}-model` }, availableModels: Array.from({ length: 14 }, (_, i) => `${id}-model-${i}`),
          capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
          ...(id === 'gemini' ? { quota: { measured: true, window: 'weekly', usedPercent: 19, headroomPercent: 81, resetsAt: '2026-10-12T17:31:49Z',
            buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.81, resetTime: '2026-10-12T17:31:49Z' }] } } : {}),
        }),
      };
    }
    saveConfig({ defaultBackend: null, routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'gemini'] } });

    const report = await runDoctor();
    const summary = formatDoctorSummary(report);
    assert.equal(summary.split('\n').length, 4, summary);
    assert.match(summary, /^CoAgent8 doctor: operational · default backend: auto/);
    assert.match(summary, /claude: ready · claude 1\.0\.0 · model claude-model · 5h 60% left, resets 2026-10-07T12:00:00Z/);
    assert.match(summary, /gemini: ready · gemini 1\.0\.0 · model gemini-model · weekly 81% left/);
    assert.ok(Buffer.byteLength(summary) < 1024, 'summary budget 1 KB');

    assert.equal(report.backends.gemini.quota, undefined, 'quota reported once, under quotas');
    assert.equal(report.quotas.gemini.buckets.length, 1);

    quotaReads.length = 0;
    const claudeOnly = await runDoctor({ backend: 'claude', quota: false });
    assert.deepEqual(Object.keys(claudeOnly.backends), ['claude']);
    assert.deepEqual(quotaReads, [], 'quota: false skips native quota reads');
    const cache = await inspectQuotas(false);
    assert.equal(cache.codex.installed, true, 'a filtered doctor keeps the other providers cached');
    assert.equal(cache.gemini.installed, true);

    const summaryResult = await handleDoctor({});
    assert.equal(summaryResult.structuredContent, undefined);
    const full = await handleDoctor({ detail: 'full', backend: 'gemini' });
    assert.deepEqual(JSON.parse(full.content[0].text), full.structuredContent);
    assert.deepEqual(Object.keys(full.structuredContent.backends), ['gemini']);
  } finally {
    process.env.coagent8_QUOTA_CACHE = quotaCache;
    Object.assign(adapterRegistry, original);
  }
});
