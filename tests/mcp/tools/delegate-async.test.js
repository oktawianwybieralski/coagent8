const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// DELEGATE-001e: delegate returns once the backend turn runs, and a task-owned operation holds the
// writer until the result is persisted.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-delegate-async-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
// Never the user's own notes.
process.env.coagent8_END_NOTES_DIR = path.join(tempDir, 'notes');
process.env.CODEX_PATH = path.resolve(__dirname, '../../fixtures/codex-cli/codex.cjs');
process.env.CODEX_FIXTURE_CAPTURE = path.join(tempDir, 'capture.json');
process.env.CODEX_CONFIG_PATH = path.join(tempDir, 'config.toml');
const { handleDelegate, waitCommand } = require('../../../src/mcp/tools/delegate.tool.ts');
const { handleSession, handleCancelSession } = require('../../../src/mcp/tools/session.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
require('../../../src/execution/controller.ts').composeExecutionCancellation();
const { ownProcessIdentity } = require('../../../src/sessions/activity.ts');
const { readTask, writeFinalTask, writeTask, createTaskHandle, pruneTasks } = require('../../../src/sessions/tasks.ts');
const { runWaitCli } = require('../../../src/sessions/wait-cli.ts');
const { WRITER_RECORD_FILE } = require('../../../src/sessions/writer.ts');
test.after(async () => {
  await stopActiveDelegations();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const approve = { askConsent: async () => ({ approved: true, remember: false }) };
const MODEL = 'gpt-6.1-sol';
const REQUEST = { task: 'Add a file', backend: 'codex', model: MODEL };

let repos = 0;
function fixtureRepo() {
  const repo = path.join(tempDir, `repo-${++repos}`);
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return repo;
}
const writerRecord = repo => path.join(repo, '.git', WRITER_RECORD_FILE);
async function finished(handle) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const task = readTask(handle);
    if (task.state !== 'running') return task;
    assert.ok(Date.now() < deadline, 'the task finished in time');
    await delay(25);
  }
}
const stream = () => {
  const chunks = [];
  return { write: chunk => chunks.push(String(chunk)), text: () => chunks.join('') };
};

test.beforeEach(async () => {
  await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
  delete process.env.CODEX_FIXTURE_MODE;
  delete process.env.CODEX_FIXTURE_WRITES;
});

test('delegate returns the task while the worker runs, then the result carries the observed changes', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_WRITES = JSON.stringify({ 'new.ts': 'export const n = 1;\n' });
  const started = await handleDelegate(REQUEST, repo, null, null, { ...approve, clientName: 'claude-code' });
  const { taskHandle, sessionHandle, wakeup, waitArgv } = started.structuredContent;
  assert.match(taskHandle, /^task_[a-f0-9]{32}$/);
  assert.match(sessionHandle, /^syn_sess_/);
  assert.equal(wakeup, 'background_wait');
  assert.deepEqual(waitArgv.slice(-6), ['wait', '--data-dir', process.env.coagent8_DIR, '--notes-dir', endNotesDir(), taskHandle]);
  assert.match(started.content[0].text, /Start wait_argv now as a background command/);

  const task = await finished(taskHandle);
  assert.equal(task.state, 'completed');
  assert.equal(task.sessionHandle, sessionHandle);
  assert.match(task.result.text, /Observed by CoAgent8/);
  assert.match(task.result.text, /new\.ts/);

  const read = await handleSession({ action: 'task', task_handle: taskHandle }, repo);
  assert.match(read.content[0].text, /state: completed/);
  assert.match(read.content[0].text, /new\.ts/);

  // The writer slot is free once the result is there: the next delegation starts.
  const deadline = Date.now() + 5000;
  while (fs.existsSync(writerRecord(repo)) && Date.now() < deadline) await delay(25);
  assert.equal(fs.existsSync(writerRecord(repo)), false);
});

test('a client without an observed wake-up gets the same task and no promise of a wake-up', async () => {
  const repo = fixtureRepo();
  const started = await handleDelegate(REQUEST, repo, null, null, { ...approve, clientName: 'codex-mcp-client' });
  assert.equal(started.structuredContent.wakeup, 'none');
  assert.match(started.content[0].text, /session tool, action task, or run wait_argv/);
  await finished(started.structuredContent.taskHandle);
});

