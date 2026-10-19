const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-codex-'));
process.env.coagent8_DIR = directory;
process.env.OMNIAGENT_DIR = path.join(directory,'legacy');
process.env.CODEX_PATH = path.resolve(__dirname, '../../fixtures/codex-cli/codex.cjs');
process.env.CODEX_FIXTURE_CAPTURE = path.join(directory,'capture.json');
process.env.CODEX_CONFIG_PATH = path.join(directory,'config.toml');
const {execute, probe, readCodexConfig, normalizeReasoningEffort, codexAdapter, CODEX_MAX_PROMPT_BYTES, CODEX_MAX_LINE_BYTES, CODEX_MAX_SERIALIZED_PROMPT_BYTES} = require('../../../src/backends/codex/adapter.ts');
const {executeTask} = require('../../../src/execution/controller.ts');
const {sessionHistory} = require('../../../src/sessions/history/index.ts');
const {getSession} = require('../../../src/sessions/session.ts');
const {INTERRUPT_GRACE_MS} = require('../../../src/execution/process.ts');
const {ToolError} = require('../../../src/contracts/index.ts');
const {saveConfig} = require('../../../src/config.ts');
const { readResult } = require('../../helpers/result.cjs');
const options = {cwd:directory,model:'gpt-6.1-sol'};
test.after(() => fs.rmSync(directory,{recursive:true,force:true}));

test('production Codex adapter passes the shared pipeline, preserves Markdown and resumes two turns with durable public history',async () => {
  await saveConfig({defaultBackend:'codex',routing:{strategy:'fixed',allowedBackends:['codex']}});
  const first = await executeTask('PRIVATE_REPOSITORY_SNAPSHOT','Public question 😀',{backend:'codex',model:options.model},directory);
  assert.equal(first.isError,false); assert.equal(readResult(first).status,'completed');
  assert.ok(readResult(first).answer.includes('const answer = 42;'));
  assert.ok(readResult(first).answer.includes('😀')); assert.ok(!readResult(first).answer.includes('fixtureSecret'));
  assert.equal(readResult(first).continuationAvailable,true);
  assert.match(readResult(first).text,/ · 1 op · /);
  const handle = readResult(first).sessionHandle;
  const thread = getSession(handle).threadId;
  assert.equal(thread,'11111111-aaaa-bbbb-cccc-123456789012');
  const second = await executeTask('Follow up','Follow up',{session_handle:handle,reasoning_effort:'high'},directory);
  assert.equal(second.isError,false); assert.equal(readResult(second).turn,2);
  const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
  assert.deepEqual(capture.args.slice(0,5),['app-server','-c','sandbox_mode="read-only"','-c','approval_policy="never"']);
  assert.deepEqual(capture.records.map(r=>r.method),['initialize','initialized','config/read','thread/resume','experimentalFeature/list','mcpServerStatus/list','mcpServerStatus/list','turn/start']);
  assert.ok(capture.records.every(r=>!('jsonrpc' in r)),'the app-server wire format omits the jsonrpc field');
  const resume = capture.records[3].params;
  assert.equal(resume.threadId,thread); assert.equal(resume.excludeTurns,true);
  assert.equal(resume.sandbox,'read-only'); assert.equal(resume.approvalPolicy,'never'); assert.equal(resume.model,options.model);
  assert.deepEqual(resume.config,{mcp_servers:{coagent8:{enabled:false},'fixture-http':{enabled:false}}},'a resumed thread disables inherited MCP servers too');
  const turn = capture.records[7].params;
  assert.equal(turn.threadId,thread); assert.equal(turn.effort,'high'); assert.equal(capture.prompt,'Follow up');
  const history = await sessionHistory(handle,directory);
  assert.equal(history.events.filter(event => event.type === 'assistant_message').length,2);
  assert.equal(history.events.filter(event => event.type === 'user_message').length,2);
  assert.equal(history.events.filter(event => event.type === 'turn_finished').length,2);
  for (const forbidden of ['Draft','PRIVATE_REASONING','PRIVATE_RAW_COMMAND','PRIVATE_TOOL_OUTPUT','PRIVATE_REPOSITORY_SNAPSHOT','SUBAGENT_TEXT','fixtureSecret']) assert.ok(!JSON.stringify(history).includes(forbidden),forbidden);
  assert.equal(getSession(handle).activePid,null);
});

