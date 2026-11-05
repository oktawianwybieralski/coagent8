const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// #159 to #162: parallel workers under one root, in disjoint scopes of one work tree.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-parallel-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
process.env.coagent8_END_NOTES_DIR = path.join(tempDir, 'notes');
process.env.CODEX_PATH = path.resolve(__dirname, '../../fixtures/codex-cli/codex.cjs');
process.env.CODEX_CONFIG_PATH = path.join(tempDir, 'config.toml');
const { handleDelegate } = require('../../../src/mcp/tools/delegate.tool.ts');
const { handleSession, handleCancelSession } = require('../../../src/mcp/tools/session.tool.ts');
const { saveConfig, loadConfig } = require('../../../src/config.ts');
const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
require('../../../src/execution/controller.ts').composeExecutionCancellation();
const { readTask, createTaskHandle, claimTaskRequest } = require('../../../src/sessions/tasks.ts');
const { readRoot, createRoot, reserveRootTask, bindRootTask, reserveRootCall, refundRootTask } = require('../../../src/sessions/roots.ts');
const { acquireWriterLease, WRITERS_DIRECTORY, WRITER_RECORD_FILE } = require('../../../src/sessions/writer.ts');
const { claimsOverlap, resolveWriteClaim, readWorkspaceRepository } = require('../../../src/workspace/changes.ts');
const { claudeTurnSettings } = require('../../../src/backends/claude/adapter.ts');
const { superviseChange } = require('../../../src/execution/loop.ts');
const { ToolError } = require('../../../src/contracts/error.ts');
const { atomicWrite } = require('../../../src/storage/lock.ts');

test.after(async () => {
  await stopActiveDelegations();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const approve = { askConsent: async () => ({ approved: true, remember: false }) };
const REQUEST = { task: 'Change a file', backend: 'codex', model: 'gpt-6.1-sol' };
const code = expected => err => err.code === expected;

let repos = 0;
function fixtureRepo() {
  const repo = path.join(tempDir, `repo-${++repos}`);
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(repo, 'a'));
  fs.mkdirSync(path.join(repo, 'b'));
  fs.writeFileSync(path.join(repo, 'a', 'one.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'b', 'two.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return repo;
}

async function finished(handle) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const task = readTask(handle);
    if (task.state !== 'running') return task;
    assert.ok(Date.now() < deadline, 'the task finished in time');
    await delay(25);
  }
}

/** Starts a worker that runs until it is stopped, after writing `writes`. */
async function runningWorker(repo, args, writes) {
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  process.env.CODEX_FIXTURE_WRITES = JSON.stringify(writes ?? {});
  const started = await handleDelegate({ ...REQUEST, ...args }, repo, null, null, approve);
  assert.equal(started.isError, undefined, started.content?.[0]?.text);
  // The call returns before the CLI starts, which reads its fixture environment: the next worker
  // must not set its own until this one has written.
  const deadline = Date.now() + 15000;
  for (const [file, content] of Object.entries(writes ?? {})) {
    while (!fs.existsSync(path.join(repo, file)) || fs.readFileSync(path.join(repo, file), 'utf8') !== content) {
      assert.ok(Date.now() < deadline, `the worker wrote ${file}`);
      await delay(25);
    }
  }
  return started.structuredContent;
}

test.beforeEach(async () => {
  await saveConfig({ defaultBackend: 'codex', rootLimits: {}, routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
  delete process.env.CODEX_FIXTURE_MODE;
  delete process.env.CODEX_FIXTURE_WRITES;
});

test('two workers run at once on disjoint scopes; an overlapping start is refused; cancelling the root stops both', async () => {
  const repo = fixtureRepo();
  const first = await runningWorker(repo, { scope: ['a'] }, { 'a/one.ts': 'export const a = 2;\n' });
  assert.match(first.rootHandle, /^root_[a-f0-9]{32}$/);
  const second = await runningWorker(repo, { scope: ['b'], root_handle: first.rootHandle }, { 'b/two.ts': 'export const b = 2;\n' });
  assert.equal(second.rootHandle, first.rootHandle);
  assert.equal(readTask(first.taskHandle).state, 'running');
  assert.equal(readTask(second.taskHandle).state, 'running');

  await assert.rejects(handleDelegate({ ...REQUEST, scope: ['a/one.ts'] }, repo, null, null, approve), code('SESSION_BUSY'));
  await assert.rejects(handleDelegate({ ...REQUEST, scope: ['A'] }, repo, null, null, approve), code('SESSION_BUSY'), 'any case');
  await assert.rejects(handleDelegate(REQUEST, repo, null, null, approve), code('SESSION_BUSY'), 'the whole tree overlaps');
  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['c'], loop: true, checks: [] }, repo, null, null, approve),
    code('SESSION_BUSY'),
    "a loop's checks and review read the whole tree",
  );

  const report = await handleSession({ action: 'root', root_handle: first.rootHandle }, repo);
  assert.equal(report.structuredContent.calls, 2, 'refused starts are not charged to this root');
  assert.match(report.content[0].text, /running: 2 of 4/);
  assert.match(report.content[0].text, /do not make the root accepted/);

  const cancelled = await handleCancelSession({ root_handle: first.rootHandle });
  assert.equal(cancelled.structuredContent.cancelled, true);
  assert.deepEqual(cancelled.structuredContent.running, []);
  assert.deepEqual(cancelled.structuredContent.ended.sort(), [first.taskHandle, second.taskHandle].sort());
  assert.equal(readTask(first.taskHandle).state, 'cancelled');
  assert.equal(readTask(second.taskHandle).state, 'cancelled');
  assert.match(readTask(second.taskHandle).result.text, /b\/two\.ts/, 'each result keeps its observed changes');

  // The first worker ran while the second held b: the note says so, and hides nothing.
  const text = readTask(first.taskHandle).result.text;
  assert.match(text, /Warning: changed outside scope: b\/two\.ts/);
  assert.match(text, /another worker held these paths during this turn, so either may have changed them: b\/two\.ts/);

  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['c'], root_handle: first.rootHandle }, repo, null, null, approve),
    code('ABORTED'),
  );
  assert.deepEqual(fs.readdirSync(path.join(repo, '.git', WRITERS_DIRECTORY)), [], 'no writer record stays');
});

