const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {executeClaude,probe}=require('../../../src/backends/claude/adapter.ts');
const MODEL='claude-sonnet-4-6';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function withFixture(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-claude-')),capture=path.join(dir,'capture.json');
  const previous={...process.env};
  try{
    process.env.CLAUDE_PATH=path.resolve(__dirname,'../../fixtures/claude-cli/claude.cjs');process.env.CLAUDE_FIXTURE_CAPTURE=capture;
    delete process.env.CLAUDE_FIXTURE_SCENARIO;delete process.env.CLAUDE_FIXTURE_MODE;delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    const captured=()=>{if(!fs.existsSync(capture))return null;const value=JSON.parse(fs.readFileSync(capture,'utf8'));fs.unlinkSync(capture);return value;};
    await run({dir,captured});
  }finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);fs.rmSync(dir,{recursive:true,force:true});}
}

test('Claude runs restricted read-only print mode with streaming, a pinned session and the prompt as a stream-json message',()=>withFixture(async({dir,captured})=>{
  const events=[];
  const result=await executeClaude('Reply with OK',{cwd:dir,model:MODEL,reasoningEffort:'low',onEvent:e=>events.push(e)});
  assert.equal(result.status,'completed');assert.equal(result.output,'OK');
  assert.equal(result.model,'claude-haiku-4-5-20251001','the model reported by system/init, not the requested alias');
  const {argv,stdin,records,nested}=captured();assert.equal(stdin,'Reply with OK');assert.equal(nested,'1','the turn carries the nested-turn guard');assert.equal(argv[argv.indexOf('--model')+1],MODEL,'the model the controller selected');
  assert.deepEqual(records,[{type:'user',message:{role:'user',content:'Reply with OK'}}],'one user message, then stdin is closed');
  assert.equal(argv[argv.indexOf('--input-format')+1],'stream-json');
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
  const resumed=await executeClaude('What did I ask?',{cwd:dir,model:MODEL,nativeSessionId:session});
  assert.equal(resumed.status,'completed');assert.match(resumed.output,/OK/);assert.equal(resumed.nativeSessionId,session);
  const {argv}=captured();assert.equal(argv[argv.indexOf('--resume')+1],session);assert.ok(!argv.includes('--session-id'));
  const upper=await executeClaude('What did I ask?',{cwd:dir,model:MODEL,nativeSessionId:session.toUpperCase()});
  assert.equal(upper.status,'completed');assert.equal(upper.nativeSessionId,session);captured();
  const malformed=await executeClaude('x',{cwd:dir,model:MODEL,nativeSessionId:'--dangerously-skip-permissions'});
  assert.equal(malformed.error.code,'SESSION_INVALID');assert.equal(captured(),null);
  process.env.CLAUDE_FIXTURE_SCENARIO='resume-unknown';
  const unknown=await executeClaude('x',{cwd:dir,model:MODEL,nativeSessionId:'00000000-0000-4000-8000-000000000000'});
  assert.equal(unknown.error.code,'SESSION_INVALID');assert.equal(unknown.continuationAvailable,false);
}));

test('Claude returns a refused write as an answer and fails closed when write tools are exposed',()=>withFixture(async({dir})=>{
  process.env.CLAUDE_FIXTURE_SCENARIO='readonly-refusal';
  const events=[];const refused=await executeClaude('create a file',{cwd:dir,model:MODEL,onEvent:e=>events.push(e)});
  assert.equal(refused.status,'completed');assert.match(refused.output,/FAILED/);
  assert.ok(events.some(e=>e.type==='tool_started'&&e.name==='Read'));assert.ok(events.some(e=>e.type==='tool_finished'&&e.success));
  process.env.CLAUDE_FIXTURE_SCENARIO='write-tools';
  const exposed=await executeClaude('x',{cwd:dir,model:MODEL});
  assert.equal(exposed.status,'failed');assert.equal(exposed.error.code,'SANDBOX_UNAVAILABLE');assert.equal(exposed.output,'');assert.equal(exposed.continuationAvailable,false);
  process.env.CLAUDE_FIXTURE_SCENARIO='missing-init';
  const noInit=await executeClaude('x',{cwd:dir,model:MODEL});
  assert.equal(noInit.status,'failed');assert.equal(noInit.error.code,'SANDBOX_UNAVAILABLE');assert.equal(noInit.continuationAvailable,false);
}));

