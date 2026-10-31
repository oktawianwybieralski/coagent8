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
const { handleDelegate, delegatePrompt } = require('../../../src/mcp/tools/delegate.tool.ts');
const { handleConsult } = require('../../../src/mcp/tools/consult.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { acquireWriterLease, WRITER_RECORD_FILE } = require('../../../src/sessions/writer.ts');
const { normalizeScopeEntry, inScope, readWorkspaceRepository, captureWorkspace, compareWorkspace } = require('../../../src/workspace/changes.ts');
const { codexAppServerArgs, codexSandboxMismatch } = require('../../../src/backends/codex/app-server.ts');
const { claudeTurnSettings, CLAUDE_WRITE_TOOLS } = require('../../../src/backends/claude/adapter.ts');
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
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { repo, git };
}

test.beforeEach(async () => {
  await saveConfig({ defaultBackend: 'codex', routing: { strategy: 'fixed', allowedBackends: ['codex'] } });
  delete process.env.CODEX_FIXTURE_MODE;
  delete process.env.CODEX_FIXTURE_WRITES;
});

test('delegate runs a verified workspace-write Codex turn and reports the observed changes apart from the answer', async () => {
  const { repo } = fixtureRepo();
  // The user's uncommitted work before the turn.
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  process.env.CODEX_FIXTURE_WRITES = JSON.stringify({ 'src/new.ts': 'export const n = 1;\n', 'a.ts': 'export const a = 3;\n', 'gone.txt': null, 'src-old/x.ts': 'x\n' });
  const result = await handleDelegate({ task: 'Add src/new.ts', scope: ['src'], checks: ['npm test'], backend: 'codex', model: MODEL }, repo, null, null, approve);
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
  for (const setting of ['sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.writable_roots=[]',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true', 'approval_policy="never"']) {
    assert.ok(args.includes(setting), setting);
  }
  const start = records.find(r => r.method === 'thread/start').params;
  assert.equal(start.sandbox, 'workspace-write'); assert.equal(start.approvalPolicy, 'never');
  assert.ok(records.some(r => r.method === 'turn/start'));
  assert.match(prompt, /Change only: src\./);
  assert.match(prompt, /Do not commit, push, reset, stash/);
  assert.match(prompt, /CHECKS:\n- npm test/);
  assert.equal(fs.existsSync(path.join(repo, '.git', WRITER_RECORD_FILE)), false, 'the writer slot is released');
});

test('a workspace-write thread that reports network access or a root outside the workspace starts no turn', async () => {
  for (const mode of ['write-network', 'write-outside-root']) {
    const { repo } = fixtureRepo();
    process.env.CODEX_FIXTURE_MODE = mode;
    const result = await handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve);
    assert.equal(result.isError, true, mode);
    assert.match(text(result), /SANDBOX_UNAVAILABLE/, mode);
    assert.ok(!capture().records.some(r => r.method === 'turn/start'), `${mode}: no turn starts`);
    assert.match(text(result), /No file changed\./, `${mode}: the observed block still follows a failed turn`);
  }
});

test('codexSandboxMismatch requires the exact workspace-write policy, and read-only stays the default launch', () => {
  const cwd = tempDir;
  const ok = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  const check = (sandbox, extra = {}) => codexSandboxMismatch({ sandbox, approvalPolicy: 'never', cwd, ...extra }, 'workspace-write', cwd);
  assert.equal(check(ok), null);
  assert.equal(check({ ...ok, writableRoots: [path.join(cwd, 'sub')] }), null, 'a root inside the workspace is allowed');
  assert.match(check({ ...ok, writableRoots: [os.homedir()] }), /outside the workspace/);
  assert.match(check({ ...ok, excludeSlashTmp: false }), /temporary write roots/);
  assert.match(check({ ...ok, networkAccess: true }), /network/);
  assert.match(check(ok, { cwd: os.homedir() }), /another working directory/);
  assert.match(check(ok, { approvalPolicy: 'on-request' }), /approvals/);
  assert.match(codexSandboxMismatch({ sandbox: ok, approvalPolicy: 'never' }, 'read-only', cwd), /read-only sandbox/);
  assert.ok(codexAppServerArgs().includes('sandbox_mode="read-only"'));
  assert.ok(!codexAppServerArgs().some(arg => arg.startsWith('sandbox_workspace_write')));
});

test('one writer per work tree: a second delegate is refused at once, a dead owner is taken over', async () => {
  const { repo } = fixtureRepo();
  const gitDir = path.join(repo, '.git');
  const recordPath = path.join(gitDir, WRITER_RECORD_FILE);
  const held = await acquireWriterLease(gitDir);
  await assert.rejects(handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve), /SESSION_BUSY|Another delegate call/);
  await held.release();
  // A record left by a process that has exited.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const lease = await acquireWriterLease(gitDir);
  fs.writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(recordPath, 'utf8')), pid: dead, token: 'someone-else' }));
  await lease.release();
  assert.ok(fs.existsSync(recordPath), 'a release never removes another call\'s record');
  const taken = await acquireWriterLease(gitDir);
  await taken.release();
  assert.equal(fs.existsSync(recordPath), false);
});

