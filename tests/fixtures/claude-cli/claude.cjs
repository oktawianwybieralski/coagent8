// Replays redacted stream-json recordings captured from Claude Code 2.1.289 (recordings/*.jsonl).
// CLAUDE_FIXTURE_SCENARIO selects a recording or a variant; the session ID from argv replaces the recorded one.
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
if (argv.includes('--version')) { console.log(env.CLAUDE_FIXTURE_VERSION || '2.1.289 (Claude Code)'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = env.CLAUDE_FIXTURE_LOGGED_IN !== '0';
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' }, null, 2));
  process.exit(loggedIn ? 0 : 1);
}
if (argv.at(-1) === '/usage') {
  if (env.CLAUDE_FIXTURE_CAPTURE) fs.writeFileSync(env.CLAUDE_FIXTURE_CAPTURE, JSON.stringify({ argv, stdin: '' }));
  const usage = JSON.parse(fs.readFileSync(path.join(__dirname, 'recordings', 'usage-subscription.json'), 'utf8'));
  if (env.CLAUDE_FIXTURE_USAGE === 'api-key') usage.result = 'You are currently using API billing.';
  if (env.CLAUDE_FIXTURE_USAGE === 'model-turn') { usage.num_turns = 1; usage.total_cost_usd = 0.001; }
  console.log(JSON.stringify(usage));
  process.exit(0);
}
const valueOf = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const sessionId = valueOf('--session-id') || valueOf('--resume');
const scenario = env.CLAUDE_FIXTURE_SCENARIO || (valueOf('--resume') ? 'resume' : 'success-partial');
const recordings = {
  'success-partial': ['success-partial', 0], 'readonly-refusal': ['readonly-refusal', 0], resume: ['resume', 0],
  'auth-failed': ['auth-failed', 1], 'model-not-found': ['model-not-found', 1], 'resume-unknown': ['resume-unknown', 1],
  'unknown-events': ['success-partial', 0], 'write-tools': ['success-partial', 0], 'no-result': ['success-partial', 0],
  'missing-init': ['success-partial', 0], 'startup-failure': ['success-partial', 1],
};
const [file, exitCode] = recordings[scenario] || [];
if (!file) { console.error(`unknown fixture scenario ${scenario}`); process.exit(2); }
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  if (env.CLAUDE_FIXTURE_CAPTURE) fs.writeFileSync(env.CLAUDE_FIXTURE_CAPTURE, JSON.stringify({ argv, stdin }));
  if (scenario === 'startup-failure') {
    process.stderr.write('Claude Code CLI failed to initialize: invalid argument\n');
    process.exit(1);
  }
  const lines = fs.readFileSync(path.join(__dirname, 'recordings', `${file}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const out = [];
  for (const event of lines) {
    if (sessionId && typeof event.session_id === 'string') event.session_id = sessionId;
    if (scenario === 'missing-init' && event.subtype === 'init') continue;
    if (scenario === 'write-tools' && event.subtype === 'init') event.tools = [...event.tools, 'Bash', 'Write'];
    if (scenario === 'no-result' && event.type === 'result') continue;
    if (scenario === 'unknown-events' && event.type === 'result') {
      out.push({ type: 'future_event_type', payload: 1 }, { type: 'future_event_type', payload: 2 }, { type: 'system', subtype: 'future_subtype' });
    }
    out.push(event);
  }
  process.stdout.write(out.map(event => JSON.stringify(event)).join('\n') + '\n');
  process.exitCode = exitCode;
});
