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
const {
  readRoot,
  createRoot,
  reserveRootTask,
  bindRootTask,
  reserveRootCall,
  refundRootTask,
  rootRunningMs,
  endRootTask,
  touchRootTask,
} = require('../../../src/sessions/roots.ts');
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
/** A root whose ended task used all but `leftMs` of `minutes` of running time, ending a second ago. */
const spent = (root, leftMs, minutes = root.limits.maxMinutes) => {
  const end = Date.now() - 1000;
  const past = {
    taskHandle: `task_${'f'.repeat(32)}`,
    pid: 1,
    depth: 1,
    startedAt: new Date(end - (minutes * 60_000 - leftMs)).toISOString(),
    endedAt: new Date(end).toISOString(),
  };
  return { ...root, tasks: [past, ...root.tasks] };
};

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
  assert.match(report.content[0].text, /running: 2 of 8/);
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

test('a Claude worker scope is a schedule, not an allow rule (#211)', () => {
  // Every turn allows every tool; the scope reaches the worker through its prompt and the claims.
  assert.deepEqual(JSON.parse(claudeTurnSettings()).permissions.allow, [
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'Bash',
    'WebFetch',
    'WebSearch',
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

test('a finished task has left its root by the time its final state can be read', async () => {
  await saveConfig({ ...loadConfig(), rootLimits: { maxConcurrent: 1 } });
  const repo = fixtureRepo();
  const first = await handleDelegate({ ...REQUEST, scope: ['a'] }, repo, null, null, approve);
  await finished(first.structuredContent.taskHandle);
  assert.ok(readRoot(first.structuredContent.rootHandle).tasks[0].endedAt);
  const next = await handleDelegate(
    { ...REQUEST, scope: ['b'], root_handle: first.structuredContent.rootHandle },
    repo,
    null,
    null,
    approve,
  );
  await finished(next.structuredContent.taskHandle);
});

test('the configuration refuses invalid limits', async () => {
  for (const rootLimits of [
    { maxCalls: 0 },
    { maxConcurrent: 65 },
    { maxDepth: 1.5 },
    { maxMinutes: '4' },
    { graceMinutes: -1 },
    { graceMinutes: 241 },
    { other: 1 },
    [],
  ]) {
    await assert.rejects(saveConfig({ ...loadConfig(), rootLimits }), /rootLimits/, JSON.stringify(rootLimits));
  }
  const saved = loadConfig();
  await saveConfig({ ...saved, rootLimits: { graceMinutes: 0 } });
  assert.equal(loadConfig().rootLimits.graceMinutes, 0, 'a grace of 0 turns it off');
  await saveConfig(saved);
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
  await edit({ state: 'open' });
  await atomicWrite(file, JSON.stringify(spent(readRoot(root.rootHandle), -1)));
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: `task_${'2'.repeat(32)}` }), code('ROOT_LIMIT'));
  await assert.rejects(reserveRootCall(root.rootHandle), code('ROOT_LIMIT'));

  const repo = fixtureRepo();
  const joined = await createRoot();
  const joinedFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${joined.rootHandle}.json`);
  await atomicWrite(joinedFile, JSON.stringify(spent(joined, 2500)));
  const worker = await runningWorker(repo, { scope: ['a'], root_handle: joined.rootHandle });
  assert.equal((await finished(worker.taskHandle)).state, 'timed_out');
});

test('a root counts running time, not idle time, and a continued session may finish in the grace (#228)', async () => {
  const root = await createRoot({ maxMinutes: 10, graceMinutes: 5 });
  const file = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
  const at = minutesAgo => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const ended = (n, from, to) => ({ taskHandle: `task_${String(n).repeat(32)}`, pid: 1, depth: 1, startedAt: at(from), endedAt: at(to) });
  // Created five hours ago; 4 + 4 minutes of work two hours apart, and two tasks side by side that count once.
  await atomicWrite(
    file,
    JSON.stringify({
      ...root,
      createdAt: at(300),
      tasks: [ended(4, 300, 296), { ...ended(5, 180, 176), sessionHandle: 'syn_sess_old' }, ended(6, 179, 177)],
    }),
  );
  assert.equal(Math.round(rootRunningMs(readRoot(root.rootHandle)) / 60_000), 8);
  const first = await reserveRootTask(root.rootHandle, { taskHandle: `task_${'7'.repeat(32)}` });
  assert.ok(Math.abs(first.deadlineMs - (Date.now() + 2 * 60_000)) < 5000, 'a new task gets what is left of the limit');
  await touchRootTask(root.rootHandle);
  assert.ok(readRoot(root.rootHandle).tasks.at(-1).seenAt, 'a running task is noted as seen');
  await endRootTask(root.rootHandle, `task_${'7'.repeat(32)}`);

  // A server that died unseen: its task counts up to the last time it was seen, not until the next call.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const record = readRoot(root.rootHandle);
  record.tasks.push({ taskHandle: `task_${'8'.repeat(32)}`, pid: dead, depth: 1, startedAt: at(100), seenAt: at(99) });
  await atomicWrite(file, JSON.stringify(record));
  assert.equal(Math.round(rootRunningMs(readRoot(root.rootHandle)) / 60_000), 9);

  // Out of the limit: a new task is refused and told how to go on; a continuation runs in the grace.
  const usedMinutes = rootRunningMs(readRoot(root.rootHandle)) / 60_000;
  await atomicWrite(file, JSON.stringify(spent(readRoot(root.rootHandle), 0, 10.5 - usedMinutes)));
  const refused = await reserveRootTask(root.rootHandle, { taskHandle: `task_${'9'.repeat(32)}` }).catch(err => err);
  assert.equal(refused.code, 'ROOT_LIMIT');
  assert.ok(
    refused.message.includes('used its 10 minutes of running time (counted while its tasks run, not between calls)'),
    refused.message,
  );
  assert.ok(refused.message.includes('continue its session with session_handle: a continued session gets 5 more minutes'));
  assert.ok(refused.message.includes('raise rootLimits.maxMinutes (up to 1440) or rootLimits.graceMinutes in '));
  assert.ok(refused.message.includes('config.json; it applies to new roots'));
  const continued = `task_${'a'.repeat(32)}`;
  const grace = await reserveRootTask(root.rootHandle, { taskHandle: continued, continues: 'syn_sess_old' });
  assert.ok(grace.deadlineMs - Date.now() > 3 * 60_000 && grace.deadlineMs - Date.now() <= 5 * 60_000, 'the grace bounds it');
  await bindRootTask(root.rootHandle, continued, 'syn_sess_old');
  await reserveRootCall(root.rootHandle, continued);
  await assert.rejects(reserveRootCall(root.rootHandle), code('ROOT_LIMIT'), 'another round without the task is no continuation');
  await endRootTask(root.rootHandle, continued);

  // Past the grace too: the continuation is refused and told to start over.
  await atomicWrite(file, JSON.stringify(spent(readRoot(root.rootHandle), 0, 20)));
  const late = await reserveRootTask(root.rootHandle, { taskHandle: `task_${'b'.repeat(32)}`, continues: 'syn_sess_old' }).catch(
    err => err,
  );
  assert.equal(late.code, 'ROOT_LIMIT');
  assert.ok(late.message.includes('used its 10 minutes of running time and the 5 more minutes a continued session gets'), late.message);
  assert.ok(late.message.includes('start a new task without root_handle and session_handle'));

  // Without a grace: the refusal names graceMinutes 0, so a continuation would get no more minutes.
  const graceless = await createRoot({ maxMinutes: 10, graceMinutes: 0 });
  const gracelessFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${graceless.rootHandle}.json`);
  await atomicWrite(gracelessFile, JSON.stringify(spent(graceless, -1)));
  const none = await reserveRootTask(graceless.rootHandle, { taskHandle: `task_${'d'.repeat(32)}` }).catch(err => err);
  assert.equal(none.code, 'ROOT_LIMIT');
  assert.ok(none.message.includes('used its 10 minutes of running time (counted while its tasks run, not between calls)'), none.message);
  assert.ok(none.message.includes('rootLimits.graceMinutes is 0, so a continued session gets no more minutes'), none.message);
  assert.ok(none.message.includes('start a new task without root_handle and session_handle'), none.message);

  // Past the grace too: a new task is not told to continue a session, which would be refused as well.
  const used = await createRoot({ maxMinutes: 10, graceMinutes: 5 });
  const usedFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${used.rootHandle}.json`);
  await atomicWrite(usedFile, JSON.stringify(spent(used, 0, 16)));
  const over = await reserveRootTask(used.rootHandle, { taskHandle: `task_${'e'.repeat(32)}` }).catch(err => err);
  assert.equal(over.code, 'ROOT_LIMIT');
  assert.ok(over.message.includes('used its 10 minutes of running time and the 5 more minutes a continued session gets'), over.message);
  assert.ok(!over.message.includes('continue its session with session_handle'), over.message);
  assert.ok(over.message.includes('start a new task without root_handle and session_handle'), over.message);

  // A record from before #228 has no grace stored and a deadline nobody reads.
  const legacy = await createRoot();
  const legacyFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${legacy.rootHandle}.json`);
  const { graceMinutes: _omitted, ...oldLimits } = legacy.limits;
  await atomicWrite(legacyFile, JSON.stringify({ ...legacy, limits: oldLimits, createdAt: at(1000), deadlineAt: at(760) }));
  await reserveRootTask(legacy.rootHandle, { taskHandle: `task_${'c'.repeat(32)}` });
  const report = await handleSession({ action: 'root', root_handle: legacy.rootHandle });
  assert.ok(report.content[0].text.includes('running time: 0 of 240 minutes, 60 more for a continued session'), report.content[0].text);
  assert.equal(report.structuredContent.graceMinutes, 60);
});