test('a refusal before the turn is the call error, and no task is left behind', async () => {
  const repo = fixtureRepo();
  await saveConfig({ governance: { models: { deny: [MODEL] } } });
  await assert.rejects(handleDelegate(REQUEST, repo, null, null, approve), /denied|POLICY_DENIED|not allowed/i);
  assert.equal(fs.existsSync(writerRecord(repo)), false, 'the writer was released');
  await saveConfig({ governance: { models: { deny: [] } } });
  await assert.rejects(handleDelegate(REQUEST, path.join(tempDir), null, null, approve), /Git work tree/);
});

test('the worker holds the writer: a second start is refused, and cancel ends the task with evidence', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const started = await handleDelegate(REQUEST, repo, null, null, approve);
  const { taskHandle, sessionHandle } = started.structuredContent;
  assert.equal(readTask(taskHandle).state, 'running');
  assert.equal(fs.existsSync(writerRecord(repo)), true);
  await assert.rejects(handleDelegate(REQUEST, repo, null, null, approve), /Another delegate call/);

  const running = await handleSession({ action: 'task', task_handle: taskHandle }, repo);
  assert.match(running.content[0].text, /still running/);

  await handleCancelSession({ session_handle: sessionHandle, workspace_path: repo });
  const task = await finished(taskHandle);
  assert.equal(task.state, 'cancelled');
  assert.match(task.result.text, /Observed by CoAgent8/);
});

test('a task read right after cancel returns is never running (#136)', async () => {
  for (let i = 0; i < 3; i++) {
    const repo = fixtureRepo();
    process.env.CODEX_FIXTURE_MODE = 'interruptible';
    const started = await handleDelegate(REQUEST, repo, null, null, approve);
    const { taskHandle, sessionHandle } = started.structuredContent;
    const cancelled = await handleCancelSession({ session_handle: sessionHandle, workspace_path: repo });
    assert.equal(cancelled.structuredContent.cancelled, true);
    const read = await handleSession({ action: 'task', task_handle: taskHandle }, repo);
    assert.equal(read.structuredContent.state, 'cancelled', `round ${i}`);
    assert.doesNotMatch(read.content[0].text, /still running/);
  }
});

test('the request ending after the start does not stop the worker', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const request = new AbortController();
  const started = await handleDelegate(REQUEST, repo, request.signal, null, approve);
  request.abort();
  await delay(300);
  const { taskHandle, sessionHandle } = started.structuredContent;
  assert.equal(readTask(taskHandle).state, 'running');
  await handleCancelSession({ session_handle: sessionHandle, workspace_path: repo });
  assert.equal((await finished(taskHandle)).state, 'cancelled');
});

test('a request cancelled before the turn starts stops the start', async () => {
  const repo = fixtureRepo();
  const request = new AbortController();
  request.abort();
  await assert.rejects(handleDelegate(REQUEST, repo, request.signal, null, approve), /cancel|abort/i);
  assert.equal(fs.existsSync(writerRecord(repo)), false);
});

test('the deadline of the call bounds a delegation from its first Git read', async () => {
  const repo = fixtureRepo();
  await assert.rejects(handleDelegate({ ...REQUEST, timeout_ms: 1 }, repo, null, null, approve), /budget expired/);
  assert.equal(fs.existsSync(writerRecord(repo)), false);
});

test('timeout_ms also ends a running delegation', async () => {
  const repo = fixtureRepo();
  // Long enough that Git under a full test run does not spend the budget before the turn.
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const started = await handleDelegate({ ...REQUEST, timeout_ms: 5000 }, repo, null, null, approve);
  const task = await finished(started.structuredContent.taskHandle);
  assert.equal(task.state, 'timed_out');
  assert.match(task.result.text, /Observed by CoAgent8/);
});

test('a repeated start with the same request id returns the existing task', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const first = await handleDelegate({ ...REQUEST, request_id: 'r1' }, repo, null, null, approve);
  const second = await handleDelegate({ ...REQUEST, request_id: 'r1' }, repo, null, null, approve);
  assert.equal(second.structuredContent.taskHandle, first.structuredContent.taskHandle);
  await handleCancelSession({ session_handle: first.structuredContent.sessionHandle, workspace_path: repo });
  await finished(first.structuredContent.taskHandle);
  const third = await handleDelegate({ ...REQUEST, request_id: 'r1' }, repo, null, null, approve);
  assert.match(third.content[0].text, /already finished/);
});