test('Claude tolerates unknown events, maps auth and model failures, and requires a result event',()=>withFixture(async({dir})=>{
  process.env.CLAUDE_FIXTURE_SCENARIO='unknown-events';
  const events=[];const tolerated=await executeClaude('x',{cwd:dir,model:MODEL,onEvent:e=>events.push(e)});
  assert.equal(tolerated.status,'completed');assert.equal(events.filter(e=>e.type==='warning').length,2);
  process.env.CLAUDE_FIXTURE_SCENARIO='auth-failed';
  const auth=await executeClaude('x',{cwd:dir,model:MODEL});assert.equal(auth.error.code,'AUTH_REQUIRED');assert.equal(auth.output,'');assert.equal(auth.continuationAvailable,false);
  process.env.CLAUDE_FIXTURE_SCENARIO='model-not-found';
  assert.equal((await executeClaude('x',{cwd:dir,model:'claude-sonnet-unknown'})).error.code,'MODEL_UNAVAILABLE');
  process.env.CLAUDE_FIXTURE_SCENARIO='no-result';
  assert.equal((await executeClaude('x',{cwd:dir,model:MODEL})).error.code,'PROTOCOL_ERROR');
  process.env.CLAUDE_FIXTURE_SCENARIO='startup-failure';
  const startup=await executeClaude('x',{cwd:dir,model:MODEL});
  assert.equal(startup.status,'failed');
  assert.equal(startup.error.code,'PROCESS_ERROR');
  assert.match(startup.error.message,/failed to initialize/);
  assert.equal(startup.continuationAvailable,false);
}));

test('Claude validates the model before argv and runs exactly the model it is given',()=>withFixture(async({dir,captured})=>{
  for(const model of ['--dangerously-skip-permissions','sonnet --tools Bash','','x'.repeat(129)]){
    assert.equal((await executeClaude('x',{cwd:dir,model})).error.code,'INPUT_LIMIT',model);
  }
  assert.equal((await executeClaude('x',{cwd:dir})).error.code,'INPUT_LIMIT','without a selected model the CLI never chooses one');
  assert.equal(captured(),null);
  // Consent is the controller's: it asks the user before it passes a model that needs approval.
  const expensive='claude-opus-4-6';
  const ran=await executeClaude('x',{cwd:dir,model:expensive});assert.equal(ran.status,'completed');
  const {argv}=captured();assert.equal(argv[argv.indexOf('--model')+1],expensive);
}));