test('Codex failures are typed and authoritative even at exit zero; malformed or incomplete protocol cannot pass',async () => {
  for (const [mode,code] of [['auth','AUTH_REQUIRED'],['rate','RATE_LIMITED'],['http-failure','AUTH_REQUIRED'],['error-exit-zero','PROCESS_ERROR'],['no-terminal','PROTOCOL_ERROR'],['malformed','PROTOCOL_ERROR'],['duplicate-terminal','PROTOCOL_ERROR'],['exit-failed','PROCESS_ERROR'],['sandbox-writable','SANDBOX_UNAVAILABLE'],['approvals-on','SANDBOX_UNAVAILABLE'],['mcp-not-disabled','SANDBOX_UNAVAILABLE'],['feature-enabled','SANDBOX_UNAVAILABLE'],['no-isolation-api','SANDBOX_UNAVAILABLE']]) {
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

test('Codex tool output beyond the runner stdout copy does not mark a complete answer truncated',async () => {
  process.env.CODEX_FIXTURE_MODE = 'large-tool-output';
  try {
    const result = await execute('x',options);
    assert.equal(result.status,'completed'); assert.equal(result.error,undefined);
    assert.equal(result.truncated,false);
    assert.ok(result.output.includes('const answer = 42;'));
  } finally { delete process.env.CODEX_FIXTURE_MODE; }
});

test('Codex executes turns with prompts above 512 KB without BUFFER_LIMIT when the app-server echoes the prompt (FEEDBACK-061g)', async () => {
  const largePrompt = 'a'.repeat(600 * 1024);
  const result = await execute(largePrompt, options);
  assert.equal(result.status, 'completed');
  assert.equal(result.isError, false);
  assert.equal(result.error, undefined);
  assert.equal(result.truncated, false);
  assert.ok(result.output.includes('const answer = 42;'));
});

test('Codex executes turns with escaped newline prompts expanding beyond 512 KB and 8 MiB without BUFFER_LIMIT (FEEDBACK-061g)', async () => {
  // 600 KiB of newlines expands 2x in JSON to >1.2 MiB line
  const newlinePrompt = '\n'.repeat(600 * 1024);
  const result1 = await execute(newlinePrompt, options);
  assert.equal(result1.status, 'completed');
  assert.equal(result1.isError, false);
  assert.equal(result1.truncated, false);

  // 4 MiB of newlines expands to >8 MiB line, accommodated within the 16 MiB ceiling
  const fullNewlinePrompt = '\n'.repeat(CODEX_MAX_PROMPT_BYTES);
  const result2 = await execute(fullNewlinePrompt, options);
  assert.equal(result2.status, 'completed');
  assert.equal(result2.isError, false);
  assert.equal(result2.truncated, false);
});

test('Codex rejects prompts exceeding CODEX_MAX_PROMPT_BYTES with INPUT_LIMIT', async () => {
  const oversizedPrompt = 'a'.repeat(CODEX_MAX_PROMPT_BYTES + 1);
  const result = await execute(oversizedPrompt, options);
  assert.equal(result.status, 'failed');
  assert.equal(result.isError, true);
  assert.equal(result.error.code, 'INPUT_LIMIT');
  assert.match(result.error.message, /Prompt exceeds the UTF-8 byte limit/);
});

test('Codex rejects prompts whose serialized JSON expands beyond CODEX_MAX_SERIALIZED_PROMPT_BYTES with INPUT_LIMIT', async () => {
  // 3 MiB of \u0001 is within raw 4 MiB, but expands 6x in JSON to ~18 MiB (>15.93 MiB limit)
  const expandingPrompt = '\u0001'.repeat(3 * 1024 * 1024);
  const result = await execute(expandingPrompt, options);
  assert.equal(result.status, 'failed');
  assert.equal(result.isError, true);
  assert.equal(result.error.code, 'INPUT_LIMIT');
  assert.match(result.error.message, /Serialized prompt exceeds the line record limit/);
});

test('Codex declines server requests, ignores sub-agent threads, sums turn usage and reports retries as warnings',async () => {
  for (const mode of ['server-request','retry-warning']) {
    process.env.CODEX_FIXTURE_MODE = mode;
    const events = [];
    const result = await execute('x',{...options,onEvent:e=>events.push(e)});
    assert.equal(result.status,'completed',mode); assert.equal(result.output.includes('SUBAGENT'),false);
    // AX-001b: the turn's usage is the thread total minus the total before the turn; a repeated update counts once.
    assert.deepEqual(result.usage,{source:'provider',inputTokens:5,cachedInputTokens:3,cacheWriteInputTokens:0,outputTokens:9,reasoningTokens:3,totalTokens:14});
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

test('Codex turns run only after the thread reports every inherited MCP server disabled and tool features off (CUR-002)',async () => {
  delete process.env.CODEX_FIXTURE_MODE;
  const result = await execute('x',options);
  assert.equal(result.status,'completed');
  const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
  for (const feature of ['apps','plugins','browser_use','computer_use','hooks','multi_agent']) assert.ok(capture.args.includes(`features.${feature}=false`),feature);
  assert.equal(capture.nested,'1','the turn carries the nested-turn guard');
  const methods = capture.records.map(r=>r.method);
  assert.deepEqual(methods,['initialize','initialized','config/read','thread/start','experimentalFeature/list','mcpServerStatus/list','mcpServerStatus/list','turn/start']);
  assert.equal(capture.records[2].params.cwd,path.resolve(directory),'project configuration layers of the turn directory are read');
  // The recursive CoAgent8 registration is disabled like every other configured server.
  assert.deepEqual(capture.records[3].params.config,{mcp_servers:{coagent8:{enabled:false},'fixture-http':{enabled:false}}});
  const thread = '11111111-aaaa-bbbb-cccc-123456789012';
  assert.ok(capture.records.slice(4,7).every(r=>r.params.threadId===thread),'checks describe the turn thread');
  assert.equal(capture.records[6].params.cursor,'page-2','every status page is checked');
  for (const [mode,detail] of [['mcp-not-disabled',/MCP server 'plugin-server' is not disabled/],['feature-enabled',/feature 'apps' is still enabled/],['no-isolation-api',/rejected the check/]]) {
    process.env.CODEX_FIXTURE_MODE = mode;
    const denied = await execute('x',options);
    assert.equal(denied.error.code,'SANDBOX_UNAVAILABLE',mode); assert.match(denied.error.message,detail,mode);
    const failed = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8'));
    assert.ok(!failed.records.some(r=>r.method==='turn/start'),`${mode}: no turn starts`);
  }
  delete process.env.CODEX_FIXTURE_MODE;
});

test('Codex respects deadlines and cancellation through the common runner, and never runs without a selected model',async () => {
  fs.rmSync(process.env.CODEX_FIXTURE_CAPTURE,{force:true});
  const unselected = await execute('x',{...options,model:undefined});
  assert.equal(unselected.error.code,'INPUT_LIMIT'); assert.equal(fs.existsSync(process.env.CODEX_FIXTURE_CAPTURE),false);
  const aborted = await execute('x',{...options,abortSignal:AbortSignal.abort()});
  assert.equal(aborted.status,'cancelled'); assert.equal(aborted.error.code,'ABORTED');
  assert.equal(fs.existsSync(process.env.CODEX_FIXTURE_CAPTURE),false);
  // Times are measured from the stop, never from the call: a slow runner may take longer than
  // a fixed deadline just to start the fixture (2026-10-19, windows-latest Node 26).
  const turn = {threadId:'11111111-aaaa-bbbb-cccc-123456789012',turnId:'019a0000-0000-7000-8000-000000000001'};
  const interruptOf = () => JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE,'utf8')).records.find(r=>r.method==='turn/interrupt');
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const controller = new AbortController(); let abortedAt = 0;
  const cancelled = await execute('x',{...options,abortSignal:controller.signal,timeoutMs:60000,
    onEvent:e=>{if(e.type==='assistant_message'&&!abortedAt){abortedAt=Date.now();controller.abort();}}});
  assert.equal(cancelled.status,'cancelled'); assert.equal(cancelled.error.code,'ABORTED');
  assert.equal(cancelled.exitCode,0,'the server exited by itself after the interrupted turn');
  assert.ok(Date.now()-abortedAt<INTERRUPT_GRACE_MS-100,'no wait for the forced-stop grace period');
  assert.ok(cancelled.output.includes('const answer = 42;'));
  assert.deepEqual(interruptOf().params,turn);
  // A deadline during the turn: an execution budget stops a turn with its TIMEOUT error as the
  // abort reason, which stays a timeout; the turn is interrupted without a forced stop.
  const budget = new AbortController(); let expiredAt = 0;
  const timedOut = await execute('x',{...options,abortSignal:budget.signal,timeoutMs:60000,
    onEvent:e=>{if(e.type==='assistant_message'&&!expiredAt){expiredAt=Date.now();budget.abort(new ToolError('TIMEOUT','Execution deadline exceeded.'));}}});
  assert.equal(timedOut.status,'timed_out'); assert.equal(timedOut.error.code,'TIMEOUT');
  assert.equal(timedOut.exitCode,0,'the server exited by itself after the interrupted turn');
  assert.ok(Date.now()-expiredAt<INTERRUPT_GRACE_MS-100,'no wait for the forced-stop grace period');
  assert.deepEqual(interruptOf().params,turn);
  assert.ok(timedOut.output.includes('const answer = 42;'));
  // The runner's own deadline before any turn exists (the thread never starts): nothing to
  // interrupt, so EOF ends the server, again without a forced stop.
  process.env.CODEX_FIXTURE_MODE = 'no-thread';
  const deadlineAt = Date.now();
  const early = await execute('x',{...options,timeoutMs:500});
  assert.equal(early.status,'timed_out'); assert.equal(early.error.code,'TIMEOUT');
  assert.equal(early.exitCode,0,'the server exited by itself on EOF');
  assert.ok(Date.now()-deadlineAt<500+INTERRUPT_GRACE_MS-100,'no wait for the forced-stop grace period');
  assert.equal(interruptOf(),undefined,'no turn, nothing to interrupt');
  // A server that ignores the interrupt is stopped once the grace period after the stop has passed.
  process.env.CODEX_FIXTURE_MODE = 'hang';
  const hung = new AbortController(); let stoppedAt = 0;
  const forced = await execute('x',{...options,abortSignal:hung.signal,timeoutMs:60000,
    onEvent:e=>{if(e.type==='assistant_message'&&!stoppedAt){stoppedAt=Date.now();hung.abort();}}});
  assert.equal(forced.status,'cancelled'); assert.equal(forced.error.code,'ABORTED');
  assert.ok(Date.now()-stoppedAt>=INTERRUPT_GRACE_MS-50,'a server that ignores the interrupt is stopped after the grace period');
  assert.notEqual(forced.exitCode,0);
  assert.ok(forced.output.includes('const answer = 42;'));
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

test('readCodexConfig reads only the top-level model keys, never comments, other keys or tables (AUD-P1-11)', () => {
  const file = path.join(directory,'audit-config.toml');
  fs.writeFileSync(file, [
    '# model = "o3"',
    'review_model = "luna"',
    'model_reasoning_effort = "high"',
    '[profiles.deep]',
    'model = "astra"',
  ].join('\n'));
  const commented = readCodexConfig(file);
  assert.equal(commented.defaultModel, undefined, 'a commented, review or profile model is not the default model; the catalog default applies');
  assert.equal(commented.defaultReasoningEffort, 'high');
  assert.equal(commented.configError, undefined);
  fs.writeFileSync(file, 'model = "gpt-6.0-sol" # chosen\n[profiles.deep]\nmodel = "astra"\n');
  assert.equal(readCodexConfig(file).defaultModel, 'gpt-6.0-sol');
  fs.writeFileSync(file, 'model = "unterminated\n');
  const invalid = readCodexConfig(file);
  assert.equal(invalid.defaultModel, undefined);
  assert.match(invalid.configError, /^Codex configuration not used: /, 'an invalid file is reported, not silently ignored');
  assert.equal(readCodexConfig(path.join(directory,'missing.toml')).configError, undefined, 'a missing file is the normal default case');
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
    assert.equal(result.modelSource, 'config.toml default; models from codex app-server model/list');
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

test('Codex reports the model the thread resolved rather than the requested one', async () => {
  assert.equal((await execute('x', options)).model, options.model);
  process.env.CODEX_FIXTURE_MODE = 'resolved-model';
  try {
    const resolved = await execute('x', options);
    assert.equal(resolved.status, 'completed');
    assert.equal(resolved.model, 'gpt-6.1-sol-2026-10-01');
  } finally {
    delete process.env.CODEX_FIXTURE_MODE;
  }
});

test('Codex reads the account rate-limit windows from app-server without a thread or a turn', async () => {
  const { codexAdapter } = require('../../../src/backends/codex/adapter.ts');
  const quota = await codexAdapter.inspectQuota();
  assert.deepEqual({ ...quota, buckets: undefined }, { measured: true, headroomPercent: 55, usedPercent: 45, resetsAt: '2026-10-14T00:00:45.000Z', window: 'weekly', buckets: undefined },
    'the weekly window is the bottleneck');
  assert.deepEqual(quota.buckets.map(b => [b.id, b.window, b.remainingFraction]), [['codex:primary', '5h', 0.8], ['codex:secondary', 'weekly', 0.55]]);
  const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE, 'utf8'));
  assert.deepEqual(capture.records.map(r => r.method), ['initialize', 'initialized', 'account/rateLimits/read'], 'no thread is started');
  process.env.CODEX_FIXTURE_LIMITS = 'error';
  try { assert.equal(await codexAdapter.inspectQuota(), undefined, 'an account without ChatGPT limits stays unmeasured'); }
  finally { delete process.env.CODEX_FIXTURE_LIMITS; }
});

test('Codex rate limits without a measured window are no quota', () => {
  const { parseCodexRateLimits } = require('../../../src/backends/codex/models.ts');
  assert.equal(parseCodexRateLimits({}), undefined);
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }), undefined);
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 120, windowDurationMins: 90, resetsAt: 'soon' } } }).buckets[0].window, '90m');
});

