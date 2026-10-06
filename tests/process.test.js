const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getEventListeners } = require('node:events');
const { runCommand, activeProcesses, terminateAllProcesses } = require('../src/execution/process.ts');
const { resolveCliCommand } = require('../src/backends/cli-resolver.ts');
const { createLineDecoder, truncateToByteLength, readBoundedFile } = require('../src/execution/stream.ts');

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
  const marker=path.join(dir,'should-not-exist'),module=path.resolve(__dirname, '..', 'src/execution/process.ts');
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

test('owned process-tree teardown releases retained descendant tracking records', async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { trackedDescendants, terminateProcessTree } = require('../src/execution/process.ts');
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', windowsHide: true });
  await once(proc, 'spawn');
  trackedDescendants.set(proc, new Set());
  try { await terminateProcessTree(proc); }
  finally { await terminateProcessTree(proc); }
  assert.equal(trackedDescendants.has(proc), false);
});
