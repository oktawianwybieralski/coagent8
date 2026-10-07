const { test } = require('node:test');
const assert = require('node:assert/strict');

const { StreamReducer, createStreamReducer } = require('../../src/execution/stream-reducer.ts');
const { truncateToByteLength } = require('../../src/execution/stream.ts');

test('StreamReducer manages message accumulation and terminal answer replacement', () => {
  const reducer = new StreamReducer({ maxTotalBytes: 500, maxMessageBytes: 200 });

  // 1. Delta accumulation
  reducer.upsertMessage('msg1', 'Part 1: Initial analysis. ', { delta: true });
  reducer.upsertMessage('msg1', 'Part 2: Findings confirmed.', { delta: true });
  assert.equal(reducer.getMessageMap().get('msg1'), 'Part 1: Initial analysis. Part 2: Findings confirmed.');

  // 2. Terminal answer replacement clears intermediate drafts and sets final
  reducer.setFinalAnswer('Comprehensive Final Architecture Report:\nAll 4 tasks completed.');
  assert.equal(reducer.getMessageMap().size, 1);
  assert.ok(reducer.getFormattedOutput().includes('Comprehensive Final Architecture Report'));
  assert.ok(!reducer.getFormattedOutput().includes('Initial analysis'));
});

test('StreamReducer tracks tool lifecycle', () => {
  const reducer = new StreamReducer();

  // Tool transitions
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'active'), true);
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'active'), false, 'Duplicate active ignored');
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'done'), true);
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'done'), false, 'Duplicate done ignored');

  assert.equal(reducer.getActiveTools().get('tool-1'), 'ast_grep');
  assert.ok(reducer.getFinishedTools().has('tool-1'));
});

test('strict byte budgets never exceed available space even with small budgets and multiple messages', () => {
  // Truncating with tiny budget (2 bytes) must never exceed 2 bytes
  const tiny = truncateToByteLength('Long text string', 2, '...[truncated]');
  assert.ok(Buffer.byteLength(tiny, 'utf8') <= 2);

  // Message budget of 10 bytes must strictly never exceed 10 bytes across multiple insertions & updates
  const reducer = new StreamReducer({ maxTotalBytes: 10, maxMessageBytes: 10 });
  reducer.upsertMessage('m1', 'Hello');
  assert.ok(reducer.getTotalBytes() <= 10);

  reducer.upsertMessage('m2', 'World 12345');
  assert.ok(reducer.getTotalBytes() <= 10, `Total bytes was ${reducer.getTotalBytes()}`);

  reducer.upsertMessage('m3', 'Third message overflow');
  assert.ok(reducer.getTotalBytes() <= 10, `Total bytes was ${reducer.getTotalBytes()}`);
  assert.ok(Buffer.byteLength(reducer.getFormattedOutput(), 'utf8') <= 10);
  assert.equal(reducer.isTruncated(), true);

  // Updating existing message under budget pressure
  reducer.upsertMessage('m1', 'Updated longer message text', { delta: true });
  assert.ok(reducer.getTotalBytes() <= 10, `Total bytes after delta was ${reducer.getTotalBytes()}`);
  assert.ok(Buffer.byteLength(reducer.getFormattedOutput(), 'utf8') <= 10);
});

test('tool state bounds prevent memory leaks', () => {
  const reducer = new StreamReducer({ maxTools: 5 });

  for (let i = 0; i < 20; i++) {
    reducer.recordTool(`tool-${i}`, `name-${i}`, 'active');
  }

  assert.ok(reducer.getActiveTools().size <= 5);

  // Completion-only tool events must also strictly respect maxTools: 5
  const compReducer = new StreamReducer({ maxTools: 5 });
  for (let i = 0; i < 20; i++) {
    compReducer.recordTool(`comp-tool-${i}`, `comp-name-${i}`, 'done');
  }
  assert.ok(compReducer.getActiveTools().size <= 5, `Active tools size was ${compReducer.getActiveTools().size}`);
  assert.ok(compReducer.getFinishedTools().size <= 5, `Finished tools size was ${compReducer.getFinishedTools().size}`);
});

test('joining messages under tight budget marks isTruncated true', () => {
  const reducer = new StreamReducer({ maxTotalBytes: 10, maxMessageBytes: 10 });
  reducer.upsertMessage('m1', '12345'); // 5 bytes
  reducer.upsertMessage('m2', '67890'); // 5 bytes
  assert.equal(reducer.isTruncated(), false); // individually they fit (5 + 5 = 10)
  const output = reducer.getFormattedOutput(); // joined with '\n\n' -> 12 bytes -> bounded to 10 bytes
  assert.ok(Buffer.byteLength(output, 'utf8') <= 10);
  assert.equal(reducer.isTruncated(), true, 'Joined output truncation must mark isTruncated true');
});

test('StreamReducer fast-path token streaming without full-string recomputation', () => {
  const reducer = createStreamReducer({
    maxLineBuffer: 1024,
    maxMessageBytes: 64 * 1024,
    maxTotalBytes: 128 * 1024,
  });

  // Stream 100 tokens as incremental deltas
  const tokens = ['Hello', ' ', 'world', '!', ' ', 'This', ' ', 'is', ' ', 'CoAgent8', '.'];
  for (let i = 0; i < 50; i++) {
    for (const tok of tokens) {
      reducer.upsertMessage('msg1', tok, { delta: true });
    }
  }

  const messages = reducer.getMessages();
  assert.equal(messages.length, 1);
  assert.ok(messages[0].startsWith('Hello world!'));
  assert.equal(reducer.getTotalBytes(), Buffer.byteLength(messages[0], 'utf8'));

  // Terminal answer replacement clears token trackers cleanly
  reducer.setFinalAnswer('Final authoritative answer.');
  assert.equal(reducer.getMessages().length, 1);
  assert.equal(reducer.getMessages()[0], 'Final authoritative answer.');
  assert.equal(reducer.getTotalBytes(), Buffer.byteLength('Final authoritative answer.', 'utf8'));
});

test('StreamReducer accounts for split surrogate pairs without overcounting', () => {
  const reducer = createStreamReducer({
    maxLineBuffer: 1024,
    maxMessageBytes: 8,
    maxTotalBytes: 8,
  });

  // Append high surrogate then low surrogate across separate deltas
  reducer.upsertMessage('msg1', '\uD83D', { delta: true });
  reducer.upsertMessage('msg1', '\uDE00', { delta: true });

  const messages = reducer.getMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0], '😀');
  // Full UTF-8 byte length for 😀 is exactly 4 bytes (not 6)
  assert.equal(reducer.getTotalBytes(), 4);
  assert.equal(Buffer.byteLength(messages[0], 'utf8'), 4);
});

test('a reducer without backend text returns no placeholder that could read as an answer beside a failure', () => {
  assert.equal(new StreamReducer().getFormattedOutput(), '');
});