test('a worker alone reports a change outside its scope without naming another worker', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WRITES = JSON.stringify({ 'a/one.ts': 'x\n', 'b/two.ts': 'y\n' });
  const started = await handleDelegate({ ...REQUEST, scope: ['a'] }, repo, null, null, approve);
  const { text } = (await finished(started.structuredContent.taskHandle)).result;
  assert.match(text, /Warning: changed outside scope: b\/two\.ts/);
  assert.doesNotMatch(text, /another worker/);
});

test('a writer that ended before a worker started is not named as its peer', async () => {
  const gitDir = fs.mkdtempSync(path.join(tempDir, 'git-'));
  const a = await acquireWriterLease(gitDir, undefined, ['a']);
  const b = await acquireWriterLease(gitDir, undefined, ['b']);
  await a.release();
  const c = await acquireWriterLease(gitDir, undefined, ['c']);
  assert.deepEqual(c.peerClaims(), ['b'], 'a ended first, b still ran');
  assert.deepEqual(b.peerClaims().sort(), ['a', 'c'], 'b ran beside both');
  await b.release();
  assert.deepEqual(c.peerClaims(), ['b'], 'an ended peer still counts for the one that ran beside it');
  await c.release();
  assert.deepEqual(fs.readdirSync(path.join(gitDir, WRITERS_DIRECTORY)), [], 'the last release removes the tombstones');
});

