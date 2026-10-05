'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set isolated paths before importing modules
const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-test-'));
const testConfigFile = path.join(testTempDir, 'config.json');
const testQuotaCache = path.join(testTempDir, 'quota-cache.json');

process.env.coagent8_CONFIG = testConfigFile;
process.env.coagent8_QUOTA_CACHE = testQuotaCache;

const { loadConfig, saveConfig, setDefaultBackend, validateConfig } = require('../src/config.ts');
const {
  inspectQuotas,
  selectSmartQuotaBackend,
  recordQuotaCooldown,
  checkAndRecordRateLimit,
  isRateLimitError,
} = require('../src/backends/availability.ts');

test.after(() => {
  try {
    fs.rmSync(testTempDir, { recursive: true, force: true });
  } catch (_) {}
});

test('config module validates schema and persists user settings cleanly', () => {
  const initial = loadConfig();
  assert.ok(initial);
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.defaultBackend, null);

  // Set default backend
  const updated = setDefaultBackend('claude');
  assert.equal(updated.defaultBackend, 'claude');

  // Verify persistence
  const reloaded = loadConfig();
  assert.equal(reloaded.defaultBackend, 'claude');

  // Set back to smart_quota
  setDefaultBackend('smart_quota');
  assert.equal(loadConfig().defaultBackend, 'smart_quota');

  // Invalid backend rejects
  assert.throws(() => setDefaultBackend('invalid_agent_xyz'), /Validation Error/);

  // Schema validation tests
  assert.throws(() => validateConfig({ defaultBackend: 42 }), /Invalid defaultBackend/);
  assert.throws(() => validateConfig({ routing: { strategy: 'random' } }), /Invalid routing strategy/);
  assert.throws(
    () => validateConfig({ routing: { allowedBackends: 'claude' } }),
    /Invalid allowedBackends/
  );
  assert.throws(
    () => validateConfig({ routing: { allowedBackends: ['forbidden_backend'] } }),
    /Invalid entry in allowedBackends/
  );

  // Corrupted JSON in config file throws and does NOT silently reset
  fs.writeFileSync(testConfigFile, 'INVALID_JSON{[[', 'utf8');
  assert.throws(() => loadConfig(), /Configuration Error: Malformed JSON/);

  // Restore clean config
  fs.unlinkSync(testConfigFile);
});

