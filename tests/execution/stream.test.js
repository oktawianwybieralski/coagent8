const { test } = require('node:test');
const assert = require('node:assert/strict');

const { truncateToByteLength } = require('../../src/execution/stream-reducer.ts');

test('Phase 1 Task 1.4: truncateToByteLength truncates safely along UTF-8 multi-byte boundaries', () => {
  const polish = 'zażółć gęślą jaźń';
  const emoji = '😀🎉🚀🔥💎';

  // Never corrupts Polish characters
  for (let limit = 0; limit <= Buffer.byteLength(polish, 'utf8') + 5; limit++) {
    const truncated = truncateToByteLength(polish, limit);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= limit);
    assert.ok(!truncated.includes('\uFFFD'), `Limit ${limit} produced replacement character`);
  }

  // Never corrupts 4-byte UTF-8 emoji
  for (let limit = 0; limit <= Buffer.byteLength(emoji, 'utf8') + 5; limit++) {
    const truncated = truncateToByteLength(emoji, limit);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= limit);
    assert.ok(!truncated.includes('\uFFFD'), `Limit ${limit} produced replacement character`);
  }

  // Suffix handling
  const withSuffix = truncateToByteLength('abcdefghijklmnopqrstuvwxyz', 15, '...[trunc]');
  assert.ok(Buffer.byteLength(withSuffix, 'utf8') <= 15);
  assert.ok(withSuffix.endsWith('...[trunc]'));
});

test('Perf Optimization Area 2: truncateToByteLength handles fast-path, emoji, and large strings efficiently', () => {
  const polish = 'zażółć gęślą jaźń';
  const emoji = '😀🎉🚀🔥💎';

  // Fast-path: within budget returns unchanged
  assert.equal(truncateToByteLength(polish, 100), polish);
  assert.equal(truncateToByteLength(emoji, 100), emoji);

  // Exact bounds check without corruption
  for (let limit = 0; limit <= Buffer.byteLength(polish, 'utf8') + 5; limit++) {
    const res = truncateToByteLength(polish, limit);
    assert.ok(Buffer.byteLength(res, 'utf8') <= limit);
    assert.ok(!res.includes('\uFFFD'), `Limit ${limit} corrupted Polish character`);
  }

  for (let limit = 0; limit <= Buffer.byteLength(emoji, 'utf8') + 5; limit++) {
    const res = truncateToByteLength(emoji, limit);
    assert.ok(Buffer.byteLength(res, 'utf8') <= limit);
    assert.ok(!res.includes('\uFFFD'), `Limit ${limit} corrupted emoji sequence`);
  }

  // Large string truncation with custom suffix
  const largeText = 'CoAgent8 High-Performance Architecture '.repeat(500);
  const truncated = truncateToByteLength(largeText, 200, '...[perf]');
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 200);
  assert.ok(truncated.endsWith('...[perf]'));
});
