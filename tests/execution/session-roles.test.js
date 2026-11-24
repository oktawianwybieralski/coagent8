'use strict';

/**
 * #210: sessions record their role, and a turn can run outside the workspace that owns its session.
 *
 * Verifies:
 * - A runner turn records its role on a new session, with the profile the role runs.
 * - A record whose role and profile disagree, or whose role is unknown, is not a session.
 * - Records written before roles keep their profile and continue as before.
 * - Continuation across a read-only role and delegate is refused in both directions; between
 *   read-only roles it is not.
 * - `executionCwd` moves only the backend's directory: the session, its workspace and a
 *   continuation stay with the workspace.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-roles-'));
process.env.coagent8_DIR = tempDir;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-roles-ws-'));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-roles-exec-'));

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { runTask } = require('../../src/execution/task.ts');
const {
  createSession,
  getSession,
  getSessionFilePath,
  sessionProfile,
  acquireAndResolveSession,
} = require('../../src/sessions/session.ts');
const { saveConfig } = require('../../src/config.ts');
const { canonicalPath } = require('../../src/workspace/identity.ts');

test.after(() => {
  for (const dir of [tempDir, workspace, elsewhere]) fs.rmSync(dir, { recursive: true, force: true });
});

let turn = 0;
const seenCwd = [];
function useFixture() {
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      seenCwd.push(options.cwd);
      turn++;
      options.onEvent({ type: 'assistant_message', messageId: `m${turn}`, text: 'OK' });
      return {
        status: 'completed',
        isError: false,
        output: 'OK',
        nativeSessionId: `11111111-2222-3333-4444-${String(turn).padStart(12, '0')}`,
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  return () => {
    adapterRegistry.agy = original;
  };
}

function record(handle) {
  return JSON.parse(fs.readFileSync(getSessionFilePath(handle), 'utf8'));
}

function rewrite(handle, change) {
  const file = getSessionFilePath(handle);
  fs.writeFileSync(file, JSON.stringify({ ...record(handle), ...change }));
}

test('a new session records its role with the profile the role runs', () => {
  for (const role of ['consult', 'review']) {
    const s = createSession('agy', workspace, null, 'read-only', role);
    assert.equal(record(s.sessionHandle).role, role);
    assert.equal(record(s.sessionHandle).profile, undefined);
    assert.equal(sessionProfile(getSession(s.sessionHandle)), 'read-only');
  }
  const writer = createSession('agy', workspace, null, 'workspace-write', 'delegate');
  assert.equal(record(writer.sessionHandle).role, 'delegate');
  assert.equal(record(writer.sessionHandle).profile, 'workspace-write');
  assert.throws(() => createSession('agy', workspace, null, 'read-only', 'delegate'));
  assert.throws(() => createSession('agy', workspace, null, 'workspace-write', 'review'));
});

test('a record whose role disagrees with its profile, or is unknown, is not a session', () => {
  const reader = createSession('agy', workspace, null, 'read-only', 'review');
  rewrite(reader.sessionHandle, { role: 'delegate' });
  assert.equal(getSession(reader.sessionHandle), null);
  const writer = createSession('agy', workspace, null, 'workspace-write', 'delegate');
  rewrite(writer.sessionHandle, { role: 'consult' });
  assert.equal(getSession(writer.sessionHandle), null);
  const other = createSession('agy', workspace, null, 'read-only', 'consult');
  rewrite(other.sessionHandle, { role: 'author' });
  assert.equal(getSession(other.sessionHandle), null);
});

test('records written before roles keep their profile', async () => {
  const reader = createSession('agy', workspace);
  const writer = createSession('agy', workspace, null, 'workspace-write');
  assert.equal(record(reader.sessionHandle).role, undefined);
  assert.equal(sessionProfile(getSession(reader.sessionHandle)), 'read-only');
  assert.equal(sessionProfile(getSession(writer.sessionHandle)), 'workspace-write');
  const refused = await acquireAndResolveSession(reader.sessionHandle, 'agy', workspace, undefined, 'workspace-write', 'delegate');
  assert.match(refused.error ?? '', /started read-only and cannot run a workspace-write turn/);
  const refusedWriter = await acquireAndResolveSession(writer.sessionHandle, 'agy', workspace, undefined, 'read-only', 'review');
  assert.match(refusedWriter.error ?? '', /started workspace-write and cannot run a read-only turn/);
});

test('runner turns record their role and continue only within the same profile', async () => {
  const restore = useFixture();
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const consult = await runTask('consult', { prompt: 'p', publicInput: 'p', args: { backend: 'agy' }, cwd: workspace });
    assert.equal(consult.isError, false);
    assert.equal(record(consult.sessionHandle).role, 'consult');

    // A review may continue a consult session: both are read-only.
    const followed = await runTask('review', {
      prompt: 'p',
      publicInput: 'p',
      args: { backend: 'agy', session_handle: consult.sessionHandle },
      cwd: workspace,
    });
    assert.equal(followed.isError, false);
    assert.equal(followed.sessionHandle, consult.sessionHandle);
    assert.equal(record(consult.sessionHandle).role, 'consult', 'the role is written once, at creation');

    const before = turn;
    await assert.rejects(
      runTask('delegate', {
        prompt: 'p',
        publicInput: 'p',
        args: { backend: 'agy', session_handle: consult.sessionHandle },
        cwd: workspace,
      }),
      err => err.code === 'POLICY_DENIED',
    );
    assert.equal(turn, before, 'no turn ran');

    const writer = createSession('agy', workspace, '11111111-2222-3333-4444-999999999999', 'workspace-write', 'delegate');
    await assert.rejects(
      runTask('review', { prompt: 'p', publicInput: 'p', args: { backend: 'agy', session_handle: writer.sessionHandle }, cwd: workspace }),
      err => err.code === 'POLICY_DENIED',
    );
    assert.equal(turn, before, 'no turn ran');
  } finally {
    restore();
  }
});

test('executionCwd moves the backend, not the session', async () => {
  const restore = useFixture();
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    seenCwd.length = 0;
    const first = await runTask('review', {
      prompt: 'p',
      publicInput: 'p',
      args: { backend: 'agy' },
      cwd: workspace,
      options: { executionCwd: elsewhere },
    });
    assert.equal(first.isError, false);
    assert.equal(seenCwd[0], elsewhere);
    assert.equal(record(first.sessionHandle).workspace, canonicalPath(workspace));

    // The continuation is found through the workspace, from another execution directory.
    const elsewhereToo = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-roles-exec2-'));
    try {
      const next = await runTask('review', {
        prompt: 'p',
        publicInput: 'p',
        args: { backend: 'agy', session_handle: first.sessionHandle },
        cwd: workspace,
        options: { executionCwd: elsewhereToo },
      });
      assert.equal(next.isError, false);
      assert.equal(next.sessionHandle, first.sessionHandle);
      assert.equal(seenCwd[1], elsewhereToo);
    } finally {
      fs.rmSync(elsewhereToo, { recursive: true, force: true });
    }

    // Without it the backend runs in the workspace, as before.
    const plain = await runTask('consult', { prompt: 'p', publicInput: 'p', args: { backend: 'agy' }, cwd: workspace });
    assert.equal(plain.isError, false);
    assert.equal(seenCwd[2], workspace);
  } finally {
    restore();
  }
});
