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
  for(const name of ['dist/index.cjs','dist/setup.cjs','dist/THIRD_PARTY_NOTICES.txt','assets/logo.svg','assets/logo.png','assets/logo32.png','assets/logo64.png','plugin.json','mcp.json','index.js','README.md','LICENSE',...['consult','delegate','doctor','issue','loop','review','session'].map(n=>`skills/coagent8-${n}/SKILL.md`)])assert.ok(pack.files.some(f=>f.path===name),name);
  assert.deepEqual(pack.files.filter(f=>f.path.startsWith('dist/')).map(f=>f.path).sort(),['dist/THIRD_PARTY_NOTICES.txt','dist/index.cjs','dist/setup.cjs'],'Packed dist/ must contain only the bundles and third-party notices');
  assert.ok(!pack.files.some(f=>f.path.endsWith('.map')),'Source maps must not ship in runtime package');
  for(const name of ['logo-light.svg','logo-light.png','logo32-light.png','logo64-light.png','logo256-light.png'])assert.ok(pack.files.some(f=>f.path===`assets/${name}`),name);
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
    assert.equal(installed.dependencies,undefined,'Packed package.json must declare no runtime dependencies');
    assert.equal(installed.peerDependencies,undefined,'Packed package.json must declare no peer dependencies');
    assert.equal(installed.optionalDependencies,undefined,'Packed package.json must declare no optional dependencies');
    const plugin=JSON.parse(await fsp.readFile(path.join(pkg,'plugin.json'),'utf8'));
    assert.equal(plugin.version,installed.version,'Plugin/runtime/package version');
    for(const key of ['composerIcon','composerIconDark','logo','logoDark']) {
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
    for(const name of ['dist/index.cjs','dist/setup.cjs','dist/THIRD_PARTY_NOTICES.txt']) {
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
    assert.deepEqual(mcp.mcpServers.coagent8.args,['${PLUGIN_ROOT}/dist/index.cjs','mcp']);
    const expectedIcons={light:await fsp.readFile(path.join(pkg,'assets/logo64.png')),dark:await fsp.readFile(path.join(pkg,'assets/logo64-light.png'))};
    // The installed server must advertise both theme icons even without runtime PNG files.
    for(const name of fs.readdirSync(path.join(pkg,'assets')).filter(name=>name.endsWith('.png'))) {
      await fsp.unlink(path.join(pkg,'assets',name));
    }
    const commands=[];
    for(const bin of ['coagent8','coagent8-mcp']){
      assert.equal(installed.bin[bin],'./dist/index.cjs');
      const shim=path.join(dir,'node_modules','.bin',bin+(process.platform==='win32'?'.cmd':''));assert.ok(fs.existsSync(shim),bin);
      commands.push(resolveCliCommand(shim));
    }
    assert.deepEqual(fs.readdirSync(path.join(dir,'node_modules')).filter(name=>!name.startsWith('.')),['coagent8'],'Consumer node_modules must contain only coagent8');
    const setupHome=path.join(dir,'setup-home');await fsp.mkdir(setupHome);
    const setupEnv={...process.env,HOME:setupHome,USERPROFILE:setupHome,CODEX_HOME:path.join(setupHome,'.codex'),CLAUDE_CONFIG_DIR:undefined,CODEX_CONFIG_PATH:undefined,GEMINI_CLI_HOME:undefined,
      CODEX_PATH:path.join(setupHome,'missing-codex'),CLAUDE_PATH:path.join(setupHome,'missing-claude'),AGY_PATH:path.join(setupHome,'missing-agy'),coagent8_EXTENSION_PATHS:'{}'};
    const setupCommand=commands[0];
    const dispatch=args=>spawnSync(setupCommand.command,[...setupCommand.argsPrefix,...args],{cwd:setupHome,env:setupEnv,encoding:'utf8',windowsHide:true,timeout:15000});
    const status=dispatch(['status']);assert.equal(status.status,1,status.stderr);
    assert.equal(JSON.parse(status.stdout).length,3);
    assert.ok(JSON.parse(status.stdout).every(item=>!item.installed&&!item.ready));
    assert.ok(!fs.existsSync(path.join(setupHome,'.coagent8')),'read-only status does not publish state');
    const preview=dispatch(['cleanup']);assert.equal(preview.status,0,preview.stderr);
    const plan=JSON.parse(preview.stdout);assert.ok(plan.results.every(item=>item.action==='absent'));
    const applied=dispatch(['cleanup',`--apply=${plan.token}`]);assert.equal(applied.status,0,applied.stderr);
    assert.match(dispatch(['--help']).stdout,/cleanup/);
    const modelsOut=dispatch(['models']);assert.equal(modelsOut.status,0,modelsOut.stderr);
    assert.match(modelsOut.stdout,/^CoAgent8 models · /);
    const modelsJson=dispatch(['models','--json']);assert.equal(modelsJson.status,0,modelsJson.stderr);
    assert.equal(JSON.parse(modelsJson.stdout).scope,'models');
    const doctorOut=dispatch(['doctor']);assert.equal(doctorOut.status,0,doctorOut.stderr);
    assert.match(doctorOut.stdout,/^CoAgent8 models · /);
    const doctorJson=dispatch(['doctor','--json']);assert.equal(doctorJson.status,0,doctorJson.stderr);
    assert.equal(JSON.parse(doctorJson.stdout).scope,'models');
    const sessionListOut=dispatch(['session','list']);assert.equal(sessionListOut.status,0,sessionListOut.stderr);
    assert.match(sessionListOut.stdout,/> CoAgent8: No active sessions found\./);
    const sessionListJson=dispatch(['session','list','--json']);assert.equal(sessionListJson.status,0,sessionListJson.stderr);
    assert.deepEqual(JSON.parse(sessionListJson.stdout),[]);
    for(const [binIndex,command] of commands.entries()) {
    const connection=connect(command.command,command.argsPrefix,{cwd:dir,env:{...process.env,NODE_PATH:'',coagent8_DIR:path.join(dir,'data'),GEMINI_CLI_HOME:path.join(dir,'original-home'),AGY_PATH:path.join(root,'tests','fixtures','agy-cli','agy.cjs'),CODEX_PATH:path.join(root,'tests','fixtures','codex-cli','codex.cjs'),CODEX_FIXTURE_MODE:'success',CODEX_FIXTURE_CAPTURE:'',coagent8_PRICES_URL:path.join(root,'tests','fixtures','prices','openrouter-models.json')}});
    const {proc,request}=connection;
    try {
      const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'tarball-consumer',version:'1'}});assert.equal(init.result.serverInfo.version,installed.version);
      assert.equal(init.result.serverInfo.title,'CoAgent8');
      assert.deepEqual(init.result.serverInfo.icons.map(icon=>icon.theme),['light','dark']);
      for(const icon of init.result.serverInfo.icons) {
        assert.deepEqual(icon.sizes,['64x64']);
        assert.equal(icon.mimeType,'image/png');
        assert.deepEqual(Buffer.from(icon.src.replace(/^data:image\/png;base64,/,''),'base64'),expectedIcons[icon.theme]);
      }
      proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
      const tools=await request('tools/list',{});assert.equal(tools.result.tools.length,7);
      assert.ok(tools.result.tools.every(tool=>tool.icons===undefined),'the brand icon is declared once, on the server');
      for(const name of ['consult','review'])assert.equal(tools.result.tools.find(tool=>tool.name===name).outputSchema,undefined,`${name}: markdown result only`);
      if(binIndex===0) {
      const first=await request('tools/call',{name:'consult',arguments:{proposal:'consumer first turn',backend:'agy',workspace_path:dir}});assert.equal(first.result.isError,false,JSON.stringify(first));
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
      const cliHist=spawnSync(setupCommand.command,[...setupCommand.argsPrefix,'session','history',codexHandle,'--json'],{cwd:dir,env:{...process.env,coagent8_DIR:path.join(dir,'data')},encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(cliHist.status,0,cliHist.stderr);
      assert.equal(JSON.parse(cliHist.stdout).sessionHandle,codexHandle);
      }
      proc.stdin.end();await connection.waitForExit(5000);
      assert.ok(connection.getStderr().includes('running on stdio'));
    } finally {await connection.cleanup();}
    }
    const evidence={version:installed.version,tarball:pack.filename,sha256:hash,platform:process.platform,node:process.version,files:pack.files.length,
      installation:'PASS (omit=dev)',bundledSdk:'PASS (no runtime dependencies; consumer node_modules contains only coagent8)',binAliases:'PASS (two installed npm commands launched with shared resolver; initialize/list/EOF each)',setup:'PASS (separate bundled status/cleanup/help dispatch in isolated zero-dependency consumer tree)',mcp:'PASS (initialize/list, Codex and Gemini two fixture turns/history, EOF)',realCli:'NOT VERIFIED by consumer fixture smoke'};
    await fsp.writeFile(path.join(artifacts,'consumer-'+process.versions.node+'.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  } finally {await fsp.rm(dir,{recursive:true,force:true});}
})().catch(err=>{console.error(err.message);process.exitCode=1;});
