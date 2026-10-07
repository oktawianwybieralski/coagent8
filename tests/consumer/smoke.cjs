// Installs the exact generated tarball, without development dependencies.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
require('tsx/cjs'); // Test tooling only; deliberately absent from the installed consumer.
const {resolveCliCommand}=require('../../src/execution/cli-resolver.ts');
const {connect}=require('../helpers/stdio.cjs');
const {readResult}=require('../helpers/result.cjs');
const root=path.resolve(__dirname,'../..');
const artifacts=path.join(root,'.artifacts','consumer');fs.mkdirSync(artifacts,{recursive:true});
const npm=process.env.npm_execpath || path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
function npmRun(args,cwd=root) {
  const result=spawnSync(process.execPath,[npm,...args],{cwd,encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
  if(result.status!==0)throw new Error(`npm ${args[0]} failed: ${result.stderr}`);return result.stdout;
}
(async()=>{
  const existing=process.argv[2] ? path.resolve(process.argv[2]) : null;
  const pack=existing ? JSON.parse(await fsp.readFile(existing+'.manifest.json','utf8')) : JSON.parse(npmRun(['pack','--json','--pack-destination',artifacts]))[0];
  const tarball=existing || path.join(artifacts,pack.filename);
  const hash=createHash('sha256').update(await fsp.readFile(tarball)).digest('hex');
  if(existing)assert.equal(hash,pack.sha256,'Existing artifact hash');
  else await fsp.writeFile(tarball+'.manifest.json',JSON.stringify({...pack,sha256:hash},null,2));
  for(const name of ['dist/index.cjs','dist/index.cjs.map','dist/THIRD_PARTY_NOTICES.txt','assets/logo.svg','assets/logo.png','assets/logo32.png','assets/logo64.png','plugin.json','mcp.json','index.js','README.md','LICENSE'])assert.ok(pack.files.some(f=>f.path===name),name);
  assert.ok(!pack.files.some(f=>f.path.includes('windows-job.ps1')),'Retired wrapper must not ship in runtime package');
  assert.ok(!pack.files.some(f=>f.path.endsWith('.af')),'Design source must not ship in runtime package');
  assert.ok(!pack.files.some(f=>f.path.startsWith('assets/design/')),'Design assets must not ship in runtime package');
  assert.ok(!pack.files.some(f=>f.path.includes('node_modules')||/^(?:test|tests|fixtures|\.rc-tools|\.artifacts)\//.test(f.path)||/consumer-smoke|node20-polyfill|\.test\.[cm]?js$/.test(f.path)));
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'coagent8-consumer-'));
  try {
    npmRun(['init','--yes'],dir);
    npmRun(['install','--omit=dev','--no-audit','--no-fund',tarball],dir);
    const pkg=path.join(dir,'node_modules','coagent8');
    const installed=JSON.parse(await fsp.readFile(path.join(pkg,'package.json'),'utf8'));
    const plugin=JSON.parse(await fsp.readFile(path.join(pkg,'plugin.json'),'utf8'));
    assert.equal(plugin.version,installed.version,'Plugin/runtime/package version');
    for(const key of ['composerIcon','logo']) {
      const asset=plugin.extensions['com.openai'].interface[key];
      assert.ok(asset.startsWith('./assets/'));
      assert.ok(fs.existsSync(path.join(pkg,asset)),`Plugin ${key} must resolve in installed package`);
    }
    // The packed bundle is a build of the packed source: dist/ is not in Git, so a stale
    // or hand-edited bundle would show up as a difference from a fresh build here.
    for(const file of pack.files.filter(f=>f.path.startsWith('src/'))) {
      assert.deepEqual(await fsp.readFile(path.join(pkg,file.path)),await fsp.readFile(path.join(root,file.path)),`Packed ${file.path} matches the source`);
    }
    const rebuild=spawnSync(process.execPath,[path.join(root,'scripts','build.cjs')],{cwd:root,encoding:'utf8',windowsHide:true});
    assert.equal(rebuild.status,0,`Rebuild failed: ${rebuild.stderr}`);
    for(const name of ['dist/index.cjs','dist/index.cjs.map','dist/THIRD_PARTY_NOTICES.txt']) {
      assert.ok((await fsp.readFile(path.join(pkg,name))).equals(await fsp.readFile(path.join(root,name))),`Packed ${name} matches a fresh build of the packed source`);
    }
    // License notices ship beside the bundle; the bundle itself carries no license comments.
    const bundle=await fsp.readFile(path.join(pkg,'dist','index.cjs'),'utf8');
    assert.ok(!/\/\*!|@license|@preserve|SPDX-License-Identifier/.test(bundle),'Bundle must not embed license comments');
    const notices=await fsp.readFile(path.join(pkg,'dist','THIRD_PARTY_NOTICES.txt'),'utf8');
    for(const bundled of ['@modelcontextprotocol/sdk','jsonc-parser','smol-toml','zod'])assert.ok(notices.includes(`\n${bundled} `),`Notices must cover ${bundled}`);
    const mcp=JSON.parse(await fsp.readFile(path.join(pkg,'mcp.json'),'utf8'));
    assert.equal(mcp.mcpServers.coagent8.type,'stdio');
    assert.equal(mcp.mcpServers.coagent8.command,'node');
    assert.equal(mcp.mcpServers.coagent8.args[0],'${PLUGIN_ROOT}/dist/index.cjs');
    const expectedIcon=await fsp.readFile(path.join(pkg,'assets/logo64.png'));
    // The installed server must advertise its icon even without runtime PNG files.
    for(const name of fs.readdirSync(path.join(pkg,'assets')).filter(name=>name.endsWith('.png'))) {
      await fsp.unlink(path.join(pkg,'assets',name));
    }
    const commands=[];
    for(const bin of ['coagent8','coagent8-mcp']){
      assert.equal(installed.bin[bin],'./dist/index.cjs');
      const shim=path.join(dir,'node_modules','.bin',bin+(process.platform==='win32'?'.cmd':''));assert.ok(fs.existsSync(shim),bin);
      commands.push(resolveCliCommand(shim));
    }
    const sdk=path.join(dir,'node_modules','@modelcontextprotocol','sdk');assert.ok(fs.existsSync(sdk));
    // Prove the installed commands use the bundled SDK instead of resolving the npm dependency.
    await fsp.rename(sdk,sdk+'-unused');
    for(const dependency of ['jsonc-parser','smol-toml']) await fsp.rename(path.join(dir,'node_modules',dependency),path.join(dir,'node_modules',dependency+'-unused'));
    assert.ok(!fs.existsSync(sdk),'SDK must be unavailable during runtime smoke');
    assert.ok(!fs.existsSync(path.join(dir,'node_modules','tsx')));for(const tool of ['esbuild','tsdown','rolldown'])assert.ok(!fs.existsSync(path.join(dir,'node_modules',tool)),tool);
    for(const [binIndex,command] of commands.entries()) {
    const connection=connect(command.command,command.argsPrefix,{cwd:dir,env:{...process.env,NODE_PATH:'',coagent8_DIR:path.join(dir,'data'),GEMINI_CLI_HOME:path.join(dir,'original-home'),GEMINI_PATH:path.join(root,'tests','fixtures','gemini-cli','gemini.cjs'),CODEX_PATH:path.join(root,'tests','fixtures','codex-cli','codex.cjs'),CODEX_FIXTURE_MODE:'success',CODEX_FIXTURE_CAPTURE:'',coagent8_PRICES_URL:path.join(root,'tests','fixtures','prices','openrouter-models.json')}});
    const {proc,request}=connection;
    try {
      const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'tarball-consumer',version:'1'}});assert.equal(init.result.serverInfo.version,installed.version);
      assert.equal(init.result.serverInfo.title,'CoAgent8');
      assert.deepEqual(init.result.serverInfo.icons[0].sizes,['64x64']);
      assert.equal(init.result.serverInfo.icons[0].mimeType,'image/png');
      assert.deepEqual(Buffer.from(init.result.serverInfo.icons[0].src.replace(/^data:image\/png;base64,/,''),'base64'),expectedIcon);
      proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
      const tools=await request('tools/list',{});assert.equal(tools.result.tools.length,6);
      assert.ok(tools.result.tools.every(tool=>tool.icons===undefined),'the brand icon is declared once, on the server');
      for(const name of ['consult','review'])assert.equal(tools.result.tools.find(tool=>tool.name===name).outputSchema,undefined,`${name}: markdown result only`);
      if(binIndex===0) {
      const first=await request('tools/call',{name:'consult',arguments:{proposal:'consumer first turn',backend:'gemini',workspace_path:dir}});assert.equal(first.result.isError,false,JSON.stringify(first));
      const handle=readResult(first.result).sessionHandle;
      const second=await request('tools/call',{name:'analyze',arguments:{task:'consumer second turn',session_handle:handle,workspace_path:dir}});assert.equal(readResult(second.result).turn,2);
      const history=await request('tools/call',{name:'session',arguments:{action:'history',session_handle:handle,workspace_path:dir}});assert.equal(history.result.structuredContent.events.filter(e=>e.type==='assistant_message').length,2);
      const codexFirst=await request('tools/call',{name:'consult',arguments:{proposal:'Codex consumer first turn',backend:'codex',model:'gpt-6.1-sol',workspace_path:dir}});
      assert.equal(codexFirst.result.isError,false,JSON.stringify(codexFirst));
      assert.equal(readResult(codexFirst.result).status,'completed');
      assert.ok(readResult(codexFirst.result).answer.includes('const answer = 42;'));
      assert.equal(readResult(codexFirst.result).continuationAvailable,true);
      const codexHandle=readResult(codexFirst.result).sessionHandle;
      const codexSecond=await request('tools/call',{name:'analyze',arguments:{task:'Codex consumer second turn',session_handle:codexHandle,workspace_path:dir}});
      assert.equal(codexSecond.result.isError,false,JSON.stringify(codexSecond));
      assert.equal(readResult(codexSecond.result).turn,2);
      const codexHistory=await request('tools/call',{name:'session',arguments:{action:'history',session_handle:codexHandle,workspace_path:dir}});
      assert.equal(codexHistory.result.structuredContent.events.filter(e=>e.type==='assistant_message').length,2);
      for(const forbidden of ['PRIVATE_REASONING','PRIVATE_RAW_COMMAND','PRIVATE_TOOL_OUTPUT','fixtureSecret'])assert.ok(!JSON.stringify(codexHistory).includes(forbidden),forbidden);
      }
      proc.stdin.end();await connection.waitForExit(5000);
      assert.ok(connection.getStderr().includes('running on stdio'));
    } finally {await connection.cleanup();}
    }
    const evidence={version:installed.version,tarball:pack.filename,sha256:hash,platform:process.platform,node:process.version,files:pack.files.length,
      installation:'PASS (omit=dev)',bundledSdk:'PASS (installed SDK unavailable during runtime smoke)',binAliases:'PASS (two installed npm commands launched with shared resolver; initialize/list/EOF each)',mcp:'PASS (initialize/list, Codex and Gemini two fixture turns/history, EOF)',realCli:'NOT VERIFIED by consumer fixture smoke'};
    await fsp.writeFile(path.join(artifacts,'consumer-'+process.versions.node+'.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  } finally {await fsp.rm(dir,{recursive:true,force:true});}
})().catch(err=>{console.error(err.message);process.exitCode=1;});
