const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const { spawn } = require('node:child_process');

const {
  runCommand,
  activeProcesses,
  terminateAllProcesses,
  terminateProcessTree,
} = require('../../src/execution/process.ts');
const { resolveCliCommand } = require('../../src/execution/cli-resolver.ts');
const { createLineDecoder, truncateToByteLength, readBoundedFile } = require('../../src/execution/stream.ts');

// Fake protocol CLI: NDJSON on stdin; answers an interrupt with a terminal record unless told to ignore it.
const protocolCli = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.type === 'start') console.log(JSON.stringify({ type: 'started', input: m.input }));
    if (m.type === 'interrupt' && process.argv[1] !== 'ignore') console.log(JSON.stringify({ type: 'done', reason: 'interrupted' }));
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`;

function protocolSession(onStarted) {
  const seen = [];
  let channel;
  return {
    seen,
    session: { start(c, input) { channel = c; c.send({ type: 'start', input }); }, interrupt(c) { c.send({ type: 'interrupt' }); } },
    line(raw) {
      const m = JSON.parse(raw); seen.push(m.type);
      if (m.type === 'started') onStarted?.();
      if (m.type === 'done') channel.close();
    },
  };
}

test('F05: pre-abort with a missing executable never launches or emits uncaught ENOENT', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runCommand('coagent8-nonexistent-command', [], { abortSignal: controller.signal });
  assert.equal(result.error.code, 'ABORTED'); assert.equal(result.status, 'cancelled');
  assert.equal(activeProcesses.size, 0);
  await new Promise(resolve => setImmediate(resolve));
});

test('F02: npm shim resolves its actual JS entrypoint with spaces and literal shell metacharacters', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8 shim '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'cli.cjs'), shim = path.join(dir, 'fake.cmd');
  fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\cli.cjs" %*\r\n');
  assert.deepEqual(resolveCliCommand(shim).argsPrefix, [entry]);
  const result = await runCommand(shim, ['a b', '$(literal)&"x\\', 'zażółć 😀']);
  assert.equal(result.status, 'completed', result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['a b', '$(literal)&"x\\', 'zażółć 😀']);
  const byPath = resolveCliCommand('fake', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' } });
  assert.equal(byPath.source, 'npm-shim');
  fs.chmodSync(entry,0o600);
  assert.equal(resolveCliCommand(entry,{platform:'linux'}).command,process.execPath,'Explicit JS does not require an executable bit');
});

test('F06: timeout, cancellation, EOF shutdown remove the whole process tree and listeners', async (t) => {
  for (const mode of ['timeout', 'abort', 'eof', 'leader-exit']) {
    let pid;
    t.after(() => {
      if (pid) {
        try { process.kill(pid); } catch {}
      }
    });
    const controller = new AbortController();
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:${mode==='leader-exit'?"'inherit'":"'ignore'"},windowsHide:true});console.log(c.pid);${mode === 'leader-exit' ? 'setTimeout(()=>process.exit(0),100)' : 'setInterval(()=>{},1000)'};`;
    const result = await runCommand(process.execPath, ['-e', script], {
      abortSignal: controller.signal, timeoutMs: 4000,
      onStdoutLine(line) { pid = Number(line); if (mode === 'abort') controller.abort(); if (mode === 'eof') void terminateAllProcesses(); },
    });
    assert.ok(pid, `${mode}: ${result.stderr}`);
    assert.equal(result.status, mode === 'timeout' ? 'timed_out' : mode === 'leader-exit' ? 'completed' : 'cancelled');
    const deadline = Date.now() + 2000;
    let descendantGone = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise(r => setTimeout(r, 50));
      } catch (err) {
        if (err && err.code === 'ESRCH') {
          descendantGone = true;
          break;
        }
        throw err;
      }
    }
    assert.equal(descendantGone, true, `${mode}: descendant alive`);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(activeProcesses.size, 0);
  }
});

test('F08: UTF-8, CRLF, split emoji, complete oversized lines and trailing fragments', () => {
  const lines = [], decoder = createLineDecoder(line => lines.push(line), 20);
  const bytes = Buffer.from('zażółć 😀\r\nx\ny');
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.finish(); assert.deepEqual(lines, ['zażółć 😀', 'x', 'y']);
  for (const text of ['a'.repeat(21)+'\n', 'ok\n'+'a'.repeat(21)]) {
    assert.throws(() => createLineDecoder(() => {}, 20).push(Buffer.from(text)), { code: 'BUFFER_LIMIT' });
  }
  for (let limit = 0; limit < 30; limit++) {
    const output = truncateToByteLength('😀'.repeat(50), limit, '…');
    assert.ok(Buffer.byteLength(output) <= limit); assert.ok(!output.includes('�'));
  }
});

