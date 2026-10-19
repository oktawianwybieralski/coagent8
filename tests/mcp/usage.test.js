const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatUsage } = require('../../src/mcp/result.ts');

// AX-001g: token counts and their list-price equivalent, never counted twice, never guessed.
const price = { model: 'm', inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.5, outputUsdPerMTok: 10, source: 'openrouter 2026-10-19' };
const known = (fields) => ({ source: 'provider', cachedInputTokens: 0, cacheWriteInputTokens: 0, ...fields });

test('AX-001g: counts show their reported parts and the list-price equivalent counts each token once', () => {
  const usage = known({ inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000, reasoningTokens: 40_000, totalTokens: 1_100_000 });
  // 400,000 uncached x 2 + 600,000 cached x 0.5 + 100,000 output (reasoning included) x 10 = 0.8 + 0.3 + 1.0
  assert.equal(formatUsage(usage, price), 'Usage: 1,000,000 input (600,000 cached) \u{b7} 100,000 output (40,000 reasoning) tokens \u{b7} list price ~2.10 USD (openrouter 2026-10-19)');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), price), 'Usage: 100 input \u{b7} 20 output tokens \u{b7} list price ~0.0004 USD (openrouter 2026-10-19)', 'explicit zero cache counts');
});

test('AX-001g: an unknown count or price, or a cache write, shows no amount; no counts show no line', () => {
  const countsOnly = 'Usage: 100 input \u{b7} 20 output tokens';
  assert.equal(formatUsage(undefined, price), undefined);
  assert.equal(formatUsage({ source: 'provider' }, price), undefined, 'unknown is not zero');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), undefined), countsOnly, 'no exact price match');
  assert.equal(formatUsage({ source: 'provider', inputTokens: 100, outputTokens: 20 }, price), countsOnly, 'cache counts unknown');
  assert.equal(formatUsage({ source: 'provider', inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, price), countsOnly, 'cache writes unknown');
  assert.equal(formatUsage(known({ inputTokens: 100, cacheWriteInputTokens: 30, outputTokens: 20 }), price), countsOnly, 'cache writes have no list price');
  assert.equal(formatUsage(known({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 }), { ...price, cachedInputUsdPerMTok: null }),
    'Usage: 100 input (50 cached) \u{b7} 20 output tokens', 'cached input without its price');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), { ...price, outputUsdPerMTok: null }), countsOnly);
  assert.equal(formatUsage({ source: 'provider', outputTokens: 20 }, price), 'Usage: 20 output tokens', 'input unknown');
});
