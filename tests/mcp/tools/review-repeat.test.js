const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// AX-007c: an unchanged repeat review (same snapshot, scope, backend and model in the same
// workspace) starts no model turn and refers to the earlier server verdict.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-review-repeat-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
const { adapterRegistry } = require('../../../src/backends/registry.ts');
const { handleReview } = require('../../../src/mcp/tools/review.tool.ts');
const { saveConfig } = require('../../../src/config.ts');
const { getSessionsDir } = require('../../../src/sessions/session.ts');
const { readResult } = require('../../helpers/result.cjs');
const original = { agy: adapterRegistry.agy, codex: adapterRegistry.codex };
test.after(() => {
  Object.assign(adapterRegistry, original);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const approve = { askConsent: async () => ({ approved: true, remember: false }) };

function fixtureRepo(name) {
  const repo = path.join(tempDir, name);
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  return { repo, git };
}

/** Fixture reviewers that count their turns; `answer` builds the reply from the prompt. */
function installReviewers(answer = snapshot => ['REVIEW: 1', `SNAPSHOT: ${snapshot}`, 'COVERAGE: COMPLETE', 'VERDICT: READY', 'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN', 'END_REVIEW'].join('\n')) {
  const turns = { agy: 0, codex: 0 };
  for (const id of ['agy', 'codex']) {
    adapterRegistry[id] = {
      id, name: 'fixture',
      probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
      execute: async (prompt, options) => {
        turns[id]++;
        const nativeSessionId = id === 'agy' ? '11111111-2222-3333-4444-55555555555' + turns[id] : `codex-thread-${turns[id]}`;
        return { status: 'completed', isError: false, truncated: false, continuationAvailable: true, nativeSessionId, model: options.model,
          output: answer(prompt.match(/^SNAPSHOT: (.+)$/m)[1]) };
      },
    };
  }
  return turns;
}

test('an unchanged repeat review starts no model turn and refers to the earlier verdict', async () => {
  const { repo } = fixtureRepo('unchanged');
  const turns = installReviewers();
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy', 'codex'] } });
  const first = readResult(await handleReview('review', {}, repo, null, null, approve));
  assert.equal(turns.agy, 1);
  assert.equal(first.verdict, 'BLOCKED');
  assert.ok(first.sessionHandle);
  const second = await handleReview('review', {}, repo, null, null, approve);
  const repeat = readResult(second);
  assert.equal(turns.agy, 1, 'the second identical request costs no turn');
  assert.match(repeat.answer, new RegExp(`^No model turn: this request matches a completed review \\(same snapshot, scope, backend and model\\) in session ${first.sessionHandle}, completed `));
  assert.equal(repeat.verdict, first.verdict, 'the earlier server verdict is reported');
  assert.equal(repeat.reason, first.reason);
  assert.equal(repeat.sessionHandle, null, 'no continuation is offered for the unchanged input');
  assert.ok(second.content[0].text.length < 2000, 'the reference is bounded');
});

test('a changed snapshot, scope, model or backend proceeds', async () => {
  const { repo, git } = fixtureRepo('changes');
  const turns = installReviewers();
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy', 'codex'] } });
  await handleReview('review', {}, repo, null, null, approve);
  assert.equal(turns.agy, 1);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n');
  await handleReview('review', {}, repo, null, null, approve);
  assert.equal(turns.agy, 2, 'changed snapshot');
  git('add', '.');
  await handleReview('review', { scope: 'staged' }, repo, null, null, approve);
  assert.equal(turns.agy, 3, 'changed scope');
  await handleReview('review', { scope: 'staged', model: 'fixture-model-b' }, repo, null, null, approve);
  assert.equal(turns.agy, 4, 'changed model');
  await handleReview('review', { scope: 'staged', backend: 'codex' }, repo, null, null, approve);
  assert.equal(turns.codex, 1, 'changed backend');
  await handleReview('review', { scope: 'staged', backend: 'codex' }, repo, null, null, approve);
  assert.equal(turns.codex, 1, 'and its own repeat is refused');
});

test('a turn without a complete envelope is not a judgement and may be repeated', async () => {
  const { repo } = fixtureRepo('unjudged');
  const turns = installReviewers(() => 'Looks fine to me.');
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  assert.equal(readResult(await handleReview('review', {}, repo, null, null, approve)).reason, 'Answer has no State Envelope');
  await handleReview('review', {}, repo, null, null, approve);
  assert.equal(turns.agy, 2);
});

test('an unreadable sessions directory is reported and the review runs', async t => {
  const { repo } = fixtureRepo('unreadable');
  const turns = installReviewers();
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  await handleReview('review', {}, repo, null, null, approve);
  const sessionsDir = path.resolve(getSessionsDir());
  const readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function (dir, ...rest) {
    if (path.resolve(String(dir)) === sessionsDir) throw Object.assign(new Error(`EACCES: simulated, scandir '${dir}'`), { code: 'EACCES' });
    return readdirSync.call(this, dir, ...rest);
  });
  const result = readResult(await handleReview('review', {}, repo, null, null, approve));
  t.mock.restoreAll();
  assert.equal(turns.agy, 2, 'never a silent pass: the review ran');
  assert.ok(result.warnings.some(warning => /^Repeat-review check unavailable, so this review ran: .*EACCES/.test(warning)), result.warnings.join('\n'));
});

test('disabled history still refuses an unchanged repeat: the outcome lives in the session record', async t => {
  const previous = process.env.coagent8_HISTORY;
  process.env.coagent8_HISTORY = 'off';
  t.after(() => { if (previous === undefined) delete process.env.coagent8_HISTORY; else process.env.coagent8_HISTORY = previous; });
  const { repo } = fixtureRepo('history-off');
  const turns = installReviewers();
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  await handleReview('review', {}, repo, null, null, approve);
  const repeat = readResult(await handleReview('review', {}, repo, null, null, approve));
  assert.equal(turns.agy, 1);
  assert.match(repeat.answer, /^No model turn/);
});
