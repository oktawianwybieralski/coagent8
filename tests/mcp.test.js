const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {connect: connectStdio}=require('./helpers/stdio.cjs');

function connect(dir) {
  return connectStdio(process.execPath,['--require','tsx/cjs',path.resolve(__dirname, '../src/index.ts')],{env:{...process.env,coagent8_DIR:dir,GEMINI_CLI_HOME:path.join(dir,'original-home'),GEMINI_PATH:path.resolve(__dirname, 'fixtures/gemini-cli/gemini.cjs')}});
}
test('MCP stdio exposes unified schema; two fixture turns, public history, fallback, validation, redacted errors and monotonic progress',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-mcp-'));
  const c=connect(dir);
  t.after(async()=>{await c.cleanup();fs.rmSync(dir,{recursive:true,force:true});});
  const init=await c.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture-client',version:'1'}});
  assert.equal(init.result.serverInfo.title,'CoAgent');
  const icon=init.result.serverInfo.icons[0];
  assert.equal(icon.mimeType,'image/png');assert.deepEqual(icon.sizes,['64x64']);
  assert.ok(icon.src.startsWith('data:image/png;base64,'));
  assert.deepEqual(Buffer.from(icon.src.slice('data:image/png;base64,'.length),'base64'),fs.readFileSync(path.resolve('assets/logo64.png')));
  c.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await c.request('tools/list',{});assert.equal(list.result.tools.length,9);assert.ok(list.result.tools.some(x=>x.name==='issue'));
  assert.ok(list.result.tools.every(tool=>JSON.stringify(tool.icons)===JSON.stringify(init.result.serverInfo.icons)));
  const definition=list.result.tools.find(x=>x.name==='consult');assert.ok(definition.inputSchema.properties.backend.enum.includes('gemini'));assert.ok(definition.outputSchema);
  const invalid=await c.request('tools/call',{name:'analyze',arguments:{task:'x',file_paths:[2]}});assert.equal(invalid.result.isError,true);assert.equal(invalid.error,undefined);
  const bad=await c.request('tools/call',{name:'consult',arguments:{proposal:'x',workspace_path:path.join(dir,'token=fixtureSecret')}});assert.ok(!JSON.stringify(bad).includes('fixtureSecret'));
  const first=await c.request('tools/call',{name:'consult',arguments:{proposal:'first public turn',backend:'gemini',workspace_path:dir},_meta:{progressToken:'turn-one'}});
  assert.equal(first.result.isError,false,JSON.stringify(first));
  const handle=first.result.structuredContent.sessionHandle;
  const second=await c.request('tools/call',{name:'analyze',arguments:{task:'second public turn',session_handle:handle,workspace_path:dir}});
  assert.equal(second.result.isError,false);assert.equal(second.result.structuredContent.turn,2);assert.ok(second.result.content[0].text.includes('Markdown'));
  const history=await c.request('tools/call',{name:'session',arguments:{action:'history',session_handle:handle,workspace_path:dir,limit:100}});
  assert.equal(history.result.structuredContent.events.filter(e=>e.type==='user_message').length,2);
  assert.equal(history.result.structuredContent.events.filter(e=>e.type==='assistant_message').length,2);
  assert.ok(!JSON.stringify(history).includes('PRIVATE_CHAIN'));assert.ok(!JSON.stringify(history).includes('SYNTHETIC_SECRET'));
  const progress=c.notifications.filter(n=>n.method==='notifications/progress').map(n=>n.params.progress);
  assert.ok(progress.length);assert.ok(progress.every((n,i)=>i===0||n>progress[i-1]));
  c.proc.stdin.end();await c.waitForExit(5000);
  assert.ok(c.getStderr().includes('running on stdio'));
});
test('MCP active EOF cancels CLI and writes terminal history before exit',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-mcp-eof-'));
  const capture=path.join(dir,'capture.json');
  const oldMode=process.env.coagent8_FIXTURE_MODE,oldCapture=process.env.coagent8_FIXTURE_CAPTURE;
  process.env.coagent8_FIXTURE_MODE='hang';process.env.coagent8_FIXTURE_CAPTURE=capture;
  const c=connect(dir);if(oldMode===undefined)delete process.env.coagent8_FIXTURE_MODE;else process.env.coagent8_FIXTURE_MODE=oldMode;if(oldCapture===undefined)delete process.env.coagent8_FIXTURE_CAPTURE;else process.env.coagent8_FIXTURE_CAPTURE=oldCapture;
  t.after(async()=>{await c.cleanup();fs.rmSync(dir,{recursive:true,force:true});});
  await c.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
  c.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const activeRequest=c.request('tools/call',{name:'consult',arguments:{proposal:'active cancellation',backend:'gemini',workspace_path:dir}}).catch(error=>({error}));
  const started=Date.now();while(!fs.existsSync(capture)){if(Date.now()-started>30000)throw new Error('Fixture did not start');await new Promise(resolve=>setTimeout(resolve,25));}
  c.proc.stdin.end();
  await c.waitForExit(20000);
  await activeRequest;
  const histories=fs.readdirSync(path.join(dir,'history')).filter(f=>f.endsWith('.json'));
  const h=JSON.parse(fs.readFileSync(path.join(dir,'history',histories[0]),'utf8'));
  assert.equal(h.events.at(-1).type,'turn_finished');assert.equal(h.events.at(-1).status,'cancelled');
  const session=JSON.parse(fs.readFileSync(path.join(dir,'sessions',histories[0]),'utf8'));assert.equal(session.activePid,null);
});