test('a dead writer of a claim blocks only what it may still change', async () => {
  const gitDir = fs.mkdtempSync(path.join(tempDir, 'git-'));
  const dir = path.join(gitDir, WRITERS_DIRECTORY);
  fs.mkdirSync(dir);
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const write = (name, record) =>
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ pid: dead, token: name, startedAt: 'x', ...record }));
  write('crashed', { claim: ['a'], starting: true });
  await assert.rejects(
    acquireWriterLease(gitDir, () => false, ['a/x']),
    err => err.code === 'SESSION_BUSY' && err.message.includes('crashed.json'),
  );
  await assert.rejects(
    acquireWriterLease(gitDir, () => false),
    code('SESSION_BUSY'),
    'nor the whole tree',
  );
  await (await acquireWriterLease(gitDir, () => false, ['b'])).release();
  assert.ok(fs.existsSync(path.join(dir, 'crashed.json')), 'it stays for the user');
  fs.rmSync(path.join(dir, 'crashed.json'));

  write('ended', { claim: ['a'], workerGroups: [77] });
  await assert.rejects(
    acquireWriterLease(gitDir, () => true, ['a']),
    err => err.code === 'SESSION_BUSY' && /process group 77/.test(err.message),
  );
  const taken = await acquireWriterLease(gitDir, () => false, ['a']);
  assert.equal(fs.existsSync(path.join(dir, 'ended.json')), false, 'gone once nothing of it lives');
  await taken.release();

  fs.writeFileSync(path.join(dir, 'damaged.json'), '{ not json');
  await assert.rejects(
    acquireWriterLease(gitDir, () => false, ['b']),
    code('SESSION_BUSY'),
    'an unreadable record fails closed',
  );
  fs.rmSync(path.join(dir, 'damaged.json'));

  // A dead writer of the whole tree does not stop a claim, and a live one does.
  fs.writeFileSync(path.join(gitDir, WRITER_RECORD_FILE), JSON.stringify({ pid: dead, token: 'old', startedAt: 'x' }));
  const claim = await acquireWriterLease(gitDir, () => false, ['b']);
  assert.equal(fs.existsSync(path.join(gitDir, WRITER_RECORD_FILE)), false);
  await claim.release();
  const whole = await acquireWriterLease(gitDir);
  await assert.rejects(acquireWriterLease(gitDir, undefined, ['b']), code('SESSION_BUSY'));
  await whole.release();
});

