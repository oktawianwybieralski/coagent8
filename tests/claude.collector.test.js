const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClaudeStreamCollector } = require('../src/backends/claude.collector.ts');
const { classifyClaudeFailure, CLAUDE_ERROR_CATEGORIES } = require('../src/backends/claude-errors.ts');

const SESSION = '859bbd7d-81ae-440c-b76a-a80e596d0fa5';
const TOOLS = ['Read', 'Glob', 'Grep'];
function recording(name, session = SESSION) {
  return fs.readFileSync(path.join(__dirname, 'fixtures/claude-cli/recordings', `${name}.jsonl`), 'utf8').trim().split('\n')
    .map(line => { const event = JSON.parse(line); if (typeof event.session_id === 'string') event.session_id = session; return event; });
}
function collect(events, options = {}) {
  const seen = [];
  const collector = createClaudeStreamCollector({ expectedSessionId: SESSION, allowedTools: TOOLS, onEvent: event => seen.push(event), ...options });
  for (const event of events) collector.line(JSON.stringify(event));
  return { snapshot: collector.snapshot(), seen };
}

test('Claude collector streams deltas, final message, usage and the session from a recorded run', () => {
  const { snapshot, seen } = collect(recording('success-partial'));
  assert.equal(snapshot.output, 'OK');
  assert.equal(snapshot.sessionId, SESSION);
  assert.equal(snapshot.terminal, true);
  assert.equal(snapshot.error, undefined);
  assert.deepEqual(seen.filter(e => e.type === 'assistant_delta').map(e => e.text), ['OK']);
  const final = seen.filter(e => e.type === 'assistant_message');
  assert.equal(final.length, 1);
  assert.equal(final[0].text, 'OK');
  assert.equal(final[0].messageId, seen.find(e => e.type === 'assistant_delta').messageId);
  assert.ok(!seen.some(e => e.type === 'assistant_message' && /thinking/i.test(e.text)), 'thinking is private');
  assert.equal(snapshot.usage.outputTokens, 48);
  assert.equal(snapshot.usage.inputTokens, 10 + 2010 + 4570);
});

test('Claude collector reports read tool activity and a refused write as a completed answer', () => {
  const { snapshot, seen } = collect(recording('readonly-refusal'));
  assert.equal(snapshot.error, undefined);
  assert.match(snapshot.output, /Create created\.txt.*FAILED/s);
  const started = seen.filter(e => e.type === 'tool_started');
  assert.deepEqual(started.map(e => e.name), ['Read']);
  assert.deepEqual(seen.filter(e => e.type === 'tool_finished').map(e => [e.toolId, e.success]), [[started[0].toolId, true]]);
});

test('Claude collector fails closed when init exposes write tools, MCP servers or another permission mode', () => {
  for (const patch of [{ tools: [...TOOLS, 'Bash'] }, { mcp_servers: [{ name: 'x', status: 'connected' }] }, { permissionMode: 'acceptEdits' }]) {
    const events = recording('success-partial');
    Object.assign(events[0], patch);
    assert.throws(() => collect(events), err => err.code === 'SANDBOX_UNAVAILABLE');
  }
});

test('Claude collector fails closed when stream events or result arrive without init', () => {
  const withoutInit = recording('success-partial').filter(e => e.subtype !== 'init');
  assert.throws(() => collect(withoutInit), err => err.code === 'SANDBOX_UNAVAILABLE');
  assert.throws(() => collect([{ type: 'result', subtype: 'success', result: 'OK' }]), err => err.code === 'SANDBOX_UNAVAILABLE');
});

