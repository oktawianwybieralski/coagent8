const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-codex-'));
process.env.coagent8_DIR = directory;
process.env.OMNIAGENT_DIR = path.join(directory,'legacy');
process.env.CODEX_PATH = path.resolve(__dirname, 'fixtures/codex-cli/codex.cjs');
process.env.CODEX_FIXTURE_CAPTURE = path.join(directory,'capture.json');
process.env.CODEX_CONFIG_PATH = path.join(directory,'config.toml');
const {execute, probe, readCodexConfig, normalizeReasoningEffort} = require('../src/backends/codex.adapter.ts');
const {executeTask} = require('../src/execution/controller.ts');
const {sessionHistory} = require('../src/sessions/history.ts');
const {getSession} = require('../src/sessions/session.ts');
const {saveConfig} = require('../src/config.ts');
const options = {cwd:directory,model:'gpt-6.1-sol'};
test.after(() => fs.rmSync(directory,{recursive:true,force:true}));

test('production Codex adapter passes the shared pipeline, preserves Markdown and resumes two turns with durable public history',async () => {
  saveConfig({defaultBackend:'codex',routing:{strategy:'fixed',allowedBackends:['codex']}});
  const first = await executeTask('PRIVATE_REPOSITORY_SNAPSHOT','Public question 😀',{backend:'codex',model:options.model},directory);
  assert.equal(first.isError,false); assert.equal(first.structuredContent.status,'completed');
  assert.ok(first.structuredContent.output.includes('const answer = 42;'));
  assert.ok(first.structuredContent.output.includes('😀')); assert.ok(!first.structuredContent.output.includes('fixtureSecret'));
  assert.equal(first.structuredContent.continuationAvailable,true);
  assert.equal(first.structuredContent.activity.toolCount,1);
  const handle = first.structuredContent.sessionHandle;
  const thread = getSession(handle).threadId;
  assert.equal(thread,'11111111-aaaa-bbbb-cccc-123456789012');
  const second = await executeTask('Follow up','Follow up',{session_handle:handle,reasoning_effort:'high'},directory);
  assert.equal(second.isError,false); assert.equal(second.structuredContent.turn,2);
  const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
  assert.equal(capture.args[capture.args.indexOf('resume')+1],thread);
  assert.ok(!capture.args.includes('--last'));
  assert.equal(capture.args[capture.args.indexOf('--sandbox')+1],'read-only');
  assert.ok(capture.args.indexOf('--sandbox') < capture.args.indexOf('resume'));
  assert.ok(capture.args.includes('sandbox_mode="read-only"'));
  assert.ok(capture.args.includes('approval_policy="never"'));
  assert.ok(capture.args.includes('model_reasoning_effort="high"'));
  assert.equal(capture.args[capture.args.indexOf('-m')+1],options.model);
  assert.equal(capture.args.at(-1),'-'); assert.equal(capture.prompt,'Follow up');
  const history = await sessionHistory(handle,directory);
  assert.equal(history.events.filter(event => event.type === 'assistant_message').length,2);
  assert.equal(history.events.filter(event => event.type === 'user_message').length,2);
  assert.equal(history.events.filter(event => event.type === 'turn_finished').length,2);
  for (const forbidden of ['Draft','PRIVATE_REASONING','PRIVATE_RAW_COMMAND','PRIVATE_TOOL_OUTPUT','PRIVATE_REPOSITORY_SNAPSHOT','fixtureSecret']) assert.ok(!JSON.stringify(history).includes(forbidden),forbidden);
  assert.equal(getSession(handle).activePid,null);
});