test('claims of writers in other server processes exclude each other', async () => {
  const gitDir = fs.mkdtempSync(path.join(tempDir, 'git-'));
  const script = `require('tsx/cjs');
    require(${JSON.stringify(path.resolve(__dirname, '../../../src/sessions/writer.ts'))})
      .acquireWriterLease(${JSON.stringify(gitDir)}, undefined, ['a'])
      .then(() => console.log('held'), err => console.log(err.code));
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const holders = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    }),
  );
  try {
    const answers = await Promise.all(
      holders.map(holder => new Promise(resolve => holder.stdout.once('data', chunk => resolve(String(chunk).trim())))),
    );
    assert.deepEqual(answers.sort(), ['SESSION_BUSY', 'SESSION_BUSY', 'SESSION_BUSY', 'held']);
  } finally {
    await Promise.all(
      holders.map(holder => {
        holder.stdin.end();
        return new Promise(resolve => holder.once('exit', resolve));
      }),
    );
  }
});

test('claim paths: whole segments, any case, repository coordinates, nothing outside', async () => {
  assert.equal(claimsOverlap(['src'], ['src-old']), false, 'a shared prefix is no overlap');
  assert.equal(claimsOverlap(['src'], ['src/a.ts']), true);
  assert.equal(claimsOverlap(['SRC/a.ts'], ['src']), true);
  assert.equal(claimsOverlap(['a'], []), true, 'empty is the whole tree');
  const repo = fixtureRepo();
  const root = await readWorkspaceRepository(repo);
  assert.deepEqual(resolveWriteClaim(root, ['a', 'new/dir/file.ts']), ['a', 'new/dir/file.ts']);
  assert.deepEqual(resolveWriteClaim(root, []), []);
  const nested = await readWorkspaceRepository(path.join(repo, 'a'));
  assert.deepEqual(resolveWriteClaim(nested, ['one.ts']), ['a/one.ts'], 'a workspace in a subfolder uses the same coordinates');
  assert.throws(() => resolveWriteClaim(root, ['.git/hooks']), code('INPUT_LIMIT'));
  assert.throws(() => resolveWriteClaim(root, ['.GIT/config']), code('INPUT_LIMIT'));
  const outside = fs.mkdtempSync(path.join(tempDir, 'outside-'));
  let linked = true;
  try {
    fs.symlinkSync(outside, path.join(repo, 'out'), 'junction');
    fs.symlinkSync(path.join(repo, 'b'), path.join(repo, 'to-b'), 'junction');
  } catch (err) {
    // Creating links can need a right the account lacks; junctions normally do not.
    linked = false;
    assert.equal(err.code, 'EPERM');
  }
  if (linked) {
    fs.symlinkSync(path.join(repo, 'not-yet'), path.join(repo, 'dangling'), 'junction');
    assert.throws(() => resolveWriteClaim(root, ['dangling']), code('INPUT_LIMIT'), 'a link to nothing yet');
    assert.throws(() => resolveWriteClaim(root, ['dangling/x']), code('INPUT_LIMIT'), 'and a path through it');
    assert.throws(() => resolveWriteClaim(root, ['out/x']), code('INPUT_LIMIT'), 'a link out of the repository');
    assert.deepEqual(resolveWriteClaim(root, ['to-b/new.ts']), ['b/new.ts'], 'a link inside resolves to its target');
  }
});

test('a Claude worker gets allow rules for its scope only', () => {
  assert.deepEqual(JSON.parse(claudeTurnSettings('workspace-write', ['src', 'a.ts'])).permissions.allow, [
    'Edit(./src)',
    'Edit(./src/**)',
    'Edit(./a.ts)',
    'Edit(./a.ts/**)',
    'Write(./src)',
    'Write(./src/**)',
    'Write(./a.ts)',
    'Write(./a.ts/**)',
    'Bash',
  ]);
  assert.deepEqual(JSON.parse(claudeTurnSettings('workspace-write', ['src/[id]'])).permissions.allow, [
    'Edit(./**)',
    'Write(./**)',
    'Bash',
  ]);
});

test('root limits come from the configuration and refuse a start before it reserves anything', async () => {
  await saveConfig({
    ...loadConfig(),
    rootLimits: { maxConcurrent: 1, maxCalls: 2, maxDepth: 2 },
  });
  const repo = fixtureRepo();
  const first = await runningWorker(repo, { scope: ['a'] });
  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['b'], root_handle: first.rootHandle }, repo, null, null, approve),
    code('ROOT_LIMIT'),
  );
  assert.equal(readRoot(first.rootHandle).calls, 1, 'a refusal is not charged');
  await handleCancelSession({ session_handle: first.sessionHandle });
  await finished(first.taskHandle);

  delete process.env.CODEX_FIXTURE_MODE;
  const child = await handleDelegate({ ...REQUEST, scope: ['b'], parent_task: first.taskHandle }, repo, null, null, approve);
  assert.equal(child.structuredContent.rootHandle, first.rootHandle, 'a parent names its root');
  assert.equal(child.structuredContent.parentTask, first.taskHandle);
  await finished(child.structuredContent.taskHandle);
  assert.equal(readTask(child.structuredContent.taskHandle).depth, 2);
  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['b'], parent_task: child.structuredContent.taskHandle }, repo, null, null, approve),
    code('ROOT_LIMIT'),
    'the depth is the limit, before the calls',
  );
  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['b'], root_handle: first.rootHandle }, repo, null, null, approve),
    code('ROOT_LIMIT'),
  );
  const report = await handleSession({ action: 'root', root_handle: first.rootHandle }, repo);
  assert.equal(report.structuredContent.calls, 2);
  assert.equal(report.structuredContent.state, 'open', 'finished workers do not finish the root');
});

test('the configuration refuses invalid limits', async () => {
  for (const rootLimits of [{ maxCalls: 0 }, { maxConcurrent: 65 }, { maxDepth: 1.5 }, { maxMinutes: '4' }, { other: 1 }, []]) {
    await assert.rejects(saveConfig({ ...loadConfig(), rootLimits }), /rootLimits/, JSON.stringify(rootLimits));
  }
});

test('a start outside the root contract is refused', async () => {
  const repo = fixtureRepo();
  const other = await createRoot();
  await assert.rejects(handleDelegate({ ...REQUEST, root_handle: 'root_nope' }, repo, null, null, approve), code('INPUT_LIMIT'));
  await assert.rejects(
    handleDelegate({ ...REQUEST, root_handle: `root_${'0'.repeat(32)}` }, repo, null, null, approve),
    code('SESSION_INVALID'),
  );
  await assert.rejects(
    handleDelegate({ ...REQUEST, parent_task: `task_${'0'.repeat(32)}` }, repo, null, null, approve),
    code('SESSION_INVALID'),
  );
  await assert.rejects(
    handleDelegate({ ...REQUEST, mode: 'sync', root_handle: other.rootHandle }, repo, null, null, approve),
    code('INPUT_LIMIT'),
  );
  const first = await runningWorker(repo, { scope: ['a'] });
  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['b'], root_handle: other.rootHandle, parent_task: first.taskHandle }, repo, null, null, approve),
    code('INPUT_LIMIT'),
    'a parent in another root',
  );
  await assert.rejects(handleCancelSession({ root_handle: other.rootHandle, session_handle: first.sessionHandle }), code('INPUT_LIMIT'));
  await assert.rejects(handleCancelSession({ root_handle: `root_${'0'.repeat(32)}` }), code('SESSION_INVALID'));
  await assert.rejects(handleSession({ action: 'root' }, repo), code('INPUT_LIMIT'));
  await handleCancelSession({ root_handle: first.rootHandle });
});

test('a continued session stays under its root, also without naming it', async () => {
  const repo = fixtureRepo();
  const first = await handleDelegate(REQUEST, repo, null, null, approve);
  const { rootHandle, taskHandle, sessionHandle } = first.structuredContent;
  await finished(taskHandle);
  const other = await createRoot();
  await assert.rejects(
    handleDelegate({ ...REQUEST, session_handle: sessionHandle, root_handle: other.rootHandle }, repo, null, null, approve),
    code('INPUT_LIMIT'),
  );
  await assert.rejects(
    handleDelegate({ ...REQUEST, mode: 'sync', session_handle: sessionHandle }, repo, null, null, approve),
    code('INPUT_LIMIT'),
  );
  const next = await handleDelegate({ ...REQUEST, session_handle: sessionHandle }, repo, null, null, approve);
  assert.equal(next.structuredContent.rootHandle, rootHandle);
  await finished(next.structuredContent.taskHandle);
  assert.equal(readRoot(rootHandle).calls, 2);
});

test('a root cancelled from another server process stops the worker there', async () => {
  const repo = fixtureRepo();
  const worker = await runningWorker(repo, { scope: ['a'] });
  const script = `require('tsx/cjs');
    require(${JSON.stringify(path.resolve(__dirname, '../../../src/sessions/roots.ts'))}).cancelRoot(${JSON.stringify(worker.rootHandle)})
      .then(() => process.exit(0), err => { console.error(err); process.exit(1); });`;
  await new Promise((resolve, reject) => {
    const other = spawn(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: 'inherit',
      windowsHide: true,
    });
    other.once('exit', status => (status === 0 ? resolve() : reject(new Error(`exit ${status}`))));
  });
  assert.equal((await finished(worker.taskHandle)).state, 'cancelled');
});

test('a worker whose root can no longer be read is stopped', async () => {
  const repo = fixtureRepo();
  const worker = await runningWorker(repo, { scope: ['a'] });
  fs.rmSync(path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${worker.rootHandle}.json`));
  assert.equal((await finished(worker.taskHandle)).state, 'cancelled');
});

