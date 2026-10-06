const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-history-'));
process.env.coagent8_DIR=dir;
const {adapterRegistry}=require('../src/backends/registry.ts');
const {executeTask}=require('../src/execution/controller.ts');
const {sessionHistory,createHistoryWriter,deleteHistory}=require('../src/sessions/history.ts');
const {createSession,getSession,acquireSessionTurn,releaseSessionTurn,getSessionFilePath,updateSession,canonicalPath}=require('../src/sessions/session.ts');
const {withFileLock}=require('../src/sessions/lock.ts');
const {saveConfig}=require('../src/config.ts');
const {createToolDefinitions,validateToolArguments}=require('../src/server.ts');
const {checkModelGovernance}=require('../src/backends/policy.ts');
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test('one pipeline pins provider, persists two turns and canonical messages, preserves Markdown, activity and errors',async()=>{
  const original=adapterRegistry.gemini;
  adapterRegistry.gemini={id:'gemini',name:'fixture',probe:async()=>({installed:true,version:'fixture'}),execute:async(prompt,options)=>{
    options.onEvent({type:'user_message',text:'CLI echo must be ignored'});
    options.onEvent({type:'assistant_delta',messageId:'m',text:'Draft'});
    options.onEvent({type:'assistant_message',messageId:'m',text:'Final **answer**\n```js\nconst answer = 42;\n```\napi_key=fixtureSecret'});
    options.onEvent({type:'tool_started',toolId:'t',name:'read_file'});
    options.onEvent({type:'tool_finished',toolId:'t',name:'read_file',success:true});
    return {status:'completed',isError:false,output:'Final **answer**\n```js\nconst answer = 42;\n```\napi_key=fixtureSecret',nativeSessionId:'11111111-aaaa-bbbb-cccc-123456789012',model:'fixture-model',truncated:false,continuationAvailable:true};
  }};
  try {
    saveConfig({defaultBackend:'gemini',routing:{strategy:'fixed',allowedBackends:['gemini']}});
    const first=await executeTask('PROMPT_WITH_PRIVATE_SNAPSHOT','User first turn',{backend:'gemini'},dir);
    assert.equal(first.isError,false); assert.equal(first.structuredContent.activity.toolCount,1); assert.ok(first.content[0].text.includes('const answer = 42;'));
    const handle=first.structuredContent.sessionHandle;
    const second=await executeTask('second prompt','User second turn',{session_handle:handle},dir);
    assert.equal(second.structuredContent.turn,2);
    const page=await sessionHistory(handle,dir);
    assert.equal(page.events.filter(e=>e.type==='user_message').length,2);
    assert.equal(page.events.filter(e=>e.type==='assistant_message').length,2);
    assert.ok(!JSON.stringify(page).includes('PROMPT_WITH_PRIVATE')); assert.ok(!JSON.stringify(page).includes('fixtureSecret')); assert.ok(!JSON.stringify(page).includes('Draft'));
    assert.equal(page.events.filter(e=>e.type==='turn_finished').length,2);
    await assert.rejects(executeTask('x','x',{session_handle:handle,backend:'codex'},dir),/cannot switch provider/);
    await assert.rejects(sessionHistory(handle,path.join(dir,'different')),/workspace/);
    const pages=[];let cursor;
    do {const p=await sessionHistory(handle,dir,cursor,2);pages.push(...p.events);cursor=p.nextCursor;}while(cursor);
    assert.deepEqual(pages.map(e=>e.eventId),page.events.map(e=>e.eventId));
    const savedModel=getSession(handle).model;
    assert.equal(savedModel,'fixture-model'); assert.equal(getSession(handle).activePid,null);
    await deleteHistory(handle,dir); await assert.rejects(sessionHistory(handle,dir),/not found/);
  } finally {adapterRegistry.gemini=original;}
});
test('F09/F10/F11: unique claim ownership, async contention, stale claimant recovery, validation and immutable fields',async()=>{
  const sess=createSession('codex',dir);
  const file=getSessionFilePath(sess.sessionHandle);
  const first=await acquireSessionTurn(sess.sessionHandle);assert.ok(first.ok);
  assert.equal((await acquireSessionTurn(sess.sessionHandle)).ok,false);
  assert.equal((await releaseSessionTurn(sess.sessionHandle,randomUUID())).ok,false);
  assert.equal(getSession(sess.sessionHandle).turnToken,first.data.token);
  await releaseSessionTurn(sess.sessionHandle,first.data.token);
  await assert.rejects(updateSession(sess.sessionHandle,{backend:'gemini'}),/Immutable/);
  assert.equal(getSession('../'+sess.sessionHandle),null);
  const data=JSON.parse(fs.readFileSync(file,'utf8'));data.lastUsedAt='invalid-date';fs.writeFileSync(file,JSON.stringify(data));
  assert.equal(getSession(sess.sessionHandle),null);
  const lock=path.join(dir,'counter');let responsive=false;
  const held=withFileLock(lock,async()=>{await new Promise(resolve=>setTimeout(resolve,80));});
  await new Promise(resolve=>setTimeout(resolve,10));
  const contender=withFileLock(lock,async()=>{});
  setTimeout(()=>{responsive=true;},20);await Promise.all([held,contender]);assert.ok(responsive);
});
test('storage locks serialize actual competing Node processes (F09/F10)',async()=>{
  const counter=path.join(dir,'multiprocess-counter');fs.writeFileSync(counter,'0');
  const module=path.resolve(__dirname, '..', 'src/sessions/lock.ts');
  const script=`const fs=require('node:fs/promises');const {withFileLock}=require(process.argv[1]);(async()=>{for(let i=0;i<8;i++)await withFileLock(process.argv[2],async()=>{const n=Number(await fs.readFile(process.argv[2],'utf8'));await new Promise(r=>setTimeout(r,2));await fs.writeFile(process.argv[2],String(n+1));});})().catch(e=>{console.error(e);process.exitCode=1;});`;
  await Promise.all(Array.from({length:3},()=>new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,['--require','tsx/cjs','-e',script,module,counter],{stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';proc.stderr.on('data',d=>{error+=d;});proc.on('error',reject);proc.on('exit',code=>code===0?resolve():reject(new Error(error)));
  })));
  assert.equal(fs.readFileSync(counter,'utf8'),'24');
});

