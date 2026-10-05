const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {executeClaude,probe}=require('../src/backends/claude.adapter.ts');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function withFixture(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-claude-')),capture=path.join(dir,'capture.json');
  const previous={...process.env};
  try{
    process.env.CLAUDE_PATH=path.resolve(__dirname,'fixtures/claude-cli/claude.cjs');process.env.CLAUDE_FIXTURE_CAPTURE=capture;
    delete process.env.CLAUDE_FIXTURE_SCENARIO;delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    const captured=()=>{if(!fs.existsSync(capture))return null;const value=JSON.parse(fs.readFileSync(capture,'utf8'));fs.unlinkSync(capture);return value;};
    await run({dir,captured});
  }finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
}

test('Claude runs restricted read-only print mode with streaming, a pinned session and the prompt on stdin',()=>withFixture(async({dir,captured})=>{
  const events=[];
  const result=await executeClaude('Reply with OK',{cwd:dir,reasoningEffort:'low',onEvent:e=>events.push(e)});
  assert.equal(result.status,'completed');assert.equal(result.output,'OK');assert.equal(result.model,'sonnet');
  const {argv,stdin}=captured();assert.equal(stdin,'Reply with OK');
  assert.ok(argv.includes('--restricted'));assert.ok(!argv.includes('--bare'));assert.equal(argv[argv.indexOf('--tools')+1],'Read,Glob,Grep');
  assert.equal(argv[argv.indexOf('--permission-mode')+1],'dontAsk');assert.equal(argv[argv.indexOf('--permission-prompts')+1],'none');
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings')+1]),{disableAllHooks:true});assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--output-format')+1],'stream-json');assert.ok(argv.includes('--include-partial-messages'));
  assert.equal(argv[argv.indexOf('--effort')+1],'low');
  const session=argv[argv.indexOf('--session-id')+1];assert.match(session,UUID);assert.ok(!argv.includes('--resume'));
  assert.equal(result.nativeSessionId,session);assert.equal(result.continuationAvailable,true);
  assert.ok(events.some(e=>e.type==='assistant_delta'&&e.text==='OK'));assert.ok(events.some(e=>e.type==='assistant_message'&&e.text==='OK'));
  assert.equal(result.usage.outputTokens,48);
}));

test('Claude continues a native session with --resume and rejects malformed or unknown sessions',()=>withFixture(async({dir,captured})=>{
  const session='859bbd7d-81ae-440c-b76a-a80e596d0fa5';
  const resumed=await executeClaude('What did I ask?',{cwd:dir,nativeSessionId:session});
  assert.equal(resumed.status,'completed');assert.match(resumed.output,/OK/);assert.equal(resumed.nativeSessionId,session);
  const {argv}=captured();assert.equal(argv[argv.indexOf('--resume')+1],session);assert.ok(!argv.includes('--session-id'));
  const upper=await executeClaude('What did I ask?',{cwd:dir,nativeSessionId:session.toUpperCase()});
  assert.equal(upper.status,'completed');assert.equal(upper.nativeSessionId,session);captured();
  const malformed=await executeClaude('x',{cwd:dir,nativeSessionId:'--dangerously-skip-permissions'});
  assert.equal(malformed.error.code,'SESSION_INVALID');assert.equal(captured(),null);
  process.env.CLAUDE_FIXTURE_SCENARIO='resume-unknown';
  const unknown=await executeClaude('x',{cwd:dir,nativeSessionId:'00000000-0000-4000-8000-000000000000'});
  assert.equal(unknown.error.code,'SESSION_INVALID');assert.equal(unknown.continuationAvailable,false);
}));

test('Claude returns a refused write as an answer and fails closed when write tools are exposed',()=>withFixture(async({dir})=>{
  process.env.CLAUDE_FIXTURE_SCENARIO='readonly-refusal';
  const events=[];const refused=await executeClaude('create a file',{cwd:dir,onEvent:e=>events.push(e)});
  assert.equal(refused.status,'completed');assert.match(refused.output,/FAILED/);
  assert.ok(events.some(e=>e.type==='tool_started'&&e.name==='Read'));assert.ok(events.some(e=>e.type==='tool_finished'&&e.success));
  process.env.CLAUDE_FIXTURE_SCENARIO='write-tools';
  const exposed=await executeClaude('x',{cwd:dir});
  assert.equal(exposed.status,'failed');assert.equal(exposed.error.code,'SANDBOX_UNAVAILABLE');assert.equal(exposed.output,'');assert.equal(exposed.continuationAvailable,false);
  process.env.CLAUDE_FIXTURE_SCENARIO='missing-init';
  const noInit=await executeClaude('x',{cwd:dir});
  assert.equal(noInit.status,'failed');assert.equal(noInit.error.code,'SANDBOX_UNAVAILABLE');assert.equal(noInit.continuationAvailable,false);
}));

