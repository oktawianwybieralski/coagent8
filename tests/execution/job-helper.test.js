const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { jobHelperPath, jobTreeEnded, locateJobHelper, parseJobStatus } = require('../../src/execution/job-helper.ts');
const { runCommand } = require('../../src/execution/process.ts');

// WINDOWS-001: the helper is built by CI on Windows and by `cargo build --release` locally.
// The helper starts children with CREATE_NO_WINDOW and is started hidden, so no window can open.
const helper = jobHelperPath();
const skip = helper ? false : 'needs the Windows job helper';

test('the status line tells a failed start from a running command', () => {
  assert.equal(parseJobStatus('ready\n'), undefined);
  assert.equal(parseJobStatus('error process-cre'), undefined, 'an incomplete line is not a status yet');
  assert.equal(parseJobStatus('error process-create 2\n').code, 'CLI_NOT_FOUND');
  assert.equal(parseJobStatus('error process-create 3\n').code, 'CLI_NOT_FOUND');
  const other = parseJobStatus('error attribute-job 87\n');
  assert.equal(other.code, 'PROCESS_ERROR');
  assert.match(other.message, /attribute-job.*87/);
});

test('only the final line confirms the end of the tree', () => {
  assert.equal(jobTreeEnded('ready\nended\n'), true);
  assert.equal(jobTreeEnded('ready\nunconfirmed\n'), false);
  assert.equal(jobTreeEnded('ready\n'), false);
  assert.equal(jobTreeEnded(''), false);
});

