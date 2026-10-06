const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.2.16'); process.exit(0); }
if (args.includes('models')) {
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)');
  process.exit(0);
}

let prompt = '';
if (args.includes('-p')) {
  prompt = args[args.indexOf('-p') + 1] || '';
  run();
} else if (args.includes('--print')) {
  prompt = args[args.indexOf('--print') + 1] || '';
  run();
} else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => run());
}

function run() {
  const mode = process.env.coagent8_FIXTURE_MODE || 'success';
  if (prompt === '/usage') {
    if (mode === 'unauthenticated' || mode === 'auth') {
      console.log(JSON.stringify({ status: 'ERROR', error: 'Authentication required' }));
      return;
    }
    console.log(JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 0.52,
                  reset_time: '2026-10-05T17:31:49Z'
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.75,
                  reset_time: '2026-10-05T17:35:23Z'
                }
              ]
            }
          ]
        }
      }
    }));
    return;
  }
  if (process.env.coagent8_FIXTURE_CAPTURE) {
    fs.writeFileSync(process.env.coagent8_FIXTURE_CAPTURE, JSON.stringify({ args, prompt }));
  }
  const send = event => console.log(JSON.stringify(event));
  if (mode === 'malformed') { console.log('{invalid}'); return; }
  const native = args.includes('--conversation')
    ? args[args.indexOf('--conversation') + 1]
    : (args.includes('--resume') ? args[args.indexOf('--resume') + 1] : '11111111-aaaa-bbbb-cccc-123456789012');
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'gemini-3.8-flash-high';

  if (mode === 'rate-before-init') {
    send({ event: 'result', result: { conversation_id: native, status: 'ERROR', error: 'HTTP 429 Too Many Requests' } });
    return;
  }

  const sid = mode === 'wrong-session' ? '99999999-aaaa-bbbb-cccc-123456789012' : native;
  send({ event: 'init', conversation_id: sid, model });

  if (mode === 'secret-hang') {
    send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '{"api_key":"fixtureSecret' } });
    setInterval(() => {}, 1000);
    return;
  }

  if (mode.startsWith('sandbox-denied')) {
    const terminal = {
      event: 'result',
      result: {
        conversation_id: sid,
        status: 'SUCCESS',
        response: '',
        duration_seconds: 0.5,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      },
    };
    const denial = () => process.stderr.write('jetski: RunCommand auto-denied by sandbox policy\n');
    if (mode === 'sandbox-denied-stderr-first') {
      process.stderr.write('jetski: RunCommand auto-denied by sandbox policy\n', () => setTimeout(() => send(terminal), 100));
    } else {
      send(terminal);
      if (mode === 'sandbox-denied-stdout-first') setTimeout(denial, 100);
      if (mode === 'sandbox-denied-duplicate') { denial(); send(terminal); }
    }
    return;
  }

  send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 0, state: 'DONE', step_type: 'user_input' } });
  send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file' } });
  send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file' } });
  send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Draft ' } });
  send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Final **Markdown**\n```js\nconst value = 42;\n```' } });

  if (mode === 'no-terminal') return;
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }

  if (['auth', 'model', 'rate', 'invalid-session', 'error-exit-zero'].includes(mode)) {
    const message = {
      auth: 'Authentication required; api_key=fixtureSecret',
      model: 'Model not found',
      rate: 'HTTP 429 Too Many Requests',
      'invalid-session': 'Session not found',
      'error-exit-zero': 'protocol failure',
    }[mode];
    send({ event: 'result', result: { conversation_id: sid, status: 'ERROR', error: message } });
    return;
  }

  send({
    event: 'result',
    result: {
      conversation_id: sid,
      status: 'SUCCESS',
      response: 'Final **Markdown**\n```js\nconst value = 42;\n```',
      duration_seconds: 1.2,
      num_turns: 1,
      usage: { input_tokens: 5, output_tokens: 9, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 14 },
    },
  });

  if (mode === 'exit-failed') {
    console.error('Authentication required');
    process.exitCode = 1;
  }
}
