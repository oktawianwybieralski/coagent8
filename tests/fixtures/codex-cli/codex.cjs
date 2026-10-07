// Codex CLI double speaking the `codex app-server` protocol of 0.160 (JSONL JSON-RPC without
// the `jsonrpc` field). Like the real server it exits on stdin EOF. CODEX_FIXTURE_MODE selects
// failure variants; CODEX_FIXTURE_CAPTURE records argv, every client message and the prompt.
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args[0] !== 'app-server') { console.error(`unexpected arguments ${args.join(' ')}`); process.exit(2); }
const mode = process.env.CODEX_FIXTURE_MODE || 'success';
const THREAD = '11111111-aaaa-bbbb-cccc-123456789012', TURN = '019a0000-0000-7000-8000-000000000001';
const records = [];
let threadId = null, turnRunning = false, pending = '';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
function capture() {
  if (!process.env.CODEX_FIXTURE_CAPTURE) return;
  const turn = records.find(record => record.method === 'turn/start');
  fs.writeFileSync(process.env.CODEX_FIXTURE_CAPTURE, JSON.stringify({ args, records, prompt: turn ? turn.params.input[0].text : null }));
}
const item = (method, value) => notify(method, { threadId, turnId: TURN, item: value });
function completeTurn(status, error = null) {
  turnRunning = false;
  notify('turn/completed', { threadId, turn: { id: TURN, items: [], status, error, startedAt: null, completedAt: null, durationMs: null } });
}
function runTurn() {
  turnRunning = true;
  notify('turn/started', { threadId, turn: { id: TURN, items: [], status: 'inProgress', error: null } });
  notify('thread/started', { thread: { id: '33333333-aaaa-bbbb-cccc-123456789012' } });
  notify('item/completed', { threadId: '33333333-aaaa-bbbb-cccc-123456789012', turnId: 'other', item: { type: 'agentMessage', id: 'subagent', text: 'SUBAGENT_TEXT_NOT_THE_ANSWER' } });
  item('item/started', { type: 'reasoning', id: 'private', summary: [], content: [] });
  item('item/completed', { type: 'reasoning', id: 'private', summary: ['PRIVATE_REASONING_NEVER_PERSIST'], content: [] });
  item('item/started', { type: 'commandExecution', id: 'read-1', command: 'PRIVATE_RAW_COMMAND', status: 'inProgress', exitCode: null });
  item('item/completed', { type: 'commandExecution', id: 'read-1', command: 'PRIVATE_RAW_COMMAND', status: 'completed', aggregatedOutput: 'PRIVATE_TOOL_OUTPUT', exitCode: 0 });
  item('item/started', { type: 'agentMessage', id: 'message-1', text: '' });
  notify('item/agentMessage/delta', { threadId, turnId: TURN, itemId: 'message-1', delta: 'Draft' });
  const text = 'Final **Markdown** 😀\n```js\nconst answer = 42;\n```\nsk-fixtureSecret1234567890abcdef';
  item('item/completed', { type: 'agentMessage', id: 'message-1', text, phase: 'final_answer' });
  item('item/completed', { type: 'agentMessage', id: 'message-1', text, phase: 'final_answer' });
  const usage = last => ({ threadId, turnId: TURN, tokenUsage: { total: last, last, modelContextWindow: null } });
  notify('thread/tokenUsage/updated', usage({ totalTokens: 6, inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 }));
  notify('thread/tokenUsage/updated', usage({ totalTokens: 8, inputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }));
  if (mode === 'server-request') send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: TURN, itemId: 'read-1' } });
  if (mode === 'hang' || mode === 'interruptible') return;
  if (mode === 'no-terminal') process.exit(0);
  if (mode === 'auth') { completeTurn('failed', { message: 'Authentication required; api_key=fixtureSecret', codexErrorInfo: 'unauthorized', additionalDetails: null }); return; }
  if (mode === 'rate') { completeTurn('failed', { message: 'HTTP 429 Too Many Requests', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }); return; }
  if (mode === 'http-failure') { completeTurn('failed', { message: 'stream failed', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null }); return; }
  if (mode === 'error-exit-zero') notify('error', { error: { message: 'Provider failure', codexErrorInfo: 'other', additionalDetails: null }, willRetry: false, threadId, turnId: TURN });
  if (mode === 'retry-warning') notify('error', { error: { message: 'Reconnecting', codexErrorInfo: null, additionalDetails: null }, willRetry: true, threadId, turnId: TURN });
  completeTurn('completed');
  if (mode === 'duplicate-terminal') completeTurn('completed');
  if (mode === 'exit-failed') { console.error('Process failed'); process.exitCode = 1; }
}
function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    if (mode === 'malformed') { process.stdout.write('{invalid\n'); return; }
    send({ id, result: { userAgent: 'codex-fixture/0.160.0', codexHome: '/fixture', platformFamily: 'windows', platformOs: 'windows' } });
  } else if (method === 'thread/start' || method === 'thread/resume') {
    if (method === 'thread/resume' && mode === 'invalid-session') { send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } }); return; }
    threadId = method === 'thread/resume' ? (mode === 'wrong-thread' ? '22222222-aaaa-bbbb-cccc-123456789012' : params.threadId) : THREAD;
    const sandbox = mode === 'sandbox-writable'
      ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'readOnly', networkAccess: false };
    // `resolved-model`: the thread reports a concrete model other than the requested one.
    send({ id, result: { thread: { id: threadId, turns: [] }, model: mode === 'resolved-model' ? 'gpt-6.1-sol-2026-10-01' : params.model, modelProvider: 'openai', serviceTier: null, cwd: params.cwd,
      approvalPolicy: mode === 'approvals-on' ? 'on-request' : 'never', sandbox, reasoningEffort: null } });
  } else if (method === 'model/list') {
    // Shape of Codex 0.160 `model/list` (2026-10-07), abridged; one hidden entry is not offered.
    const efforts = names => names.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort }));
    send({ id, result: { nextCursor: null, data: [
      { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) },
      { id: 'gpt-6-astra', model: 'gpt-6-astra', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) },
      { id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max']) },
      { id: 'gpt-internal', model: 'gpt-internal', hidden: true, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: efforts(['low']) },
    ] } });
  } else if (method === 'turn/start') {
    send({ id, result: { turn: { id: TURN, items: [], status: 'inProgress', error: null } } });
    runTurn();
  } else if (method === 'turn/interrupt') {
    if (!turnRunning || params.turnId !== TURN || params.threadId !== threadId) { send({ id, error: { code: -32600, message: 'no active turn' } }); return; }
    // `hang` keeps running after the interrupt to exercise the forced stop.
    send({ id, result: {} });
    if (mode !== 'hang') completeTurn('interrupted');
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf('\n')) >= 0) {
    const message = JSON.parse(pending.slice(0, index));
    pending = pending.slice(index + 1);
    records.push(message);
    capture();
    handle(message);
  }
});
process.stdin.on('end', () => { capture(); process.exit(); });
setInterval(() => {}, 1000);
