// Replays redacted stream-json recordings captured from Claude Code 2.1.289 (recordings/*.jsonl).
// CLAUDE_FIXTURE_SCENARIO selects a recording or a variant; the session ID from argv replaces the recorded one.
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
if (argv.includes('--version')) {
  if (env.CLAUDE_FIXTURE_MODE === 'hang-probe' || env.CLAUDE_FIXTURE_SCENARIO === 'hang-probe') {
    setInterval(() => {}, 1000);
    return;
  }
  console.log(env.CLAUDE_FIXTURE_VERSION || '2.1.289 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (env.CLAUDE_FIXTURE_MODE === 'hang-auth' || env.CLAUDE_FIXTURE_SCENARIO === 'hang-auth') {
    setInterval(() => {}, 1000);
    return;
  }
  const loggedIn = env.CLAUDE_FIXTURE_LOGGED_IN !== '0';
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }, null, 2));
  process.exit(loggedIn ? 0 : 1);
}
const valueOf = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.at(-1) === '/usage') {
  if (env.CLAUDE_FIXTURE_MODE === 'hang-usage' || env.CLAUDE_FIXTURE_SCENARIO === 'hang-usage') {
    setInterval(() => {}, 1000);
    return;
  }
  if (env.CLAUDE_FIXTURE_CAPTURE) fs.writeFileSync(env.CLAUDE_FIXTURE_CAPTURE, JSON.stringify({ argv, stdin: '' }));
  const usage = JSON.parse(fs.readFileSync(path.join(__dirname, 'recordings', 'usage-subscription.json'), 'utf8'));
  if (env.CLAUDE_FIXTURE_USAGE === 'api-key') usage.result = 'You are currently using API billing.';
  if (env.CLAUDE_FIXTURE_USAGE === 'model-turn') { usage.num_turns = 1; usage.total_cost_usd = 0.001; }
  // stream-json (2.1.289, recorded 2026-10-07): `system/init` names the model a name runs,
  // or the account default without `--model`; aliases and CLAUDE_FIXTURE_MODELS map names.
  const requested = valueOf('--model') ?? '';
  const models = { '': 'claude-sonnet-4-6', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001', opus: 'claude-opus-4-6', ...JSON.parse(env.CLAUDE_FIXTURE_MODELS || '{}') };
  if (valueOf('--output-format') === 'stream-json') {
    if (env.CLAUDE_FIXTURE_USAGE !== 'no-init') console.log(JSON.stringify({ type: 'system', subtype: 'init', model: models[requested] ?? requested, tools: [], mcp_servers: [], permissionMode: 'dontAsk' }));
    console.log(JSON.stringify({ ...usage, type: 'result' }));
  } else console.log(JSON.stringify(usage));
  process.exit(0);
}
const sessionId = valueOf('--session-id') || valueOf('--resume');
const scenario = env.CLAUDE_FIXTURE_SCENARIO || (valueOf('--resume') ? 'resume' : 'success-partial');
const recordings = {
  'success-partial': ['success-partial', 0], 'readonly-refusal': ['readonly-refusal', 0], resume: ['resume', 0],
  'auth-failed': ['auth-failed', 1], 'model-not-found': ['model-not-found', 1], 'resume-unknown': ['resume-unknown', 1],
  'unknown-events': ['success-partial', 0], 'write-tools': ['success-partial', 0], 'no-result': ['success-partial', 0],
  'missing-init': ['success-partial', 0], 'startup-failure': ['success-partial', 1],
  interruptible: ['success-partial', 0], 'ignore-interrupt': ['success-partial', 0], 'max-tokens': ['success-partial', 0],
};
const [file, exitCode] = recordings[scenario] || [];
if (!file) { console.error(`unknown fixture scenario ${scenario}`); process.exit(2); }
if (scenario === 'startup-failure') {
  process.stderr.write('Claude Code CLI failed to initialize: invalid argument\n');
  process.exit(1);
}
// `--input-format stream-json`: one NDJSON record per line. Like Claude Code 2.1.289, the
// process exits only once stdin is closed after the turn's `result`.
const records = [];
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
let pending = '', answered = false, interruptible = null;
function capture() {
  if (!env.CLAUDE_FIXTURE_CAPTURE) return;
  const user = records.find(record => record.type === 'user');
  fs.writeFileSync(env.CLAUDE_FIXTURE_CAPTURE, JSON.stringify({ argv, stdin: user ? user.message.content : '', records, nested: env.COAGENT8_NESTED_TURN ?? null }));
}
function answer() {
  const lines = fs.readFileSync(path.join(__dirname, 'recordings', `${file}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const out = [];
  for (const event of lines) {
    if (sessionId && typeof event.session_id === 'string') event.session_id = sessionId;
    if (scenario === 'missing-init' && event.subtype === 'init') continue;
    if (scenario === 'write-tools' && event.subtype === 'init') event.tools = [...event.tools, 'Bash', 'Write'];
    // `max-tokens`: the answer stopped at the output length limit (ENVELOPE-001).
    if (scenario === 'max-tokens' && event.type === 'result') event.stop_reason = 'max_tokens';
    if ((scenario === 'no-result' || scenario === 'interruptible' || scenario === 'ignore-interrupt') && event.type === 'result') continue;
    if (scenario === 'unknown-events' && event.type === 'result') {
      out.push({ type: 'future_event_type', payload: 1 }, { type: 'future_event_type', payload: 2 }, { type: 'system', subtype: 'future_subtype' });
    }
    out.push(event);
  }
  for (const event of out) send(event);
  // A CLI that dies without a terminal result: exit without waiting for stdin.
  if (scenario === 'no-result') process.exit(exitCode);
  if (scenario === 'interruptible' || scenario === 'ignore-interrupt') {
    // The turn keeps running until an interrupt arrives (2.1.289 output shapes, recorded live).
    interruptible = setInterval(() => {}, 1000);
    if (env.CLAUDE_FIXTURE_READY) {
      const tmp = `${env.CLAUDE_FIXTURE_READY}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, sessionId, scenario, state: 'running' }));
      fs.renameSync(tmp, env.CLAUDE_FIXTURE_READY);
    }
  }
}
// `initialize` (shape of Claude Code 2.1.294, recorded 2026-10-08): the names the CLI accepts,
// each with the concrete model it resolves to; CLAUDE_FIXTURE_MODELS adds or remaps names and
// CLAUDE_FIXTURE_CATALOG=error answers with an error.
function initialize(request) {
  if (env.CLAUDE_FIXTURE_MODE === 'hang-catalog' || env.CLAUDE_FIXTURE_SCENARIO === 'hang-catalog') {
    setInterval(() => {}, 1000);
    return;
  }
  if (env.CLAUDE_FIXTURE_CATALOG === 'error') {
    send({ type: 'control_response', response: { subtype: 'error', request_id: request.request_id, error: 'initialize failed' } });
    return;
  }
  const names = { default: 'claude-sonnet-4-6', opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001', ...JSON.parse(env.CLAUDE_FIXTURE_MODELS || '{}') };
  delete names[''];
  const efforts = model => model.startsWith('claude-haiku-4-5') ? undefined : ['low', 'medium', 'high', 'xhigh', 'max'];
  const concrete = [...new Set(Object.values(names))];
  const models = [...Object.entries(names), ...concrete.map(model => [model, model])]
    .map(([value, resolvedModel]) => ({ value, resolvedModel, displayName: value, description: '', ...(efforts(resolvedModel) ? { supportsEffort: true, supportedEffortLevels: efforts(resolvedModel) } : {}) }));
  send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { commands: [], agents: [], models, account: {}, pid: process.pid } } });
}
function interrupt(request) {
  send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [] } } });
  // Only a running turn ends with an interrupted result.
  if (scenario === 'ignore-interrupt' || !interruptible) return;
  clearInterval(interruptible);
  interruptible = null;
  send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, terminal_reason: 'aborted_streaming', stop_reason: null, errors: [] });
  process.exitCode = 1;
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf('\n')) >= 0) {
    const record = JSON.parse(pending.slice(0, index));
    pending = pending.slice(index + 1);
    records.push(record);
    if (record.type === 'user' && !answered) { answered = true; capture(); answer(); }
    else if (record.type === 'control_request' && record.request?.subtype === 'interrupt') { capture(); interrupt(record); }
    else if (record.type === 'control_request' && record.request?.subtype === 'initialize') initialize(record);
  }
});
process.stdin.on('end', () => {
  if (env.CLAUDE_FIXTURE_MODE === 'hang-catalog' || env.CLAUDE_FIXTURE_SCENARIO === 'hang-catalog') return;
  if (env.CLAUDE_FIXTURE_MODE === 'hang-after-channel-close') {
    setInterval(() => {}, 1000);
    return;
  }
  capture();
  clearInterval(interruptible);
  if (process.exitCode === undefined) process.exitCode = exitCode;
});
