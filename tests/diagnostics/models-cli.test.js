'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const { runModelsCli } = require('../../src/diagnostics/models-cli.ts');

/** A stream that keeps what is written to it. */
function sink() {
  const chunks = [];
  return { stream: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } }), text: () => chunks.join('') };
}

test('coagent8 models prints the model view as text or as the report the VS Code menu reads', async () => {
  const text = sink(), json = sink(), err = sink();
  assert.equal(await runModelsCli([], text.stream, err.stream), 0);
  assert.match(text.text(), /^CoAgent8 models · /);
  assert.equal(await runModelsCli(['--json', '--backend', 'codex'], json.stream, err.stream), 0);
  const report = JSON.parse(json.text());
  assert.equal(report.scope, 'models');
  assert.deepEqual(Object.keys(report.backends), ['codex'], '--backend narrows the view');
  assert.ok(Array.isArray(report.selection));
  assert.equal(report.trace, undefined, 'timing stays out of the data');
  assert.equal(err.text(), '');
});

test('coagent8 models refuses unknown arguments and an unknown backend with the usage', async () => {
  for (const args of [['--bogus'], ['--backend', 'gemini'], ['--backend']]) {
    const out = sink(), err = sink();
    assert.equal(await runModelsCli(args, out.stream, err.stream), 2, args.join(' '));
    assert.match(err.text(), /Usage: coagent8 models \[--backend codex\|claude\|agy\] \[--json\]/);
    assert.equal(out.text(), '');
  }
  const help = sink();
  assert.equal(await runModelsCli(['--help'], help.stream), 0);
  assert.match(help.text(), /^Usage: coagent8 models/);
});