test('the helper is found in the package or a source checkout, never outside the package', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-locate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text = 'x') => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const output = path.join('native', 'coagent8-job', 'target', 'release', 'coagent8-job.exe');
  const manifest = JSON.stringify({ name: 'coagent8' });

  // A helper planted beside an installed package is not picked up, even dressed as a checkout.
  write(path.join('node_modules', 'coagent8', 'package.json'), manifest);
  write(path.join('node_modules', 'package.json'), manifest);
  write(path.join('node_modules', 'native', 'coagent8-job', 'Cargo.toml'));
  write(path.join('node_modules', output));
  const installed = path.join(root, 'node_modules', 'coagent8', 'dist');
  fs.mkdirSync(installed, { recursive: true });
  assert.equal(locateJobHelper(installed, 'x64'), undefined);

  // The packaged helper is the one an installation uses, for its own architecture, and only
  // when its digest matches the bundle's.
  const packaged = write(path.join('node_modules', 'coagent8', 'dist', 'win32-x64', 'coagent8-job.exe'), 'helper');
  const digest = createHash('sha256').update('helper').digest('hex');
  assert.equal(locateJobHelper(installed, 'x64', { x64: digest }), packaged);
  assert.equal(locateJobHelper(installed, 'arm64', { x64: digest }), undefined);
  assert.equal(locateJobHelper(installed, 'x64', {}), undefined, 'a helper the bundle does not know is refused');
  fs.writeFileSync(packaged, 'tampered');
  assert.equal(locateJobHelper(installed, 'x64', { x64: digest }), undefined, 'a changed helper is refused');
  fs.rmSync(path.dirname(packaged), { recursive: true });

  // A source checkout finds its Cargo output, from the bundle and from the source modules.
  const checkout = path.join('checkout');
  write(path.join(checkout, 'package.json'), manifest);
  write(path.join(checkout, 'native', 'coagent8-job', 'Cargo.toml'));
  const built = write(path.join(checkout, output));
  assert.equal(locateJobHelper(path.join(root, checkout, 'dist'), 'x64'), built);
  assert.equal(locateJobHelper(path.join(root, checkout, 'src', 'execution'), 'x64'), built);

  // Another project's checkout is not this project.
  const other = path.join('other');
  write(path.join(other, 'package.json'), JSON.stringify({ name: 'other' }));
  write(path.join(other, 'native', 'coagent8-job', 'Cargo.toml'));
  write(path.join(other, output));
  assert.equal(locateJobHelper(path.join(root, other, 'dist'), 'x64'), undefined);

  // A module elsewhere has no package root to look in.
  assert.equal(locateJobHelper(path.join(root, checkout, 'scripts'), 'x64'), undefined);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8 job helper '));
  t.after(async () => {
    await delay(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const script = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const heartbeat = script(
    'heartbeat.cjs',
    "const fs=require('fs');let n=0;const end=Date.now()+15000;setInterval(()=>{if(Date.now()>end)process.exit(0);fs.writeFileSync(process.argv[2],String(++n));},50);",
  );
  /**
   * Arguments of a root that starts a heartbeat descendant, detached as a native CLI's child
   * would be. The paths travel as arguments: process.argv[2] and [3] in the root's code.
   */
  const rootWithDescendant = (marker, after = 'setInterval(()=>{},1000);') => [
    script(
      `root-${path.basename(marker)}.cjs`,
      `require('child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore',windowsHide:true,detached:true}).unref();${after}`,
    ),
    heartbeat,
    marker,
  ];
  return { dir, script, rootWithDescendant };
}

const launch = (dir, command, args) =>
  spawn(helper, [command, ...args], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
const collect = child =>
  new Promise(resolve => {
    const result = { stdout: '', stderr: '', status: '' };
    child.stdout.on('data', chunk => (result.stdout += chunk));
    child.stderr.on('data', chunk => (result.stderr += chunk));
    child.stdio[3].on('data', chunk => (result.status += chunk));
    child.stdio[3].on('error', () => {});
    child.stdio[4].on('error', () => {});
    child.on('close', code => resolve({ ...result, exitCode: code }));
  });
const beats = marker => {
  try {
    return Number(fs.readFileSync(marker, 'utf8')) || 0;
  } catch {
    return 0;
  }
};
async function waitForBeat(marker) {
  const deadline = Date.now() + 10000;
  while (!beats(marker) && Date.now() < deadline) await delay(25);
  assert.ok(beats(marker) > 0, 'the descendant started');
}
async function assertStopped(marker) {
  const before = beats(marker);
  await delay(400);
  assert.equal(beats(marker), before, 'the descendant stopped');
}

test('arguments reach the command exactly as the parent passed them', { skip }, async t => {
  const { dir, script } = fixture(t);
  const args = ['plain', 'with space', 'quote"inside', 'trailing\\', 'trailing space\\', '', 'zażółć', 'a\\\\"b', '%PATH%', '^&|<>'];
  const printer = script('print args.cjs', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const result = await collect(launch(dir, process.execPath, [printer, ...args]));
  assert.equal(result.status, 'ready\nended\n');
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('the exit code and large final output on both streams arrive intact', { skip }, async t => {
  const { dir, script } = fixture(t);
  const big = script(
    'big.cjs',
    "let i='';process.stdin.on('data',d=>i+=d).on('end',()=>{const s='x'.repeat(1500000);process.stderr.write(s,()=>process.stdout.write(i+s,()=>process.exit(4000)));});",
  );
  const child = launch(dir, process.execPath, [big]);
  const done = collect(child);
  child.stdin.end('input-');
  const result = await done;
  assert.equal(result.exitCode, 4000);
  assert.equal(result.stdout.length, 6 + 1500000);
  assert.ok(result.stdout.startsWith('input-'));
  assert.equal(result.stderr.length, 1500000);
});

test('a failed start is reported on the status pipe, also when a command could exit with the same code', { skip }, async t => {
  const { dir } = fixture(t);
  const missing = await collect(launch(dir, path.join(dir, 'missing.exe'), []));
  assert.equal(missing.status, 'error process-create 2\n');
  assert.equal(missing.exitCode, 1);
  const failing = await collect(launch(dir, process.execPath, ['-e', 'process.exit(1)']));
  assert.equal(failing.status, 'ready\nended\n');
  assert.equal(failing.exitCode, 1);
});

test('without its status and stop pipes the helper refuses to run anything', { skip }, async t => {
  const { dir, rootWithDescendant } = fixture(t);
  const marker = path.join(dir, 'no-status');
  const result = spawnSync(helper, [process.execPath, ...rootWithDescendant(marker)], { stdio: 'pipe', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 1);
  await delay(200);
  assert.equal(beats(marker), 0);
});

for (const [name, stop] of [
  ['closing the stop pipe', child => child.stdio[4].destroy()],
  ['terminating the helper', child => child.kill()],
]) {
  test(`${name} ends a detached descendant`, { skip }, async t => {
    const { dir, rootWithDescendant } = fixture(t);
    const marker = path.join(dir, `stop-${name.replace(/ /g, '-')}`);
    const child = launch(dir, process.execPath, rootWithDescendant(marker));
    const done = collect(child);
    await waitForBeat(marker);
    stop(child);
    await done;
    await assertStopped(marker);
  });
}

test('a root that exits by itself takes its descendants along and keeps its exit code', { skip }, async t => {
  const { dir, rootWithDescendant } = fixture(t);
  const marker = path.join(dir, 'root-exit');
  const exitWhenRunning = `const t=setInterval(()=>{if(require('fs').existsSync(process.argv[3])){clearInterval(t);process.exit(5);}},20);`;
  const result = await collect(launch(dir, process.execPath, rootWithDescendant(marker, exitWhenRunning)));
  assert.equal(result.exitCode, 5);
  await assertStopped(marker);
});

test('a descendant holding stdout open does not delay the end of the run', { skip }, async t => {
  const { dir, script } = fixture(t);
  const root = script(
    'pipe-holder.cjs',
    "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true,detached:true}).unref();process.stdout.write('last line',()=>setTimeout(()=>process.exit(0),300));",
  );
  const result = await collect(launch(dir, process.execPath, [root]));
  assert.equal(result.stdout, 'last line');
  assert.equal(result.exitCode, 0);
});

test('a request to leave the job is denied', { skip }, async t => {
  const { dir } = fixture(t);
  const tool = path.join(path.dirname(helper), 'examples', 'breakaway.exe');
  assert.ok(fs.existsSync(tool), 'cargo build --release --examples builds the test program');
  const inside = await collect(launch(dir, tool, [process.execPath]));
  assert.equal(inside.status, 'ready\nended\n');
  assert.equal(inside.stdout.trim(), 'denied 5', 'ERROR_ACCESS_DENIED: the job allows no breakaway');
});

test('runCommand maps a program the system cannot start to a typed failure', { skip }, async t => {
  const { dir } = fixture(t);
  const notAProgram = path.join(dir, 'not-a-program.exe');
  fs.writeFileSync(notAProgram, 'text, not a program');
  const result = await runCommand(notAProgram, [], { cwd: dir, timeoutMs: 10000 });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'PROCESS_ERROR');
  assert.match(result.error.message, /job helper could not start the CLI at process-create/);
});

test('a forced stop returns only after the descendant ended', { skip }, async t => {
  const { dir, rootWithDescendant } = fixture(t);
  const marker = path.join(dir, 'forced');
  const controller = new AbortController();
  const run = runCommand(process.execPath, rootWithDescendant(marker), { cwd: dir, timeoutMs: 15000, abortSignal: controller.signal });
  await waitForBeat(marker);
  controller.abort();
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.treeEnded, true, 'the helper confirmed the end of the tree');
  const atReturn = beats(marker);
  await delay(400);
  assert.equal(beats(marker), atReturn, 'nothing in the tree ran after the run returned');
});
