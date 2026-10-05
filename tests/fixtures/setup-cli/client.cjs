const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('synthetic 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--bare --sandbox'); process.exit(0); }
if (args[0] === 'mcp' && ['add', 'remove'].includes(args[1])) {
  const file = path.join(process.env.CODEX_HOME, 'config.toml');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = before.indexOf('[mcp_servers.coagent8]');
  const next = start < 0 ? -1 : before.slice(start + '[mcp_servers.coagent8]'.length).search(/^\[/m);
  const end = next < 0 ? before.length : start + '[mcp_servers.coagent8]'.length + next;
  const prefix = start < 0 ? before : before.slice(0, start);
  const suffix = start < 0 ? '' : before.slice(end);
  if (args[1] === 'remove') { fs.writeFileSync(file, prefix + suffix); process.exit(0); }
  const command = args[args.indexOf('--') + 1];
  const commandArgs = args.slice(args.indexOf('--') + 2);
  fs.writeFileSync(file, prefix + `\n[mcp_servers.coagent8]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(commandArgs)}\n` + suffix);
  process.exit(0);
}
if (args[0] === 'app-server') {
  const file = path.join(process.env.CODEX_HOME, 'config.toml');
  const config = fs.readFileSync(file, 'utf8');
  const baseline = path.join(process.env.SETUP_FIXTURE_HOME, 'baseline-config');
  if (!fs.existsSync(baseline)) fs.writeFileSync(baseline, config);
  const candidate = config !== fs.readFileSync(baseline, 'utf8');
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const failed = candidate && process.env.SETUP_FIXTURE_FAIL_CANDIDATE;
    if (failed && process.env.SETUP_FIXTURE_CONCURRENT_EDIT && request.method === 'mcpServerStatus/list') {
      fs.appendFileSync(file, '\n[unrelated]\nsecret = "synthetic-concurrent-secret"\n');
    }
    const result = request.method === 'thread/start' ? { thread: { id: 'synthetic-thread' } }
      : request.method === 'mcpServerStatus/list' ? { data: [{ name: 'coagent8', tools: failed ? {} : { doctor: { name: 'doctor' } } }] }
      : request.method === 'mcpServer/tool/call' ? { content: [], isError: false }
      : {};
    console.log(JSON.stringify({ id: request.id, result }));
  });
} else { console.log('synthetic CLI'); }
