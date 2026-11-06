const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// #164: an agent coordinates workers through its read-only turns; identity comes from the server.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-coordination-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
process.env.coagent8_END_NOTES_DIR = path.join(tempDir, 'notes');
process.env.CODEX_PATH = path.resolve(__dirname, '../../fixtures/codex-cli/codex.cjs');
process.env.CODEX_CONFIG_PATH = path.join(tempDir, 'config.toml');
const REPLIES = path.join(tempDir, 'replies.json');
const CAPTURE = path.join(tempDir, 'capture.jsonl');
process.env.CODEX_FIXTURE_REPLIES = REPLIES;
process.env.CODEX_FIXTURE_PROMPT_WRITES = '1';
const { handleDelegate } = require('../../../src/mcp/tools/delegate.tool.ts');
const { handleCancelSession } = require('../../../src/mcp/tools/session.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
const { parseCoordinatorAnswer } = require('../../../src/execution/coordination.ts');
require('../../../src/execution/controller.ts').composeExecutionCancellation();
const { readTask, createTaskHandle, writeTask } = require('../../../src/sessions/tasks.ts');
const {
  readRoot,
  createRoot,
  reserveRootTask,
  bindRootTask,
  endRootTask,
  beginCoordinatorTurn,
  endCoordinatorTurn,
  requestCoordinatorCancel,
} = require('../../../src/sessions/roots.ts');
const { readCoordination, writeCoordination } = require('../../../src/sessions/coordinations.ts');

const CONFIG = { defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } };
test.before(() => saveConfig(CONFIG));
test.after(async () => {
  await stopActiveDelegations();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const approve = { askConsent: async () => ({ approved: true, remember: false }) };
const REQUEST = { backend: 'codex', model: 'gpt-6.1-sol', coordinate: true };
const fence = value => `Plan.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const finish = (report = 'All done') => fence({ action: 'finish', report });
const start = (...children) => fence({ action: 'start', children });

let repos = 0;
function fixtureRepo() {
  const repo = path.join(tempDir, `repo-${++repos}`);
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const dir of ['a', 'b', 'c']) {
    fs.mkdirSync(path.join(repo, dir));
    fs.writeFileSync(path.join(repo, dir, 'keep.txt'), `${dir}\n`);
  }
  git('add', '.');
  git('commit', '-qm', 'base');
  return repo;
}

function script(...replies) {
  fs.writeFileSync(REPLIES, JSON.stringify(replies));
  fs.rmSync(CAPTURE, { force: true });
}

async function ended(handle, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const task = readTask(handle);
    if (task.state !== 'running') return task;
    assert.ok(Date.now() < deadline, 'the task ended in time');
    await delay(25);
  }
}

async function coordinate(repo, args, options = approve) {
  const started = await handleDelegate({ task: 'Build it', ...REQUEST, ...args }, repo, null, null, options);
  assert.equal(started.isError, undefined, started.content?.[0]?.text);
  return started.structuredContent;
}

test('a coordinator starts disjoint workers, reads their reports and finishes; the root stays unaccepted', async () => {
  const repo = fixtureRepo();
  script(
    start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }, { id: 'two', task: 'WRITE b/new.txt', scope: ['b'] }),
    finish('Both written'),
  );
  const started = await coordinate(repo);
  const task = await ended(started.taskHandle);
  assert.equal(task.state, 'completed', task.result?.text);
  assert.equal(task.coordinator, true);
  assert.match(task.result.text, /Both written/);
  assert.match(task.result.text, /- one: completed, task_/);
  assert.equal(fs.existsSync(path.join(repo, 'a', 'new.txt')), true);
  assert.equal(fs.existsSync(path.join(repo, 'b', 'new.txt')), true);

  const root = readRoot(started.rootHandle);
  assert.equal(root.state, 'open', 'finishing accepts nothing');
  // Two coordinator turns and two workers.
  assert.equal(root.calls, 4);
  const workers = root.tasks.filter(entry => !entry.coordinator);
  assert.equal(workers.length, 2);
  for (const worker of workers) {
    assert.equal(worker.parentTask, started.taskHandle, 'the server names the parent');
    assert.equal(worker.depth, 2);
    assert.equal(readTask(worker.taskHandle).rootHandle, started.rootHandle);
  }
});

test('a coordinator gives its place back while it waits: a limit of one still runs its workers, in turn', async () => {
  const repo = fixtureRepo();
  await saveConfig({
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    rootLimits: { maxConcurrent: 1 },
  });
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }, { id: 'two', task: 'WRITE b/new.txt', scope: ['b'] }), finish());
    const task = await ended((await coordinate(repo)).taskHandle);
    assert.equal(task.state, 'completed', task.result?.text);
    assert.match(task.result.text, /- two: completed/);
  } finally {
    await saveConfig({ ...CONFIG, rootLimits: {} });
  }
});

test('overlapping or whole-tree siblings wait for each other instead of failing', async () => {
  const repo = fixtureRepo();
  script(start({ id: 'whole', task: 'WRITE a/whole.txt' }, { id: 'part', task: 'WRITE a/part.txt', scope: ['a'] }), finish());
  const task = await ended((await coordinate(repo)).taskHandle);
  assert.equal(task.state, 'completed', task.result?.text);
  assert.match(task.result.text, /- whole: completed/);
  assert.match(task.result.text, /- part: completed/);
});

test('fields that name an identity or a profile are refused, and nothing starts from them', () => {
  for (const forged of [
    { root_handle: 'root_00000000000000000000000000000000' },
    { parent_task: 'task_00000000000000000000000000000000' },
    { parentTask: 'task_00000000000000000000000000000000' },
    { session_handle: 'syn_sess_x' },
    { profile: 'workspace-write' },
    { workspace_path: '/elsewhere' },
    { request_id: 'x' },
    { output_price_below: 100 },
  ]) {
    assert.throws(
      () => parseCoordinatorAnswer(start({ id: 'one', task: 'x', ...forged }), []),
      err => err.code === 'INPUT_LIMIT' && /Unknown child field/.test(err.message),
      JSON.stringify(forged),
    );
  }
});

test('an answer counts only when it ends in one strict object', () => {
  const bad = [
    'Please start a worker on a/',
    '{"action":"start","children":[{"id":"x","task":"y"}]} and then something',
    `${fence({ action: 'finish', report: 'x' })}\nAnd one more thing`,
    fence({ action: 'launch', children: [] }),
    fence({ action: 'start', children: [] }),
    fence({ action: 'finish', report: '' }),
    fence({ action: 'finish', report: 'x', children: [] }),
    fence({ action: 'start', children: [{ id: 'a b', task: 'x' }] }),
    fence({ action: 'start', children: [{ id: 'a', task: ' ' }] }),
    fence({
      action: 'start',
      children: [
        { id: 'a', task: 'x' },
        { id: 'a', task: 'y' },
      ],
    }),
    fence({ action: 'start', children: [{ id: 'a', task: 'x', scope: ['../out'] }] }),
    fence({ action: 'start', children: [{ id: 'a', task: 'x', scope: ['/abs'] }] }),
    fence({ action: 'start', children: [{ id: 'a', task: 'x', loop: 'yes' }] }),
    fence({ action: 'start', children: [{ id: 'a', task: 'x', timeout_ms: 1e9 }] }),
  ];
  for (const answer of bad)
    assert.throws(
      () => parseCoordinatorAnswer(answer, []),
      err => err.code === 'INPUT_LIMIT',
      answer,
    );
  assert.deepEqual(parseCoordinatorAnswer(fence({ action: 'finish', report: ' done ' }), []), { action: 'finish', report: 'done' });
  assert.equal(parseCoordinatorAnswer(JSON.stringify({ action: 'finish', report: 'plain' }), []).report, 'plain');
});

test("a worker stays inside its coordinator's scope", () => {
  const within = parseCoordinatorAnswer(start({ id: 'a', task: 'x', scope: ['src/one'] }), ['src']);
  assert.deepEqual(within.children[0].scope, ['src/one']);
  for (const child of [
    { id: 'a', task: 'x' },
    { id: 'a', task: 'x', scope: ['.'] },
    { id: 'a', task: 'x', scope: ['srcother'] },
    { id: 'a', task: 'x', scope: ['src/one', 'lib'] },
  ]) {
    assert.throws(() => parseCoordinatorAnswer(start(child), ['src']), /must stay within src/, JSON.stringify(child));
  }
});

test('a refused answer gets one charged correction, and a second refusal ends the task with no worker', async () => {
  const repo = fixtureRepo();
  script('Just prose.', 'Still prose.');
  const started = await coordinate(repo);
  const task = await ended(started.taskHandle);
  assert.equal(task.state, 'failed');
  assert.match(task.result.text, /refused twice/);
  const root = readRoot(started.rootHandle);
  assert.equal(root.calls, 2);
  assert.equal(root.tasks.length, 1, 'no worker');

  const repaired = fixtureRepo();
  script('Prose first.', finish('Fine now'));
  const second = await ended((await coordinate(repaired)).taskHandle);
  assert.equal(second.state, 'completed', second.result?.text);
  assert.match(second.result.text, /Fine now/);
});

test('an id used again starts nothing: a replayed request reaches no second worker', async () => {
  const repo = fixtureRepo();
  const child = { id: 'one', task: 'WRITE a/new.txt', scope: ['a'] };
  script(start(child), start(child), finish('Stopped asking'));
  const started = await coordinate(repo);
  const task = await ended(started.taskHandle);
  assert.equal(task.state, 'completed', task.result?.text);
  assert.equal(readRoot(started.rootHandle).tasks.filter(entry => !entry.coordinator).length, 1);
  // Three turns and one worker: the refused repeat costs a turn and starts nothing.
  assert.equal(readRoot(started.rootHandle).calls, 4);
});

test('a worker continues an earlier worker only by its id, in its own session and place', async () => {
  const repo = fixtureRepo();
  script(
    start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }),
    start(
      { id: 'fix', task: 'WRITE a/fix.txt', scope: ['a'], continues: 'one' },
      { id: 'lost', task: 'x', scope: ['b'], continues: 'nobody' },
    ),
    finish(),
  );
  const started = await coordinate(repo);
  const task = await ended(started.taskHandle);
  assert.equal(task.state, 'completed', task.result?.text);
  assert.equal(fs.existsSync(path.join(repo, 'a', 'fix.txt')), true);
  assert.match(task.result.text, /- lost: not started/);
  const workers = readRoot(started.rootHandle).tasks.filter(entry => !entry.coordinator);
  const sessions = workers.map(worker => worker.sessionHandle);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0], sessions[1], 'the same worker session');
  assert.equal(workers[1].depth, workers[0].depth);
});

test('fan-out and depth limits reach the coordinator as reports; the root is never passed', async () => {
  const repo = fixtureRepo();
  await saveConfig({ ...CONFIG, rootLimits: { maxChildren: 1 } });
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }, { id: 'two', task: 'WRITE b/new.txt', scope: ['b'] }), finish());
    const started = await coordinate(repo);
    const task = await ended(started.taskHandle);
    assert.equal(task.state, 'completed', task.result?.text);
    assert.match(task.result.text, /- one: completed/);
    assert.match(task.result.text, /- two: not started/);
    assert.equal(fs.existsSync(path.join(repo, 'b', 'new.txt')), false);

    await saveConfig({ ...CONFIG, rootLimits: { maxDepth: 1 } });
    const deep = fixtureRepo();
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish());
    const shallow = await coordinate(deep);
    const ended2 = await ended(shallow.taskHandle);
    assert.match(ended2.result.text, /- one: not started/);
    assert.equal(fs.existsSync(path.join(deep, 'a', 'new.txt')), false);
  } finally {
    await saveConfig({ ...CONFIG, rootLimits: {} });
  }
});

test('a task cannot be its own parent, and a parent must exist first', async () => {
  const root = await createRoot();
  const handle = createTaskHandle();
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: handle, parentTask: handle }), /own parent/);
  await reserveRootTask(root.rootHandle, { taskHandle: handle });
  await assert.rejects(
    reserveRootTask(root.rootHandle, { taskHandle: createTaskHandle(), parentTask: createTaskHandle() }),
    /not in this root/,
  );
});

test('a worker needing a check the user did not list is refused without asking anyone', async () => {
  const repo = fixtureRepo();
  script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'], loop: true, checks: ['node -e 1'] }), finish());
  let asked = 0;
  const started = await coordinate(repo, {}, { ...approve, askChecks: async () => (asked++, 'approved') });
  const task = await ended(started.taskHandle);
  assert.equal(asked, 0);
  assert.match(task.result.text, /- one: not started/);
  assert.equal(fs.existsSync(path.join(repo, 'a', 'new.txt')), false);
});

test('a coordinator refuses what belongs to its workers, and a synchronous start', async () => {
  const repo = fixtureRepo();
  for (const args of [{ mode: 'sync' }, { loop: true }, { checks: ['npm test'] }]) {
    await assert.rejects(handleDelegate({ task: 'x', ...REQUEST, ...args }, repo, null, null, approve), err => err.code === 'INPUT_LIMIT');
  }
});

test('cancelling a coordinator between its turns stops its workers', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WORKERS_HANG = '1';
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }, { id: 'two', task: 'WRITE b/new.txt', scope: ['b'] }), finish());
    const started = await coordinate(repo);
    const deadline = Date.now() + 15000;
    while (readRoot(started.rootHandle).tasks.filter(entry => !entry.coordinator && !entry.endedAt && entry.sessionHandle).length < 2) {
      assert.ok(Date.now() < deadline, 'both workers started');
      await delay(25);
    }
    const answer = await handleCancelSession({ session_handle: started.sessionHandle });
    assert.equal(answer.structuredContent.cancelled, true, answer.content[0].text);
    const task = await ended(started.taskHandle);
    assert.equal(task.state, 'cancelled', task.result?.text);
    for (const worker of readRoot(started.rootHandle).tasks.filter(entry => !entry.coordinator)) {
      assert.equal(readTask(worker.taskHandle).state, 'cancelled');
    }
  } finally {
    delete process.env.CODEX_FIXTURE_WORKERS_HANG;
  }
});

test('cancelling the root stops the coordinator and every worker, and starts nothing later', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WORKERS_HANG = '1';
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish('Never read'));
    const started = await coordinate(repo);
    const deadline = Date.now() + 15000;
    while (!readRoot(started.rootHandle).tasks.some(entry => !entry.coordinator && entry.sessionHandle)) {
      assert.ok(Date.now() < deadline, 'the worker started');
      await delay(25);
    }
    const answer = await handleCancelSession({ root_handle: started.rootHandle });
    assert.deepEqual(answer.structuredContent.running, []);
    const task = await ended(started.taskHandle);
    assert.equal(task.state, 'cancelled', task.result?.text);
    assert.doesNotMatch(task.result.text, /Never read/);
    assert.equal(readRoot(started.rootHandle).tasks.filter(entry => !entry.coordinator).length, 1);
  } finally {
    delete process.env.CODEX_FIXTURE_WORKERS_HANG;
  }
});

test('a time limit on a coordinator ends its workers too', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WORKERS_HANG = '1';
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish());
    const started = await coordinate(repo, { timeout_ms: 4000 });
    const task = await ended(started.taskHandle);
    assert.equal(task.state, 'timed_out', task.result?.text);
    const worker = readRoot(started.rootHandle).tasks.find(entry => !entry.coordinator);
    assert.notEqual(readTask(worker.taskHandle).state, 'running');
  } finally {
    delete process.env.CODEX_FIXTURE_WORKERS_HANG;
  }
});

test('a request is in the ledger before its worker starts, and a repeated start finds that worker', async () => {
  const repo = fixtureRepo();
  script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish());
  const started = await coordinate(repo);
  await ended(started.taskHandle);
  const ledger = readCoordination(started.sessionHandle);
  assert.equal(ledger.parentTask, started.taskHandle);
  assert.equal(ledger.rootHandle, started.rootHandle);
  assert.deepEqual(
    ledger.children.map(child => [child.id, child.reported]),
    [['one', true]],
  );
  assert.equal(
    ledger.children[0].taskHandle,
    createTaskHandle(`${repo}\ncoordination/${started.sessionHandle}/one`),
    'the handle comes from the session and the id, so a repeat cannot be a second task',
  );
});

test('after a crash a continuation reports what became of each worker and restarts none', async () => {
  const repo = fixtureRepo();
  script(finish('First'));
  const first = await coordinate(repo);
  await ended(first.taskHandle);
  // What a crash leaves: a request in the ledger, one worker that never started, one whose server died.
  const never = createTaskHandle();
  const died = createTaskHandle();
  await writeTask({
    schemaVersion: 1,
    taskHandle: died,
    state: 'running',
    workspace: repo,
    sessionHandle: 'syn_sess_dead',
    backend: 'codex',
    model: null,
    serverPid: 2 ** 30,
    startedAt: new Date().toISOString(),
  });
  await writeCoordination({
    schemaVersion: 1,
    sessionHandle: first.sessionHandle,
    rootHandle: first.rootHandle,
    parentTask: first.taskHandle,
    children: [
      { id: 'never', taskHandle: never, reported: false },
      { id: 'died', taskHandle: died, reported: false },
    ],
  });
  process.env.CODEX_FIXTURE_CAPTURE = CAPTURE;
  try {
    script(finish('Recovered'));
    const again = await coordinate(repo, { task: 'Go on', session_handle: first.sessionHandle });
    const task = await ended(again.taskHandle);
    assert.equal(task.state, 'completed', task.result?.text);
    assert.match(task.result.text, /Recovered/);
    assert.equal(again.rootHandle, first.rootHandle, 'a continuation stays in its root');
    const sent = fs.readFileSync(CAPTURE, 'utf8');
    assert.match(sent, /id=\\+"never\\+" state=\\+"not_started/);
    assert.match(sent, /id=\\+"died\\+" state=\\+"interrupted/);
    assert.match(sent, /Go on/);
    assert.equal(readTask(never), null, 'a worker that did not start is not started by itself');
    assert.equal(
      readCoordination(first.sessionHandle).children.every(child => child.reported),
      true,
    );
  } finally {
    delete process.env.CODEX_FIXTURE_CAPTURE;
  }
});

test('a second coordinator in a running session is refused', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WORKERS_HANG = '1';
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish());
    const started = await coordinate(repo);
    const deadline = Date.now() + 15000;
    while (!readRoot(started.rootHandle).tasks.some(entry => !entry.coordinator && entry.sessionHandle)) {
      assert.ok(Date.now() < deadline, 'the worker started');
      await delay(25);
    }
    await assert.rejects(
      handleDelegate({ task: 'Again', ...REQUEST, session_handle: started.sessionHandle }, repo, null, null, approve),
      err => err.code === 'SESSION_BUSY',
    );
    await handleCancelSession({ session_handle: started.sessionHandle });
    await ended(started.taskHandle);
  } finally {
    delete process.env.CODEX_FIXTURE_WORKERS_HANG;
  }
});

test('a coordinator turn runs read-only, while its worker runs the write profile', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_CAPTURE = CAPTURE;
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish());
    await ended((await coordinate(repo)).taskHandle);
    // The fixture writes only on a workspace-write thread, and captures the last process: the coordinator's resume.
    assert.equal(fs.existsSync(path.join(repo, 'a', 'new.txt')), true);
    const { records, nested } = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
    const thread = records.find(record => record.method === 'thread/resume');
    assert.equal(thread.params.sandbox, 'read-only');
    assert.equal(nested, '1', 'the nested-turn refusal stays set in its environment');
  } finally {
    delete process.env.CODEX_FIXTURE_CAPTURE;
  }
});

test('a coordinator holds a place only during its turns', async () => {
  const root = await createRoot({ maxConcurrent: 1 });
  const coordinator = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: coordinator, coordinator: true });
  await assert.rejects(reserveRootTask(root.rootHandle, { taskHandle: createTaskHandle() }), err => err.code === 'ROOT_LIMIT');
  await endCoordinatorTurn(root.rootHandle, coordinator);
  const worker = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: worker });
  await assert.rejects(beginCoordinatorTurn(root.rootHandle, coordinator), err => err.code === 'ROOT_LIMIT');
  await endRootTask(root.rootHandle, worker);
  await beginCoordinatorTurn(root.rootHandle, coordinator);
  await assert.rejects(
    reserveRootTask(root.rootHandle, { taskHandle: createTaskHandle(), coordinator: true }),
    err => err.code === 'ROOT_LIMIT',
  );
});

test('a continuing coordinator owns its session from its reservation on', async () => {
  const root = await createRoot();
  const first = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: first, coordinator: true });
  await bindRootTask(root.rootHandle, first, 'syn_sess_owner');
  await endRootTask(root.rootHandle, first);
  await reserveRootTask(root.rootHandle, { taskHandle: createTaskHandle(), coordinator: true, continues: 'syn_sess_owner' });
  await assert.rejects(
    reserveRootTask(root.rootHandle, { taskHandle: createTaskHandle(), coordinator: true, continues: 'syn_sess_owner' }),
    err => err.code === 'SESSION_BUSY',
  );
});

test('a continued worker is no further child of its parent', async () => {
  const root = await createRoot({ maxChildren: 2 });
  const parent = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: parent });
  const child = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: child, parentTask: parent });
  await bindRootTask(root.rootHandle, child, 'syn_sess_child');
  await endRootTask(root.rootHandle, child);
  const again = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: again, parentTask: parent, continues: 'syn_sess_child' });
  await endRootTask(root.rootHandle, again);
  const second = createTaskHandle();
  await reserveRootTask(root.rootHandle, { taskHandle: second, parentTask: parent });
  await endRootTask(root.rootHandle, second);
  await assert.rejects(
    reserveRootTask(root.rootHandle, { taskHandle: createTaskHandle(), parentTask: parent }),
    err => err.code === 'ROOT_LIMIT',
  );
});

test('a failed ledger write stops the workers it started', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WORKERS_HANG = '1';
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }, { id: 'two', task: 'WRITE b/new.txt', scope: ['b'] }), finish());
    const started = await coordinate(repo);
    // The next write replaces the record: a directory in its place makes that fail.
    const dir = path.join(process.env.coagent8_DIR, 'delegations', 'coordinations');
    const deadline = Date.now() + 15000;
    let names = [];
    while (!names.length) {
      assert.ok(Date.now() < deadline, 'the request was stored');
      names = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(name => readCoordinationFile(path.join(dir, name)) === started.sessionHandle)
        : [];
      await delay(5);
    }
    const file = path.join(dir, names[0]);
    fs.rmSync(file);
    fs.mkdirSync(file);
    const task = await ended(started.taskHandle, 40000);
    assert.equal(task.state, 'failed', task.result?.text);
    for (const worker of readRoot(started.rootHandle).tasks.filter(entry => !entry.coordinator)) {
      assert.notEqual(readTask(worker.taskHandle)?.state, 'running');
    }
    assert.equal(fs.existsSync(path.join(repo, 'b', 'new.txt')), false, 'the next worker did not start');
    fs.rmSync(file, { recursive: true, force: true });
  } finally {
    delete process.env.CODEX_FIXTURE_WORKERS_HANG;
  }
});

function readCoordinationFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).sessionHandle;
  } catch {
    return null;
  }
}

test('reports stay untold until a turn has ended, and an error turn still lists the workers', async () => {
  const repo = fixtureRepo();
  script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish('Never read'));
  const started = await coordinate(repo);
  await ended(started.taskHandle);
  const ledger = readCoordination(started.sessionHandle);
  assert.equal(ledger.children[0].reported, true, 'a turn that ended was told');
  // Told, then lost: a continuation whose turn fails keeps what it was to be told.
  ledger.children[0].reported = false;
  await writeCoordination(ledger);
  process.env.CODEX_FIXTURE_MODE = 'auth';
  try {
    const failed = await coordinate(repo, { task: 'Go on', session_handle: started.sessionHandle });
    const task = await ended(failed.taskHandle);
    assert.equal(task.state, 'failed', task.result?.text);
    assert.match(task.result.text, /- one: completed/);
    assert.equal(readCoordination(started.sessionHandle).children[0].reported, false);
  } finally {
    delete process.env.CODEX_FIXTURE_MODE;
  }
});

test('a cancel reaches a coordinator through its root, as from another server', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WORKERS_HANG = '1';
  try {
    script(start({ id: 'one', task: 'WRITE a/new.txt', scope: ['a'] }), finish());
    const started = await coordinate(repo);
    const deadline = Date.now() + 15000;
    while (!readRoot(started.rootHandle).tasks.some(entry => !entry.coordinator && entry.sessionHandle)) {
      assert.ok(Date.now() < deadline, 'the worker started');
      await delay(25);
    }
    assert.equal(await requestCoordinatorCancel(started.sessionHandle), true);
    const task = await ended(started.taskHandle);
    assert.equal(task.state, 'cancelled', task.result?.text);
    assert.equal(await requestCoordinatorCancel(started.sessionHandle), false, 'it has ended');
    assert.equal(await requestCoordinatorCancel('syn_sess_nobody'), false);
    const worker = readRoot(started.rootHandle).tasks.find(entry => !entry.coordinator);
    assert.equal(readTask(worker.taskHandle).state, 'cancelled');
  } finally {
    delete process.env.CODEX_FIXTURE_WORKERS_HANG;
  }
});

test('one answer asks for a bounded number of children, and the closing fence wins over a leading brace', () => {
  const many = Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, task: 'x' }));
  assert.throws(() => parseCoordinatorAnswer(start(...many), []), /at most 64/);
  const answer = `{not json} then a plan\n${fence({ action: 'finish', report: 'done' })}`;
  assert.equal(parseCoordinatorAnswer(answer, []).report, 'done');
});

test('agy cannot coordinate, named or chosen', async () => {
  const repo = fixtureRepo();
  await assert.rejects(
    handleDelegate({ task: 'x', coordinate: true, backend: 'agy' }, repo, null, null, approve),
    err => err.code === 'POLICY_DENIED',
  );
  const fixture = path.resolve(__dirname, '../../fixtures/agy-cli/agy.cjs');
  process.env.AGY_PATH = fixture;
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  try {
    const answer = await handleDelegate({ task: 'x', coordinate: true }, repo, null, null, approve).catch(err => err);
    const text = answer instanceof Error ? answer.message : answer.content.map(part => part.text).join('\n');
    assert.match(text, /agy cannot coordinate/);
  } finally {
    delete process.env.AGY_PATH;
    await saveConfig({ ...CONFIG, rootLimits: {} });
  }
});
