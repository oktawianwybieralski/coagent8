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
const { readRoot, createRoot, reserveRootTask } = require('../../../src/sessions/roots.ts');
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

test('a coordinator holds no place: one running worker fits a limit of one, and siblings run in turn', async () => {
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