test('Claude reports the model a name or its default runs from a local /usage run, without a model turn',()=>withFixture(async({captured})=>{
  const {observeModel}=require('../../../src/backends/claude/adapter.ts');
  assert.equal(await observeModel(),'claude-sonnet-4-6','the account default, from system/init');
  let {argv}=captured();assert.equal(argv.at(-1),'/usage');assert.ok(!argv.includes('--model'));assert.ok(argv.includes('--restricted'));
  assert.equal(argv[argv.indexOf('--tools')+1],'');assert.equal(argv[argv.indexOf('--output-format')+1],'stream-json');
  // An environment override such as ANTHROPIC_DEFAULT_SONNET_MODEL maps an alias to another model; the CLI says which.
  process.env.CLAUDE_FIXTURE_MODELS=JSON.stringify({sonnet:'claude-opus-4-6'});
  assert.equal(await observeModel('sonnet'),'claude-opus-4-6');({argv}=captured());assert.equal(argv[argv.indexOf('--model')+1],'sonnet');
  process.env.CLAUDE_FIXTURE_USAGE='model-turn';assert.equal(await observeModel('sonnet'),undefined,'a run that reached a model is not trusted');captured();
  process.env.CLAUDE_FIXTURE_USAGE='no-init';assert.equal(await observeModel('sonnet'),undefined,'no system/init, no model');captured();
  delete process.env.CLAUDE_FIXTURE_USAGE;
  assert.equal(await observeModel('--tools=Bash'),undefined);assert.equal(captured(),null,'an invalid name never reaches argv');
  process.env.CLAUDE_FIXTURE_VERSION='2.1.288 (Claude Code)';
  assert.equal(await observeModel(),undefined,'older CLI versions are not asked');assert.equal(captured(),null);
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
  const {inspectQuota}=require('../../../src/backends/claude/adapter.ts');
  const quota=await inspectQuota();
  assert.equal(quota.measured,true);assert.equal(quota.usedPercent,40);assert.equal(quota.window,'session');
  const {argv}=captured();assert.equal(argv.at(-1),'/usage');assert.ok(!argv.includes('--model'),'no model is named for a local command');assert.equal(argv[argv.indexOf('--tools')+1],'');assert.ok(argv.includes('--restricted'));
  process.env.CLAUDE_FIXTURE_USAGE='api-key';assert.equal(await inspectQuota(),undefined);captured();
  process.env.CLAUDE_FIXTURE_USAGE='model-turn';assert.equal(await inspectQuota(),undefined,'a model turn is never reported as quota');captured();
  delete process.env.CLAUDE_FIXTURE_USAGE;
  process.env.CLAUDE_FIXTURE_VERSION='2.1.259 (Claude Code)';
  assert.equal(await inspectQuota(),undefined,'unverified older CLI versions skip local /usage');
  assert.equal(captured(),null);
  delete process.env.CLAUDE_FIXTURE_VERSION;
  process.env.coagent8_QUOTA_CACHE=path.join(dir,'quota-cache.json');
  const {inspectQuotas}=require('../../../src/backends/availability.ts');const {adapterRegistry}=require('../../../src/backends/registry.ts');
  const original={...adapterRegistry};
  try{
    for(const id of ['codex','agy'])adapterRegistry[id]={id,name:id,probe:async()=>({installed:false}),execute:async()=>{throw new Error('not executed');}};
    const report=await inspectQuotas(true);
    assert.equal(report.claude.measured,true);assert.equal(report.claude.headroomPercent,60);assert.equal(report.claude.status,'operational');
    const overridden=await inspectQuotas(true,{claude:{installed:true}});assert.equal(overridden.claude.measured,true,'cached measurement is kept');
    captured();
    await inspectQuotas(true,{claude:{installed:true}});assert.equal(captured(),null,'caller-supplied probes do not trigger native reads by default');
  }finally{Object.assign(adapterRegistry,original);}
}));

test('Claude cancellation and deadlines interrupt the turn over stream-json before any forced stop',()=>withFixture(async({dir,captured})=>{
  for(const [mode,expected] of [['abort','cancelled'],['deadline','timed_out']]){
    process.env.CLAUDE_FIXTURE_SCENARIO='interruptible';
    const controller=new AbortController();const events=[];const startedAt=Date.now();
    const result=await executeClaude('Count slowly',{cwd:dir,model:MODEL,abortSignal:controller.signal,timeoutMs:mode==='deadline'?1500:30000,
      onEvent:e=>{events.push(e);if(mode==='abort'&&e.type==='assistant_message')controller.abort();}});
    assert.equal(result.status,expected,mode);assert.equal(result.error.code,mode==='abort'?'ABORTED':'TIMEOUT');
    assert.equal(result.exitCode,1,`${mode}: Claude exited by itself after the interrupted result`);
    assert.ok(Date.now()-startedAt<2900,`${mode}: no wait for the forced-stop grace period`);
    const {records}=captured();
    assert.deepEqual(records.map(r=>r.type),['user','control_request'],mode);
    assert.equal(records[1].request.subtype,'interrupt');
    assert.equal(events.filter(e=>e.type==='warning').length,0,`${mode}: control_response is a known event`);
  }
  process.env.CLAUDE_FIXTURE_SCENARIO='ignore-interrupt';
  const controller=new AbortController();const startedAt=Date.now();
  const stuck=await executeClaude('x',{cwd:dir,model:MODEL,abortSignal:controller.signal,onEvent:e=>{if(e.type==='assistant_message')controller.abort();}});
  assert.equal(stuck.status,'cancelled');assert.ok(Date.now()-startedAt>=3000,'a CLI that ignores the interrupt is stopped after the grace period');
  assert.notEqual(stuck.exitCode,1,'the stuck CLI did not exit by itself');
}));