test('Claude collector rejects a mismatched session, duplicate result, and malformed assistant content', () => {
  assert.throws(() => collect(recording('success-partial', '00000000-0000-4000-8000-000000000000')), err => err.code === 'PROTOCOL_ERROR');
  assert.throws(() => collect([{ type: 'system', subtype: 'init', tools: TOOLS, mcp_servers: [], permissionMode: 'dontAsk' }]), err => err.code === 'PROTOCOL_ERROR');
  const events = recording('success-partial');
  assert.throws(() => collect([...events, events.at(-1)]), err => err.code === 'PROTOCOL_ERROR');
  const init = events[0];
  assert.throws(() => collect([init, { type: 'assistant', message: { id: 'm', content: 'x' } }]), err => err.code === 'PROTOCOL_ERROR');
});

test('Claude collector accepts uppercase session ID in init and result case-insensitively', () => {
  const { snapshot } = collect(recording('success-partial', SESSION.toUpperCase()));
  assert.equal(snapshot.sessionId, SESSION);
  assert.equal(snapshot.output, 'OK');
});

test('Claude collector tolerates unknown event types and system subtypes with one warning each', () => {
  const events = recording('success-partial');
  events.splice(-1, 0, { type: 'future_event_type' }, { type: 'future_event_type' }, { type: 'system', subtype: 'future_subtype' });
  const { snapshot, seen } = collect(events);
  assert.equal(snapshot.output, 'OK');
  assert.equal(snapshot.error, undefined);
  assert.equal(seen.filter(e => e.type === 'warning').length, 2);
});

test('Claude collector itself applies no keyword redaction to answer text (controller redaction is AUD-P0-2)', () => {
  const events = recording('success-partial');
  events.at(-1).result = 'const token = getToken();';
  assert.equal(collect(events).snapshot.output, 'const token = getToken();');
});

test('Claude collector maps recorded failures to typed errors without reading stderr', () => {
  const auth = collect(recording('auth-failed'));
  assert.equal(auth.snapshot.error.code, 'AUTH_REQUIRED');
  assert.equal(auth.snapshot.output, '');
  assert.ok(!auth.seen.some(e => e.type === 'assistant_message'), 'API error notices are not model answers');
  assert.equal(collect(recording('model-not-found')).snapshot.error.code, 'MODEL_UNAVAILABLE');
  const unknown = collect(recording('resume-unknown'));
  assert.equal(unknown.snapshot.error.code, 'SESSION_INVALID');
  assert.equal(unknown.snapshot.initialized, false);
});

test('Claude error mapping is table driven, defaults to PROCESS_ERROR and carries the provider reset', () => {
  assert.equal(classifyClaudeFailure({ category: 'rate_limit' }).retryable, true);
  assert.equal(classifyClaudeFailure({ category: 'billing_error' }).code, 'AUTH_REQUIRED');
  assert.equal(classifyClaudeFailure({ category: 'billing_error' }).retryable, false);
  assert.equal(classifyClaudeFailure({ category: 'a_future_category' }).code, 'PROCESS_ERROR');
  assert.equal(classifyClaudeFailure({ category: 'toString' }).code, 'PROCESS_ERROR');
  assert.equal(classifyClaudeFailure({ apiErrorStatus: 429 }).code, 'RATE_LIMITED');
  assert.equal(classifyClaudeFailure({ apiErrorStatus: 503 }).retryable, true);
  assert.equal(classifyClaudeFailure({ errors: ['Some other failure'] }).code, 'PROCESS_ERROR');
  const limited = classifyClaudeFailure({ category: 'rate_limit', message: 'Usage limit reached', rateLimitResetsAt: 1791237000 });
  assert.match(limited.message, /resets at 2026-10-0\dT\d\d:\d\d:00\.000Z/);
  assert.ok(Object.isFrozen(CLAUDE_ERROR_CATEGORIES));
});

test('Claude collector snapshot reflects uninitialized state without masking process crashes', () => {
  const collector = createClaudeStreamCollector({ expectedSessionId: SESSION, allowedTools: TOOLS });
  const snap = collector.snapshot();
  assert.equal(snap.initialized, false);
  assert.equal(snap.terminal, false);
  assert.equal(snap.error, undefined, 'uninitialized snapshot before terminal has no synthetic error so adapter reports process stderr');
  assert.equal(snap.output, '');
});
