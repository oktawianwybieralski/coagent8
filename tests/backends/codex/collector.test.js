'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createCodexStreamCollector } = require('../../../src/backends/codex/collector.ts');

test('live Codex collector emits public progress without private tool operands or reasoning', () => {
  const progress = [];
  const collector = createCodexStreamCollector({ onProgress: message => progress.push(message) });
  const accept = (method, params) => collector.line(JSON.stringify({ method, params }));
  const started = item => accept('item/started', { threadId: 'thread_progress', turnId: 'turn_1', item });
  collector.initialize('thread_progress');
  collector.beginTurn('turn_1');
  accept('turn/started', { threadId: 'thread_progress', turn: { id: 'turn_1' } });
  started({ id: 'command', type: 'commandExecution', command: 'private-command' });
  started({ id: 'search', type: 'webSearch', query: 'private-query' });
  started({ id: 'tool', type: 'mcpToolCall', arguments: { path: 'private-path' } });
  started({ id: 'thought', type: 'reasoning', summary: ['private-reasoning'] });
  started({ id: 'message', type: 'agentMessage', text: '' });
  accept('item/completed', { threadId: 'thread_progress', turnId: 'turn_1', item: { id: 'message', type: 'agentMessage', text: 'Public findings' } });
  assert.deepEqual(progress, [
    'Initializing Codex session...', 'Starting task analysis...', 'Executing sandbox command...',
    'Executing web search...', 'Executing MCP tool...', 'Analyzing context and architecture...', 'Formulating findings...',
  ]);
  assert.equal(collector.snapshot().output, 'Public findings');
  assert.doesNotMatch(JSON.stringify(progress) + collector.snapshot().output, /private-/);
});

test('createCodexStreamCollector accumulates message updates from created -> updated -> completed without losing findings', async () => {
  const collector = createCodexStreamCollector();

  // 1. Thread started event
  collector.initialize('thread_audit_123');
  assert.equal(collector.snapshot().threadId, 'thread_audit_123');

  // 2. Stream partial message
  collector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'msg_0', type: 'agentMessage', text: 'Partial analysis: checking lock mechanism...' } }
  }));
  assert.equal(collector.snapshot().output, 'Partial analysis: checking lock mechanism...');

  // 3. Stream updated message
  collector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'msg_0', type: 'agentMessage', text: 'Partial analysis: identified race window in reclamation.' } }
  }));
  assert.equal(collector.snapshot().output, 'Partial analysis: identified race window in reclamation.');

  // 4. Stream completed message with final audit findings
  collector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'msg_0', type: 'agentMessage', text: 'Audit Findings:\n- Mutual exclusion verified with reclaimMutex.\n- Zero P1/P2 issues.' } }
  }));

  const finalOutput = collector.snapshot().output;
  assert.ok(finalOutput.includes('Mutual exclusion verified with reclaimMutex'));
  assert.ok(finalOutput.includes('Zero P1/P2 issues'));
  assert.ok(!finalOutput.includes('checking lock mechanism'));
});

test('createCodexStreamCollector retains bounded latest text under budget pressure rather than stale draft', async () => {
  // Set a tight budget of 150 bytes total
  const collector = createCodexStreamCollector({ maxTotalMessageBytes: 150 });

  // Stream initial partial draft (60 bytes)
  collector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'Initial partial analysis draft from turn.' } }
  }));
  assert.equal(collector.snapshot().output, 'Initial partial analysis draft from turn.');

  // Stream final large findings (250 bytes), which exceeds the 150 bytes budget
  const finalFindings = 'Final comprehensive findings: identified 0 vulnerabilities in review, confirmed mutual exclusion and strict secret masking. '.repeat(2);
  collector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: finalFindings } }
  }));

  const output = collector.snapshot().output;
  // It must NOT keep the stale "Initial partial analysis draft"
  assert.ok(!output.includes('Initial partial analysis draft'));
  // It MUST keep the latest final findings with explicit truncation marker
  assert.ok(output.includes('Final comprehensive findings'));
  assert.ok(output.includes('[truncated]'));

  // Reduced budget test (40 bytes total): 5-byte draft + 35-byte message leaves 0 bytes available
  const tightCollector = createCodexStreamCollector({ maxTotalMessageBytes: 40 });
  tightCollector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'draft' } }
  }));
  tightCollector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'm2', type: 'agentMessage', text: '01234567890123456789012345678901234' } } // 35 bytes
  }));
  // Final text arrives for m1
  tightCollector.line(JSON.stringify({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'final text for m1' } }
  }));
  const tightOutput = tightCollector.snapshot().output;
  assert.ok(!tightOutput.includes('draft'), 'Stale draft must never survive under tight budget');
  assert.ok(tightOutput.includes('[truncated]'), 'Must indicate truncation');
});