test('Claude lists its models and aliases from the stream-json initialize response, without a user message or turn',()=>withFixture(async({captured})=>{
  const {listModels}=require('../../../src/backends/claude/adapter.ts');
  const catalog=await listModels({executionSupported:true});
  assert.deepEqual(catalog,{source:'claude stream-json initialize',acceptsUnlisted:true,models:[
    {id:'claude-sonnet-4-6',efforts:['low','medium','high','xhigh','max'],aliases:['default','sonnet'],isDefault:true},
    {id:'claude-opus-4-6',efforts:['low','medium','high','xhigh','max'],aliases:['opus']},
    {id:'claude-haiku-4-5-20251001',efforts:[],aliases:['haiku']},
  ]});
  const {argv,records,stdin}=captured();
  assert.deepEqual(records.map(r=>[r.type,r.request?.subtype]),[['control_request','initialize']],'only the control request; stdin closes before any user message');
  assert.equal(stdin,'');
  assert.ok(argv.includes('--restricted'));assert.equal(argv[argv.indexOf('--tools')+1],'');assert.equal(argv[argv.indexOf('--input-format')+1],'stream-json');
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--mcp-config')+1]),{mcpServers:{}});assert.ok(!argv.includes('--model'));
  process.env.CLAUDE_FIXTURE_MODELS=JSON.stringify({sonnet:'claude-sonnet-5-5',default:'claude-sonnet-5-5'});
  const remapped=await listModels({executionSupported:true});captured();
  assert.deepEqual(remapped.models.find(m=>m.id==='claude-sonnet-5-5'),{id:'claude-sonnet-5-5',efforts:['low','medium','high','xhigh','max'],aliases:['default','sonnet'],isDefault:true},'an alias follows what the CLI resolves it to');
  process.env.CLAUDE_FIXTURE_CATALOG='error';
  assert.equal(await listModels({executionSupported:true}),undefined,'an error answer is no catalog');captured();
  assert.equal(await listModels({executionSupported:false}),undefined,'an unsupported version is not asked');assert.equal(captured(),null);
}));

test('Claude initialize entries without a valid name are left out; none at all is no catalog',()=>{
  const {parseClaudeModels}=require('../../../src/backends/claude/adapter.ts');
  assert.equal(parseClaudeModels({models:[]}),undefined);
  assert.equal(parseClaudeModels({}),undefined);
  assert.deepEqual(parseClaudeModels({models:[{value:'--tools=Bash'},{value:'x',resolvedModel:'bad name'},{value:'claude-x',supportedEffortLevels:['low','turbo',3]}]}).models,[{id:'claude-x',efforts:['low']}]);
});