test('EXEC-001-T08c: probe, listModels, and inspectQuota abort deterministically via abortSignal and release handles', async () => {
  const { activeProcesses } = require('../../../src/execution/process.ts');

  // 1. Backward compatibility without context
  const normalProbe = await codexAdapter.probe();
  assert.equal(normalProbe.installed, true);
  const normalCatalog = await codexAdapter.listModels();
  assert.ok(normalCatalog?.models.length > 0);
  assert.equal(normalCatalog?.source, 'codex app-server model/list');
  const normalQuota = await codexAdapter.inspectQuota();
  assert.ok(normalQuota?.measured);

  // 2. Pre-aborted signal rejects immediately before launching process
  const preController = new AbortController();
  preController.abort();
  await assert.rejects(
    codexAdapter.probe({ abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    codexAdapter.listModels(undefined, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  await assert.rejects(
    codexAdapter.inspectQuota(undefined, { abortSignal: preController.signal }),
    err => err instanceof ToolError && err.code === 'ABORTED'
  );
  assert.equal(activeProcesses.size, 0, 'no process launched for pre-aborted reads');

  // 3. Pre-expired budget rejects with TIMEOUT before launch
  const expiredBudget = { isExecutionExpired: () => true, isTimedOut: () => true, executionSignal: new AbortController().signal };
  await assert.rejects(
    codexAdapter.probe({ budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    codexAdapter.listModels(undefined, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  await assert.rejects(
    codexAdapter.inspectQuota(undefined, { budget: expiredBudget }),
    err => err instanceof ToolError && err.code === 'TIMEOUT'
  );
  assert.equal(activeProcesses.size, 0, 'no process launched for expired budgets');

  // 4. Stalled probe aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CODEX_FIXTURE_MODE = 'hang-probe';
  try {
    const probeCtrl = new AbortController();
    const probePromise = codexAdapter.probe({ abortSignal: probeCtrl.signal });
    await new Promise(r => setTimeout(r, 60));
    assert.ok(activeProcesses.size >= 1, 'probe process is running');
    probeCtrl.abort();
    await assert.rejects(probePromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'probe process cleaned up after abort');
  } finally {
    delete process.env.CODEX_FIXTURE_MODE;
  }

  // 5. Stalled catalog read aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CODEX_FIXTURE_MODE = 'hang-models';
  try {
    const catalogCtrl = new AbortController();
    const catalogPromise = codexAdapter.listModels(undefined, { abortSignal: catalogCtrl.signal });
    await new Promise(r => setTimeout(r, 60));
    assert.ok(activeProcesses.size >= 1, 'catalog process is running');
    catalogCtrl.abort();
    await assert.rejects(catalogPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'catalog process cleaned up after abort');
  } finally {
    delete process.env.CODEX_FIXTURE_MODE;
  }

  // 6. Stalled quota read aborts via abortSignal, releases process and rejects with ABORTED
  process.env.CODEX_FIXTURE_MODE = 'hang-limits';
  try {
    const quotaCtrl = new AbortController();
    const quotaPromise = codexAdapter.inspectQuota(undefined, { abortSignal: quotaCtrl.signal });
    await new Promise(r => setTimeout(r, 60));
    assert.ok(activeProcesses.size >= 1, 'quota process is running');
    quotaCtrl.abort();
    await assert.rejects(quotaPromise, err => err instanceof ToolError && err.code === 'ABORTED');
    assert.equal(activeProcesses.size, 0, 'quota process cleaned up after abort');
  } finally {
    delete process.env.CODEX_FIXTURE_MODE;
  }
});

test('a Codex review turn may read repository files with read-only shell commands, inside the verified read-only profile', async () => {
  const { execFileSync } = require('node:child_process');
  const { handleReview } = require('../../../src/mcp/tools/review.tool.ts');
  const repo = path.join(directory, 'review-repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
  await handleReview('review', { backend: 'codex', model: options.model }, repo);
  const capture = JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE, 'utf8'));
  // Codex has no file tool: its read-only shell (`exec_command`, feature `shell_tool`) is how it reads files.
  assert.ok(!capture.args.includes('features.shell_tool=false'), 'the read-only shell stays on');
  assert.doesNotMatch(capture.prompt, /do not run shell commands/i, 'the prompt does not forbid the only way Codex reads files');
  assert.match(capture.prompt, /if you have none, read them with read-only shell commands/);
  const start = capture.records.find(r => r.method === 'thread/start').params;
  assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never');
  assert.deepEqual(start.config, { mcp_servers: { coagent8: { enabled: false }, 'fixture-http': { enabled: false } } });
  assert.deepEqual(capture.records.map(r => r.method).slice(-4), ['experimentalFeature/list', 'mcpServerStatus/list', 'mcpServerStatus/list', 'turn/start'], 'the turn starts only after the isolation checks');
});