test('after the clock is set back, later work counts at its real length and is refused at maxMinutes plus grace (#228)', async () => {
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const root = await createRoot({ maxMinutes: 2, graceMinutes: 0, maxConcurrent: 4, maxCalls: 10 });
    const handle = n => `task_${String(n).repeat(32)}`;
    // One minute of work, then the clock is set back an hour.
    await reserveRootTask(root.rootHandle, { taskHandle: handle(1) });
    shift += 60_000;
    await endRootTask(root.rootHandle, handle(1));
    shift -= 3600_000;
    const second = await reserveRootTask(root.rootHandle, { taskHandle: handle(2) });
    assert.ok(Math.abs(second.deadlineMs - (Date.now() + 60_000)) < 5000, 'the second task gets the minute left, on this clock');
    assert.ok(readRoot(root.rootHandle).clockOffsetMs >= 3600_000 - 60_000, 'the root keeps the offset');
    shift += 60_000;
    await endRootTask(root.rootHandle, handle(2));
    const usedMs = rootRunningMs(readRoot(root.rootHandle));
    assert.ok(usedMs >= 120_000 && usedMs < 125_000, `the minute after the clock was set back counts (${usedMs} ms)`);
    const third = await reserveRootTask(root.rootHandle, { taskHandle: handle(3) }).catch(err => err);
    assert.equal(third.code, 'ROOT_LIMIT', 'a third minute is refused');
    assert.ok(third.message.includes('rootLimits.graceMinutes is 0'), third.message);
  } finally {
    Date.now = realNow;
  }

  // A clock set back while a task runs, before any note: its server's monotonic time still counts.
  shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const root = await createRoot({ maxMinutes: 2, graceMinutes: 0, maxConcurrent: 4, maxCalls: 10 });
    const handle = n => `task_${String(n).repeat(32)}`;
    for (const n of [6, 7]) {
      await reserveRootTask(root.rootHandle, { taskHandle: handle(n) });
      shift += 60_000;
      shift -= 3600_000;
      await endRootTask(root.rootHandle, handle(n), 60_000);
    }
    const ended = readRoot(root.rootHandle).tasks.find(task => task.taskHandle === handle(6));
    const ranMs = Date.parse(ended.endedAt) - Date.parse(ended.startedAt);
    assert.ok(ranMs >= 60_000 && ranMs < 61_000, `the task counts its measured minute (${ranMs} ms)`);
    const usedMs = rootRunningMs(readRoot(root.rootHandle));
    assert.ok(usedMs >= 120_000 && usedMs < 125_000, `both measured minutes count (${usedMs} ms)`);
    const third = await reserveRootTask(root.rootHandle, { taskHandle: handle(8) }).catch(err => err);
    assert.equal(third.code, 'ROOT_LIMIT', 'a third task is refused at maxMinutes plus grace');
    // A touch with the measured time notes it as well.
    const touched = await createRoot({ maxMinutes: 10, graceMinutes: 0 });
    await reserveRootTask(touched.rootHandle, { taskHandle: handle(9) });
    const startedAt = Date.parse(readRoot(touched.rootHandle).tasks.at(-1).startedAt);
    shift += 50_000;
    shift -= 3600_000;
    await touchRootTask(touched.rootHandle, { taskHandle: handle(9), elapsedMs: 50_000 });
    assert.ok(Date.parse(readRoot(touched.rootHandle).tasks.at(-1).seenAt) - startedAt >= 50_000);
  } finally {
    Date.now = realNow;
  }

  // A measured time a little ahead of the wall clock, without a clock change, charges no note interval.
  {
    const root = await createRoot({ maxMinutes: 10, graceMinutes: 0, maxConcurrent: 4, maxCalls: 10 });
    const task = `task_${'c'.repeat(32)}`;
    await reserveRootTask(root.rootHandle, { taskHandle: task });
    const startedAt = Date.parse(readRoot(root.rootHandle).tasks.at(-1).startedAt);
    const ahead = () => Date.now() - startedAt + 5;
    await touchRootTask(root.rootHandle, { taskHandle: task, elapsedMs: ahead() });
    await reserveRootCall(root.rootHandle);
    await touchRootTask(root.rootHandle);
    await endRootTask(root.rootHandle, task, ahead());
    await reserveRootCall(root.rootHandle);
    const record = readRoot(root.rootHandle);
    assert.ok(rootRunningMs(record) < 5000, `no note interval is charged (${rootRunningMs(record)} ms)`);
    assert.ok((record.clockOffsetMs ?? 0) < 1000, `the offset rises only by what the measured time was ahead (${record.clockOffsetMs})`);
  }

  // Set back by less than the time since the last write, which no check sees: the measured time still counts.
  shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const root = await createRoot({ maxMinutes: 10, graceMinutes: 0, maxConcurrent: 4, maxCalls: 10 });
    const task = `task_${'d'.repeat(32)}`;
    await reserveRootTask(root.rootHandle, { taskHandle: task });
    const startedAt = Date.parse(readRoot(root.rootHandle).tasks.at(-1).startedAt);
    shift += 50_000;
    shift -= 30_000;
    await endRootTask(root.rootHandle, task, 50_000);
    const ranMs = Date.parse(readRoot(root.rootHandle).tasks.at(-1).endedAt) - startedAt;
    assert.ok(ranMs >= 50_000 && ranMs < 51_000, `the measured 50 s count, not the 20 s the clock shows (${ranMs} ms)`);
  } finally {
    Date.now = realNow;
  }

  // Set back before a running task's first note: another task cannot get the time it may have run.
  shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const root = await createRoot({ maxMinutes: 1, graceMinutes: 0, maxConcurrent: 4, maxCalls: 10 });
    const first = `task_${'a'.repeat(32)}`;
    await reserveRootTask(root.rootHandle, { taskHandle: first });
    const startedAt = Date.parse(readRoot(root.rootHandle).tasks.at(-1).startedAt);
    shift += 50_000;
    shift -= 3600_000;
    const second = await reserveRootTask(root.rootHandle, { taskHandle: `task_${'b'.repeat(32)}` }).catch(err => err);
    assert.equal(second.code, 'ROOT_LIMIT', 'the running task is charged a full note interval, the whole limit');
    const noted = readRoot(root.rootHandle).tasks.at(-1);
    assert.equal(Date.parse(noted.seenAt) - startedAt, 60_000, 'it is noted a note interval after the latest written time');
    assert.ok(rootRunningMs(readRoot(root.rootHandle)) >= 60_000);
    await endRootTask(root.rootHandle, first, 50_000);
    const ended = readRoot(root.rootHandle).tasks.at(-1);
    assert.ok(Date.parse(ended.endedAt) - startedAt >= 60_000, 'its measured 50 s does not lower what was counted');
    assert.ok(rootRunningMs(readRoot(root.rootHandle)) >= 60_000);
  } finally {
    Date.now = realNow;
  }

  // A record from before the offset, its times an hour ahead of the clock, starts the offset at 0.
  const old = await createRoot({ maxMinutes: 10 });
  const oldFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${old.rootHandle}.json`);
  const ahead = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
  const past = { taskHandle: `task_${'4'.repeat(32)}`, pid: 1, depth: 1, startedAt: ahead(59), endedAt: ahead(60) };
  const { clockOffsetMs: _none, ...oldRecord } = { ...old, tasks: [past] };
  await atomicWrite(oldFile, JSON.stringify(oldRecord));
  assert.equal(readRoot(old.rootHandle).clockOffsetMs, undefined);
  assert.ok(Math.abs(rootRunningMs(readRoot(old.rootHandle)) - 60_000) < 1000, 'an old record counts as before');
  const next = await reserveRootTask(old.rootHandle, { taskHandle: `task_${'5'.repeat(32)}` });
  assert.ok(Math.abs(next.deadlineMs - (Date.now() + 9 * 60_000)) < 5000);
  const record = readRoot(old.rootHandle);
  assert.ok(record.clockOffsetMs > 59 * 60_000, 'the first write sets the offset');
  assert.equal(record.tasks.at(-1).startedAt, past.endedAt, 'the new task starts where the record ends');
});

test('a reservation that reached no turn is refunded; a task of a dead server stops counting but keeps its charge', async () => {
  const root = await createRoot({ maxConcurrent: 1, maxCalls: 10 });
  const handle = `task_${'3'.repeat(32)}`;
  await reserveRootTask(root.rootHandle, { taskHandle: handle });
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: handle }), code('SESSION_BUSY'), 'the same task, reserved twice');
  await refundRootTask(root.rootHandle, handle);
  assert.equal(readRoot(root.rootHandle).calls, 0);
  assert.deepEqual(readRoot(root.rootHandle).tasks, [], 'a refund does not grow the record');
  assert.ok(readRoot(root.rootHandle).refundedMs >= 0, 'the time it took still counts');

  await reserveRootTask(root.rootHandle, { taskHandle: handle });
  const file = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
  await touchRootTask(root.rootHandle);
  const record = readRoot(root.rootHandle);
  // What the last write counted: the running task up to that write.
  const usedWhileRunning = rootRunningMs(record, Date.parse(record.tasks.at(-1).seenAt));
  record.tasks.at(-1).pid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  await atomicWrite(file, JSON.stringify(record));
  assert.ok(rootRunningMs(readRoot(root.rootHandle)) >= usedWhileRunning, 'what a write counted stays counted after the server dies');
  await reserveRootTask(root.rootHandle, { taskHandle: `task_${'4'.repeat(32)}` });
  assert.equal(readRoot(root.rootHandle).calls, 2, 'the charge of the dead one stays');

  // A clock set back does not shorten what was counted.
  const ahead = readRoot(root.rootHandle);
  const later = new Date(Date.now() + 10 * 60_000).toISOString();
  ahead.tasks.at(-1).seenAt = later;
  await atomicWrite(file, JSON.stringify(ahead));
  await reserveRootCall(root.rootHandle).catch(() => undefined);
  assert.equal(
    Date.parse(readRoot(root.rootHandle).tasks.at(-1).seenAt) - Date.parse(later),
    60_000,
    'the timeline goes on a note interval after the latest recorded time, since a task was running',
  );
  assert.ok(readRoot(root.rootHandle).clockOffsetMs > 9 * 60_000, 'the root keeps the offset of the clock set back');
  await endRootTask(root.rootHandle, `task_${'4'.repeat(32)}`);
  assert.ok(Date.parse(readRoot(root.rootHandle).tasks.at(-1).endedAt) >= Date.parse(later));
  // A new task then starts after it on the root's timeline, not inside it where it would not count.
  const next = `task_${'5'.repeat(32)}`;
  await reserveRootTask(root.rootHandle, { taskHandle: next });
  assert.ok(Date.parse(readRoot(root.rootHandle).tasks.at(-1).startedAt) >= Date.parse(later));

  // A refused change still records what it counted for the running task.
  const before = readRoot(root.rootHandle).tasks.at(-1).seenAt;
  await atomicWrite(file, JSON.stringify(spent(readRoot(root.rootHandle), -60_000)));
  await delay(20);
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: `task_${'6'.repeat(32)}` }), code('ROOT_LIMIT'));
  assert.notEqual(readRoot(root.rootHandle).tasks.at(-1).seenAt, before);

  // A refund keeps the time only it covered.
  const alone = await createRoot();
  await reserveRootTask(alone.rootHandle, { taskHandle: next });
  await delay(30);
  await refundRootTask(alone.rootHandle, next);
  assert.ok(readRoot(alone.rootHandle).refundedMs >= 20, String(readRoot(alone.rootHandle).refundedMs));
  assert.ok(rootRunningMs(readRoot(alone.rootHandle)) >= 20);
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
  assert.equal(readRoot(root.rootHandle).calls, 0);
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
    assert.match(report.content[0].text, /running: 1 of 8/);
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
  await atomicWrite(file, JSON.stringify(spent(root, 1500)));
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
  assert.deepEqual(
    readRoot(root.rootHandle).tasks.map(task => task.taskHandle),
    [`task_${'f'.repeat(32)}`],
    'no turn started',
  );
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

test('a later turn of a loop is charged just before it starts, and a refusal starts none', async () => {
  const { executeDelegation } = require('../../../src/execution/delegation.ts');
  const { executeReview } = require('../../../src/mcp/tools/review.tool.ts');
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WRITES = JSON.stringify({ 'a/one.ts': 'x\n' });
  let charged = 0;
  const refuse = async () => {
    charged++;
    throw new ToolError('ROOT_LIMIT', 'Root used its calls.');
  };
  const outcome = await executeDelegation('Change a file', 'Change a file', REQUEST, repo, [], null, null, {
    ...approve,
    requireEnvelope: false,
    exclusive: true,
    beforeRound: refuse,
    supervise: async (first, turn) => {
      assert.equal(charged, 0, 'the first turn was charged at its reservation');
      const fixed = await turn.fix('Again');
      assert.equal(fixed.result.error.code, 'ROOT_LIMIT');
      assert.equal(charged, 1);
      const reviewed = await turn.inRound(round =>
        executeReview({ backend: 'codex', scope: 'uncommitted' }, repo, null, null, { ...round }),
      );
      assert.equal(reviewed.result.error.code, 'ROOT_LIMIT');
      assert.equal(charged, 2);
      return first;
    },
  });
  assert.equal(outcome.isError, false);
});

test('a review in parts charges each backend turn', async () => {
  const { executeReview } = require('../../../src/mcp/tools/review.tool.ts');
  const repo = fixtureRepo();
  const lines = 'const line = 1;\n'.repeat(9000);
  fs.writeFileSync(path.join(repo, 'a', 'one.ts'), lines);
  fs.writeFileSync(path.join(repo, 'b', 'two.ts'), lines);
  let turns = 0;
  const reviewed = await executeReview({ backend: 'codex', scope: 'uncommitted' }, repo, null, null, {
    ...approve,
    onTurnStart: async () => {
      turns++;
    },
  });
  assert.equal(turns >= 3, true, `two parts and a synthesis, got ${turns}: ${reviewed.result.error?.message ?? ''}`);
});

test('a limit met before a later turn ends the loop with the change as it was', async () => {
  const first = {
    isError: false,
    provider: 'codex',
    result: { status: 'completed', isError: false, output: 'done', model: 'm' },
    sessionHandle: 'worker',
    meta: {},
    warnings: [],
  };
  const refused = {
    ...first,
    isError: true,
    result: {
      status: 'failed',
      isError: true,
      output: '',
      error: { code: 'ROOT_LIMIT', message: 'Root used its calls.', retryable: false },
    },
  };
  const base = { checks: [], cwd: tempDir, signal: null, remainingMs: () => 60000 };
  const review = await superviseChange(first, { ...base, fix: async () => first, review: async () => refused });
  assert.equal(review.loop.outcome, 'needs_input');
  assert.match(review.loop.detail, /Root used its calls/);
  const fix = await superviseChange(first, {
    ...base,
    checks: [`${JSON.stringify(process.execPath)} -e "process.exit(3)"`],
    fix: async () => refused,
    review: async () => assert.fail('no review of a failing check'),
  });
  assert.equal(fix.loop.outcome, 'needs_input');
  assert.equal(fix.loop.checks.length, 1, 'the failure that asked for the fix stays in the report');
  assert.equal(fix.isError, false, 'the last turn that ran stays the result');
  const aborted = {
    ...refused,
    result: { ...refused.result, error: { code: 'ABORTED', message: 'Root was cancelled.', retryable: false } },
  };
  const cancelledReview = await superviseChange(first, { ...base, fix: async () => first, review: async () => aborted });
  assert.equal(cancelledReview.loop.outcome, 'cancelled');
  assert.equal(cancelledReview.result.status, 'cancelled');
  const cancelledFix = await superviseChange(first, {
    ...base,
    checks: [`${JSON.stringify(process.execPath)} -e "process.exit(3)"`],
    fix: async () => aborted,
    review: async () => assert.fail('no review of a failing check'),
  });
  assert.equal(cancelledFix.loop.outcome, 'cancelled');
});

test('continuing an old idle root via root_handle or session_handle is not defeated by pruneRoots (#246)', async () => {
  const repo = fixtureRepo();
  const finish = async started => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(started.structuredContent.taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'task finished in time');
      await delay(25);
    }
  };

  const first = await handleDelegate({ ...REQUEST, scope: ['a'] }, repo, null, null, approve);
  const firstDone = await finish(first);
  const rootHandle = first.structuredContent.rootHandle;
  const rootFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${rootHandle}.json`);

  // Create an unrelated old idle root so we prove pruning still removes unselected old idle roots.
  const unrelated = await createRoot();
  const unrelatedFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${unrelated.rootHandle}.json`);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  await atomicWrite(unrelatedFile, JSON.stringify({ ...unrelated, createdAt: eightDaysAgo }));

  // Age the idle target root past retention (7 days), then join it explicitly via root_handle.
  await atomicWrite(rootFile, JSON.stringify({ ...readRoot(rootHandle), createdAt: eightDaysAgo }));
  const byRoot = await handleDelegate({ ...REQUEST, scope: ['a'], root_handle: rootHandle }, repo, null, null, approve);
  assert.equal(byRoot.structuredContent.rootHandle, rootHandle);
  await finish(byRoot);
  assert.ok(readRoot(rootHandle), 'selected root must not be pruned');
  assert.equal(readRoot(unrelated.rootHandle), null, 'unrelated old idle root is still pruned');

  // Keep it aged past retention and idle, then continue via session_handle without passing root_handle.
  await atomicWrite(rootFile, JSON.stringify({ ...readRoot(rootHandle), createdAt: eightDaysAgo }));
  const bySession = await handleDelegate({ ...REQUEST, scope: ['a'], session_handle: firstDone.sessionHandle }, repo, null, null, approve);
  assert.equal(bySession.structuredContent.rootHandle, rootHandle);
  await finish(bySession);
  assert.equal(readRoot(rootHandle).tasks.at(-1).continuation, true);
});