test('selection resolves a listed Claude alias through the catalog and observes only an unlisted name',()=>withFixture(async({captured})=>{
  const {selectModel}=require('../../../src/execution/selection.ts');
  const {probeBackend,readModelCatalog}=require('../../../src/backends/probe-cache.ts');
  const probe=await probeBackend('claude',{fresh:true});await readModelCatalog('claude',{fresh:true});captured();
  assert.deepEqual(await selectModel('claude',probe,{model:'haiku'}),{model:'claude-haiku-4-5-20251001',source:'request'});
  assert.deepEqual(await selectModel('claude',probe),{model:'claude-sonnet-4-6',source:'catalog'},'the account default is the default entry');
  assert.equal(captured(),null,'no CLI run: the catalog answers');
  assert.deepEqual(await selectModel('claude',probe,{model:'claude-opus-4-1'}),{model:'claude-opus-4-1',source:'request'});
  assert.equal(captured().argv.at(-1),'/usage','an unlisted name is resolved by the CLI itself');
}));

test('EXEC-001-T08d: probe, listModels, observeModel, and inspectQuota abort deterministically via abortSignal and release handles', () => withFixture(async ({ dir }) => {
  const { ToolError } = require('../../../src/contracts/index.ts');
  const { activeProcesses } = require('../../../src/execution/process.ts');
  const { claudeAdapter, probe, listModels, observeModel, inspectQuota } = require('../../../src/backends/claude/adapter.ts');

  async function waitForActiveProcess(timeoutMs = 3000) {
    const start = Date.now();
    while (activeProcesses.size === 0 && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 10));
    }
  }

  // 1. Backward compatibility without context
  const normalProbe = await probe();
  assert.equal(normalProbe.installed, true);
  const normalCatalog = await listModels({ executionSupported: true });
  assert.ok(normalCatalog?.models.length > 0);
  assert.equal(normalCatalog?.source, 'claude stream-json initialize');
  const normalObserved = await observeModel('sonnet', { executionSupported: true, version: '2.1.289' });
  assert.equal(normalObserved, 'claude-sonnet-4-6');
  const normalQuota = await inspectQuota({ executionSupported: true, version: '2.1.289' });
  assert.ok(normalQuota?.measured);

  // 2. Pre-aborted signal rejects immediately before launching process
  const preController = new AbortController();
  preController.abort();
  await assert.rejects(
    probe({ abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    listModels(undefined, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    observeModel(undefined, undefined, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    inspectQuota(undefined, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    claudeAdapter.probe({ abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  assert.equal(activeProcesses.size, 0, 'no process launched for pre-aborted reads');

  // 3. Pre-expired budget rejects with TIMEOUT before launch
  const expiredBudget = { isExecutionExpired: () => true, isTimedOut: () => true, executionSignal: new AbortController().signal };
  await assert.rejects(
    probe({ budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    listModels(undefined, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    observeModel(undefined, undefined, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    inspectQuota(undefined, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  assert.equal(activeProcesses.size, 0, 'no process launched for expired budgets');

  // 4. Stalled probe (--version) aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CLAUDE_FIXTURE_MODE = 'hang-probe';
  try {
    const probeCtrl = new AbortController();
    const probePromise = probe({ abortSignal: probeCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'probe process is running');
    probeCtrl.abort();
    await assert.rejects(probePromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'probe process cleaned up after abort');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 5. Stalled probe (auth status) aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CLAUDE_FIXTURE_MODE = 'hang-auth';
  try {
    const authCtrl = new AbortController();
    const authPromise = probe({ abortSignal: authCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'auth status process is running');
    authCtrl.abort();
    await assert.rejects(authPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'auth process cleaned up after abort');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 6. Stalled catalog read aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CLAUDE_FIXTURE_MODE = 'hang-catalog';
  try {
    const catalogCtrl = new AbortController();
    const catalogPromise = listModels({ executionSupported: true }, { abortSignal: catalogCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'catalog process is running');
    catalogCtrl.abort();
    await assert.rejects(catalogPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'catalog process cleaned up after abort');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 7. Stalled observeModel aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CLAUDE_FIXTURE_MODE = 'hang-usage';
  try {
    const observeCtrl = new AbortController();
    const observePromise = observeModel('sonnet', { executionSupported: true, version: '2.1.289' }, { abortSignal: observeCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'observe process is running');
    observeCtrl.abort();
    await assert.rejects(observePromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'observe process cleaned up after abort');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 8. Stalled inspectQuota aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CLAUDE_FIXTURE_MODE = 'hang-usage';
  try {
    const quotaCtrl = new AbortController();
    const quotaPromise = inspectQuota({ executionSupported: true, version: '2.1.289' }, { abortSignal: quotaCtrl.signal });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'quota process is running');
    quotaCtrl.abort();
    await assert.rejects(quotaPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'quota process cleaned up after abort');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 9. Fallback to context?.budget?.executionSignal
  process.env.CLAUDE_FIXTURE_MODE = 'hang-probe';
  try {
    const budgetCtrl = new AbortController();
    const liveBudget = { isExecutionExpired: () => false, isTimedOut: () => false, executionSignal: budgetCtrl.signal };
    const budgetProbePromise = probe({ budget: liveBudget });
    await waitForActiveProcess();
    assert.ok(activeProcesses.size >= 1, 'probe process is running under budget');
    budgetCtrl.abort();
    await assert.rejects(budgetProbePromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'probe process cleaned up after budget abort');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 10. Stalled probe ended by timeoutMs cleans up process and settles
  process.env.CLAUDE_FIXTURE_MODE = 'hang-probe';
  try {
    const timedOutProbe = await probe({ timeoutMs: 150 });
    assert.equal(timedOutProbe.installed, false);
    assert.equal(activeProcesses.size, 0, 'timed-out probe process cleaned up');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 11. Stalled usage ended by timeoutMs cleans up process and returns undefined
  process.env.CLAUDE_FIXTURE_MODE = 'hang-usage';
  try {
    const timedOutQuota = await inspectQuota({ executionSupported: true, version: '2.1.289' }, { timeoutMs: 150 });
    assert.equal(timedOutQuota, undefined);
    assert.equal(activeProcesses.size, 0, 'timed-out quota process cleaned up');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 12. Stalled catalog ended by timeoutMs cleans up channel and process and returns undefined
  process.env.CLAUDE_FIXTURE_MODE = 'hang-catalog';
  try {
    const timedOutCatalog = await listModels({ executionSupported: true }, { timeoutMs: 150 });
    assert.equal(timedOutCatalog, undefined);
    assert.equal(activeProcesses.size, 0, 'timed-out catalog process cleaned up');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 13. Stalled catalog after channel close: channel.close() was called, but process hangs on EOF until timeout
  process.env.CLAUDE_FIXTURE_MODE = 'hang-after-channel-close';
  try {
    const hungAfterClose = await listModels({ executionSupported: true }, { timeoutMs: 150 });
    assert.equal(hungAfterClose, undefined, 'stalled process after channel close safely terminated on timeout');
    assert.equal(activeProcesses.size, 0, 'process after channel close cleaned up');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }

  // 14. Stalled probe ended by budget expiration during run throws TIMEOUT
  process.env.CLAUDE_FIXTURE_MODE = 'hang-probe';
  try {
    let expired = false;
    const expCtrl = new AbortController();
    const expBudget = {
      isExecutionExpired: () => expired,
      isTimedOut: () => expired,
      executionSignal: expCtrl.signal,
    };
    const expPromise = probe({ budget: expBudget, timeoutMs: 150 });
    await waitForActiveProcess();
    expired = true;
    expCtrl.abort();
    await assert.rejects(expPromise, err => err instanceof ToolError && err.code === 'TIMEOUT');
    assert.equal(activeProcesses.size, 0, 'expired budget process cleaned up');
  } finally {
    delete process.env.CLAUDE_FIXTURE_MODE;
  }
}));

test('FEEDBACK-060h: deterministic running-turn handshake confirms live Claude turn before cancellation, releases process resources, and resumes on a subsequent turn', () => withFixture(async ({ dir, captured }) => {
  const { activeProcesses, terminateAllProcesses } = require('../../../src/execution/process.ts');
  const readyFile = path.join(dir, 'ready.json');
  process.env.CLAUDE_FIXTURE_SCENARIO = 'interruptible';
  process.env.CLAUDE_FIXTURE_READY = readyFile;

  const controller = new AbortController();
  let turn1Settled = false;
  let turn1Promise;
  try {
    turn1Promise = executeClaude('Analyze while running', {
      cwd: dir,
      model: MODEL,
      abortSignal: controller.signal,
      timeoutMs: 30000,
    }).finally(() => {
      turn1Settled = true;
    });

    const deadline = Date.now() + 5000;
    while (!fs.existsSync(readyFile)) {
      if (turn1Settled) {
        const early = await turn1Promise;
        assert.fail(`Turn 1 settled before ready handshake: ${JSON.stringify(early)}`);
      }
      if (Date.now() >= deadline) {
        assert.fail('Timed out waiting for CLAUDE_FIXTURE_READY handshake');
      }
      await new Promise(r => setTimeout(r, 15));
    }

    const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    assert.equal(ready.state, 'running');
    assert.equal(ready.scenario, 'interruptible');
    assert.match(ready.sessionId, UUID);
    assert.equal(turn1Settled, false, 'natural completion must not occur before cancellation');
    assert.ok([...activeProcesses].some(proc => proc.pid === ready.pid), 'live Claude process must be tracked in activeProcesses');

    controller.abort();
    const cancelled = await turn1Promise;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.error?.code, 'ABORTED');
    assert.equal(cancelled.exitCode, 1);
    assert.equal(cancelled.nativeSessionId, ready.sessionId);
    assert.equal(cancelled.continuationAvailable, true, 'initialized turn with partial assistant output remains resumable');
    assert.equal(activeProcesses.size, 0, 'all owned process handles released after cancellation');

    const turn1Capture = captured();
    assert.ok(turn1Capture, 'turn 1 capture recorded');
    assert.deepEqual(turn1Capture.records.map(r => r.type), ['user', 'control_request']);
    assert.equal(turn1Capture.records[1].request.subtype, 'interrupt');

    fs.rmSync(readyFile, { force: true });
    delete process.env.CLAUDE_FIXTURE_READY;
    delete process.env.CLAUDE_FIXTURE_SCENARIO;

    const resumed = await executeClaude('Follow up on the same session', {
      cwd: dir,
      model: MODEL,
      nativeSessionId: cancelled.nativeSessionId,
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.isError, false);
    assert.equal(resumed.nativeSessionId, ready.sessionId);
    assert.match(resumed.output, /OK/);
    assert.equal(activeProcesses.size, 0);

    const turn2Capture = captured();
    assert.ok(turn2Capture, 'turn 2 capture recorded');
    assert.equal(turn2Capture.argv[turn2Capture.argv.indexOf('--resume') + 1], ready.sessionId);
    assert.ok(!turn2Capture.argv.includes('--session-id'));
  } finally {
    controller.abort();
    delete process.env.CLAUDE_FIXTURE_READY;
    delete process.env.CLAUDE_FIXTURE_SCENARIO;
    await terminateAllProcesses();
    await turn1Promise?.catch(() => {});
  }
}));

test('ENVELOPE-001: Claude forwards a stop at the output length limit as lengthLimited',()=>withFixture(async({dir})=>{
  const done=await executeClaude('Reply with OK',{cwd:dir,model:MODEL});
  assert.equal(done.status,'completed');assert.equal(done.lengthLimited,false,'end_turn in the recorded result');
  process.env.CLAUDE_FIXTURE_SCENARIO='max-tokens';
  const limited=await executeClaude('Reply with OK',{cwd:dir,model:MODEL});
  assert.equal(limited.status,'completed');assert.equal(limited.lengthLimited,true);
}));