test("a cancellation just before the turn prevents it, and a task never outlives its root's time", async () => {
  const root = await createRoot();
  await reserveRootTask(root.rootHandle, { taskHandle: `task_${'1'.repeat(32)}` });
  const file = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
  const edit = change => atomicWrite(file, JSON.stringify({ ...readRoot(root.rootHandle), ...change }));
  await edit({ state: 'cancelled' });
  await assert.rejects(bindRootTask(root.rootHandle, `task_${'1'.repeat(32)}`, 'syn_sess_x'), code('ABORTED'));
  await assert.rejects(reserveRootCall(root.rootHandle), code('ABORTED'));
  await edit({ state: 'open', deadlineAt: new Date(Date.now() - 1).toISOString() });
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: `task_${'2'.repeat(32)}` }), code('ROOT_LIMIT'));
  await assert.rejects(reserveRootCall(root.rootHandle), code('ROOT_LIMIT'));

  const repo = fixtureRepo();
  const joined = await createRoot();
  const joinedFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${joined.rootHandle}.json`);
  await atomicWrite(joinedFile, JSON.stringify({ ...joined, deadlineAt: new Date(Date.now() + 2500).toISOString() }));
  const worker = await runningWorker(repo, { scope: ['a'], root_handle: joined.rootHandle });
  assert.equal((await finished(worker.taskHandle)).state, 'timed_out');
});

test('a reservation that reached no turn is refunded; a task of a dead server stops counting but keeps its charge', async () => {
  const root = await createRoot({ maxConcurrent: 1, maxCalls: 3 });
  const handle = `task_${'3'.repeat(32)}`;
  await reserveRootTask(root.rootHandle, { taskHandle: handle });
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: handle }), code('SESSION_BUSY'), 'the same task, reserved twice');
  await refundRootTask(root.rootHandle, handle);
  assert.equal(readRoot(root.rootHandle).calls, 0);

  await reserveRootTask(root.rootHandle, { taskHandle: handle });
  const file = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
  const record = readRoot(root.rootHandle);
  record.tasks[0].pid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  await atomicWrite(file, JSON.stringify(record));
  await reserveRootTask(root.rootHandle, { taskHandle: `task_${'4'.repeat(32)}` });
  assert.equal(readRoot(root.rootHandle).calls, 2, 'the charge of the dead one stays');
});

test('a loop still refuses a scope that escapes, and a cancelled root closes an open form', async () => {
  const repo = fixtureRepo();
  await assert.rejects(
    handleDelegate({ ...REQUEST, scope: ['.git/hooks'], loop: true, checks: [] }, repo, null, null, approve),
    code('INPUT_LIMIT'),
  );

  let formOpen;
  const opened = new Promise(resolve => {
    formOpen = resolve;
  });
  const root = await createRoot();
  const start = handleDelegate({ ...REQUEST, root_handle: root.rootHandle, loop: true, checks: ['node -v'] }, repo, null, null, {
    ...approve,
    askChecks: async (_checks, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('form closed')), { once: true });
        formOpen();
      }),
  });
  // Observed before the cancel, which waits for the task and so sees it rejected first.
  const refused = assert.rejects(start, code('ABORTED'));
  await opened;
  await handleCancelSession({ root_handle: root.rootHandle });
  await refused;
  assert.deepEqual(readRoot(root.rootHandle).tasks, [], 'no turn started, so the charge is back');
  assert.equal(fs.existsSync(path.join(repo, '.git', WRITER_RECORD_FILE)), false, 'and the writer is free');
});

test('a task keeps the parent of the session it continues', async () => {
  const repo = fixtureRepo();
  const first = await handleDelegate(REQUEST, repo, null, null, approve);
  await finished(first.structuredContent.taskHandle);
  const child = await handleDelegate({ ...REQUEST, parent_task: first.structuredContent.taskHandle }, repo, null, null, approve);
  await finished(child.structuredContent.taskHandle);
  const next = await handleDelegate({ ...REQUEST, session_handle: child.structuredContent.sessionHandle }, repo, null, null, approve);
  await finished(next.structuredContent.taskHandle);
  const task = readTask(next.structuredContent.taskHandle);
  assert.equal(task.parentTask, first.structuredContent.taskHandle);
  assert.equal(task.depth, 2);
  await assert.rejects(
    handleDelegate(
      { ...REQUEST, session_handle: child.structuredContent.sessionHandle, parent_task: next.structuredContent.taskHandle },
      repo,
      null,
      null,
      approve,
    ),
    code('INPUT_LIMIT'),
    'a continuation cannot move in the tree',
  );
});

test('a worker that may outlive its dead server still counts as running', async () => {
  const root = await createRoot({ maxConcurrent: 1 });
  const handle = `task_${'9'.repeat(32)}`;
  await reserveRootTask(root.rootHandle, { taskHandle: handle });
  const gitDir = fs.mkdtempSync(path.join(tempDir, 'git-'));
  const writer = path.join(gitDir, WRITER_RECORD_FILE);
  await bindRootTask(root.rootHandle, handle, 'syn_sess_gone', { file: writer, token: 'old' });
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  fs.writeFileSync(writer, JSON.stringify({ pid: dead, token: 'old', startedAt: 'x', starting: true }));
  const file = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
  const record = readRoot(root.rootHandle);
  record.tasks[0].pid = dead;
  await atomicWrite(file, JSON.stringify(record));
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: `task_${'a'.repeat(32)}` }), code('ROOT_LIMIT'));
  const cancelledLater = readRoot(root.rootHandle);
  assert.equal(cancelledLater.calls, 1);
  fs.writeFileSync(writer, JSON.stringify({ pid: dead, token: 'someone-later', startedAt: 'x', starting: true }));
  await reserveRootTask(root.rootHandle, { taskHandle: `task_${'a'.repeat(32)}` });
  assert.equal(readRoot(root.rootHandle).calls, 2, "another writer's record says nothing about this task");
});

test(
  'a worker whose end is not confirmed keeps its place in the root',
  { skip: process.platform === 'win32' ? false : 'needs the job helper' },
  async () => {
    const { activeProcesses } = require('../../../src/execution/process.ts');
    const repo = fixtureRepo();
    // Once it wrote, the process that runs now is the worker, not a probe before it.
    const worker = await runningWorker(repo, { scope: ['a'] }, { 'a/one.ts': 'x\n' });
    assert.ok(activeProcesses.size > 0);
    // A helper killed from outside can report nothing.
    for (const proc of activeProcesses) proc.kill();
    await finished(worker.taskHandle);
    const entry = readRoot(worker.rootHandle).tasks[0];
    assert.equal(entry.endedAt, undefined);
    const report = await handleSession({ action: 'root', root_handle: worker.rootHandle }, repo);
    assert.match(report.content[0].text, /running: 1 of 4/);
  },
);

test('a call limit holds across server processes', async () => {
  const root = await createRoot({ maxCalls: 2, maxConcurrent: 64 });
  const script = index => `require('tsx/cjs');
    require(${JSON.stringify(path.resolve(__dirname, '../../../src/sessions/roots.ts'))})
      .reserveRootTask(${JSON.stringify(root.rootHandle)}, { taskHandle: 'task_${String(index).repeat(32)}' })
      .then(() => console.log('reserved'), err => console.log(err.code))
      .finally(() => process.stdin.destroy());`;
  const answers = await Promise.all(
    [5, 6, 7, 8].map(
      index =>
        new Promise(resolve => {
          const child = spawn(process.execPath, ['-e', script(index)], {
            cwd: path.resolve(__dirname, '../../..'),
            stdio: ['ignore', 'pipe', 'inherit'],
            windowsHide: true,
          });
          let out = '';
          child.stdout.on('data', chunk => (out += chunk));
          child.once('exit', () => resolve(out.trim()));
        }),
    ),
  );
  assert.deepEqual(answers.sort(), ['ROOT_LIMIT', 'ROOT_LIMIT', 'reserved', 'reserved']);
  assert.equal(readRoot(root.rootHandle).calls, 2);
});

test('two identical starts at once run one worker', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const args = { ...REQUEST, scope: ['a'], request_id: 'same' };
  const answers = await Promise.allSettled([
    handleDelegate(args, repo, null, null, approve),
    handleDelegate(args, repo, null, null, approve),
  ]);
  const started = answers.filter(answer => answer.status === 'fulfilled');
  const refused = answers.filter(answer => answer.status === 'rejected');
  assert.equal(started.length, 1);
  assert.equal(refused[0].reason.code, 'SESSION_BUSY');
  const { taskHandle, rootHandle } = started[0].value.structuredContent;
  const again = await handleDelegate(args, repo, null, null, approve);
  assert.equal(again.structuredContent.taskHandle, taskHandle, 'a repeat finds the task');
  assert.equal(readRoot(rootHandle).calls, 1);
  await assert.rejects(
    handleDelegate({ ...args, root_handle: rootHandle }, repo, null, null, approve),
    /already used for a different delegation/,
  );
  await handleCancelSession({ root_handle: rootHandle });
});

test('a claim on a request id of a dead process is taken over; a live one holds; a release removes only its own', async () => {
  const handle = createTaskHandle('claim');
  const release = await claimTaskRequest(handle);
  await assert.rejects(claimTaskRequest(handle), code('SESSION_BUSY'));
  await release();
  await release();
  const file = path.join(process.env.coagent8_DIR, 'delegations', `${handle}.json.starting`);
  assert.equal(fs.existsSync(file), false);
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  fs.writeFileSync(file, JSON.stringify({ pid: dead, token: 'old' }));
  await (
    await claimTaskRequest(handle)
  )();
  fs.writeFileSync(file, '{ damaged');
  const taken = await claimTaskRequest(handle);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'another' }));
  await taken();
  assert.ok(fs.existsSync(file), "another call's claim stays");
  fs.rmSync(file);
});

test('claims of a request id in other server processes exclude each other', async () => {
  const handle = createTaskHandle('contended');
  const script = `require('tsx/cjs');
    require(${JSON.stringify(path.resolve(__dirname, '../../../src/sessions/tasks.ts'))}).claimTaskRequest(${JSON.stringify(handle)})
      .then(() => console.log('held'), err => console.log(err.code));
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const holders = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '../../..'),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    }),
  );
  try {
    const answers = await Promise.all(
      holders.map(holder => new Promise(resolve => holder.stdout.once('data', chunk => resolve(String(chunk).trim())))),
    );
    assert.deepEqual(answers.sort(), ['SESSION_BUSY', 'SESSION_BUSY', 'SESSION_BUSY', 'held']);
  } finally {
    await Promise.all(
      holders.map(holder => {
        holder.stdin.end();
        return new Promise(resolve => holder.once('exit', resolve));
      }),
    );
  }
});