test('quota module operates without fabricated numbers and respects exhaustion & allowlists', async () => {
  // 1. Quotas inspect with null defaults when unmeasured
  const fakeProbes = {
    codex: { installed: true },
    claude: { installed: true },
  };

  const quotas = await inspectQuotas(true, fakeProbes);
  assert.ok(quotas);
  assert.equal(quotas.codex.installed, true);
  assert.equal(quotas.claude.installed, true);
  assert.equal(quotas.codex.usedPercent, null);
  assert.equal(quotas.claude.usedPercent, null);

  // 2. Selects unblocked candidate based on preference order when unmeasured
  const selected = await selectSmartQuotaBackend(['codex', 'claude'], {
    probesOverride: fakeProbes,
    config: { routing: { allowedBackends: ['codex', 'claude'] } },
  });
  assert.equal(selected, 'codex');

  // 3. Respects allowlist filtering (e.g. only claude allowed)
  const claudeOnly = await selectSmartQuotaBackend(['codex', 'claude'], {
    probesOverride: fakeProbes,
    config: { routing: { allowedBackends: ['claude'] } },
  });
  assert.equal(claudeOnly, 'claude');

  // 4. Exhausted single backend is NOT bypassed (throws error)
  const exhaustedQuotas = {
    codex: { installed: true, status: 'rate_limited', usedPercent: 100, headroomPercent: 0 },
    claude: { installed: false, status: 'uninstalled' },
  };

  await assert.rejects(
    () =>
      selectSmartQuotaBackend(['codex'], {
        quotasOverride: exhaustedQuotas,
        config: { routing: { allowedBackends: ['codex'] } },
      }),
    /observed rate limits/
  );

  // 5. The smart_quota compatibility name uses observed signals; fabricated
  // percentages cannot override the stable executable-provider preference order.
  const measuredQuotas = {
    codex: { installed: true, status: 'operational', usedPercent: 80, headroomPercent: 20 },
    claude: { installed: true, status: 'operational', usedPercent: 30, headroomPercent: 70 },
  };

  const bestChoice = await selectSmartQuotaBackend(['codex', 'claude'], {
    quotasOverride: measuredQuotas,
    config: { routing: { allowedBackends: ['codex', 'claude'] } },
  });
  assert.equal(bestChoice, 'codex');
  const geminiBest=await selectSmartQuotaBackend(['codex','claude','gemini'],{quotasOverride:{...measuredQuotas,gemini:{installed:true,status:'operational',headroomPercent:90}},config:{routing:{allowedBackends:['codex','claude','gemini']}}});assert.equal(geminiBest,'codex');
  await Promise.all(['codex','claude','gemini'].map(id=>recordQuotaCooldown(id)));
  const concurrent=JSON.parse(fs.readFileSync(testQuotaCache,'utf8'));for(const id of ['codex','claude','gemini'])assert.equal(concurrent.data[id].status,'rate_limited');
  await Promise.all(['codex','claude','gemini'].map(id=>recordQuotaCooldown(id,-5000)));

  // 6. Runtime rate-limit error detection and cooldown recording
  const recorded = await checkAndRecordRateLimit(
    'codex',
    'OpenAI API Error: 429 Too Many Requests - rate limit exceeded for 5h window'
  );
  assert.equal(recorded, true);

  // Quota metrics remain null (unmeasured/honest) while status becomes rate_limited
  const inspectedAfterRateLimit = await inspectQuotas(true, fakeProbes);
  assert.equal(inspectedAfterRateLimit.codex.status, 'rate_limited');
  assert.equal(inspectedAfterRateLimit.codex.usedPercent, null);
  assert.ok(inspectedAfterRateLimit.codex.cooldownUntil);

  // Smart quota routing automatically skips rate-limited codex and routes to available claude
  const routedToClaude = await selectSmartQuotaBackend(['codex', 'claude'], {
    probesOverride: fakeProbes,
    config: { routing: { allowedBackends: ['codex', 'claude'] } },
  });
  assert.equal(routedToClaude, 'claude');

  // 7. Expired cooldowns are immediately sanitized to operational even in fresh cache
  await recordQuotaCooldown('codex', -5000); // Expired 5 seconds ago
  const inspectedAfterExpiry = await inspectQuotas(false, fakeProbes);
  assert.equal(inspectedAfterExpiry.codex.status, 'operational');
  assert.equal(inspectedAfterExpiry.codex.cooldownUntil, null);

  // 8. Precise rate limit matching tests
  // Negative matching: file extensions, port numbers, overloads, and model outputs discussing 429 do NOT trigger cooldown
  assert.equal(isRateLimitError('Error: file report-429.txt not found'), false);
  assert.equal(isRateLimitError('Error 429.txt: permission denied'), false);
  assert.equal(isRateLimitError('Error: unable to open status 429.txt'), false);
  assert.equal(isRateLimitError('Connection refused at 127.0.0.1:1429'), false);
  assert.equal(isRateLimitError('overloaded_error: server is currently experiencing high load'), false);
  assert.equal(isRateLimitError('{"status": 4290}'), false);
  assert.equal(isRateLimitError('{"statusCode": 42901}'), false);
  assert.equal(
    isRateLimitError(
      'Execution error (1):\nProcess crashed unexpectedly.\nPartial output:\nIn this section we will handle HTTP 429 rate limit responses gracefully.'
    ),
    false
  );

  // Mixed stderr warning + stdout 429 diagnostic is recognized
  const mixedOutput = 'warning: node memory usage high\n{"status": 429, "message": "Too Many Requests"}';
  assert.equal(isRateLimitError(mixedOutput), true);

  // Positive matching: genuine status lines, JSON errors, and usage limit messages DO trigger cooldown
  assert.equal(isRateLimitError('API Error: 429'), true);
  assert.equal(isRateLimitError('{"status": 429, "message": "Too Many Requests"}'), true);
  assert.equal(isRateLimitError("You've hit your usage limit. Try again later."), true);
  assert.equal(isRateLimitError('HTTP 429'), true);
  assert.equal(isRateLimitError('HTTP/2 429 Too Many Requests'), true);

  // 9. All-blocked error includes earliest recovery reset timestamp
  const bothRateLimited = {
    codex: { installed: true, status: 'rate_limited', cooldownUntil: '2026-10-02T23:59:00.000Z' },
    claude: { installed: true, status: 'rate_limited', cooldownUntil: '2026-10-02T23:45:00.000Z' },
  };

  await assert.rejects(
    () =>
      selectSmartQuotaBackend(['codex', 'claude'], {
        quotasOverride: bothRateLimited,
        config: { routing: { allowedBackends: ['codex', 'claude'] } },
      }),
    /Earliest recovery cooldown resets at: 2026-10-02T23:45:00.000Z/
  );
});

