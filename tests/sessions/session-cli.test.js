'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { runSessionCli } = require('../../src/sessions/session-cli.ts');
const { createSession, getSession } = require('../../src/sessions/session.ts');
const { createHistoryWriter } = require('../../src/sessions/history/index.ts');

/** A stream that keeps what is written to it. */
function sink() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    }),
    text: () => chunks.join(''),
  };
}

test('coagent8 session list outputs human text and JSON with workspace isolation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-cli-list-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-cli-other-'));

  try {
    // 1. Empty workspace returns no active sessions message
    const emptyOut = sink(), emptyErr = sink();
    assert.equal(await runSessionCli(['list'], emptyOut.stream, emptyErr.stream, undefined, tempDir), 0);
    assert.match(emptyOut.text(), /> CoAgent8: No active sessions found\./);
    assert.equal(emptyErr.text(), '');

    // 2. Empty workspace with --json returns empty array
    const emptyJsonOut = sink(), emptyJsonErr = sink();
    assert.equal(await runSessionCli(['list', '--json'], emptyJsonOut.stream, emptyJsonErr.stream, undefined, tempDir), 0);
    assert.deepEqual(JSON.parse(emptyJsonOut.text()), []);
    assert.equal(emptyJsonErr.text(), '');

    // 3. Create sessions in both tempDir and otherDir
    const s1 = createSession('codex', tempDir);
    const s2 = createSession('agy', tempDir);
    const sOther = createSession('claude', otherDir);

    // 4. Human text list in tempDir shows s1 and s2, excludes sOther
    const textOut = sink(), textErr = sink();
    assert.equal(await runSessionCli(['list'], textOut.stream, textErr.stream, undefined, tempDir), 0);
    assert.match(textOut.text(), /## Active CoAgent8 Sessions/);
    assert.ok(textOut.text().includes(s1.sessionHandle));
    assert.ok(textOut.text().includes(s2.sessionHandle));
    assert.ok(!textOut.text().includes(sOther.sessionHandle), 'Workspace isolation must exclude other workspace session');
    assert.equal(textErr.text(), '');

    // 5. JSON list in tempDir returns array of session records with redacted home path
    const jsonOut = sink(), jsonErr = sink();
    assert.equal(await runSessionCli(['list', '--json'], jsonOut.stream, jsonErr.stream, undefined, tempDir), 0);
    const list = JSON.parse(jsonOut.text());
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 2);
    assert.ok(list.some(s => s.sessionHandle === s1.sessionHandle));
    assert.ok(list.some(s => s.sessionHandle === s2.sessionHandle));
    assert.ok(!list.some(s => s.sessionHandle === sOther.sessionHandle));
    assert.equal(jsonErr.text(), '');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('coagent8 session history inspects paginated turn history in text and JSON', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-cli-hist-'));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-cli-hist-other-'));

  try {
    const s = createSession('codex', tempDir);
    const handle = s.sessionHandle;

    // Populate multi-turn history
    const writer1 = createHistoryWriter(handle, tempDir, 'codex', randomUUID());
    writer1.accept({ type: 'turn_started' });
    writer1.accept({ type: 'user_message', text: 'Hello, who are you?' });
    writer1.accept({ type: 'assistant_message', messageId: 'm1', text: 'I am Codex.' });
    writer1.accept({ type: 'turn_finished', status: 'completed' });
    await writer1.flush();

    const writer2 = createHistoryWriter(handle, tempDir, 'codex', randomUUID());
    writer2.accept({ type: 'turn_started' });
    writer2.accept({ type: 'user_message', text: 'Calculate 2 + 2' });
    writer2.accept({ type: 'tool_finished', toolId: 't1', name: 'calc', success: true });
    writer2.accept({ type: 'assistant_message', messageId: 'm2', text: 'Result is 4.' });
    writer2.accept({ type: 'turn_finished', status: 'completed' });
    await writer2.flush();

    // 1. Text history format
    const textOut = sink(), textErr = sink();
    assert.equal(await runSessionCli(['history', handle], textOut.stream, textErr.stream, undefined, tempDir), 0);
    assert.match(textOut.text(), new RegExp(`## Session History: \`${handle}\``));
    assert.match(textOut.text(), /### Turn 1/);
    assert.match(textOut.text(), /Hello, who are you\?/);
    assert.match(textOut.text(), /I am Codex\./);
    assert.match(textOut.text(), /### Turn 2/);
    assert.match(textOut.text(), /Calculate 2 \+ 2/);
    assert.match(textOut.text(), /\*Tool `calc` finished \(success\)\*/);
    assert.match(textOut.text(), /Result is 4\./);
    assert.equal(textErr.text(), '');

    // 2. JSON history format
    const jsonOut = sink(), jsonErr = sink();
    assert.equal(await runSessionCli(['history', handle, '--json'], jsonOut.stream, jsonErr.stream, undefined, tempDir), 0);
    const hist = JSON.parse(jsonOut.text());
    assert.equal(hist.sessionHandle, handle);
    assert.equal(hist.schemaVersion, 1);
    assert.ok(Array.isArray(hist.events));
    assert.ok(hist.events.some(e => e.type === 'user_message' && e.text.includes('Hello')));
    assert.equal(jsonErr.text(), '');

    // 3. Pagination with --limit and --cursor
    const p1Out = sink(), p1Err = sink();
    assert.equal(await runSessionCli(['history', handle, '--limit', '2', '--json'], p1Out.stream, p1Err.stream, undefined, tempDir), 0);
    const p1 = JSON.parse(p1Out.text());
    assert.equal(p1.events.length, 2);
    assert.ok(p1.nextCursor, 'First page should have nextCursor');

    const p2Out = sink(), p2Err = sink();
    assert.equal(await runSessionCli(['history', handle, '--cursor', p1.nextCursor, '--limit=2', '--json'], p2Out.stream, p2Err.stream, undefined, tempDir), 0);
    const p2 = JSON.parse(p2Out.text());
    assert.ok(p2.events.length > 0);
    assert.notEqual(p2.events[0].eventId, p1.events[0].eventId);

    // 4. Workspace isolation: querying handle from another workspace fails with exit code 1
    const isoOut = sink(), isoErr = sink();
    assert.equal(await runSessionCli(['history', handle], isoOut.stream, isoErr.stream, undefined, otherDir), 1);
    assert.match(isoErr.text(), /Error: History not found in this workspace\./);

    // 5. Non-existent handle fails with exit code 1
    const fakeOut = sink(), fakeErr = sink();
    assert.equal(await runSessionCli(['history', 'syn_sess_nonexistent'], fakeOut.stream, fakeErr.stream, undefined, tempDir), 1);
    assert.match(fakeErr.text(), /Error: History not found in this workspace\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test('coagent8 session argument validation and exit code 2 handling', async () => {
  const out = sink(), err = sink();

  // Root session missing subcommand -> exit 2
  assert.equal(await runSessionCli([], out.stream, err.stream), 2);
  assert.match(err.text(), /Unknown command or missing subcommand/);

  // Root session unknown subcommand -> exit 2
  const unkOut = sink(), unkErr = sink();
  assert.equal(await runSessionCli(['unknown-subcmd'], unkOut.stream, unkErr.stream), 2);
  assert.match(unkErr.text(), /Unknown subcommand 'unknown-subcmd'/);

  // Root session --help -> exit 0
  const helpOut = sink(), helpErr = sink();
  assert.equal(await runSessionCli(['--help'], helpOut.stream, helpErr.stream), 0);
  assert.match(helpOut.text(), /Usage: coagent8 session/);

  // session list --help -> exit 0
  const listHelpOut = sink(), listHelpErr = sink();
  assert.equal(await runSessionCli(['list', '--help'], listHelpOut.stream, listHelpErr.stream), 0);
  assert.match(listHelpOut.text(), /Usage: coagent8 session list \[--json\]/);

  // session list unknown argument -> exit 2
  const listArgOut = sink(), listArgErr = sink();
  assert.equal(await runSessionCli(['list', '--invalid'], listArgOut.stream, listArgErr.stream), 2);
  assert.match(listArgErr.text(), /Unknown argument '--invalid'/);

  // session history --help -> exit 0
  const histHelpOut = sink(), histHelpErr = sink();
  assert.equal(await runSessionCli(['history', '--help'], histHelpOut.stream, histHelpErr.stream), 0);
  assert.match(histHelpOut.text(), /Usage: coagent8 session history <handle>/);

  // session history missing handle -> exit 2
  const histNoHandleOut = sink(), histNoHandleErr = sink();
  assert.equal(await runSessionCli(['history'], histNoHandleOut.stream, histNoHandleErr.stream), 2);
  assert.match(histNoHandleErr.text(), /Missing required session handle/);

  // session history invalid limit -> exit 2
  for (const invalidLimit of ['0', '101', 'abc', '-5']) {
    const limOut = sink(), limErr = sink();
    assert.equal(await runSessionCli(['history', 'handle-1', '--limit', invalidLimit], limOut.stream, limErr.stream), 2);
    assert.match(limErr.text(), /History limit must be 1\.\.100/);
  }

  // session history missing value for --cursor -> exit 2
  const noCursorValOut = sink(), noCursorValErr = sink();
  assert.equal(await runSessionCli(['history', 'handle-1', '--cursor'], noCursorValOut.stream, noCursorValErr.stream), 2);
  assert.match(noCursorValErr.text(), /Missing value for argument '--cursor'/);

  // session history extra positional argument -> exit 2
  const extraPosOut = sink(), extraPosErr = sink();
  assert.equal(await runSessionCli(['history', 'handle-1', 'extra-arg'], extraPosOut.stream, extraPosErr.stream), 2);
  assert.match(extraPosErr.text(), /Unknown argument 'extra-arg'/);
});

test('coagent8 session aborts with exit code 130 on signal abort', async () => {
  const out = sink(), err = sink();
  const ac = new AbortController();
  ac.abort();
  const code = await runSessionCli(['list'], out.stream, err.stream, ac.signal);
  assert.equal(code, 130);
});
