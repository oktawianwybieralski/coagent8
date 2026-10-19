const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatUsage } = require('../../src/mcp/result.ts');

// AX-001g: token counts and their list-price equivalent, never counted twice, never guessed.
const price = { model: 'm', inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.5, cacheWriteUsdPerMTok: null, cacheWriteLongUsdPerMTok: null, tieredFromInputTokens: null, outputUsdPerMTok: 10, source: 'openrouter 2026-10-19' };
const known = (fields) => ({ source: 'provider', cachedInputTokens: 0, cacheWriteInputTokens: 0, ...fields });

test('AX-001g: counts show their reported parts and the list-price equivalent counts each token once', () => {
  const usage = known({ inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000, reasoningTokens: 40_000, totalTokens: 1_100_000 });
  // 400,000 uncached x 2 + 600,000 cached x 0.5 + 100,000 output (reasoning included) x 10 = 0.8 + 0.3 + 1.0
  assert.equal(formatUsage(usage, price), 'Usage: 1,000,000 input (600,000 cached) \u{b7} 100,000 output (40,000 reasoning) tokens \u{b7} list price ~2.10 USD (openrouter 2026-10-19)');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), price), 'Usage: 100 input \u{b7} 20 output tokens \u{b7} list price ~0.0004 USD (openrouter 2026-10-19)', 'explicit zero cache counts');
});

test('AX-001g: an unknown count or price shows no amount; no counts show no line', () => {
  const countsOnly = 'Usage: 100 input \u{b7} 20 output tokens';
  assert.equal(formatUsage(undefined, price), undefined);
  assert.equal(formatUsage({ source: 'provider' }, price), undefined, 'unknown is not zero');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), undefined), countsOnly, 'no exact price match');
  assert.equal(formatUsage({ source: 'provider', inputTokens: 100, outputTokens: 20 }, price), countsOnly, 'cache counts unknown');
  assert.equal(formatUsage({ source: 'provider', inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, price), countsOnly, 'cache writes unknown');
  assert.equal(formatUsage(known({ inputTokens: 100, cacheWriteInputTokens: 30, outputTokens: 20 }), price), countsOnly, 'cache writes without a list price');
  assert.equal(formatUsage(known({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 }), { ...price, cachedInputUsdPerMTok: null }),
    'Usage: 100 input (50 cached) \u{b7} 20 output tokens', 'cached input without its price');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), { ...price, outputUsdPerMTok: null }), countsOnly);
  assert.equal(formatUsage({ source: 'provider', outputTokens: 20 }, price), 'Usage: 20 output tokens', 'input unknown');
});

test('AX-001g: cache writes are priced by how long they are kept, never by a guessed kind', () => {
  // Opus 5.5 on OpenRouter: input 4, cache read 0.2, write 5 (minutes) or 8 (an hour), output 20.
  const opus = { ...price, inputUsdPerMTok: 4, cachedInputUsdPerMTok: 0.2, cacheWriteUsdPerMTok: 5, cacheWriteLongUsdPerMTok: 8, outputUsdPerMTok: 20 };
  // A Claude turn from native acceptance: 1 regular + 4,704 read + 619 written for an hour, 84 output.
  const turn = known({ inputTokens: 5324, cachedInputTokens: 4704, cacheWriteInputTokens: 619, cacheWriteLongInputTokens: 619, outputTokens: 84 });
  // 1 x 4 + 4,704 x 0.2 + 619 x 8 + 84 x 20 = 0.000004 + 0.0009408 + 0.004952 + 0.00168 = 0.0075768
  assert.equal(formatUsage(turn, opus), 'Usage: 5,324 input (4,704 cached) · 84 output tokens · list price ~0.0076 USD (openrouter 2026-10-19)');
  const split = known({ inputTokens: 1_000_000, cacheWriteInputTokens: 300_000, cacheWriteLongInputTokens: 100_000, outputTokens: 0 });
  // 700,000 x 4 + 200,000 x 5 + 100,000 x 8 = 2.8 + 1.0 + 0.8
  assert.equal(formatUsage(split, opus), 'Usage: 1,000,000 input · 0 output tokens · list price ~4.60 USD (openrouter 2026-10-19)');
  const unsplit = known({ inputTokens: 100, cacheWriteInputTokens: 30, outputTokens: 20 });
  assert.equal(formatUsage(unsplit, opus), 'Usage: 100 input · 20 output tokens', 'two kinds of writes listed, the split unknown');
  // A list with one kind of write (OpenAI, Gemini) prices unsplit writes at it: 70 x 4 + 30 x 5 + 20 x 20.
  assert.equal(formatUsage(unsplit, { ...opus, cacheWriteLongUsdPerMTok: null }), 'Usage: 100 input · 20 output tokens · list price ~0.00083 USD (openrouter 2026-10-19)');
  assert.equal(formatUsage(known({ inputTokens: 100, cacheWriteInputTokens: 30, cacheWriteLongInputTokens: 30, outputTokens: 20 }), { ...opus, cacheWriteLongUsdPerMTok: null }),
    'Usage: 100 input · 20 output tokens', 'hour-long writes without their price');
  assert.equal(formatUsage(known({ inputTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 5, outputTokens: 1 }), opus), 'Usage: 10 input (8 cached) · 1 output tokens', 'parts larger than the input');
});

test('AX-001g: from the prompt size where the list changes prices, a turn total shows no amount', () => {
  // gpt-6.1-sol on OpenRouter: other prices from 272,000 prompt tokens.
  const tiered = { ...price, tieredFromInputTokens: 272_000 };
  assert.match(formatUsage(known({ inputTokens: 271_999, outputTokens: 10 }), tiered), /list price ~/, 'no request of the turn reached the tier');
  assert.equal(formatUsage(known({ inputTokens: 529_969, cachedInputTokens: 451_456, outputTokens: 5_496 }), tiered),
    'Usage: 529,969 input (451,456 cached) · 5,496 output tokens', 'the size of each request is unknown');
  assert.equal(formatUsage(known({ inputTokens: 100, outputTokens: 20 }), { ...price, tieredFromInputTokens: 0 }), 'Usage: 100 input · 20 output tokens', 'tiers unknown');
});
