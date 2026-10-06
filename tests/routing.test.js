const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-routing-'));process.env.coagent8_DIR=dir;
const {adapterRegistry}=require('../src/backends/registry.ts');
const {resolveBackend}=require('../src/backends/routing.ts');
const {saveConfig,loadConfig}=require('../src/config.ts');
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('auto and smart_quota ignore an installed but unsupported provider; explicit/default choice fails visibly without fallback',async()=>{
  const original={...adapterRegistry};
  try {
    for(const id of ['codex','claude','gemini'])adapterRegistry[id]={id,name:id,probe:async()=>({installed:id!=='codex',executionSupported:id==='claude'}),execute:async()=>{throw new Error('Routing test must not generate');}};
    saveConfig({defaultBackend:null,routing:{strategy:'fixed',allowedBackends:['claude','gemini']}});
    assert.equal((await resolveBackend('auto')).id,'claude');assert.equal(loadConfig().defaultBackend,null);
    assert.equal((await resolveBackend('smart_quota')).id,'claude');
    await assert.rejects(resolveBackend('gemini'),/CLI_UNSUPPORTED/);
    saveConfig({defaultBackend:'gemini'});await assert.rejects(resolveBackend(),/CLI_UNSUPPORTED/);
    saveConfig({defaultBackend:null,routing:{strategy:'fixed',allowedBackends:['codex']}});await assert.rejects(resolveBackend(),/CLI_NOT_FOUND/);
    saveConfig({defaultBackend:null,routing:{strategy:'fixed',allowedBackends:['claude','gemini']}});
    adapterRegistry.gemini.probe=async()=>({installed:true,executionSupported:true});await assert.rejects(resolveBackend(),/ONBOARDING_REQUIRED/);
  }finally{Object.assign(adapterRegistry,original);}
});
