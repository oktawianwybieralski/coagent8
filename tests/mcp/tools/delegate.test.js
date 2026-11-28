const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

// DELEGATE-001w: a workspace-write turn with one writer per workspace and the Git changes the
// server observed, reported apart from the worker's answer.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-delegate-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
process.env.CODEX_PATH = path.resolve(__dirname, '../../fixtures/codex-cli/codex.cjs');
process.env.CODEX_FIXTURE_CAPTURE = path.join(tempDir, 'capture.json');
process.env.CODEX_CONFIG_PATH = path.join(tempDir, 'config.toml');
const { handleDelegate: startDelegate, delegatePrompt } = require('../../../src/mcp/tools/delegate.tool.ts');
// Most tests here cover the synchronous contract; delegate-async.test.js covers the default.
const handleDelegate = (args, ...rest) => startDelegate({ mode: 'sync', ...args }, ...rest);
const { handleConsult } = require('../../../src/mcp/tools/consult.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { acquireWriterLease, WRITER_RECORD_FILE } = require('../../../src/sessions/writer.ts');
const { isProcessGroupAlive, isRecordedProcessAlive, processIdentity } = require('../../../src/sessions/activity.ts');
const {
  normalizeScopeEntry,
  inScope,
  readWorkspaceRepository,
  captureWorkspace,
  compareWorkspace,
} = require('../../../src/workspace/changes.ts');
const { codexAppServerArgs, codexSandboxMismatch } = require('../../../src/backends/codex/app-server.ts');
const { claudeTurnSettings, CLAUDE_TOOLS } = require('../../../src/backends/claude/adapter.ts');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const approve = { askConsent: async () => ({ approved: true, remember: false }) };
const MODEL = 'gpt-6.1-sol';
const text = result => result.content.map(part => part.text).join('\n');
const capture = () => JSON.parse(fs.readFileSync(process.env.CODEX_FIXTURE_CAPTURE, 'utf8'));

let repos = 0;
function fixtureRepo() {
  const repo = path.join(tempDir, `repo-${++repos}`);
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { repo, git };
}

test.beforeEach(async () => {
  await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
  delete process.env.CODEX_FIXTURE_MODE;
  delete process.env.CODEX_FIXTURE_WRITES;
});

test('delegate runs a verified full-access Codex turn and reports the observed changes apart from the answer', async () => {
  const { repo } = fixtureRepo();
  // The user's uncommitted work before the turn.
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  process.env.CODEX_FIXTURE_WRITES = JSON.stringify({
    'src/new.ts': 'export const n = 1;\n',
    'a.ts': 'export const a = 3;\n',
    'gone.txt': null,
    'src-old/x.ts': 'x\n',
  });
  const result = await handleDelegate(
    { task: 'Add src/new.ts', scope: ['src'], checks: ['npm test'], backend: 'codex', model: MODEL },
    repo,
    null,
    null,
    approve,
  );
  assert.equal(result.isError, false, text(result));
  const out = text(result);
  assert.match(out, /Observed by CoAgent8/);
  assert.match(out, /^A src\/new\.ts$/m);
  assert.match(out, /^M a\.ts$/m);
  assert.match(out, /^D gone\.txt$/m);
  assert.match(out, /^A src-old\/x\.ts$/m);
  assert.match(out, /changed outside scope: a\.ts, gone\.txt, src-old\/x\.ts/, 'scope matches whole path segments');
  assert.match(out, /already had uncommitted changes before the turn: a\.ts/);
  const { args, records, prompt } = capture();
  for (const setting of ['sandbox_mode="danger-full-access"', 'approval_policy="never"']) assert.ok(args.includes(setting), setting);
  assert.ok(!args.some(arg => arg.startsWith('sandbox_workspace_write')), 'no workspace-write overrides (#211)');
  const start = records.find(r => r.method === 'thread/start').params;
  assert.equal(start.sandbox, 'danger-full-access');
  assert.equal(start.approvalPolicy, 'never');
  assert.ok(records.some(r => r.method === 'turn/start'));
  assert.match(prompt, /Change only: src\./);
  assert.match(prompt, /Do not commit, push, reset, stash/);
  assert.match(prompt, /CHECKS:\n- npm test/);
  assert.equal(fs.existsSync(path.join(repo, '.git', WRITER_RECORD_FILE)), false, 'the writer slot is released');
});

test('a thread that does not report full access starts no turn (#211)', async () => {
  const { repo } = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'sandbox-readonly';
  const result = await handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve);
  assert.equal(result.isError, true);
  assert.match(text(result), /SANDBOX_UNAVAILABLE/);
  assert.ok(!capture().records.some(r => r.method === 'turn/start'), 'no turn starts');
  assert.match(
    text(result),
    /No tracked or untracked file changed \(Git-ignored files and changes inside submodules are not observed\)\./,
    'the observed block still follows a failed turn',
  );
});

test('codexSandboxMismatch requires full access without approvals, and every launch asks for it', () => {
  assert.equal(codexSandboxMismatch({ sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' }), null);
  assert.match(codexSandboxMismatch({ sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }), /danger-full-access/);
  assert.match(codexSandboxMismatch({ sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'never' }), /danger-full-access/);
  assert.match(codexSandboxMismatch({ sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'on-request' }), /approvals/);
  assert.ok(codexAppServerArgs().includes('sandbox_mode="danger-full-access"'));
  assert.ok(!codexAppServerArgs().some(arg => arg.startsWith('sandbox_workspace_write') || arg.startsWith('windows.sandbox')));
});
test('one writer per work tree: a second delegate is refused at once, a dead owner is taken over', async () => {
  const { repo } = fixtureRepo();
  const gitDir = path.join(repo, '.git');
  const recordPath = path.join(gitDir, WRITER_RECORD_FILE);
  const held = await acquireWriterLease(gitDir);
  await assert.rejects(
    handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve),
    /SESSION_BUSY|Another delegate call/,
  );
  await held.release();
  // A record left by a process that has exited.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const lease = await acquireWriterLease(gitDir);
  fs.writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(recordPath, 'utf8')), pid: dead, token: 'someone-else' }));
  await lease.release();
  assert.ok(fs.existsSync(recordPath), "a release never removes another call's record");
  const taken = await acquireWriterLease(gitDir);
  await taken.release();
  assert.equal(fs.existsSync(recordPath), false);
});