test('the answer is the final_answer message, without the commentary Codex marks as interim (agy saw it, 2026-10-07)', () => {
  const run = phases => {
    const events = [];
    const collector = createCodexStreamCollector({ onEvent: event => events.push(event) });
    collector.initialize('thread_phase');
    collector.beginTurn('turn_1');
    const completed = (id, text, phase) => collector.line(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread_phase', turnId: 'turn_1', item: { id, type: 'agentMessage', text, ...(phase === undefined ? {} : { phase }) } } }));
    completed('c1', 'Najlepiej użyć asynchronicznego transform. Sprawdzę dokumentację Zod.', phases[0]);
    completed('c2', 'Mam dokumentację.', phases[1]);
    if (phases[2] !== 'absent') completed('f1', 'Use z.transform with an async function and parseAsync.', phases[2]);
    return { output: collector.snapshot().output, history: events.filter(event => event.type === 'assistant_message').map(event => event.messageId) };
  };
  const tagged = run(['commentary', 'commentary', 'final_answer']);
  assert.equal(tagged.output, 'Use z.transform with an async function and parseAsync.');
  assert.deepEqual(tagged.history, ['c1', 'c2', 'f1'], 'the history keeps the commentary');
  assert.equal(run([undefined, undefined, undefined]).output.split('\n\n').length, 3, 'a model without phases keeps every message');
  assert.match(run(['commentary', 'commentary', 'absent']).output, /^Najlepiej/, 'without a final answer the commentary is the partial response');
});

test('CUR-005: commentary over the byte or count budget does not mark a small complete final answer as truncated', () => {
  const run = ({ commentary, final = 'OK', ...budgets }) => {
    const collector = createCodexStreamCollector(budgets);
    collector.initialize('thread_budget');
    collector.beginTurn('turn_1');
    const completed = (id, text, phase) => collector.line(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread_budget', turnId: 'turn_1', item: { id, type: 'agentMessage', text, ...(phase ? { phase } : {}) } } }));
    commentary.forEach((text, index) => completed(`c${index}`, text, 'commentary'));
    if (final !== null) completed('final', final, 'final_answer');
    collector.line(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_budget', turn: { id: 'turn_1', status: 'completed' } } }));
    return collector.snapshot();
  };
  const large = run({ commentary: ['x'.repeat(100)], maxTotalMessageBytes: 80 });
  assert.equal(large.output, 'OK');
  assert.equal(large.truncated, false, 'the cut commentary left the answer with the final message');
  assert.equal(large.error, undefined);

  const many = run({ commentary: ['one', 'two', 'three', 'four'], maxMessages: 2 });
  assert.equal(many.output, 'OK', 'commentary beyond the count budget does not fail the turn before its final answer');
  assert.equal(many.truncated, false);
  assert.equal(many.error, undefined);

  const unfinished = run({ commentary: ['x'.repeat(100)], final: null, maxTotalMessageBytes: 80 });
  assert.equal(unfinished.truncated, true, 'without a final answer the cut commentary is the output and stays marked');
  assert.equal(unfinished.error.code, 'BUFFER_LIMIT');

  const longFinal = run({ commentary: ['short'], final: 'y'.repeat(100), maxTotalMessageBytes: 80 });
  assert.equal(longFinal.truncated, true, 'a final answer over the budget is still reported as truncated');
  assert.equal(longFinal.error.code, 'BUFFER_LIMIT');
});