test('Claude tolerates unknown events, maps auth and model failures, and requires a result event',()=>withFixture(async({dir})=>{
  process.env.CLAUDE_FIXTURE_SCENARIO='unknown-events';
  const events=[];const tolerated=await executeClaude('x',{cwd:dir,onEvent:e=>events.push(e)});
  assert.equal(tolerated.status,'completed');assert.equal(events.filter(e=>e.type==='warning').length,2);
  process.env.CLAUDE_FIXTURE_SCENARIO='auth-failed';
  const auth=await executeClaude('x',{cwd:dir});assert.equal(auth.error.code,'AUTH_REQUIRED');assert.equal(auth.output,'');assert.equal(auth.continuationAvailable,false);
  process.env.CLAUDE_FIXTURE_SCENARIO='model-not-found';
  assert.equal((await executeClaude('x',{cwd:dir,model:'claude-sonnet-unknown'})).error.code,'MODEL_UNAVAILABLE');
  process.env.CLAUDE_FIXTURE_SCENARIO='no-result';
  assert.equal((await executeClaude('x',{cwd:dir})).error.code,'PROTOCOL_ERROR');
  process.env.CLAUDE_FIXTURE_SCENARIO='startup-failure';
  const startup=await executeClaude('x',{cwd:dir});
  assert.equal(startup.status,'failed');
  assert.equal(startup.error.code,'PROCESS_ERROR');
  assert.match(startup.error.message,/failed to initialize/);
  assert.equal(startup.continuationAvailable,false);
}));

test('Claude validates the model before argv and keeps top-tier governance',()=>withFixture(async({dir,captured})=>{
  for(const model of ['--dangerously-skip-permissions','sonnet --tools Bash','','x'.repeat(129)]){
    assert.equal((await executeClaude('x',{cwd:dir,model})).error.code,'POLICY_DENIED',model);
  }
  assert.equal(captured(),null);
  process.env.ANTHROPIC_MODEL='claude-opus-4-6';
  assert.equal((await executeClaude('x',{cwd:dir})).status,'completed');assert.equal(captured().argv.includes('sonnet'),true);
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL='claude-opus-4-6';
  assert.equal((await executeClaude('x',{cwd:dir})).error.code,'POLICY_DENIED');assert.equal(captured(),null);
  const confirmed=await executeClaude('x',{cwd:dir,userConfirmed:true});assert.equal(confirmed.status,'completed');assert.equal(confirmed.model,'claude-opus-4-6');captured();
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL='--tools=Bash';
  assert.equal((await executeClaude('x',{cwd:dir})).error.code,'POLICY_DENIED');delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  for(const model of ['opus','opusplan','opus[1m]','best','default'])assert.equal((await executeClaude('x',{cwd:dir,model})).error.code,'POLICY_DENIED',model);
  assert.equal(captured(),null);
}));

test('Claude probe reads version and login state without a model call',()=>withFixture(async({captured})=>{
  const ready=await probe();
  assert.equal(ready.installed,true);assert.equal(ready.executionSupported,true);assert.equal(ready.authStatus,'authenticated');assert.equal(ready.authMethod,'claude.ai');
  assert.deepEqual(ready.capabilities,{resume:true,streaming:true,readOnlyVerified:true,reasoningEffort:true});assert.equal(captured(),null);
  process.env.CLAUDE_FIXTURE_LOGGED_IN='0';
  assert.equal((await probe()).authStatus,'unauthenticated');
  process.env.CLAUDE_FIXTURE_VERSION='2.1.200 (Claude Code)';
  const old=await probe();assert.equal(old.executionSupported,false);assert.equal(old.capabilities.readOnlyVerified,false);
}));

test('Claude reads subscription quota from /usage without a model turn and feeds quota-aware routing',()=>withFixture(async({dir,captured})=>{
  const {inspectQuota}=require('../src/backends/claude.adapter.ts');
  const quota=await inspectQuota();
  assert.equal(quota.measured,true);assert.equal(quota.usedPercent,67);assert.equal(quota.window,'session');
  const {argv}=captured();assert.equal(argv.at(-1),'/usage');assert.equal(argv[argv.indexOf('--model')+1],'haiku');assert.equal(argv[argv.indexOf('--tools')+1],'');assert.ok(argv.includes('--restricted'));
  process.env.CLAUDE_FIXTURE_USAGE='api-key';assert.equal(await inspectQuota(),undefined);captured();
  process.env.CLAUDE_FIXTURE_USAGE='model-turn';assert.equal(await inspectQuota(),undefined,'a model turn is never reported as quota');captured();
  delete process.env.CLAUDE_FIXTURE_USAGE;
  process.env.CLAUDE_FIXTURE_VERSION='2.1.259 (Claude Code)';
  assert.equal(await inspectQuota(),undefined,'unverified older CLI versions skip local /usage');
  assert.equal(captured(),null);
  delete process.env.CLAUDE_FIXTURE_VERSION;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-opus-4-6';assert.equal(await inspectQuota(),undefined);assert.equal(captured(),null);delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  process.env.coagent8_QUOTA_CACHE=path.join(dir,'quota-cache.json');
  const {inspectQuotas}=require('../src/backends/availability.ts');const {adapterRegistry}=require('../src/backends/registry.ts');
  const original={...adapterRegistry};
  try{
    for(const id of ['codex','gemini'])adapterRegistry[id]={id,name:id,probe:async()=>({installed:false}),execute:async()=>{throw new Error('not executed');}};
    const report=await inspectQuotas(true);
    assert.equal(report.claude.measured,true);assert.equal(report.claude.headroomPercent,33);assert.equal(report.claude.status,'operational');
    const overridden=await inspectQuotas(true,{claude:{installed:true}});assert.equal(overridden.claude.measured,true,'cached measurement is kept');
    captured();
    await inspectQuotas(true,{claude:{installed:true}});assert.equal(captured(),null,'caller-supplied probes do not trigger native reads by default');
  }finally{Object.assign(adapterRegistry,original);}
}));