test('a request id reused for another delegation is refused', async () => {
  const repo = fixtureRepo();
  const first = await handleDelegate({ ...REQUEST, request_id: 'r2' }, repo, null, null, approve);
  await finished(first.structuredContent.taskHandle);
  await assert.rejects(handleDelegate({ ...REQUEST, task: 'Something else', request_id: 'r2' }, repo, null, null, approve), /already used/);
});

test('a final state appears only after the writer is free, so a woken caller can delegate again', async () => {
  const repo = fixtureRepo();
  const first = await handleDelegate(REQUEST, repo, null, null, approve);
  await finished(first.structuredContent.taskHandle);
  assert.equal(fs.existsSync(writerRecord(repo)), false);
  const second = await handleDelegate(REQUEST, repo, null, null, approve);
  await finished(second.structuredContent.taskHandle);
});

test('a task that cannot be recorded does not start, and the writer is released', async () => {
  const repo = fixtureRepo();
  const store = path.join(process.env.coagent8_DIR, 'delegations');
  const kept = `${store}.kept`;
  fs.renameSync(store, kept);
  fs.writeFileSync(store, 'not a directory');
  try {
    const result = await handleDelegate(REQUEST, repo, null, null, approve);
    assert.equal(result.structuredContent?.taskHandle, undefined);
    assert.equal(result.isError, true);
    assert.equal(fs.existsSync(writerRecord(repo)), false);
  } finally {
    fs.rmSync(store, { force: true });
    fs.renameSync(kept, store);
  }
});

test('the final result names a writer slot that could not be released', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const started = await handleDelegate(REQUEST, repo, null, null, approve);
  // A damaged record is left for the user, so the release fails.
  fs.writeFileSync(writerRecord(repo), 'damaged');
  await handleCancelSession({ session_handle: started.structuredContent.sessionHandle, workspace_path: repo });
  const task = await finished(started.structuredContent.taskHandle);
  assert.match(task.result.text, /writer slot was not released/);
  fs.rmSync(writerRecord(repo), { force: true });
});

test('server shutdown stops a running delegation and awaits its result and release', async () => {
  const repo = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const started = await handleDelegate(REQUEST, repo, null, null, approve);
  await stopActiveDelegations();
  const task = readTask(started.structuredContent.taskHandle);
  assert.notEqual(task.state, 'running');
  assert.equal(fs.existsSync(writerRecord(repo)), false);
});

test('coagent8 wait prints the result and exits by state, and a timed-out wait leaves the worker alone', async () => {
  const running = {
    schemaVersion: 1,
    taskHandle: createTaskHandle(),
    state: 'running',
    workspace: tempDir,
    sessionHandle: 'syn_sess_x',
    backend: 'codex',
    model: MODEL,
    serverPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeTask(running);
  let out = stream();
  let err = stream();
  assert.equal(await runWaitCli([running.taskHandle, '--timeout-ms', '0'], out, err), 1);
  assert.match(err.text(), /still running; the worker goes on/);
  assert.equal(readTask(running.taskHandle).state, 'running');

  await writeTask({ ...running, state: 'completed', result: { text: 'THE REPORT', isError: false } });
  out = stream();
  assert.equal(await runWaitCli([running.taskHandle, '--data-dir', process.env.coagent8_DIR], out, stream()), 0);
  assert.match(out.text(), /state: completed/);
  assert.match(out.text(), /THE REPORT/);

  await writeTask({ ...running, state: 'failed', result: { text: 'BROKE', isError: true } });
  assert.equal(await runWaitCli([running.taskHandle], stream(), stream()), 1);

  err = stream();
  assert.equal(await runWaitCli(['task_' + '0'.repeat(32)], stream(), err), 1);
  assert.match(err.text(), /No task/);
  assert.equal(await runWaitCli([], stream(), stream()), 2);
  assert.equal(await runWaitCli(['../../secret'], stream(), stream()), 2, 'a handle is no path');
});

test('a wait command starts this runtime with the store of this server', () => {
  const { argv } = waitCommand('task_' + '0'.repeat(32));
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[2], 'wait');
  assert.equal(argv[4], process.env.coagent8_DIR);
});

