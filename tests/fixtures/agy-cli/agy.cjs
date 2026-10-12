const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.coagent8_FIXTURE_LAUNCH_LOG) {
  fs.appendFileSync(process.env.coagent8_FIXTURE_LAUNCH_LOG, JSON.stringify({ args, autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null }) + '\n');
}
const mode = process.env.AGY_FIXTURE_MODE || process.env.coagent8_FIXTURE_MODE || 'success';
if (args.includes('--version')) {
  if (mode === 'hang-probe' || mode === 'hang-version') {
    setInterval(() => {}, 1000);
    return;
  }
  console.log('1.2.16');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  if (mode === 'hang-mcp' || mode === 'hang-tools') {
    setInterval(() => {}, 1000);
    return;
  }
  // `agy mcp list` of agy 1.3.1 (2026-10-07); coagent8_FIXTURE_AGY_MCP lists [name, status] rows.
  const rows = JSON.parse(process.env.coagent8_FIXTURE_AGY_MCP || '[]');
  if (!rows.length) { console.log('No MCP servers configured.'); process.exit(0); }
  console.log(['NAME          TYPE   STATUS    COMMAND/URL', ...rows.map(([name, status]) => `${name.padEnd(12)}  stdio  ${status.padEnd(8)}  npx.cmd -y ${name}`)].join('\n'));
  process.exit(0);
}
if (args.includes('models')) {
  if (mode === 'hang-models' || mode === 'hang-catalog') {
    setInterval(() => {}, 1000);
    return;
  }
  // `agy models` of agy 1.3.1 (2026-10-07), abridged: a progress line, then `<id>\t<name>`.
  console.log(['Fetching available models...', 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)', 'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', 'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)', 'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)', 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'].join('\n'));
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
  // agy-like shutdown: SIGTERM starts a 1 s cleanup that records its completion. The handler is
  // installed before any output, because the first answer delta makes the test cancel the turn.
  if (mode === 'sigterm-cleanup') {
    process.on('SIGTERM', () => {
      fs.writeFileSync(`${process.env.coagent8_FIXTURE_MARKER}.received`, '1');
      setTimeout(() => { fs.writeFileSync(process.env.coagent8_FIXTURE_MARKER, 'clean'); process.exit(0); }, 1000);
    });
  }
  if (prompt === '/usage') {
    if (mode === 'hang-usage' || mode === 'hang-quota') {
      setInterval(() => {}, 1000);
      return;
    }
    if (process.env.coagent8_FIXTURE_CAPTURE) fs.writeFileSync(process.env.coagent8_FIXTURE_CAPTURE, JSON.stringify({ args, prompt, nested: process.env.COAGENT8_NESTED_TURN ?? null }));
    if (mode === 'unauthenticated' || mode === 'auth') {
      console.log(JSON.stringify({ status: 'ERROR', error: 'Authentication required' }));
      return;
    }
    // Shape of agy 1.3.1 `/usage` (2026-10-05) with synthetic usage and reset values.
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
                  remaining_fraction: 0.6,
                  reset_time: '2026-10-05T18:00:00Z'
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  window: '5h',
                  remaining_fraction: 0.8,
                  reset_time: '2026-10-05T16:00:00Z'
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
    fs.writeFileSync(process.env.coagent8_FIXTURE_CAPTURE, JSON.stringify({ args, prompt, nested: process.env.COAGENT8_NESTED_TURN ?? null }));
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
  send(mode === 'init-without-model' ? { event: 'init', conversation_id: sid } : { event: 'init', conversation_id: sid, model });

  if (mode === 'secret-hang') {
    send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'sk-fixtureSecret1234567890abcdef' } });
    setInterval(() => {}, 1000);
    return;
  }

  if (mode.startsWith('sandbox-denied')) {
    const isRecoveryTurn = args.includes('--conversation') && prompt.includes('Your sandbox denied a shell command');
    if (mode === 'sandbox-denied-recover' && isRecoveryTurn) {
      const recoveredText = process.env.coagent8_FIXTURE_RECOVER_RESPONSE || 'Recovered answer from read_file without shell commands.';
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file' } });
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file' } });
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: recoveredText } });
      send({
        event: 'result',
        result: {
          conversation_id: sid,
          status: 'SUCCESS',
          response: recoveredText,
          duration_seconds: 0.5,
          num_turns: 1,
          usage: { input_tokens: 15, output_tokens: 25, total_tokens: 40 },
        },
      });
      return;
    }
    if (mode === 'sandbox-denied-recover') {
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } });
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'run_command' } });
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '   ' } });
    }
    const terminal = {
      event: 'result',
      result: {
        conversation_id: sid,
        status: 'SUCCESS',
        // `sandbox-denied-empty`: agy 1.3.1 (2026-10-08) ends the turn after a headless denial with an empty response.
        response: mode === 'sandbox-denied-empty' || mode === 'sandbox-denied-recover' ? '' : 'Answer from the files agy could read.',
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
  // WINDOWS-001a: a turn that started a native descendant (like an MCP server or a build) and
  // then hangs. The descendant increments a heartbeat file, never selected by PID by the test,
  // and exits on its own when `<marker>.stop` appears or after 20 s. This Node root puts a
  // normal child in its own libuv kill-on-close job; `coagent8_FIXTURE_DESCENDANT=outside-job`
  // starts it detached (no console, no job), as a child of a native, non-libuv CLI would be.
  if (mode === 'native-descendant') {
    const marker = process.env.coagent8_FIXTURE_MARKER;
    const descendant = `const fs=require('node:fs');const m=process.argv[1];let n=0;const end=Date.now()+20000;
      const timer=setInterval(()=>{if(fs.existsSync(m+'.stop')||Date.now()>end){clearInterval(timer);fs.writeFileSync(m+'.exited','1');return;}fs.writeFileSync(m,String(++n));},50);`;
    require('node:child_process').spawn(process.execPath, ['-e', descendant, marker], { stdio: 'ignore', windowsHide: true, detached: process.env.coagent8_FIXTURE_DESCENDANT === 'outside-job' })
      .unref();
    const started = setInterval(() => {
      if (!fs.existsSync(marker)) return;
      clearInterval(started);
      send({ event: 'step_update', step_update: { conversation_id: sid, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'descendant running' } });
      setInterval(() => {}, 1000);
    }, 20);
    return;
  }
  // The SIGTERM handler of this mode is installed at the start of `run`.
  if (mode === 'sigterm-cleanup') {
    setInterval(() => {}, 1000);
    return;
  }

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
