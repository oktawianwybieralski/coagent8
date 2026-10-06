const { test } = require('node:test');
const assert = require('node:assert/strict');

const { StreamReducer, createStreamReducer } = require('../../src/execution/stream-reducer.ts');
const { truncateToByteLength } = require('../../src/execution/stream.ts');

test('StreamReducer preserves record boundaries, handles streaming chunks, and flushes cleanly', () => {
  const reducer = createStreamReducer({ maxLineBuffer: 1024 });
  const lines = [];

  // Split chunk across boundary
  reducer.pushChunk('{"type":"start"', l => lines.push(l));
  assert.equal(lines.length, 0, 'No complete line yet');

  reducer.pushChunk('}\n{"type":"step"}\n', l => lines.push(l));
  assert.equal(lines.length, 2, 'Two complete lines received');
  assert.equal(lines[0], '{"type":"start"}');
  assert.equal(lines[1], '{"type":"step"}');

  // Incomplete fragment flushed at end
  reducer.pushChunk('{"type":"end"}', l => lines.push(l));
  assert.equal(lines.length, 2);
  reducer.flush(l => lines.push(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '{"type":"end"}');
});

test('StreamReducer safely discards oversized records without breaking JSONL boundaries', () => {
  const reducer = new StreamReducer({ maxLineBuffer: 256 });
  const lines = [];

  // Valid small record
  reducer.pushChunk('{"id":1}\n', l => lines.push(l));
  assert.equal(lines.length, 1);

  // Oversized record exceeding 256 bytes without newline
  reducer.pushChunk('{"huge":"' + 'X'.repeat(500) + '"}');
  assert.equal(reducer.hasOversizedLine(), true);

  // Newline terminates the discarded record; next record is valid
  reducer.pushChunk('\n{"id":2}\n', l => lines.push(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"id":1}');
  assert.equal(lines[1], '{"id":2}');
});

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

test('StreamReducer tracks activity progress and tool lifecycle', () => {
  const activities = [];
  const reducer = new StreamReducer({
    onProgress: act => activities.push(act),
  });

  reducer.recordActivity('Scanning AST nodes...');
  reducer.recordActivity('Running verification matrix...');
  assert.deepEqual(activities, ['Scanning AST nodes...', 'Running verification matrix...']);

  // Tool transitions
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'active'), true);
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'active'), false, 'Duplicate active ignored');
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'done'), true);
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'done'), false, 'Duplicate done ignored');

  assert.equal(reducer.getActiveTools().get('tool-1'), 'ast_grep');
  assert.ok(reducer.getFinishedTools().has('tool-1'));
});

test('StreamReducer handles multi-byte UTF-8 split across chunk buffers without corruption', () => {
  const reducer = new StreamReducer();
  const lines = [];

  // 4-byte emoji 😀 is 0xF0 0x9F 0x98 0x80
  const emojiBytes = Buffer.from('😀\n', 'utf8');
  assert.equal(emojiBytes.length, 5);

  // Split emoji across two chunks: 2 bytes in chunk 1, remaining 3 bytes in chunk 2
  reducer.pushChunk(emojiBytes.subarray(0, 2), l => lines.push(l));
  assert.equal(lines.length, 0);

  reducer.pushChunk(emojiBytes.subarray(2), l => lines.push(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '😀');
  assert.ok(!lines[0].includes('\uFFFD'), 'Must not produce replacement characters');
});

test('records containing a newline or trailing fragments strictly enforce maxLineBuffer', () => {
  const reducer = new StreamReducer({ maxLineBuffer: 20 });
  const lines = [];

  // A 40-byte record arriving with a newline in a single chunk must be discarded
  const oversizedChunk = 'X'.repeat(40) + '\nvalid\n';
  reducer.pushChunk(oversizedChunk, l => lines.push(l));

  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'valid');
  assert.equal(reducer.hasOversizedLine(), true);

  // An oversized trailing fragment must be discarded on flush
  reducer.pushChunk('Y'.repeat(30));
  reducer.flush(l => lines.push(l));
  assert.equal(lines.length, 1, 'Trailing oversized fragment must not be emitted');
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

test('activity and tool state bounds prevent memory leaks', () => {
  const reducer = new StreamReducer({ maxActivities: 5, maxTools: 5 });

  for (let i = 0; i < 20; i++) {
    reducer.recordActivity(`Activity step ${i}`);
    reducer.recordTool(`tool-${i}`, `name-${i}`, 'active');
  }

  assert.ok(reducer.getActivities().length <= 5);
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