test('a final record survives failed writes: first retried, then as a short note', async () => {
  const task = {
    schemaVersion: 1,
    taskHandle: createTaskHandle(),
    state: 'completed',
    workspace: tempDir,
    sessionHandle: 'syn_sess_x',
    backend: 'codex',
    model: MODEL,
    serverPid: process.pid,
    startedAt: new Date().toISOString(),
    result: { text: 'x'.repeat(100), isError: false },
  };
  const failing = failures => {
    const written = [];
    let calls = 0;
    return {
      written,
      write: async record => {
        if (++calls <= failures) throw new Error('disk');
        written.push(record);
      },
    };
  };
  const retried = failing(2);
  assert.equal(await writeFinalTask(task, retried.write), true);
  assert.equal(retried.written[0].state, 'completed', 'a retry keeps the full result');

  const noted = failing(3);
  assert.equal(await writeFinalTask(task, noted.write), true);
  assert.equal(noted.written[0].state, 'failed');
  assert.match(noted.written[0].result.text, /could not be stored/);

  assert.equal(await writeFinalTask(task, failing(4).write), true, 'the end note outside the data directory');
  fs.rmSync(endNote(task.taskHandle));
});

test('the task action shows a stored result only with a final state', async () => {
  const task = {
    schemaVersion: 1,
    taskHandle: createTaskHandle(),
    state: 'running',
    workspace: tempDir,
    sessionHandle: 'syn_sess_x',
    backend: 'codex',
    model: MODEL,
    serverPid: process.pid,
    startedAt: new Date().toISOString(),
    result: { text: 'STORED BEFORE THE RELEASE', isError: false },
  };
  await writeTask(task);
  const running = await handleSession({ action: 'task', task_handle: task.taskHandle }, tempDir);
  assert.doesNotMatch(running.content[0].text, /STORED/);
  assert.equal(running.structuredContent.result, undefined);
  await writeTask({ ...task, state: 'completed' });
  const done = await handleSession({ action: 'task', task_handle: task.taskHandle }, tempDir);
  assert.match(done.content[0].text, /STORED/);
});

test('a running task of a dead server reads as interrupted; old finished tasks are removed', async () => {
  const base = {
    schemaVersion: 1,
    workspace: tempDir,
    sessionHandle: 'syn_sess_x',
    backend: 'codex',
    model: MODEL,
    startedAt: new Date().toISOString(),
  };
  const dead = { ...base, taskHandle: createTaskHandle(), state: 'running', serverPid: 2 ** 22 + 1 };
  await writeTask(dead);
  assert.equal(readTask(dead.taskHandle).state, 'interrupted');
  const out = stream();
  assert.equal(await runWaitCli([dead.taskHandle], out, stream()), 1);
  assert.match(out.text(), /may still be running/);

  // A result stored before the server died is not presented as final.
  const stored = { ...dead, taskHandle: createTaskHandle(), result: { text: 'STORED', isError: false } };
  await writeTask(stored);
  const interrupted = await handleSession({ action: 'task', task_handle: stored.taskHandle }, tempDir);
  assert.equal(interrupted.isError, true);
  assert.match(interrupted.content[0].text, /state: interrupted[\s\S]*may still be running[\s\S]*not final[\s\S]*STORED/);

  const old = { ...base, taskHandle: createTaskHandle(), state: 'completed', serverPid: process.pid };
  const live = { ...base, taskHandle: createTaskHandle(), state: 'running', serverPid: process.pid };
  await writeTask(old);
  await writeTask(live);
  pruneTasks(Date.now() + 8 * 24 * 3600 * 1000);
  assert.equal(readTask(old.taskHandle), null);
  assert.equal(readTask(live.taskHandle).state, 'running', 'a running task stays');
});

const endNotesDir = () => process.env.coagent8_END_NOTES_DIR;
const endNote = handle => {
  const name = fs.readdirSync(endNotesDir()).find(entry => entry.startsWith(`${handle}-`));
  return name ? path.join(endNotesDir(), name) : path.join(endNotesDir(), 'none');
};