test('F06: server shutdown blocks a pending task from launching its next subprocess',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-shutdown-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'should-not-exist'),module=path.resolve(__dirname, '../..', 'src/execution/process.ts');
  const script=`const {runCommand,shutdownProcessRunner,activeProcesses}=require(process.argv[1]);(async()=>{let resume;const pending=new Promise(resolve=>resume=resolve).then(()=>runCommand(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],"launched")',process.argv[2]]));await shutdownProcessRunner();resume();const result=await pending;console.log(JSON.stringify({status:result.status,code:result.error?.code,active:activeProcesses.size}));})().catch(()=>process.exit(1));`;
  const result=await runCommand(process.execPath,['--require','tsx/cjs','-e',script,module,marker]);
  assert.equal(result.status,'completed',result.stderr);assert.deepEqual(JSON.parse(result.stdout),{status:'cancelled',code:'ABORTED',active:0});assert.equal(fs.existsSync(marker),false);
});

test('F08: protocol overflow stops execution; file and diagnostic budgets cannot be bypassed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'answer.txt'); fs.writeFileSync(file, 'x'.repeat(200));
  await assert.rejects(readBoundedFile(file, 100), { code: 'BUFFER_LIMIT' });
  const result = await runCommand(process.execPath, ['-e', "console.log('x'.repeat(10000));setInterval(()=>{},1000)"], { maxLineBytes: 100, maxBufferBytes: 40, onStdoutLine() {} });
  assert.equal(result.error.code, 'BUFFER_LIMIT'); assert.ok(Buffer.byteLength(result.stdout) <= 40);
  const diag = await runCommand(process.execPath, ['-e', "process.stderr.write('😀'.repeat(500))"], { maxBufferBytes: 39 });
  assert.ok(Buffer.byteLength(diag.stderr) <= 39); assert.ok(!diag.stderr.includes('�')); assert.ok(diag.isTruncated);
});

test('missing command, async spawn failure, closed stdin and native executable are controlled', async () => {
  assert.equal((await runCommand('coagent8-missing', [])).error.code, 'CLI_NOT_FOUND');
  const badCwd = await runCommand(process.execPath, [], { cwd: path.join(os.tmpdir(), 'coagent8-absent-cwd') });
  assert.equal(badCwd.status, 'failed');
  const result = await runCommand(process.execPath, ['-e', 'process.stdin.destroy();process.exit(0)'], { stdinInput: 'x'.repeat(65536) });
  assert.equal(result.status, 'completed', result.stderr);
});

test('layer 2: terminateProcessTree stops the owned root through its handle and is idempotent', async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { terminateProcessTree } = require('../../src/execution/process.ts');
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', windowsHide: true });
  await once(proc, 'spawn');
  const first = terminateProcessTree(proc);
  assert.equal(terminateProcessTree(proc), first, 'concurrent calls share one teardown');
  await first;
  if (proc.exitCode === null && proc.signalCode === null) await once(proc, 'exit');
  assert.ok(proc.exitCode !== 0 || proc.signalCode !== null, 'the root was stopped, not left running');
});

test('layer 1: an interrupted protocol CLI ends its turn and exits by itself before the grace period', async () => {
  for (const [mode, expected] of [['abort', 'cancelled'], ['timeout', 'timed_out']]) {
    const controller = new AbortController();
    const fake = protocolSession(() => { if (mode === 'abort') controller.abort(); });
    const startedAt = Date.now();
    const result = await runCommand(process.execPath, ['-e', protocolCli], {
      stdinInput: 'prompt', session: fake.session, onStdoutLine: fake.line, abortSignal: controller.signal,
      timeoutMs: mode === 'timeout' ? 1500 : 30_000, interruptGraceMs: 10_000,
    });
    assert.equal(result.status, expected, `${mode}: ${result.stderr}`);
    assert.deepEqual(fake.seen, ['started', 'done'], `${mode}: output after the interrupt is still delivered`);
    assert.equal(result.exitCode, 0, `${mode}: the CLI exited by itself, it was not stopped`);
    assert.ok(Date.now() - startedAt < 9000, `${mode}: no wait for the grace period`);
    assert.equal(activeProcesses.size, 0);
  }
});

test('layer 1 -> 2: a CLI that ignores the interrupt is stopped when the grace period ends', async () => {
  const controller = new AbortController();
  const fake = protocolSession(() => controller.abort());
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, ['-e', protocolCli, 'ignore'], {
    stdinInput: 'prompt', session: fake.session, onStdoutLine: fake.line, abortSignal: controller.signal, interruptGraceMs: 400,
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(fake.seen, ['started']);
  assert.ok(result.exitCode !== 0 || result.signal !== null, 'the root was stopped');
  assert.ok(Date.now() - startedAt >= 400, 'the grace period was honored');
  assert.equal(activeProcesses.size, 0);
});

test('layer 1: a session that closed stdin before failing lets the CLI exit by itself', async () => {
  let channel;
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, ['-e', protocolCli], {
    session: { start(c) { channel = c; c.send({ type: 'start' }); }, interrupt() { throw new Error('interrupt must not be sent after EOF'); } },
    onStdoutLine() { channel.close(); throw Object.assign(new Error('bad record'), { code: 'PROTOCOL_ERROR' }); }, interruptGraceMs: 10_000,
  });
  assert.equal(result.error.code, 'PROTOCOL_ERROR');
  assert.equal(result.exitCode, 0, 'EOF ended the CLI; it was not stopped');
  assert.ok(Date.now() - startedAt < 9000, 'the exit did not wait for the grace period');
});