test('the writer slot holds across server processes with different data directories', async () => {
  const { repo } = fixtureRepo();
  const gitDir = path.join(repo, '.git');
  // Another client's server: its own process and its own CoAgent8 data directory.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `require('tsx/cjs');
    require(${JSON.stringify(path.resolve(__dirname, '../../../src/sessions/writer.ts'))}).acquireWriterLease(${JSON.stringify(gitDir)})
      .then(() => console.log('held'));
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`,
    ],
    {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, coagent8_DIR: path.join(tempDir, 'other-client') },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.on('data', chunk => String(chunk).includes('held') && resolve());
      holder.once('exit', reject);
    });
    await assert.rejects(
      handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve),
      /Another delegate call/,
    );
  } finally {
    holder.stdin.end();
    await new Promise(resolve => holder.once('exit', resolve));
  }
});

test('delegate refuses a workspace outside Git and a scope that leaves the workspace', async () => {
  const plain = path.join(tempDir, 'plain');
  fs.mkdirSync(plain);
  await assert.rejects(
    handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, plain, null, null, approve),
    /needs a Git work tree/,
  );
  const { repo } = fixtureRepo();
  for (const scope of ['../other', path.resolve(repo, 'src'), 'C:/x']) {
    await assert.rejects(
      handleDelegate({ task: 'Change it', scope: [scope], backend: 'codex', model: MODEL }, repo, null, null, approve),
      /absolute or leaves the workspace/,
      scope,
    );
  }
  await assert.rejects(handleDelegate({ task: '   ', backend: 'codex', model: MODEL }, repo, null, null, approve), /task is required/);
});

test('a read-only session cannot run a write turn and a delegate session cannot run a read-only one', async () => {
  const { repo } = fixtureRepo();
  const consult = await handleConsult('consult', { proposal: 'Question?', backend: 'codex', model: MODEL }, repo, null, null, approve);
  const readOnlyHandle = /session_handle=(\S+)/.exec(text(consult))[1];
  await assert.rejects(
    handleDelegate({ task: 'Change it', session_handle: readOnlyHandle, model: MODEL }, repo, null, null, approve),
    /This session is read-only/,
  );
  const delegated = await handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve);
  const writeHandle = /session_handle=(\S+)/.exec(text(delegated))[1];
  await assert.rejects(
    handleConsult('consult', { proposal: 'Question?', session_handle: writeHandle, model: MODEL }, repo, null, null, approve),
    /belongs to delegate/,
  );
  const again = await handleDelegate({ task: 'Fix it', session_handle: writeHandle, model: MODEL }, repo, null, null, approve);
  assert.equal(again.isError, false, 'a delegate session continues with delegate');
});

test('compareWorkspace sees staged-only changes and committed files, and scope entries normalize', async () => {
  const { repo, git } = fixtureRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  git('add', 'a.ts');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n');
  const repository = await readWorkspaceRepository(repo);
  const before = await captureWorkspace(repo, repository);
  // Only the staged blob changes; the working file and its status stay the same.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    input: 'export const a = 9;\n',
    encoding: 'utf8',
  }).trim();
  git('update-index', '--cacheinfo', `100644,${blob},a.ts`);
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  git('add', 'src/b.ts');
  git('commit', '-qm', 'worker commit', '--', 'src/b.ts');
  const changes = await compareWorkspace(repo, repository, before, await captureWorkspace(repo, repository), []);
  assert.deepEqual(
    changes.changed.map(c => `${c.kind} ${c.path}`),
    ['modified a.ts', 'modified src/b.ts'],
  );
  assert.equal(changes.headMoved.commits, 1);
  assert.deepEqual(changes.dirtyBefore, ['a.ts']);
  assert.equal(normalizeScopeEntry('./src/'), 'src');
  assert.equal(normalizeScopeEntry('src\\lib'), 'src/lib');
  assert.equal(normalizeScopeEntry('.'), '');
  assert.equal(normalizeScopeEntry('../x'), null);
  assert.equal(inScope('src-old/x.ts', ['src']), false);
  assert.equal(inScope('src/x.ts', ['src']), true);
});

test('every Claude and agy turn gets the host tools (#211)', async () => {
  assert.deepEqual([...CLAUDE_TOOLS], ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']);
  assert.deepEqual(JSON.parse(claudeTurnSettings()), { disableAllHooks: true, permissions: { allow: [...CLAUDE_TOOLS] } });
  const { executeClaude } = require('../../../src/backends/claude/adapter.ts');
  const claudeCapture = path.join(tempDir, 'claude-capture.json');
  Object.assign(process.env, {
    CLAUDE_PATH: path.resolve(__dirname, '../../fixtures/claude-cli/claude.cjs'),
    CLAUDE_FIXTURE_CAPTURE: claudeCapture,
  });
  const claude = await executeClaude('Change it', { cwd: tempDir, model: 'claude-sonnet-4-5', writeScope: ['src'] });
  assert.equal(claude.isError, false, JSON.stringify(claude.error));
  const argv = JSON.parse(fs.readFileSync(claudeCapture, 'utf8')).argv;
  assert.equal(argv[argv.indexOf('--tools') + 1], CLAUDE_TOOLS.join(','));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(argv.includes('--strict-mcp-config'));
  const { execute: executeAgy } = require('../../../src/backends/agy/adapter.ts');
  const agyCapture = path.join(tempDir, 'agy-capture.json');
  Object.assign(process.env, { AGY_PATH: path.resolve(__dirname, '../../fixtures/agy-cli/agy.cjs'), coagent8_FIXTURE_CAPTURE: agyCapture });
  for (const options of [{ writeScope: ['src'] }, {}]) {
    await executeAgy('Do it', { cwd: tempDir, model: 'gemini-3-flash', ...options });
    const captured = JSON.parse(fs.readFileSync(agyCapture, 'utf8'));
    assert.ok(!captured.args.includes('--sandbox'), 'no agy turn runs in its sandbox');
    assert.ok(captured.args.includes('--dangerously-skip-permissions'), 'headless agy asks for nothing');
    assert.ok(!captured.args.includes('--mode'));
    assert.equal(captured.args[captured.args.indexOf('--add-dir') + 1], tempDir);
    assert.equal(captured.prompt, 'Do it', 'the prompt carries no command ban');
  }
});

test('delegatePrompt without checks asks for the project checks and without scope for the whole workspace', () => {
  const prompt = delegatePrompt('Do it', [], []);
  assert.match(prompt, /Change only: files in this workspace\./);
  assert.match(prompt, /Run the project's relevant tests/);
  assert.doesNotMatch(prompt, /CHECKS:/);
  assert.match(prompt, /do not work around the restriction: report that check as NOT_RUN/);
});

test('evidence before the first commit, for a committed untracked file, a rename and with diff.relative in a subdirectory', async () => {
  // Unborn HEAD: only the staged blob changes.
  const unborn = path.join(tempDir, 'unborn');
  fs.mkdirSync(unborn);
  const g = (...args) => execFileSync('git', args, { cwd: unborn, encoding: 'utf8', windowsHide: true }).trim();
  g('init', '-q');
  g('config', 'user.name', 'Fixture');
  g('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(unborn, 'a.txt'), 'one\n');
  g('add', 'a.txt');
  fs.writeFileSync(path.join(unborn, 'a.txt'), 'two\n');
  let repository = await readWorkspaceRepository(unborn);
  let before = await captureWorkspace(unborn, repository);
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: unborn, input: 'three\n', encoding: 'utf8' }).trim();
  g('update-index', '--cacheinfo', `100644,${blob},a.txt`);
  let changes = await compareWorkspace(unborn, repository, before, await captureWorkspace(unborn, repository), []);
  assert.deepEqual(
    changes.changed.map(c => `${c.kind} ${c.path}`),
    ['modified a.txt'],
    'a staged-only change before the first commit',
  );

  // A committed untracked file still exists; a rename destination is new.
  const { repo, git } = fixtureRepo();
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'n\n');
  repository = await readWorkspaceRepository(repo);
  before = await captureWorkspace(repo, repository);
  git('add', 'notes.txt');
  git('commit', '-qm', 'notes');
  git('mv', 'src/b.ts', 'src/c.ts');
  changes = await compareWorkspace(repo, repository, before, await captureWorkspace(repo, repository), []);
  assert.deepEqual(
    changes.changed.map(c => `${c.kind} ${c.path}`),
    ['modified notes.txt', 'deleted src/b.ts', 'added src/c.ts'],
  );

  // diff.relative=true would print workspace-relative names in a subdirectory workspace.
  git('config', 'diff.relative', 'true');
  const sub = path.join(repo, 'src');
  repository = await readWorkspaceRepository(sub);
  before = await captureWorkspace(sub, repository);
  fs.writeFileSync(path.join(sub, 'c.ts'), 'export const c = 2;\n');
  git('add', 'src/c.ts');
  git('commit', '-qm', 'c');
  changes = await compareWorkspace(sub, repository, before, await captureWorkspace(sub, repository), []);
  // The staged rename of b.ts is committed with c.ts, so b.ts's deletion moved into a commit.
  assert.deepEqual(
    changes.changed.map(c => `${c.kind} ${c.path}`),
    ['deleted b.ts', 'modified c.ts'],
    'committed changes are found with diff.relative set',
  );
});

test('observed paths, diff stats and branch names get diagnostic redaction', () => {
  const { formatObservedChanges } = require('../../../src/mcp/result.ts');
  const out = formatObservedChanges({
    changed: [{ path: 'token=private-value.txt', kind: 'modified' }],
    outsideScope: [],
    dirtyBefore: [],
    truncated: false,
    headMoved: { before: 'a'.repeat(40), after: 'b'.repeat(40), commits: 1, branchBefore: 'main', branchAfter: 'secret=hidden-branch' },
    diffStat: ' token=private-value.txt | 2 +-',
  });
  assert.doesNotMatch(out, /private-value|hidden-branch/);
  assert.match(out, /Git-ignored files and changes inside submodules are not observed/);

  const none = formatObservedChanges({
    changed: [],
    outsideScope: [],
    dirtyBefore: [],
    truncated: false,
  });
  assert.match(none, /No tracked or untracked file changed \(Git-ignored files and changes inside submodules are not observed\)\./);
  assert.doesNotMatch(none, /No file changed\./);
});

test('an unreadable writer record is never overwritten, and a credential at the diff stat limit stays redacted', async () => {
  const { repo } = fixtureRepo();
  const recordPath = path.join(repo, '.git', WRITER_RECORD_FILE);
  fs.writeFileSync(recordPath, '{ not json');
  await assert.rejects(acquireWriterLease(path.join(repo, '.git')), /cannot be read/);
  assert.equal(fs.readFileSync(recordPath, 'utf8'), '{ not json');
  const { formatObservedChanges } = require('../../../src/mcp/result.ts');
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const out = formatObservedChanges({
    changed: [],
    outsideScope: [],
    dirtyBefore: [],
    truncated: false,
    diffStat: `${' x | 1 +\n'.repeat(1800)}${token} | 1 +`,
  });
  assert.ok(!out.includes(token.slice(4, 20)), 'no part of the token survives the length limit');
});

function gitDirFixture() {
  const gitDir = fs.mkdtempSync(path.join(tempDir, 'git-dir-'));
  return { gitDir, record: path.join(gitDir, WRITER_RECORD_FILE) };
}

function endedPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
}

test('the writer slot of an ended server stays taken while a worker group lives, and is free after it', async () => {
  const { gitDir, record } = gitDirFixture();
  fs.writeFileSync(record, JSON.stringify({ pid: endedPid(), token: 'old', startedAt: '2026-11-02T00:00:00.000Z', workerGroups: [4242] }));
  await assert.rejects(
    acquireWriterLease(gitDir, () => true),
    err => {
      assert.equal(err.code, 'SESSION_BUSY');
      assert.match(err.message, /process group 4242/);
      assert.match(err.message, /kill -- -4242/);
      return true;
    },
  );
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).token, 'old', 'a refusal leaves the record');
  const lease = await acquireWriterLease(gitDir, () => false);
  await lease.release();
  assert.equal(fs.existsSync(record), false);
});

test('a lease records worker groups, drops ended ones and writes none after its release', async () => {
  const { gitDir, record } = gitDirFixture();
  const alive = new Set([11]);
  const lease = await acquireWriterLease(gitDir, group => alive.has(group));
  const read = () => JSON.parse(fs.readFileSync(record, 'utf8'));
  for (const group of [11, 12, 13]) {
    lease.workerStarting();
    assert.equal(read().starting, true, 'the record says so before the process starts');
    lease.workerStarted(group);
    assert.equal(read().starting, undefined);
  }
  assert.deepEqual(read().workerGroups, [11, 13]);
  lease.workerStarting();
  lease.workerStarted();
  assert.deepEqual(read().workerGroups, [11], 'a failed start adds none');
  await lease.release();
  assert.throws(() => lease.workerStarting(), /released/);
  assert.equal(fs.existsSync(record), false, 'and a release is final');
});

test('a crash while a worker starts leaves the slot taken, with the way out', async () => {
  const { gitDir, record } = gitDirFixture();
  fs.writeFileSync(record, JSON.stringify({ pid: endedPid(), token: 'old', startedAt: 'x', starting: true }));
  await assert.rejects(acquireWriterLease(gitDir), err => {
    assert.equal(err.code, 'SESSION_BUSY');
    assert.ok(err.message.includes(record), 'it names the file to delete');
    return true;
  });
  fs.rmSync(record);
  await (await acquireWriterLease(gitDir)).release();
});

test('a start mark that cannot be stored stops the worker, and a later failure leaves the mark', async () => {
  const { gitDir, record } = gitDirFixture();
  const lease = await acquireWriterLease(gitDir, () => true);
  const blocker = `${record}.${process.pid}.tmp`;
  const read = () => JSON.parse(fs.readFileSync(record, 'utf8'));

  fs.mkdirSync(blocker);
  assert.throws(() => lease.workerStarting());
  assert.equal(read().starting, undefined, 'nothing started, so nothing is marked');
  fs.rmdirSync(blocker);

  lease.workerStarting();
  fs.mkdirSync(blocker);
  const write = process.stderr.write;
  const warnings = [];
  process.stderr.write = text => warnings.push(String(text)) > 0;
  try {
    lease.workerStarted(21);
  } finally {
    process.stderr.write = write;
  }
  assert.match(warnings.join(''), /writer record was not updated/);
  assert.equal(read().starting, true, 'the mark still refuses takeover');
  fs.rmdirSync(blocker);

  lease.workerStarting();
  lease.workerStarted(22);
  assert.deepEqual(read().workerGroups, [21, 22], 'the next write carries what the failed one lost');
  assert.equal(read().starting, undefined);
  await lease.release();
  assert.equal(fs.existsSync(record), false);
});

test('a malformed list of worker groups is never overwritten', async () => {
  const { gitDir, record } = gitDirFixture();
  fs.writeFileSync(record, JSON.stringify({ pid: endedPid(), token: 'old', startedAt: 'x', workerGroups: ['1'] }));
  await assert.rejects(acquireWriterLease(gitDir), err => err.code === 'SESSION_BUSY' && /cannot be read/.test(err.message));
});

test(
  'a real process group of a dead server keeps the slot until it ends',
  { skip: process.platform === 'win32' ? 'POSIX groups' : false },
  async () => {
    const { gitDir, record } = gitDirFixture();
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    try {
      fs.writeFileSync(record, JSON.stringify({ pid: endedPid(), token: 'old', startedAt: 'x', workerGroups: [worker.pid] }));
      await assert.rejects(acquireWriterLease(gitDir), err => err.code === 'SESSION_BUSY');
    } finally {
      process.kill(-worker.pid, 'SIGKILL');
    }
    await new Promise(resolve => worker.once('exit', resolve));
    const lease = await acquireWriterLease(gitDir);
    await lease.release();
  },
);

test('a delegation records the process group of its worker', { skip: process.platform === 'win32' ? 'POSIX groups' : false }, async () => {
  const { repo } = fixtureRepo();
  process.env.CODEX_FIXTURE_MODE = 'interruptible';
  const record = path.join(repo, '.git', WRITER_RECORD_FILE);
  const running = handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL, timeout_ms: 2000 }, repo, null, null, approve);
  let groups;
  for (let i = 0; i < 100 && !groups?.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    groups = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')).workerGroups : undefined;
  }
  await running.catch(() => {});
  delete process.env.CODEX_FIXTURE_MODE;
  assert.ok(groups?.length, 'the running delegation recorded a group');
  assert.equal(fs.existsSync(record), false, 'and released the slot');
});

test('a reused PID does not hold the writer slot, but a running one does', async () => {
  const { gitDir, record } = gitDirFixture();
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const real = processIdentity(other.pid);
    assert.ok(real, 'the system tells an identity');
    fs.writeFileSync(record, JSON.stringify({ pid: other.pid, pidIdentity: real, token: 'old', startedAt: 'x' }));
    await assert.rejects(acquireWriterLease(gitDir), err => err.code === 'SESSION_BUSY');
    fs.writeFileSync(record, JSON.stringify({ pid: other.pid, pidIdentity: `${real}-earlier`, token: 'old', startedAt: 'x' }));
    await (await acquireWriterLease(gitDir)).release();
    assert.equal(fs.existsSync(record), false);
  } finally {
    other.kill();
  }
});

test('an unknown identity keeps the record alive, and only a fresh read decides that a process is gone', () => {
  assert.equal(
    isRecordedProcessAlive(process.ppid, 'stored', () => null),
    true,
  );
  assert.equal(isRecordedProcessAlive(process.ppid, undefined), true, 'a record without one');
  assert.equal(
    isRecordedProcessAlive(process.ppid, 'stored', () => 'another'),
    false,
  );
  const reads = [];
  const stale = (pid, fresh) => {
    reads.push(Boolean(fresh));
    return fresh ? 'stored' : 'the previous process';
  };
  assert.equal(isRecordedProcessAlive(process.ppid, 'stored', stale), true, 'a cached answer of the previous process');
  assert.deepEqual(reads, [false, true]);
});

test(
  'a server killed during a delegation: no second writer overlaps its worker',
  { skip: process.platform === 'win32' ? 'POSIX groups; on Windows the job helper ends the tree' : false },
  async () => {
    const { repo } = fixtureRepo();
    const gitDir = path.join(repo, '.git');
    const marker = path.join(tempDir, `worker-${Date.now()}.log`);
    // Fixed scripts: the paths reach them through the environment.
    const server = spawn(
      process.execPath,
      [
        '-e',
        `require('tsx/cjs');
        const { spawn } = require('node:child_process');
        require(process.env.WRITER_MODULE).acquireWriterLease(process.env.WRITER_GIT_DIR).then(lease => {
          lease.workerStarting();
          const worker = spawn(process.execPath, ['-e', "setInterval(() => require('fs').appendFileSync(process.env.WORKER_MARKER, 'x'), 50)"], { detached: true, stdio: 'ignore' });
          lease.workerStarted(worker.pid);
          console.log('started ' + worker.pid);
        });
        setInterval(() => {}, 1000);`,
      ],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          ...process.env,
          WRITER_MODULE: path.resolve(__dirname, '../../../src/sessions/writer.ts'),
          WRITER_GIT_DIR: gitDir,
          WORKER_MARKER: marker,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const group = await new Promise((resolve, reject) => {
      server.stdout.on('data', chunk => {
        const match = /started (\d+)/.exec(String(chunk));
        if (match) resolve(Number(match[1]));
      });
      server.once('exit', reject);
    });
    try {
      server.removeAllListeners('exit');
      const gone = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGKILL');
      await gone;
      await new Promise(resolve => setTimeout(resolve, 300));
      const before = fs.statSync(marker).size;
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.ok(fs.statSync(marker).size > before, 'the worker outlived its server and still writes');
      await assert.rejects(acquireWriterLease(gitDir), err => err.code === 'SESSION_BUSY' && err.message.includes(String(group)));
      await assert.rejects(
        handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve),
        /process group/,
      );
    } finally {
      process.kill(-group, 'SIGKILL');
    }
    for (let i = 0; i < 100 && isProcessGroupAlive(group); i++) await new Promise(resolve => setTimeout(resolve, 50));
    await (await acquireWriterLease(gitDir)).release();
  },
);

test('delegate refuses the removed coordinate argument and names its replacement (#212)', async () => {
  const { COORDINATE_REMOVED, getCanonicalDelegateToolDefinition } = require('../../../src/mcp/tools/delegate.tool.ts');
  for (const coordinate of [true, false]) {
    await assert.rejects(
      handleDelegate({ task: 'Do it', coordinate }, tempDir, null, null, approve),
      err => err.code === 'INPUT_LIMIT' && err.message === COORDINATE_REMOVED,
    );
  }
  assert.ok(!('coordinate' in getCanonicalDelegateToolDefinition().inputSchema.properties));
});

test('turn limits: async defaults to 60m and caps at 4h, sync keeps 15m/30m, root remaining/grace bounds apply and report (#246)', async () => {
  const { adapterRegistry } = require('../../../src/backends/registry.ts');
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { createRoot, readRoot } = require('../../../src/sessions/roots.ts');
  const { atomicWrite } = require('../../../src/storage/lock.ts');
  const { createServer } = require('../../../src/mcp/server.ts');
  const { readResult } = require('../../helpers/result.cjs');
  const { setTimeout: delay } = require('node:timers/promises');

  const originalCodex = adapterRegistry.codex;
  const recordedTimeouts = [];
  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    probe: async () => ({ id: 'codex', installed: true, executionSupported: true, config: { defaultModel: MODEL } }),
    execute: async (_prompt, options) => {
      recordedTimeouts.push(options.timeoutMs);
      return {
        status: 'completed',
        isError: false,
        output: 'Done.',
        nativeSessionId: `thread-${recordedTimeouts.length}`,
        model: MODEL,
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'async task finished in time');
      await delay(25);
    }
  };

  try {
    const { repo } = fixtureRepo();
    await saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    });

    // 1. Async default is 60 minutes (3,600,000 ms), bounded by async_default.
    const startedDefault = await startDelegate({ task: 'Default async', backend: 'codex', model: MODEL }, repo, null, null, approve);
    assert.equal(startedDefault.structuredContent.timeoutMs, 3_600_000);
    assert.equal(startedDefault.structuredContent.timeoutBound, 'async_default');
    assert.match(startedDefault.content[0].text, /budget: 3600000 ms \(async default\)/);
    const doneDefault = await waitTask(startedDefault.structuredContent.taskHandle);
    assert.match(doneDefault.result.text, /Budget: 3600000 ms \(async default\)/);
    const adapterDefault = recordedTimeouts.at(-1);
    assert.ok(adapterDefault > 3_500_000 && adapterDefault <= 3_600_000, `expected ~60m, got ${adapterDefault}`);

    // 2. Async accepts timeout_ms up to 14,400,000 ms (4 hours) and refuses larger values naming the limit.
    const startedCap = await startDelegate(
      { task: 'Max async', backend: 'codex', model: MODEL, timeout_ms: 14_400_000 },
      repo,
      null,
      null,
      approve,
    );
    assert.ok(
      startedCap.structuredContent.timeoutMs > 14_300_000 && startedCap.structuredContent.timeoutMs <= 14_400_000,
      `expected ~4h, got ${startedCap.structuredContent.timeoutMs}`,
    );
    assert.ok(['timeout_ms', 'root_remaining'].includes(startedCap.structuredContent.timeoutBound));
    const doneCap = await waitTask(startedCap.structuredContent.taskHandle);
    assert.match(doneCap.result.text, /Budget: \d+ ms \((timeout_ms|root remaining time)\)/);
    const adapterCap = recordedTimeouts.at(-1);
    assert.ok(adapterCap > 14_300_000 && adapterCap <= 14_400_000, `expected ~4h, got ${adapterCap}`);

    await assert.rejects(
      startDelegate({ task: 'Too long async', backend: 'codex', model: MODEL, timeout_ms: 14_400_001 }, repo, null, null, approve),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('14400000'),
    );

    // MCP server rejects > 14,400,000 for async and > 1,800,000 for sync naming the limit.
    const call = createServer()._requestHandlers.get('tools/call');
    const mcpTooLongAsync = readResult(
      await call(
        {
          method: 'tools/call',
          params: { name: 'delegate', arguments: { task: 'Over cap', workspace_path: repo, timeout_ms: 14_400_001 } },
        },
        { signal: new AbortController().signal },
      ),
    );
    assert.equal(mcpTooLongAsync.error?.code, 'INPUT_LIMIT');
    assert.match(mcpTooLongAsync.error.message, /14400000/);

    // 3. Sync keeps 15m default and 30m cap.
    const syncDefault = await handleDelegate({ task: 'Sync default', backend: 'codex', model: MODEL }, repo, null, null, approve);
    assert.equal(syncDefault.isError, false);
    const adapterSyncDefault = recordedTimeouts.at(-1);
    assert.ok(adapterSyncDefault > 850_000 && adapterSyncDefault <= 900_000, `expected ~15m, got ${adapterSyncDefault}`);

    const syncMax = await handleDelegate(
      { task: 'Sync max', backend: 'codex', model: MODEL, timeout_ms: 1_800_000 },
      repo,
      null,
      null,
      approve,
    );
    assert.equal(syncMax.isError, false);
    const adapterSyncMax = recordedTimeouts.at(-1);
    assert.ok(adapterSyncMax > 1_750_000 && adapterSyncMax <= 1_800_000, `expected ~30m, got ${adapterSyncMax}`);

    await assert.rejects(
      handleDelegate({ task: 'Too long sync', backend: 'codex', model: MODEL, timeout_ms: 1_800_001 }, repo, null, null, approve),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('1800000'),
    );

    // 4. Root remaining running time bounds async turn, and continuation grace bounds a continued session.
    const root = await createRoot({ maxMinutes: 10, graceMinutes: 5 });
    const rootFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
    const at = minutesAgo => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    // Seed 6 minutes of running time -> 4 minutes remaining before maxMinutes (10m).
    const firstInRoot = await startDelegate(
      { task: 'Seed root', backend: 'codex', model: MODEL, root_handle: root.rootHandle },
      repo,
      null,
      null,
      approve,
    );
    const firstTask = await waitTask(firstInRoot.structuredContent.taskHandle);
    const seeded = readRoot(root.rootHandle);
    seeded.tasks[0].startedAt = at(20);
    seeded.tasks[0].endedAt = at(14); // 6m used -> 4m (240_000 ms) left
    await atomicWrite(rootFile, JSON.stringify(seeded));

    const rootBounded = await startDelegate(
      { task: 'Root bounded', backend: 'codex', model: MODEL, root_handle: root.rootHandle },
      repo,
      null,
      null,
      approve,
    );
    assert.equal(rootBounded.structuredContent.timeoutBound, 'root_remaining');
    assert.ok(rootBounded.structuredContent.timeoutMs <= 240_000 && rootBounded.structuredContent.timeoutMs > 200_000);
    assert.match(rootBounded.content[0].text, /root remaining time/);
    const doneRootBounded = await waitTask(rootBounded.structuredContent.taskHandle);
    assert.match(doneRootBounded.result.text, /Budget: \d+ ms \(root remaining time\)/);

    // Advance root used time to 11m (past 10m maxMinutes, 4m left in 5m grace) and continue the first session.
    const pastLimit = readRoot(root.rootHandle);
    pastLimit.tasks[1].startedAt = at(12);
    pastLimit.tasks[1].endedAt = at(7); // 6m + 5m = 11m used -> 4m grace left
    await atomicWrite(rootFile, JSON.stringify(pastLimit));

    const graceBounded = await startDelegate(
      { task: 'Continue in grace', backend: 'codex', model: MODEL, session_handle: firstTask.sessionHandle },
      repo,
      null,
      null,
      approve,
    );
    assert.equal(graceBounded.structuredContent.timeoutBound, 'root_grace');
    assert.ok(graceBounded.structuredContent.timeoutMs <= 240_000 && graceBounded.structuredContent.timeoutMs > 200_000);
    assert.match(graceBounded.content[0].text, /root remaining time \(continuation grace\)/);
    const doneGraceBounded = await waitTask(graceBounded.structuredContent.taskHandle);
    assert.match(doneGraceBounded.result.text, /Budget: \d+ ms \(root remaining time \(continuation grace\)\)/);

    // 5. Configured limits in config.json override defaults and caps.
    await saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
      limits: { syncDefaultMs: 300_000, syncMaxMs: 600_000, asyncDefaultMs: 1_200_000, asyncMaxMs: 7_200_000 },
    });
    const customAsync = await startDelegate({ task: 'Custom async default', backend: 'codex', model: MODEL }, repo, null, null, approve);
    assert.equal(customAsync.structuredContent.timeoutMs, 1_200_000);
    await waitTask(customAsync.structuredContent.taskHandle);
    await assert.rejects(
      startDelegate({ task: 'Over custom async', backend: 'codex', model: MODEL, timeout_ms: 7_200_001 }, repo, null, null, approve),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('7200000'),
    );
    await handleDelegate({ task: 'Custom sync default', backend: 'codex', model: MODEL }, repo, null, null, approve);
    const adapterCustomSync = recordedTimeouts.at(-1);
    assert.ok(adapterCustomSync > 250_000 && adapterCustomSync <= 300_000, `expected ~5m, got ${adapterCustomSync}`);
    await assert.rejects(
      handleDelegate({ task: 'Over custom sync', backend: 'codex', model: MODEL, timeout_ms: 600_001 }, repo, null, null, approve),
      err => err.code === 'INPUT_LIMIT' && err.message.includes('600000'),
    );
  } finally {
    await stopActiveDelegations();
    adapterRegistry.codex = originalCodex;
  }
});

test('deducts post-reservation elapsed time from root remaining duration and refuses with ROOT_LIMIT when exhausted (#246)', async () => {
  const { adapterRegistry } = require('../../../src/backends/registry.ts');
  const { stopActiveDelegations } = require('../../../src/execution/delegation.ts');
  const { readTask } = require('../../../src/sessions/tasks.ts');
  const { createRoot, readRoot } = require('../../../src/sessions/roots.ts');
  const { atomicWrite } = require('../../../src/storage/lock.ts');
  const { setTimeout: delay } = require('node:timers/promises');

  const originalCodex = adapterRegistry.codex;
  const recordedTimeouts = [];
  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    probe: async () => ({ id: 'codex', installed: true, executionSupported: true, config: { defaultModel: MODEL } }),
    execute: async (_prompt, options) => {
      recordedTimeouts.push(options.timeoutMs);
      return {
        status: 'completed',
        isError: false,
        output: 'Done.',
        nativeSessionId: `post-res-${recordedTimeouts.length}`,
        model: MODEL,
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  const waitTask = async taskHandle => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = readTask(taskHandle);
      if (task && task.state !== 'running') return task;
      assert.ok(Date.now() < deadline, 'async task finished in time');
      await delay(25);
    }
  };

  try {
    const { repo } = fixtureRepo();
    await saveConfig({
      defaultBackend: 'codex',
      routing: { strategy: 'fixed', allowedBackends: ['codex'] },
    });

    const root = await createRoot({ maxMinutes: 10, graceMinutes: 5 });
    const rootFile = path.join(process.env.coagent8_DIR, 'delegations', 'roots', `${root.rootHandle}.json`);
    const seed = await startDelegate(
      { task: 'Seed', backend: 'codex', model: MODEL, root_handle: root.rootHandle },
      repo,
      null,
      null,
      approve,
    );
    const seedDone = await waitTask(seed.structuredContent.taskHandle);

    // 1. Seed 8m used (2m = 120_000 ms left), request timeout_ms 100_000 ms, advance injected clock 30_000 ms after reservation.
    const atMsAgo = ms => new Date(Date.now() - ms).toISOString();
    const seeded = readRoot(root.rootHandle);
    seeded.tasks[0].startedAt = atMsAgo(20 * 60_000);
    seeded.tasks[0].endedAt = atMsAgo(12 * 60_000); // 8m used -> 120_000 ms left
    await atomicWrite(rootFile, JSON.stringify(seeded));

    let now = 1_000;
    let clockCalls = 0;
    const advanceAfterReservation = ms => () => {
      clockCalls++;
      if (clockCalls === 2) now += ms;
      return now;
    };

    const deducted = await startDelegate(
      { task: 'Deducted root budget', backend: 'codex', model: MODEL, root_handle: root.rootHandle, timeout_ms: 100_000 },
      repo,
      null,
      null,
      { ...approve, clock: advanceAfterReservation(30_000) },
    );
    assert.equal(deducted.structuredContent.timeoutBound, 'root_remaining', 'deduction flips tighter bound to root_remaining');
    assert.ok(
      deducted.structuredContent.timeoutMs <= 90_000 && deducted.structuredContent.timeoutMs > 85_000,
      `expected <= 90000 ms after 30000 ms deduction, got ${deducted.structuredContent.timeoutMs}`,
    );
    assert.ok(recordedTimeouts.at(-1) <= 90_000);
    await waitTask(deducted.structuredContent.taskHandle);

    // 2. Continuation starting just inside maxMinutes (10_000 ms base left + 5m grace) flips into root_grace after 20_000 ms elapses.
    const nearGrace = readRoot(root.rootHandle);
    nearGrace.tasks[0].startedAt = atMsAgo(20 * 60_000);
    nearGrace.tasks[0].endedAt = atMsAgo(19 * 60_000); // 1m
    nearGrace.tasks[1].startedAt = atMsAgo(15 * 60_000);
    nearGrace.tasks[1].endedAt = atMsAgo(6 * 60_000 + 10_000); // 8m 50s -> total 9m 50s (10_000 ms base left, 310_000 ms with grace)
    await atomicWrite(rootFile, JSON.stringify(nearGrace));

    clockCalls = 0;
    const graceDeducted = await startDelegate(
      { task: 'Deducted grace', backend: 'codex', model: MODEL, session_handle: seedDone.sessionHandle },
      repo,
      null,
      null,
      { ...approve, clock: advanceAfterReservation(20_000) },
    );
    assert.equal(graceDeducted.structuredContent.timeoutBound, 'root_grace');
    assert.ok(
      graceDeducted.structuredContent.timeoutMs <= 290_000 && graceDeducted.structuredContent.timeoutMs > 280_000,
      `expected <= 290000 ms after 20000 ms deduction, got ${graceDeducted.structuredContent.timeoutMs}`,
    );
    await waitTask(graceDeducted.structuredContent.taskHandle);

    // 3. When elapsed time since reservation exhausts the root's remaining time, refuse with ROOT_LIMIT and refund the call.
    const almostEmpty = readRoot(root.rootHandle);
    almostEmpty.tasks[0].startedAt = atMsAgo(30 * 60_000);
    almostEmpty.tasks[0].endedAt = atMsAgo(20 * 60_000 + 30_000); // 9m 30s
    almostEmpty.tasks[1].startedAt = atMsAgo(25 * 60_000);
    almostEmpty.tasks[1].endedAt = atMsAgo(25 * 60_000); // 0m
    almostEmpty.tasks[2].startedAt = atMsAgo(24 * 60_000);
    almostEmpty.tasks[2].endedAt = atMsAgo(24 * 60_000); // 0m -> 30_000 ms left before maxMinutes
    await atomicWrite(rootFile, JSON.stringify(almostEmpty));

    const callsBeforeRefusal = readRoot(root.rootHandle).calls;
    const executedBeforeRefusal = recordedTimeouts.length;
    clockCalls = 0;
    await assert.rejects(
      startDelegate(
        { task: 'Exhausted after reservation', backend: 'codex', model: MODEL, root_handle: root.rootHandle },
        repo,
        null,
        null,
        { ...approve, clock: advanceAfterReservation(35_000) },
      ),
      err => err.code === 'ROOT_LIMIT',
    );
    assert.equal(recordedTimeouts.length, executedBeforeRefusal, 'no model turn may start when root time is exhausted');
    assert.equal(readRoot(root.rootHandle).calls, callsBeforeRefusal, 'refused start must refund its root call');

    // 4. Delay injected during reserveRootTask's atomic persistence write is included in the deduction.
    const fsp = require('node:fs/promises');
    const realRename = fsp.rename;
    const forWriteDelay = readRoot(root.rootHandle);
    forWriteDelay.refundedMs = 0;
    forWriteDelay.tasks[0].startedAt = atMsAgo(20 * 60_000);
    forWriteDelay.tasks[0].endedAt = atMsAgo(12 * 60_000); // 8m used -> 120_000 ms left
    await atomicWrite(rootFile, JSON.stringify(forWriteDelay));

    let writeNow = 1_000;
    let writeDelayCount = 0;
    fsp.rename = async (src, dest) => {
      if (dest === rootFile && writeDelayCount === 0) {
        writeDelayCount++;
        writeNow += 30_000;
      }
      return realRename.call(fsp, src, dest);
    };
    try {
      const writeDeducted = await startDelegate(
        { task: 'Reservation write delay', backend: 'codex', model: MODEL, root_handle: root.rootHandle, timeout_ms: 100_000 },
        repo,
        null,
        null,
        { ...approve, clock: () => writeNow },
      );
      assert.equal(writeDelayCount, 1, 'atomic write during reserveRootTask must have been intercepted');
      assert.equal(writeDeducted.structuredContent.timeoutBound, 'root_remaining');
      assert.ok(
        writeDeducted.structuredContent.timeoutMs <= 90_000 && writeDeducted.structuredContent.timeoutMs > 85_000,
        `expected <= 90000 ms after 30000 ms write delay, got ${writeDeducted.structuredContent.timeoutMs}`,
      );
      assert.ok(recordedTimeouts.at(-1) <= 90_000);
      await waitTask(writeDeducted.structuredContent.taskHandle);
    } finally {
      fsp.rename = realRename;
    }

    // 5. Delay while waiting for the root file lock before accounting is NOT deducted or charged as ROOT_LIMIT.
    const { withFileLock } = require('../../../src/storage/lock.ts');
    const forLockDelay = readRoot(root.rootHandle);
    forLockDelay.refundedMs = 0;
    forLockDelay.tasks[0].startedAt = atMsAgo(20 * 60_000);
    forLockDelay.tasks[0].endedAt = atMsAgo(12 * 60_000); // 8m used -> 120_000 ms left
    for (const extra of forLockDelay.tasks.slice(1)) {
      extra.startedAt = atMsAgo(25 * 60_000);
      extra.endedAt = atMsAgo(25 * 60_000);
    }
    await atomicWrite(rootFile, JSON.stringify(forLockDelay));

    let lockNow = 1_000;
    let releaseLock;
    let lockEnteredResolve;
    const lockEntered = new Promise(resolve => {
      lockEnteredResolve = resolve;
    });
    const holdLock = withFileLock(rootFile, async () => {
      lockEnteredResolve();
      await new Promise(resolve => {
        releaseLock = resolve;
      });
    });
    await lockEntered;

    const pendingStart = startDelegate(
      { task: 'Lock contention before accounting', backend: 'codex', model: MODEL, root_handle: root.rootHandle, timeout_ms: 100_000 },
      repo,
      null,
      null,
      { ...approve, clock: () => lockNow },
    );
    await delay(50);
    // Advance clock by 150_000 ms (more than the 120_000 ms left in the root) while waiting on the lock.
    lockNow += 150_000;
    releaseLock();
    await holdLock;
    const lockContended = await pendingStart;
    assert.equal(lockContended.structuredContent.timeoutBound, 'timeout_ms', 'lock wait must not count against root budget');
    assert.equal(lockContended.structuredContent.timeoutMs, 100_000, 'lock wait must not reduce timeoutMs');
    await waitTask(lockContended.structuredContent.taskHandle);
  } finally {
    await stopActiveDelegations();
    adapterRegistry.codex = originalCodex;
  }
});