test('atomic lease lock serializes contender and recovers cleanly upon release', async () => {
  const resource = path.join(dir, 'atomic-lease-contention');
  let releaseOwner, ownerEntered, contenderEntered = false;
  const ownerGate = new Promise(r => releaseOwner = r);
  const ownerReady = new Promise(r => ownerEntered = r);

  const owner = withFileLock(resource, async () => {
    ownerEntered();
    await ownerGate;
    return 'owner-done';
  });
  await ownerReady;

  const contender = withFileLock(resource, async () => {
    contenderEntered = true;
    return 'contender-done';
  });

  // While owner is holding lock, contender cannot enter
  await new Promise(r => setTimeout(r, 30));
  assert.equal(contenderEntered, false, 'Contender must not enter while owner holds the atomic lease');

  releaseOwner();
  const [ownerRes, contenderRes] = await Promise.all([owner, contender]);
  assert.equal(ownerRes, 'owner-done');
  assert.equal(contenderRes, 'contender-done');
  assert.equal(contenderEntered, true);
  assert.equal(fs.existsSync(resource + '.lease'), false, 'Lease file must be cleaned up after release');
});


test('session leases reject a second process, permit an independent session and recover a dead turn owner',async()=>{
  const a=createSession('codex',dir),b=createSession('codex',dir),c=createSession('codex',dir);
  const lease=await acquireSessionTurn(a.sessionHandle);assert.ok(lease.ok);
  const script=`const s=require(process.argv[1]);(async()=>{const busy=await s.acquireSessionTurn(process.argv[2]);const independent=await s.acquireSessionTurn(process.argv[3]);await s.releaseSessionTurn(process.argv[3],independent.data.token);const abandoned=await s.acquireSessionTurn(process.argv[4]);console.log(JSON.stringify({busy,independent,abandoned}));})().catch(()=>process.exit(1));`;
  const data=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',script,path.resolve(__dirname, '..', 'src/sessions/session.ts'),a.sessionHandle,b.sessionHandle,c.sessionHandle],{env:{...process.env},windowsHide:true});let out='';p.stdout.on('data',d=>out+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error('lease fixture failed')));});
  assert.equal(data.busy.ok,false);assert.equal(data.independent.ok,true);assert.equal(data.abandoned.ok,true);
  await releaseSessionTurn(a.sessionHandle,lease.data.token);
  const recovered=await acquireSessionTurn(c.sessionHandle);assert.equal(recovered.ok,true);assert.notEqual(recovered.data.token,data.abandoned.data.token);await releaseSessionTurn(c.sessionHandle,recovered.data.token);
});