test('layer 1: a session that throws on start or interrupt falls back to a forced stop', async () => {
  const startedAt = Date.now();
  const failing = await runCommand(process.execPath, ['-e', protocolCli], {
    session: { start() { throw Object.assign(new Error('bad start'), { code: 'PROTOCOL_ERROR' }); }, interrupt() { throw new Error('nothing was started'); } }, interruptGraceMs: 10_000,
  });
  assert.equal(failing.error.code, 'PROTOCOL_ERROR');
  assert.notEqual(failing.exitCode, 0, 'a session that never started is stopped');
  assert.ok(Date.now() - startedAt < 9000, 'a failed start does not wait for the grace period');
  const controller = new AbortController();
  const interruptedAt = Date.now();
  const broken = await runCommand(process.execPath, ['-e', protocolCli], {
    session: { start(c) { c.send({ type: 'start' }); }, interrupt() { throw new Error('channel broken'); } },
    onStdoutLine() { controller.abort(); }, abortSignal: controller.signal, interruptGraceMs: 10_000,
  });
  assert.equal(broken.status, 'cancelled');
  assert.ok(Date.now() - interruptedAt < 9000, 'a failed interrupt does not wait for the grace period');
});

test('layer 2 (POSIX): a per-run signal grace lets a SIGTERM handler finish before SIGKILL', async t => {
  if (process.platform === 'win32') { t.skip('POSIX process-group signals only'); return; }
  // Handles SIGTERM with 1 s of cleanup, then exits 0.
  const cli = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000)); console.log('ready'); setInterval(() => {}, 1000);";
  for (const [signalGraceMs, cleanExit] of [[2000, true], [undefined, false]]) {
    const controller = new AbortController();
    const result = await runCommand(process.execPath, ['-e', cli], { abortSignal: controller.signal, timeoutMs: 15000, signalGraceMs, onStdoutLine() { controller.abort(); } });
    assert.equal(result.status, 'cancelled');
    if (cleanExit) assert.equal(result.exitCode, 0, 'the handler finished inside the 2 s grace');
    else assert.equal(result.signal, 'SIGKILL', 'the default 250 ms grace escalates to SIGKILL');
  }
  assert.equal((await runCommand(process.execPath, ['-e', ''], { signalGraceMs: -1 })).error.code, 'INPUT_LIMIT');
});

test('layer 3: a descendant outside the owned tree that holds stdout cannot delay the result', async () => {
  const { PIPE_DRAIN_MS } = require('../../src/execution/process.ts');
  // The leaf escapes the owned tree (a non-Node intermediate on Windows, its own process
  // group on POSIX), inherits stdout and exits by itself after 6 s.
  const leaf = 'setTimeout(() => {}, 6000)';
  const root = process.platform === 'win32'
    ? `require('node:child_process').spawn('cmd.exe', ['/d', '/s', '/c', '""' + process.execPath + '" -e "${leaf}""'], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true }); setTimeout(() => process.exit(0), 500);`
    : `require('node:child_process').spawn(process.execPath, ['-e', '${leaf}'], { stdio: 'inherit', detached: true }).unref(); setTimeout(() => process.exit(0), 500);`;
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, ['-e', root], { timeoutMs: 30_000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, 'completed', result.stderr);
  assert.ok(elapsed < 500 + PIPE_DRAIN_MS + 1500, `result after ${elapsed} ms`);
  assert.equal(activeProcesses.size, 0);
});

test('layer 3: the supervisor never snapshots, polls or kills by PID', () => {
  const dir = path.resolve(__dirname, '../..', 'src');
  const files = fs.readdirSync(dir, { recursive: true }).filter(file => /\.ts$/.test(file));
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /Win32_Process|Get-CimInstance|taskkill|Stop-Process|ParentProcessId/i, file);
  }
  assert.equal(fs.existsSync(path.join(dir, 'execution', 'process-tree.ts')), false);
});

test('direct process launch without PowerShell wrapper or C# Roslyn compilation', async () => {
  assert.ok(!fs.existsSync(path.resolve('assets/windows-job.ps1')), 'assets/windows-job.ps1 must be retired');
  const result = await runCommand(process.execPath, ['-e', 'console.log("direct_launch_ok")']);
  assert.equal(result.status, 'completed');
  assert.ok(result.stdout.includes('direct_launch_ok'));
});

test('terminateProcessTree terminates running process cleanly without leaving orphans', async () => {
  // Launch an idle child process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });

  const pid = child.pid;
  assert.ok(pid, 'Child process must have a PID');

  // Verify process is running
  assert.doesNotThrow(() => process.kill(pid, 0), 'Child process should be running');

  // Terminate process tree
  await terminateProcessTree(child);

  // Allow OS a small grace window to release PID
  await new Promise(r => setTimeout(r, 200));

  // Verify process is dead
  assert.throws(() => process.kill(pid, 0), 'Process must be dead after terminateProcessTree');
});