test('the writer slot holds across server processes with different data directories', async () => {
  const { repo } = fixtureRepo();
  const gitDir = path.join(repo, '.git');
  // Another client's server: its own process and its own CoAgent8 data directory.
  const holder = spawn(process.execPath, ['-e', `require('tsx/cjs');
    require(${JSON.stringify(path.resolve(__dirname, '../../../src/sessions/writer.ts'))}).acquireWriterLease(${JSON.stringify(gitDir)})
      .then(() => console.log('held'));
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`], {
    cwd: path.resolve(__dirname, '../../..'), env: { ...process.env, coagent8_DIR: path.join(tempDir, 'other-client') }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => { holder.stdout.on('data', chunk => String(chunk).includes('held') && resolve()); holder.once('exit', reject); });
    await assert.rejects(handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve), /Another delegate call/);
  } finally {
    holder.stdin.end();
    await new Promise(resolve => holder.once('exit', resolve));
  }
});

test('delegate refuses a workspace outside Git and a scope that leaves the workspace', async () => {
  const plain = path.join(tempDir, 'plain');
  fs.mkdirSync(plain);
  await assert.rejects(handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, plain, null, null, approve), /needs a Git work tree/);
  const { repo } = fixtureRepo();
  for (const scope of ['../other', path.resolve(repo, 'src'), 'C:/x']) {
    await assert.rejects(handleDelegate({ task: 'Change it', scope: [scope], backend: 'codex', model: MODEL }, repo, null, null, approve), /absolute or leaves the workspace/, scope);
  }
  await assert.rejects(handleDelegate({ task: '   ', backend: 'codex', model: MODEL }, repo, null, null, approve), /task is required/);
});

test('a read-only session cannot run a write turn and a delegate session cannot run a read-only one', async () => {
  const { repo } = fixtureRepo();
  const consult = await handleConsult('consult', { proposal: 'Question?', backend: 'codex', model: MODEL }, repo, null, null, approve);
  const readOnlyHandle = /session_handle=(\S+)/.exec(text(consult))[1];
  await assert.rejects(handleDelegate({ task: 'Change it', session_handle: readOnlyHandle, model: MODEL }, repo, null, null, approve), /This session is read-only/);
  const delegated = await handleDelegate({ task: 'Change it', backend: 'codex', model: MODEL }, repo, null, null, approve);
  const writeHandle = /session_handle=(\S+)/.exec(text(delegated))[1];
  await assert.rejects(handleConsult('consult', { proposal: 'Question?', session_handle: writeHandle, model: MODEL }, repo, null, null, approve), /belongs to delegate/);
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
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'export const a = 9;\n', encoding: 'utf8' }).trim();
  git('update-index', '--cacheinfo', `100644,${blob},a.ts`);
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  git('add', 'src/b.ts'); git('commit', '-qm', 'worker commit', '--', 'src/b.ts');
  const changes = await compareWorkspace(repo, repository, before, await captureWorkspace(repo, repository), []);
  assert.deepEqual(changes.changed.map(c => `${c.kind} ${c.path}`), ['modified a.ts', 'modified src/b.ts']);
  assert.equal(changes.headMoved.commits, 1);
  assert.deepEqual(changes.dirtyBefore, ['a.ts']);
  assert.equal(normalizeScopeEntry('./src/'), 'src');
  assert.equal(normalizeScopeEntry('src\\lib'), 'src/lib');
  assert.equal(normalizeScopeEntry('.'), '');
  assert.equal(normalizeScopeEntry('../x'), null);
  assert.equal(inScope('src-old/x.ts', ['src']), false);
  assert.equal(inScope('src/x.ts', ['src']), true);
});