test('production execution automatically prunes expired session metadata with history disabled',async()=>{
  const data=path.join(dir,'prune-production');fs.mkdirSync(data);
  const script=`process.env.coagent8_DIR=process.argv[1];process.env.coagent8_HISTORY='off';const fs=require('node:fs');const path=require('node:path');const s=require(process.argv[2]);const {adapterRegistry}=require(process.argv[3]);const {executeTask}=require(process.argv[4]);(async()=>{const old=s.createSession('gemini',process.argv[1]);const file=s.getSessionFilePath(old.sessionHandle);const raw=JSON.parse(fs.readFileSync(file));raw.lastUsedAt=new Date(0).toISOString();fs.writeFileSync(file,JSON.stringify(raw));adapterRegistry.gemini={id:'gemini',name:'fixture',probe:async()=>({installed:true,executionSupported:true}),execute:async()=>({status:'completed',isError:false,output:'public',truncated:false,continuationAvailable:false})};await executeTask('x','x',{backend:'gemini'},process.argv[1]);console.log(JSON.stringify({oldFile:fs.existsSync(file)}));})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',script,data,path.resolve(__dirname, '..', 'src/sessions/session.ts'),path.resolve(__dirname, '..', 'src/backends/registry.ts'),path.resolve(__dirname, '..', 'src/execution/controller.ts')],{env:{...process.env},windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));});
  assert.equal(result.oldFile,false);
});

test('history reports byte-limit failures, expires old local files and supports explicit disable',async()=>{
  const old=createSession('gemini',dir),writer=createHistoryWriter(old.sessionHandle,dir,'gemini',randomUUID());
  writer.accept({type:'user_message',text:'old public'});await writer.flush();
  const file=path.join(dir,'history',old.sessionHandle+'.json');fs.utimesSync(file,new Date(0),new Date(0));
  const fresh=createSession('gemini',dir),next=createHistoryWriter(fresh.sessionHandle,dir,'gemini',randomUUID());next.accept({type:'turn_started'});await next.flush();assert.equal(fs.existsSync(file),false);
  const full=createHistoryWriter(fresh.sessionHandle,dir,'gemini',randomUUID());
  for(let i=0;i<10;i++)full.accept({type:'assistant_message',messageId:'large-'+i,text:'x'.repeat(1024*1024)});
  await assert.rejects(full.flush(),/session limit/);
  assert.equal((await sessionHistory(fresh.sessionHandle,dir)).events.length,1);
  process.env.coagent8_HISTORY='off';try{const disabled=createHistoryWriter(fresh.sessionHandle,dir,'gemini',randomUUID());assert.equal(disabled.disabled,true);disabled.accept({type:'user_message',text:'never persisted'});await disabled.flush();}finally{delete process.env.coagent8_HISTORY;}
  assert.equal((await sessionHistory(fresh.sessionHandle,dir)).events.length,1);
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
    const cancelled=new AbortController();cancelled.abort();await assert.rejects(executeTask('x','x',{},dir,cancelled.signal),/ABORTED/);assert.equal(calls,0);
    await assert.rejects(executeTask('x','x',{},dir),/POLICY_DENIED/);assert.equal(calls,0);
    const first=await executeTask('x','first',{user_confirmed:true},dir),handle=first.structuredContent.sessionHandle;
    await assert.rejects(executeTask('x','second',{session_handle:handle},dir),/POLICY_DENIED/);assert.equal(calls,1);
    mode='rate';const rate=await executeTask('x','rate',{session_handle:handle,user_confirmed:true},dir);assert.equal(rate.structuredContent.error.code,'RATE_LIMITED');assert.equal(getSession(handle).threadId,'native_fixture');
    assert.equal(require('../src/backends/availability.ts').readQuotaCache().data.codex.status,'rate_limited');
    mode='invalid';const invalid=await executeTask('x','invalid',{session_handle:handle,user_confirmed:true},dir);assert.equal(invalid.structuredContent.error.code,'SESSION_INVALID');assert.equal(invalid.structuredContent.continuationAvailable,false);assert.equal(getSession(handle),null);
    const history=await sessionHistory(handle,dir);assert.ok(!JSON.stringify(history).includes('MUST_NOT_PERSIST'));assert.equal(history.events.at(-1).status,'failed');
    for(mode of ['missing','contradiction']) {const r=await executeTask('x','x',{user_confirmed:true},dir);assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'PROTOCOL_ERROR');assert.equal(getSession(r.structuredContent.sessionHandle).activePid,null);}
  }finally{adapterRegistry.codex=original;saveConfig({defaultBackend:'gemini',routing:{strategy:'fixed',allowedBackends:['gemini']}});}
});
test('F14/F15: shared schema validates required fields, types, enums, unknown fields and model families',()=>{
  const tools=createToolDefinitions();assert.equal(new Set(tools.map(t=>t.name)).size,tools.length);
  const consultTool=tools.find(t=>t.name==='consult');assert.ok(consultTool.inputSchema.properties.session_handle);assert.ok(consultTool.outputSchema);
  assert.throws(()=>validateToolArguments({},consultTool.inputSchema),/Missing/);
  assert.throws(()=>validateToolArguments({proposal:'x',user_confirmed:'yes'},consultTool.inputSchema),/expected boolean/);
  assert.throws(()=>validateToolArguments({proposal:'x',extra:1},consultTool.inputSchema),/Unknown/);
  const schema=tools.find(t=>t.name==='analyze').inputSchema;
  assert.ok(validateToolArguments({task:'x',backend:'gemini'},schema));
  assert.throws(()=>validateToolArguments({task:'x',file_paths:[3]},schema),/expected string/);
  for(const model of ['gpt-6-astra','gpt-6.1-astra','claude-opus-4-6','opus','astra'])assert.ok(checkModelGovernance(model,false),model);
});
test('history survives a fresh process and failed turns; duplicate native snapshots are canonical',async()=>{
  const s=createSession('gemini',dir),turn=randomUUID();
  const writer=createHistoryWriter(s.sessionHandle,dir,'gemini',turn);
  writer.accept({type:'turn_started'});writer.accept({type:'user_message',text:'public user'});
  writer.accept({type:'assistant_delta',messageId:'m',text:'draft'});await writer.flush();
  writer.accept({type:'assistant_message',messageId:'m',text:'final'});writer.accept({type:'assistant_message',messageId:'m',text:'final'});
  writer.accept({type:'error',error:{code:'AUTH_REQUIRED',message:'token=fixtureSecret',retryable:false}});writer.accept({type:'turn_finished',status:'failed'});await writer.flush();
  const code=`const {sessionHistory}=require(process.argv[1]);sessionHistory(process.argv[2],process.argv[3]).then(h=>process.stdout.write(JSON.stringify(h)));`;
  const output=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--require','tsx/cjs','-e',code,path.resolve(__dirname, '..', 'src/sessions/history.ts'),s.sessionHandle,dir],{env:{...process.env},windowsHide:true});let out='';p.stdout.on('data',d=>out+=d);p.on('error',reject);p.on('exit',c=>c===0?resolve(out):reject(new Error('history subprocess failed')));});
  const h=JSON.parse(output);assert.equal(h.events.filter(e=>e.type==='assistant_message').length,1);assert.equal(h.events.find(e=>e.type==='assistant_message').text,'final');assert.ok(!output.includes('fixtureSecret'));
});

test('live pagination rejects a changed snapshot so final assistant text is never silently skipped',async()=>{
  const s=createSession('gemini',dir),w=createHistoryWriter(s.sessionHandle,dir,'gemini',randomUUID());
  w.accept({type:'assistant_delta',messageId:'m',text:'draft'});w.accept({type:'status',message:'running'});await w.flush();
  const before=await sessionHistory(s.sessionHandle,dir,undefined,1);assert.equal(before.events[0].text,'draft');assert.ok(before.nextCursor);
  w.accept({type:'assistant_message',messageId:'m',text:'final'});w.accept({type:'turn_finished',status:'completed'});await w.flush();
  await assert.rejects(sessionHistory(s.sessionHandle,dir,before.nextCursor,1),/HISTORY_CHANGED.*restart/);
  const after=await sessionHistory(s.sessionHandle,dir);assert.equal(after.events.filter(e=>e.type==='assistant_message').length,1);assert.equal(after.events[0].text,'final');assert.notEqual(before.revision,after.revision);
});

test('history fragment pagination returns the whole large UTF-8 message at limit=1 without skipping an unreturned prefix',async()=>{
  const s=createSession('gemini',dir),writer=createHistoryWriter(s.sessionHandle,dir,'gemini',randomUUID());
  const text=('😀"\n').repeat(100000);writer.accept({type:'turn_started'});writer.accept({type:'assistant_message',messageId:'large',text});await writer.flush();
  let cursor,joined='',pages=0;
  do {const page=await sessionHistory(s.sessionHandle,dir,cursor,1);assert.ok(Buffer.byteLength(JSON.stringify(page))<256*1024);joined+=page.events.filter(e=>e.type==='assistant_message').map(e=>e.text).join('');cursor=page.nextCursor;pages++;assert.ok(pages<20);}while(cursor);
  assert.equal(joined,text);assert.ok(pages>1);
});

test('oversized provider metadata cannot hang history pagination',async()=>{
  const s=createSession('gemini',dir),writer=createHistoryWriter(s.sessionHandle,dir,'gemini',randomUUID());
  assert.throws(()=>writer.accept({type:'assistant_message',messageId:'x'.repeat(300*1024),text:'short'}),/identifier/);
  const {createGeminiCollector}=require('../src/backends/gemini.adapter.ts');
  assert.throws(()=>createGeminiCollector().line(JSON.stringify({type:'message',role:'assistant',message_id:'x'.repeat(300*1024),content:'short'})),/metadata/);
  writer.accept({type:'assistant_message',messageId:'safe',text:'short'});await writer.flush();
  const file=path.join(dir,'history',s.sessionHandle+'.json'),raw=JSON.parse(fs.readFileSync(file));
  raw.events[0].messageId='x'.repeat(300*1024);fs.writeFileSync(file,JSON.stringify(raw));
  await assert.rejects(sessionHistory(s.sessionHandle,dir),/identifier/);
});

test('closing expired, invalidated or already closed sessions checks workspace under the storage lock',async()=>{
  const {handleCloseSession}=require('../src/tools/session.tool.ts');
  fs.mkdirSync(path.join(dir,'other'),{recursive:true});
  for(const state of ['idle','invalidated','closed']) {
    const s=createSession('codex',dir),file=getSessionFilePath(s.sessionHandle),raw=JSON.parse(fs.readFileSync(file));
    raw.state=state;raw.lastUsedAt=new Date(Date.now()-3*3600*1000).toISOString();fs.writeFileSync(file,JSON.stringify(raw));
    await assert.rejects(handleCloseSession({session_handle:s.sessionHandle,workspace_path:path.join(dir,'other')}),/workspace mismatch/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),raw);
    await handleCloseSession({session_handle:s.sessionHandle,workspace_path:dir});
    assert.equal(JSON.parse(fs.readFileSync(file)).state,'closed');
  }
});

test('formatExecutionResult produces clean Markdown with answer at top, and handleSessionHistory preserves global turn numbers across pagination', async () => {
  const { formatExecutionResult } = require('../src/tools/common.ts');
  const { handleSessionHistory } = require('../src/tools/session.tool.ts');

  // Test formatExecutionResult
  const formatted = await formatExecutionResult('codex', {
    status: 'completed',
    isError: false,
    output: '# Analysis Result\nEverything looks good.',
    continuationAvailable: true,
  }, '', 'syn_sess_test123', { turn: 1, toolCount: 2, durationMs: 3450, historyAvailable: true });

  assert.equal(formatted.isError, false);
  assert.ok(formatted.content[0].text.startsWith('# Analysis Result\nEverything looks good.'));
  assert.ok(formatted.content[0].text.includes('> CoAgent: codex (default) · 3.5s · 2 ops'));
  assert.ok(formatted.content[0].text.includes('> Session: syn_sess_test123 (turn 1 · ready)'));

  // Test handleSessionHistory across two turns
  const s = createSession('codex', dir);
  const w1 = createHistoryWriter(s.sessionHandle, dir, 'codex', randomUUID());
  w1.accept({ type: 'turn_started' });
  w1.accept({ type: 'user_message', text: 'Turn 1 prompt' });
  w1.accept({ type: 'tool_started', toolId: 't1', name: 'read_code' });
  w1.accept({ type: 'tool_finished', toolId: 't1', name: 'read_code', success: true });
  w1.accept({ type: 'assistant_message', messageId: 'm1', text: 'Turn 1 response' });
  w1.accept({ type: 'turn_finished', status: 'completed' });
  await w1.flush();

  const w2 = createHistoryWriter(s.sessionHandle, dir, 'codex', randomUUID());
  w2.accept({ type: 'turn_started' });
  w2.accept({ type: 'user_message', text: 'Turn 2 prompt' });
  w2.accept({ type: 'assistant_message', messageId: 'm2', text: 'Turn 2 response' });
  w2.accept({ type: 'turn_finished', status: 'completed' });
  await w2.flush();

  // Page 1 (limit 6 events covering Turn 1)
  const page1 = await handleSessionHistory({ session_handle: s.sessionHandle, workspace_path: dir, limit: 6 });
  assert.ok(page1.content[0].text.includes('### Turn 1'));
  assert.ok(page1.content[0].text.includes('**User:**\n\nTurn 1 prompt'));
  assert.ok(page1.structuredContent.nextCursor);

  // Page 2 using cursor from page 1 (covering Turn 2)
  const page2 = await handleSessionHistory({ session_handle: s.sessionHandle, workspace_path: dir, cursor: page1.structuredContent.nextCursor });
  assert.ok(page2.content[0].text.includes('### Turn 2'));
  assert.ok(page2.content[0].text.includes('**User:**\n\nTurn 2 prompt'));
  assert.ok(page2.content[0].text.includes('**Assistant (codex):**\n\nTurn 2 response'));
  // Verify Turn 2 is NOT mislabeled as Turn 1 on page 2!
  assert.ok(!page2.content[0].text.includes('### Turn 1'));
});