test('an overlapping start is refused before the check form, and a form counts against the task budget', async () => {
  await saveConfig({ ...loadConfig(), allowedChecks: [] });
  const repo = fixtureRepo();
  const worker = await runningWorker(repo, { scope: ['a'] });
  let asked = 0;
  await assert.rejects(
    handleDelegate({ ...REQUEST, loop: true, checks: ['node -v'] }, repo, null, null, {
      ...approve,
      askChecks: async () => {
        asked++;
        return 'approved';
      },
    }),
    code('SESSION_BUSY'),
  );
  assert.equal(asked, 0, 'the user is not asked for a start that cannot run');
  await handleCancelSession({ root_handle: worker.rootHandle });

  const root = await createRoot();
  const file = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
  await atomicWrite(file, JSON.stringify({ ...root, deadlineAt: new Date(Date.now() + 1500).toISOString() }));
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const started = Date.now();
  await assert.rejects(
    handleDelegate({ ...REQUEST, root_handle: root.rootHandle, loop: true, checks: ['node -v'] }, repo, null, null, {
      ...approve,
      // A form left open past the root's time is closed by the deadline.
      askChecks: async (_checks, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('form closed')), { once: true });
        }),
    }),
    code('TIMEOUT'),
  );
  assert.ok(Date.now() - started < 8000);
  assert.deepEqual(readRoot(root.rootHandle).tasks, [], 'no turn started');
});