test(
  'a notes directory that is linked or open to others is not trusted',
  { skip: process.platform === 'win32' ? 'POSIX modes and links' : false },
  async () => {
    const previous = process.env.coagent8_END_NOTES_DIR;
    const dir = path.join(tempDir, 'notes-under-test');
    process.env.coagent8_END_NOTES_DIR = dir;
    const task = {
      schemaVersion: 1,
      taskHandle: createTaskHandle(),
      state: 'completed',
      workspace: tempDir,
      sessionHandle: 's',
      backend: 'codex',
      model: 'm',
      serverPid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const refused = async () => {
      throw new Error('disk full');
    };
    try {
      const target = fs.mkdtempSync(path.join(tempDir, 'elsewhere-'));
      fs.symlinkSync(target, dir);
      assert.equal(await writeFinalTask(task, refused), false);
      assert.deepEqual(fs.readdirSync(target), [], 'nothing was written through the link');
      fs.rmSync(dir);
      fs.mkdirSync(dir, { mode: 0o755 });
      fs.chmodSync(dir, 0o755);
      assert.equal(await writeFinalTask(task, refused), false, 'open to other users');
      fs.rmSync(dir, { recursive: true });
      assert.equal(await writeFinalTask(task, refused), true, 'a private one of its own');
    } finally {
      process.env.coagent8_END_NOTES_DIR = previous;
    }
  },
);

test('a final state that cannot be stored in the data directory still reaches a reader', async () => {
  const taskHandle = createTaskHandle();
  const task = {
    schemaVersion: 1,
    taskHandle,
    state: 'completed',
    workspace: tempDir,
    sessionHandle: 's',
    backend: 'codex',
    model: 'm',
    serverPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeTask({ ...task, state: 'running' });
  const refused = async () => {
    throw new Error('disk full');
  };
  assert.equal(await writeFinalTask(task, refused), true);
  const read = readTask(taskHandle);
  assert.equal(read.state, 'failed');
  assert.match(read.result.text, /could not be stored/);
  await writeTask({ ...task, state: 'running', startedAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(readTask(taskHandle).state, 'running', 'a note of an earlier task with this handle does not count');
  assert.equal(fs.existsSync(endNote(taskHandle)), false, 'and starting that task removed it');
});

test('a running task whose PID now names a later process reads as interrupted', async () => {
  const taskHandle = createTaskHandle();
  await writeTask({
    schemaVersion: 1,
    taskHandle,
    state: 'running',
    workspace: tempDir,
    sessionHandle: 's',
    backend: 'codex',
    model: 'm',
    serverPid: process.pid,
    serverIdentity: `${ownProcessIdentity()}-earlier`,
    startedAt: new Date().toISOString(),
  });
  assert.equal(readTask(taskHandle).state, 'interrupted');
});

test('a waiter reads the end note from the directory the server named', async () => {
  const taskHandle = createTaskHandle();
  const task = {
    schemaVersion: 1,
    taskHandle,
    state: 'completed',
    workspace: tempDir,
    sessionHandle: 's',
    backend: 'codex',
    model: 'm',
    serverPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeTask({ ...task, state: 'running' });
  await writeFinalTask(task, async () => {
    throw new Error('disk full');
  });
  const named = endNotesDir();
  process.env.coagent8_END_NOTES_DIR = path.join(tempDir, 'the-shell-of-the-client-points-elsewhere');
  let text = '';
  const out = { write: chunk => (text += chunk) };
  try {
    assert.equal(await runWaitCli([taskHandle, '--notes-dir', named, '--timeout-ms', '0'], out, out), 1);
    assert.match(text, /could not be stored/);
  } finally {
    process.env.coagent8_END_NOTES_DIR = named;
  }
  fs.rmSync(endNote(taskHandle));
});

test('pruning end notes removes old notes and nothing else in that directory', () => {
  const dir = endNotesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const note = path.join(dir, `task_${'a'.repeat(32)}-${'b'.repeat(16)}.json`);
  const other = path.join(dir, 'a-file-of-the-user.txt');
  for (const file of [note, other]) {
    fs.writeFileSync(file, '{}');
    fs.utimesSync(file, old, old);
  }
  pruneTasks();
  assert.equal(fs.existsSync(note), false);
  assert.equal(fs.existsSync(other), true);
  fs.rmSync(other);
});
