const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
if (process.env.SETUP_FIXTURE_PROBE_LOG) fs.appendFileSync(process.env.SETUP_FIXTURE_PROBE_LOG, JSON.stringify(args) + '\n');
if (process.env.SETUP_FIXTURE_ENV_LOG)
  fs.appendFileSync(
    process.env.SETUP_FIXTURE_ENV_LOG,
    JSON.stringify({
      args,
      autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
      auth: process.env.AGY_CLI_CDE_AUTH_ACTION ?? null,
    }) + '\n',
  );
// agy's silent sign-in check, as run by the Google Antigravity extension.
if (process.env.AGY_CLI_CDE_AUTH_ACTION === 'check') {
  if (process.env.SETUP_FIXTURE_SIGNED_OUT === '1') {
    console.error('not authenticated: no stored credentials found');
    process.exit(1);
  }
  if (process.env.SETUP_FIXTURE_AUTH_ERROR === '1') {
    console.error('failed to refresh token: network is unreachable');
    process.exit(1);
  }
  console.log('Already authenticated as fixture@example.invalid.');
  process.exit(0);
}
if (args.includes('--version')) {
  console.log(process.env.SETUP_FIXTURE_VERSION || '2.1.292');
  process.exit(0);
}
if (args.includes('--help')) {
  (process.env.SETUP_FIXTURE_HELP_STDERR ? console.error : console.log)(
    process.env.SETUP_FIXTURE_HELP ||
      'app-server --sandbox --restricted --tools --permission-mode --permission-prompts --strict-mcp-config --mcp-config --output-format --input-format --no-session-persistence --conversation',
  );
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log(process.env.SETUP_FIXTURE_SIGNED_OUT === '1' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(process.env.SETUP_FIXTURE_SIGNED_OUT === '1' ? 1 : 0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.SETUP_FIXTURE_SIGNED_OUT !== '1' }));
  process.exit(process.env.SETUP_FIXTURE_SIGNED_OUT === '1' ? 1 : 0);
}
if (args[0] === 'mcp' && ['add', 'remove'].includes(args[1])) {
  const file = path.join(process.env.CODEX_HOME, 'config.toml');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = before.indexOf('[mcp_servers.coagent8]');
  const next = start < 0 ? -1 : before.slice(start + '[mcp_servers.coagent8]'.length).search(/^\[/m);
  const end = next < 0 ? before.length : start + '[mcp_servers.coagent8]'.length + next;
  const prefix = start < 0 ? before : before.slice(0, start);
  const suffix = start < 0 ? '' : before.slice(end);
  if (args[1] === 'remove') {
    fs.writeFileSync(file, prefix + suffix);
    process.exit(0);
  }
  const command = args[args.indexOf('--') + 1];
  const commandArgs = args.slice(args.indexOf('--') + 2);
  const environment = [];
  for (let index = 3; index < args.indexOf('--'); index++) {
    if (args[index] !== '--env') continue;
    const entry = args[++index],
      separator = entry.indexOf('=');
    if (separator < 1) throw new Error('Invalid fixture --env entry');
    environment.push(`${JSON.stringify(entry.slice(0, separator))} = ${JSON.stringify(entry.slice(separator + 1))}`);
  }
  const envLine = environment.length ? `env = { ${environment.join(', ')} }\n` : '';
  fs.writeFileSync(
    file,
    prefix + `\n[mcp_servers.coagent8]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(commandArgs)}\n${envLine}` + suffix,
  );
  process.exit(0);
}
if (args[0] === 'app-server') {
  const file = path.join(process.env.CODEX_HOME, 'config.toml');
  const config = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const baseline = path.join(process.env.SETUP_FIXTURE_HOME, 'baseline-config');
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === 'thread/start' && !fs.existsSync(baseline)) fs.writeFileSync(baseline, config);
    const candidate = fs.existsSync(baseline) && config !== fs.readFileSync(baseline, 'utf8');
    const failed = candidate && process.env.SETUP_FIXTURE_FAIL_CANDIDATE;
    if (failed && process.env.SETUP_FIXTURE_CONCURRENT_EDIT && request.method === 'mcpServerStatus/list') {
      fs.appendFileSync(file, '\n[unrelated]\nsecret = "synthetic-concurrent-secret"\n');
    }
    const result =
      request.method === 'thread/start'
        ? { thread: { id: 'synthetic-thread' } }
        : request.method === 'mcpServerStatus/list'
          ? { data: [{ name: 'coagent8', tools: failed ? {} : { doctor: { name: 'doctor' } } }] }
          : request.method === 'mcpServer/tool/call'
            ? { content: [], isError: false }
            : {};
    console.log(JSON.stringify({ id: request.id, result }));
  });
} else {
  console.log('synthetic CLI');
}