test('a loop whose root ran out of calls ends for the caller to decide', async () => {
  const first = {
    isError: false,
    provider: 'codex',
    result: { status: 'completed', isError: false, output: 'done', model: 'm' },
    sessionHandle: 'worker',
    meta: {},
    warnings: [],
  };
  const limit = new ToolError('ROOT_LIMIT', 'Root used its calls.');
  const reviewEnded = await superviseChange(first, {
    checks: [],
    cwd: tempDir,
    signal: null,
    remainingMs: () => 60000,
    fix: async () => first,
    review: async () => {
      throw limit;
    },
  });
  assert.equal(reviewEnded.loop.outcome, 'needs_input');
  assert.match(reviewEnded.loop.detail, /Root used its calls/);
});

test('later rounds of a loop are charged to the root', async () => {
  const { executeDelegation } = require('../../../src/execution/delegation.ts');
  const repo = fixtureRepo();
  let charged = 0;
  const outcome = await executeDelegation('Change a file', 'Change a file', REQUEST, repo, [], null, null, {
    ...approve,
    requireEnvelope: false,
    exclusive: true,
    beforeRound: async () => {
      charged++;
      throw new ToolError('ROOT_LIMIT', 'Root used its calls.');
    },
    supervise: async (result, turn) => {
      await assert.rejects(turn.fix('Again'), code('ROOT_LIMIT'));
      await assert.rejects(
        turn.inRound(async () => assert.fail('no turn runs')),
        code('ROOT_LIMIT'),
      );
      return result;
    },
  });
  assert.equal(outcome.isError, false);
  assert.equal(charged, 2);
});
