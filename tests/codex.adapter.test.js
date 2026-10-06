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
const {execute, probe, readCodexConfig, normalizeReasoningEffort} = require('../src/backends/codex/adapter.ts');
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
  assert.deepEqual(capture.args,['app-server','-c','sandbox_mode="read-only"','-c','approval_policy="never"']);
  assert.deepEqual(capture.records.map(r=>r.method),['initialize','initialized','thread/resume','turn/start']);
  assert.ok(capture.records.every(r=>!('jsonrpc' in r)),'the app-server wire format omits the jsonrpc field');
  const resume = capture.records[2].params;
  assert.equal(resume.threadId,thread); assert.equal(resume.excludeTurns,true);
  assert.equal(resume.sandbox,'read-only'); assert.equal(resume.approvalPolicy,'never'); assert.equal(resume.model,options.model);
  const turn = capture.records[3].params;
  assert.equal(turn.threadId,thread); assert.equal(turn.effort,'high'); assert.equal(capture.prompt,'Follow up');
  const history = await sessionHistory(handle,directory);
  assert.equal(history.events.filter(event => event.type === 'assistant_message').length,2);
  assert.equal(history.events.filter(event => event.type === 'user_message').length,2);
  assert.equal(history.events.filter(event => event.type === 'turn_finished').length,2);
  for (const forbidden of ['Draft','PRIVATE_REASONING','PRIVATE_RAW_COMMAND','PRIVATE_TOOL_OUTPUT','PRIVATE_REPOSITORY_SNAPSHOT','SUBAGENT_TEXT','fixtureSecret']) assert.ok(!JSON.stringify(history).includes(forbidden),forbidden);
  assert.equal(getSession(handle).activePid,null);
});

test('Codex failures are typed and authoritative even at exit zero; malformed or incomplete protocol cannot pass',async () => {
  for (const [mode,code] of [['auth','AUTH_REQUIRED'],['rate','RATE_LIMITED'],['http-failure','AUTH_REQUIRED'],['error-exit-zero','PROCESS_ERROR'],['no-terminal','PROTOCOL_ERROR'],['malformed','PROTOCOL_ERROR'],['duplicate-terminal','PROTOCOL_ERROR'],['exit-failed','PROCESS_ERROR'],['sandbox-writable','SANDBOX_UNAVAILABLE'],['approvals-on','SANDBOX_UNAVAILABLE']]) {
    process.env.CODEX_FIXTURE_MODE = mode;
    const result = await execute('x',options);
    assert.equal(result.status,'failed',mode); assert.equal(result.isError,true,mode); assert.equal(result.error.code,code,mode);
    assert.ok(!JSON.stringify(result).includes('fixtureSecret'));
    if (['PROTOCOL_ERROR','SESSION_INVALID','SANDBOX_UNAVAILABLE'].includes(code)) assert.equal(result.continuationAvailable,false,mode);
    if (code === 'SANDBOX_UNAVAILABLE') {
      const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
      assert.ok(!capture.records.some(r=>r.method==='turn/start'),`${mode}: no turn starts without a verified read-only sandbox`);
    }
  }
  const thread = '11111111-aaaa-bbbb-cccc-123456789012';
  process.env.CODEX_FIXTURE_MODE = 'invalid-session';
  const unknown = await execute('x',{...options,nativeSessionId:thread});
  assert.equal(unknown.error.code,'SESSION_INVALID'); assert.equal(unknown.continuationAvailable,false);
  process.env.CODEX_FIXTURE_MODE = 'wrong-thread';
  const mismatched = await execute('x',{...options,nativeSessionId:thread});
  assert.equal(mismatched.error.code,'PROTOCOL_ERROR'); assert.equal(mismatched.continuationAvailable,false);
  delete process.env.CODEX_FIXTURE_MODE;
});

test('Codex declines server requests, ignores sub-agent threads, sums turn usage and reports retries as warnings',async () => {
  for (const mode of ['server-request','retry-warning']) {
    process.env.CODEX_FIXTURE_MODE = mode;
    const events = [];
    const result = await execute('x',{...options,onEvent:e=>events.push(e)});
    assert.equal(result.status,'completed',mode); assert.equal(result.output.includes('SUBAGENT'),false);
    assert.deepEqual(result.usage,{source:'provider',inputTokens:5,outputTokens:9,totalTokens:14});
    assert.ok(events.some(e=>e.type==='tool_started'&&e.name==='commandExecution')); assert.ok(events.some(e=>e.type==='tool_finished'&&e.success));
    assert.ok(events.some(e=>e.type==='assistant_delta'&&e.text==='Draft'));
    assert.equal(events.filter(e=>e.type==='warning').length,1,mode);
    if (mode === 'server-request') {
      const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
      const answer = capture.records.find(r=>r.id==='srv-1');
      assert.equal(answer.error.code,-32601); assert.equal('result' in answer,false,'nothing is ever approved');
    }
  }
  delete process.env.CODEX_FIXTURE_MODE;
});

test('Codex respects deadlines, cancellation and effective model governance through the common runner',async () => {
  fs.rmSync(process.env.CODEX_FIXTURE_CAPTURE,{force:true});
  const denied = await execute('x',{...options,model:'gpt-6.1-astra'});
  assert.equal(denied.error.code,'POLICY_DENIED'); assert.equal(fs.existsSync(process.env.CODEX_FIXTURE_CAPTURE),false);
  const aborted = await execute('x',{...options,abortSignal:AbortSignal.abort()});
  assert.equal(aborted.status,'cancelled'); assert.equal(aborted.error.code,'ABORTED');
  assert.equal(fs.existsSync(process.env.CODEX_FIXTURE_CAPTURE),false);
  for (const [mode,expected] of [['abort','cancelled'],['deadline','timed_out']]) {
    process.env.CODEX_FIXTURE_MODE = 'interruptible';
    const controller = new AbortController(); const startedAt = Date.now();
    const result = await execute('x',{...options,abortSignal:controller.signal,timeoutMs:mode==='deadline'?1500:30000,
      onEvent:e=>{if(mode==='abort'&&e.type==='assistant_message')controller.abort();}});
    assert.equal(result.status,expected,mode); assert.equal(result.error.code,mode==='abort'?'ABORTED':'TIMEOUT');
    assert.equal(result.exitCode,0,`${mode}: the server exited by itself after the interrupted turn`);
    assert.ok(Date.now()-startedAt<2900,`${mode}: no wait for the forced-stop grace period`);
    assert.ok(result.output.includes('const answer = 42;'),mode);
    const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
    const interrupt = capture.records.find(r=>r.method==='turn/interrupt');
    assert.deepEqual(interrupt.params,{threadId:'11111111-aaaa-bbbb-cccc-123456789012',turnId:'019a0000-0000-7000-8000-000000000001'});
  }
  process.env.CODEX_FIXTURE_MODE = 'hang';
  const startedAt = Date.now();
  const timedOut = await execute('x',{...options,timeoutMs:1500});
  assert.equal(timedOut.status,'timed_out'); assert.equal(timedOut.error.code,'TIMEOUT');
  assert.ok(Date.now()-startedAt>=4500,'a server that ignores the interrupt is stopped after the grace period');
  assert.notEqual(timedOut.exitCode,0);
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
