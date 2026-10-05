const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.CODEX_FIXTURE_CAPTURE) fs.writeFileSync(process.env.CODEX_FIXTURE_CAPTURE, JSON.stringify({args, prompt}));
  const mode = process.env.CODEX_FIXTURE_MODE || 'success';
  const send = event => console.log(JSON.stringify(event));
  if (mode === 'malformed') { console.log('{invalid'); return; }
  const thread = args.includes('resume') ? args[args.indexOf('resume') + 1] : '11111111-aaaa-bbbb-cccc-123456789012';
  send({type:'thread.started',thread_id:mode === 'wrong-thread' ? '22222222-aaaa-bbbb-cccc-123456789012' : thread});
  send({type:'turn.started'});
  send({type:'item.completed',item:{id:'private',type:'reasoning',text:'PRIVATE_REASONING_NEVER_PERSIST'}});
  send({type:'item.started',item:{id:'read-1',type:'command_execution',command:'PRIVATE_RAW_COMMAND'}});
  send({type:'item.completed',item:{id:'read-1',type:'command_execution',exit_code:0,status:'completed',aggregated_output:'PRIVATE_TOOL_OUTPUT'}});
  send({type:'item.updated',item:{id:'message-1',type:'agent_message',text:'Draft'}});
  const message = {type:'item.completed',item:{id:'message-1',type:'agent_message',text:'Final **Markdown** 😀\n```js\nconst answer = 42;\n```\napi_key=fixtureSecret'}};
  send(message); send(message);
  if (mode === 'hang') { setInterval(() => {},1000); return; }
  if (mode === 'no-terminal') return;
  if (['auth','rate','invalid-session'].includes(mode)) {
    send({type:'turn.failed',error:{message:{auth:'Authentication required; api_key=fixtureSecret',rate:'HTTP 429 Too Many Requests','invalid-session':'Session not found'}[mode]}}); return;
  }
  if (mode === 'error-exit-zero') send({type:'error',message:'Provider failure'});
  send({type:'turn.completed',usage:{input_tokens:5,output_tokens:9}});
  if (mode === 'duplicate-terminal') send({type:'turn.completed'});
  if (mode === 'exit-failed') { console.error('Process failed'); process.exitCode=1; }
});
