const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-execution-pipeline-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { sessionHistory, deleteHistory } = require('../../src/sessions/history.ts');
const { getSession } = require('../../src/sessions/session.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('one pipeline pins provider, persists two turns and canonical messages, preserves Markdown, activity and errors',async()=>{
  const original=adapterRegistry.gemini;
  adapterRegistry.gemini={id:'gemini',name:'fixture',probe:async()=>({installed:true,version:'fixture',config:{defaultModel:'fixture-model'}}),execute:async(prompt,options)=>{
    options.onEvent({type:'user_message',text:'CLI echo must be ignored'});
    options.onEvent({type:'assistant_delta',messageId:'m',text:'Draft'});
    options.onEvent({type:'assistant_message',messageId:'m',text:'Final **answer**\n```js\nconst answer = 42;\n```\nsk-fixtureSecret1234567890abcdef'});
    options.onEvent({type:'tool_started',toolId:'t',name:'read_file'});
    options.onEvent({type:'tool_finished',toolId:'t',name:'read_file',success:true});
    return {status:'completed',isError:false,output:'Final **answer**\n```js\nconst answer = 42;\n```\nsk-fixtureSecret1234567890abcdef',nativeSessionId:'11111111-aaaa-bbbb-cccc-123456789012',model:'fixture-model',truncated:false,continuationAvailable:true};
  }};
  try {
    saveConfig({defaultBackend:'gemini',routing:{strategy:'fixed',allowedBackends:['gemini']}});
    const first=await executeTask('PROMPT_WITH_PRIVATE_SNAPSHOT','User first turn',{backend:'gemini'},tempDir);
    assert.equal(first.isError,false); assert.match(first.content[0].text,/ · 1 op · /); assert.ok(first.content[0].text.includes('const answer = 42;'));
    const handle=readResult(first).sessionHandle;
    const second=await executeTask('second prompt','User second turn',{session_handle:handle},tempDir);
    assert.equal(readResult(second).turn,2);
    const page=await sessionHistory(handle,tempDir);
    assert.equal(page.events.filter(e=>e.type==='user_message').length,2);
    assert.equal(page.events.filter(e=>e.type==='assistant_message').length,2);
    assert.ok(!JSON.stringify(page).includes('PROMPT_WITH_PRIVATE')); assert.ok(!JSON.stringify(page).includes('fixtureSecret')); assert.ok(!JSON.stringify(page).includes('Draft'));
    assert.equal(page.events.filter(e=>e.type==='turn_finished').length,2);
    await assert.rejects(executeTask('x','x',{session_handle:handle,backend:'codex'},tempDir),/cannot switch provider/);
    await assert.rejects(sessionHistory(handle,path.join(tempDir,'different')),/workspace/);
    const pages=[];let cursor;
    do {const p=await sessionHistory(handle,tempDir,cursor,2);pages.push(...p.events);cursor=p.nextCursor;}while(cursor);
    assert.deepEqual(pages.map(e=>e.eventId),page.events.map(e=>e.eventId));
    const savedModel=getSession(handle).model;
    assert.equal(savedModel,'fixture-model'); assert.equal(getSession(handle).activePid,null);
    await deleteHistory(handle,tempDir); await assert.rejects(sessionHistory(handle,tempDir),/not found/);
  } finally {adapterRegistry.gemini=original;}
});

test('pipeline enforces effective defaults and terminal errors; rate limits preserve native continuation and invalid resume does not',async()=>{
  const original=adapterRegistry.codex;let calls=0,mode='success';
  adapterRegistry.codex={id:'codex',name:'fixture',probe:async()=>({installed:true,version:'fixture',config:{defaultModel:'gpt-6.1-astra'}}),execute:async(_prompt,options)=>{
    calls++;options.onEvent({type:'assistant_message',messageId:'m',text:'public',privateReasoning:'MUST_NOT_PERSIST',parameters:{token:'MUST_NOT_PERSIST'}});
    const result={status:'completed',isError:false,output:'public',nativeSessionId:'native_fixture',model:'gpt-6.1-astra',truncated:false,continuationAvailable:true};
    if(mode==='missing')delete result.status;
    if(mode==='contradiction')result.isError=true;
    if(mode==='rate'||mode==='invalid')Object.assign(result,{status:'failed',isError:true,error:{code:mode==='rate'?'RATE_LIMITED':'SESSION_INVALID',message:'synthetic provider error',retryable:mode==='rate'}});
    return result;
  }};
  try {
    saveConfig({defaultBackend:'codex',routing:{strategy:'fixed',allowedBackends:['codex']}});
    const cancelled=new AbortController();cancelled.abort();await assert.rejects(executeTask('x','x',{},tempDir,cancelled.signal),{code:'ABORTED'});assert.equal(calls,0);
    await assert.rejects(executeTask('x','x',{},tempDir),{code:'POLICY_DENIED'});assert.equal(calls,0);
    const approve={askConsent:async()=>true};
    const first=await executeTask('x','first',{},tempDir,null,null,approve),handle=readResult(first).sessionHandle;
    await assert.rejects(executeTask('x','second',{session_handle:handle},tempDir),{code:'POLICY_DENIED'});assert.equal(calls,1);
    mode='rate';const rate=await executeTask('x','rate',{session_handle:handle},tempDir,null,null,approve);assert.equal(readResult(rate).error.code,'RATE_LIMITED');assert.equal(getSession(handle).threadId,'native_fixture');
    assert.equal(require('../../src/backends/availability.ts').readQuotaCache().data.codex.status,'rate_limited');
    mode='invalid';const invalid=await executeTask('x','invalid',{session_handle:handle},tempDir,null,null,approve);assert.equal(readResult(invalid).error.code,'SESSION_INVALID');assert.equal(readResult(invalid).continuationAvailable, false);assert.equal(getSession(handle),null);
    const history=await sessionHistory(handle,tempDir);assert.ok(!JSON.stringify(history).includes('MUST_NOT_PERSIST'));assert.equal(history.events.at(-1).status,'failed');
    for(mode of ['missing','contradiction']) {const r=await executeTask('x','x',{},tempDir,null,null,approve);assert.equal(r.isError,true);assert.equal(readResult(r).error.code,'PROTOCOL_ERROR');assert.equal(getSession(readResult(r).sessionHandle).activePid,null);}
  }finally{adapterRegistry.codex=original;saveConfig({defaultBackend:'gemini',routing:{strategy:'fixed',allowedBackends:['gemini']}});}
});