test('Codex failures are typed and authoritative even at exit zero; malformed or incomplete protocol cannot pass',async () => {
  for (const [mode,code] of [['auth','AUTH_REQUIRED'],['rate','RATE_LIMITED'],['invalid-session','SESSION_INVALID'],['error-exit-zero','PROCESS_ERROR'],['no-terminal','PROTOCOL_ERROR'],['malformed','PROTOCOL_ERROR'],['duplicate-terminal','PROTOCOL_ERROR'],['exit-failed','PROCESS_ERROR']]) {
    process.env.CODEX_FIXTURE_MODE = mode;
    const result = await execute('x',options);
    assert.equal(result.status,'failed',mode); assert.equal(result.isError,true,mode); assert.equal(result.error.code,code,mode);
    assert.ok(!JSON.stringify(result).includes('fixtureSecret'));
    if (code === 'PROTOCOL_ERROR' || code === 'SESSION_INVALID') assert.equal(result.continuationAvailable,false);
  }
  process.env.CODEX_FIXTURE_MODE = 'wrong-thread';
  const mismatched = await execute('x',{...options,nativeSessionId:'11111111-aaaa-bbbb-cccc-123456789012'});
  assert.equal(mismatched.error.code,'PROTOCOL_ERROR'); assert.equal(mismatched.continuationAvailable,false);
  delete process.env.CODEX_FIXTURE_MODE;
});

test('Codex respects deadlines, cancellation and effective model governance through the common runner',async () => {
  fs.rmSync(process.env.CODEX_FIXTURE_CAPTURE,{force:true});
  const denied = await execute('x',{...options,model:'gpt-6.1-astra'});
  assert.equal(denied.error.code,'POLICY_DENIED'); assert.equal(fs.existsSync(process.env.CODEX_FIXTURE_CAPTURE),false);
  const aborted = await execute('x',{...options,abortSignal:AbortSignal.abort()});
  assert.equal(aborted.status,'cancelled'); assert.equal(aborted.error.code,'ABORTED');
  assert.equal(fs.existsSync(process.env.CODEX_FIXTURE_CAPTURE),false);
  process.env.CODEX_FIXTURE_MODE = 'hang';
  const timedOut = await execute('x',{...options,timeoutMs:4000});
  assert.equal(timedOut.status,'timed_out'); assert.equal(timedOut.error.code,'TIMEOUT');
  assert.ok(timedOut.output.includes('const answer = 42;'));
  delete process.env.CODEX_FIXTURE_MODE;
});

test('readCodexConfig and normalizeReasoningEffort default safe reasoning depth to low and preserve overrides', () => {
  const config = readCodexConfig();
  assert.equal(config.defaultReasoningEffort, 'low');
  assert.equal(normalizeReasoningEffort(), 'low');
  assert.equal(normalizeReasoningEffort(null), 'low');
  assert.equal(normalizeReasoningEffort(undefined, config.defaultReasoningEffort), 'low');
  assert.equal(normalizeReasoningEffort('medium'), 'medium');
  assert.equal(normalizeReasoningEffort('high'), 'high');
  assert.equal(normalizeReasoningEffort('max'), 'max');
});

test('probe returns standardized AdapterProbeResult with executionSupported, capabilities, loginHint, modelSource, and authEvidence', async () => {
  // Isolate the probe from the machine's Codex login: empty home directory, no API key.
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-codex-home-'));
  const authFile = path.join(path.dirname(process.env.CODEX_CONFIG_PATH),'auth.json');
  const saved = {HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,OPENAI_API_KEY:process.env.OPENAI_API_KEY,CODEX_API_KEY:process.env.CODEX_API_KEY};
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.OPENAI_API_KEY; delete process.env.CODEX_API_KEY;
  try {
    fs.rmSync(authFile,{force:true});
    const result = await probe();
    assert.equal(result.id, 'codex');
    assert.equal(result.name, 'OpenAI Codex CLI');
    assert.equal(typeof result.installed, 'boolean');
    assert.equal(result.executionSupported, result.installed);
    assert.deepEqual(result.capabilities, {
      resume: true,
      streaming: true,
      readOnlyVerified: true,
      reasoningEffort: true,
    });
    assert.equal(result.loginHint, 'codex');
    assert.equal(result.modelSource, 'config.toml and built-in model definitions');
    assert.ok(Array.isArray(result.authEvidence));
    assert.ok(result.authEvidence.length > 0);
    assert.equal(result.authStatus, 'unauthenticated');
    fs.writeFileSync(authFile, JSON.stringify({auth_mode:'chatgpt',tokens:{}}));
    const signedIn = await probe();
    assert.equal(signedIn.authStatus, 'authenticated');
    assert.ok(signedIn.authEvidence.includes('Auth credentials present (chatgpt)'));
  } finally {
    fs.rmSync(authFile,{force:true});
    fs.rmSync(home,{recursive:true,force:true});
    for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