test('Claude and agy write profiles: Claude gets the write tools with workspace allow rules, agy runs without --sandbox', async () => {
  assert.deepEqual([...CLAUDE_WRITE_TOOLS], ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.deepEqual(JSON.parse(claudeTurnSettings('workspace-write')), { disableAllHooks: true, permissions: { allow: ['Edit(./**)', 'Write(./**)', 'Bash'] } });
  assert.deepEqual(JSON.parse(claudeTurnSettings('read-only')), { disableAllHooks: true });
  const { executeClaude } = require('../../../src/backends/claude/adapter.ts');
  const claudeCapture = path.join(tempDir, 'claude-capture.json');
  Object.assign(process.env, { CLAUDE_PATH: path.resolve(__dirname, '../../fixtures/claude-cli/claude.cjs'), CLAUDE_FIXTURE_CAPTURE: claudeCapture });
  const claude = await executeClaude('Change it', { cwd: tempDir, model: 'claude-sonnet-4-5', profile: 'workspace-write' });
  assert.equal(claude.isError, false, JSON.stringify(claude.error));
  const argv = JSON.parse(fs.readFileSync(claudeCapture, 'utf8')).argv;
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(argv.includes('--strict-mcp-config'));
  const { execute: executeAgy } = require('../../../src/backends/agy/adapter.ts');
  const agyCapture = path.join(tempDir, 'agy-capture.json');
  Object.assign(process.env, { AGY_PATH: path.resolve(__dirname, '../../fixtures/agy-cli/agy.cjs'), coagent8_FIXTURE_CAPTURE: agyCapture });
  await executeAgy('Change it', { cwd: tempDir, model: 'gemini-3-flash', profile: 'workspace-write' });
  const agyArgs = JSON.parse(fs.readFileSync(agyCapture, 'utf8')).args;
  assert.ok(!agyArgs.includes('--sandbox'), 'agy writers run without the sandbox');
  assert.equal(agyArgs[agyArgs.indexOf('--mode') + 1], 'accept-edits', 'headless agy approves edits and denies commands');
  assert.match(JSON.parse(fs.readFileSync(agyCapture, 'utf8')).prompt, /you cannot execute any command/, 'the agy writer is told to try no command');
  assert.equal(agyArgs[agyArgs.indexOf('--add-dir') + 1], tempDir);
  await executeAgy('Read it', { cwd: tempDir, model: 'gemini-3-flash' });
  assert.ok(JSON.parse(fs.readFileSync(agyCapture, 'utf8')).args.includes('--sandbox'), 'read-only agy keeps the sandbox');
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
  g('init', '-q'); g('config', 'user.name', 'Fixture'); g('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(unborn, 'a.txt'), 'one\n'); g('add', 'a.txt');
  fs.writeFileSync(path.join(unborn, 'a.txt'), 'two\n');
  let repository = await readWorkspaceRepository(unborn);
  let before = await captureWorkspace(unborn, repository);
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: unborn, input: 'three\n', encoding: 'utf8' }).trim();
  g('update-index', '--cacheinfo', `100644,${blob},a.txt`);
  let changes = await compareWorkspace(unborn, repository, before, await captureWorkspace(unborn, repository), []);
  assert.deepEqual(changes.changed.map(c => `${c.kind} ${c.path}`), ['modified a.txt'], 'a staged-only change before the first commit');

  // A committed untracked file still exists; a rename destination is new.
  const { repo, git } = fixtureRepo();
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'n\n');
  repository = await readWorkspaceRepository(repo);
  before = await captureWorkspace(repo, repository);
  git('add', 'notes.txt'); git('commit', '-qm', 'notes');
  git('mv', 'src/b.ts', 'src/c.ts');
  changes = await compareWorkspace(repo, repository, before, await captureWorkspace(repo, repository), []);
  assert.deepEqual(changes.changed.map(c => `${c.kind} ${c.path}`), ['modified notes.txt', 'deleted src/b.ts', 'added src/c.ts']);

  // diff.relative=true would print workspace-relative names in a subdirectory workspace.
  git('config', 'diff.relative', 'true');
  const sub = path.join(repo, 'src');
  repository = await readWorkspaceRepository(sub);
  before = await captureWorkspace(sub, repository);
  fs.writeFileSync(path.join(sub, 'c.ts'), 'export const c = 2;\n'); git('add', 'src/c.ts');
  git('commit', '-qm', 'c');
  changes = await compareWorkspace(sub, repository, before, await captureWorkspace(sub, repository), []);
  // The staged rename of b.ts is committed with c.ts, so b.ts's deletion moved into a commit.
  assert.deepEqual(changes.changed.map(c => `${c.kind} ${c.path}`), ['deleted b.ts', 'modified c.ts'], 'committed changes are found with diff.relative set');
});

test('observed paths, diff stats and branch names get diagnostic redaction', () => {
  const { formatObservedChanges } = require('../../../src/mcp/result.ts');
  const out = formatObservedChanges({
    changed: [{ path: 'token=private-value.txt', kind: 'modified' }], outsideScope: [], dirtyBefore: [], truncated: false,
    headMoved: { before: 'a'.repeat(40), after: 'b'.repeat(40), commits: 1, branchBefore: 'main', branchAfter: 'secret=hidden-branch' },
    diffStat: ' token=private-value.txt | 2 +-',
  });
  assert.doesNotMatch(out, /private-value|hidden-branch/);
});

test('an unreadable writer record is never overwritten, and a credential at the diff stat limit stays redacted', async () => {
  const { repo } = fixtureRepo();
  const recordPath = path.join(repo, '.git', WRITER_RECORD_FILE);
  fs.writeFileSync(recordPath, '{ not json');
  await assert.rejects(acquireWriterLease(path.join(repo, '.git')), /cannot be read/);
  assert.equal(fs.readFileSync(recordPath, 'utf8'), '{ not json');
  const { formatObservedChanges } = require('../../../src/mcp/result.ts');
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const out = formatObservedChanges({ changed: [], outsideScope: [], dirtyBefore: [], truncated: false,
    diffStat: `${' x | 1 +\n'.repeat(1800)}${token} | 1 +` });
  assert.ok(!out.includes(token.slice(4, 20)), 'no part of the token survives the length limit');
});
