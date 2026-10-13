'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runSessionCli } = require('../../src/sessions/session-cli.ts');
const { createSession } = require('../../src/sessions/session.ts');

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
});

test('coagent8 session aborts with exit code 130 on signal abort', async () => {
  const out = sink(), err = sink();
  const ac = new AbortController();
  ac.abort();
  const code = await runSessionCli(['list'], out.stream, err.stream, ac.signal);
  assert.equal(code, 130);
});
