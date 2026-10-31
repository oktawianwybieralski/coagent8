'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runDoctorCli } = require('../../src/diagnostics/doctor-cli.ts');
const { handleDoctor } = require('../../src/mcp/tools/doctor.tool.ts');

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

test('coagent8 doctor defaults to scope models and prints human summary or JSON', async () => {
  const text = sink(), json = sink(), err = sink();
  assert.equal(await runDoctorCli([], text.stream, err.stream), 0);
  assert.match(text.text(), /^CoAgent8 models - /);
  assert.equal(err.text(), '');

  assert.equal(await runDoctorCli(['--json', '--backend', 'codex'], json.stream, err.stream), 0);
  const report = JSON.parse(json.text());
  assert.equal(report.scope, 'models');
  assert.deepEqual(Object.keys(report.backends), ['codex']);
  assert.ok(Array.isArray(report.selection));
  assert.equal(report.trace, undefined, 'timing stays out of output');
});

test('coagent8 doctor --scope health prints health diagnostics or JSON matching MCP doctor', async () => {
  const text = sink(), json = sink(), err = sink();
  assert.equal(await runDoctorCli(['--scope', 'health'], text.stream, err.stream), 0);
  assert.match(text.text(), /^CoAgent8 doctor: \w+ - v\d+\.\d+\.\d+.* - runtime: .* - default backend:/);
  assert.equal(err.text(), '');

  assert.equal(await runDoctorCli(['--scope=health', '--backend=codex', '--json'], json.stream, err.stream), 0);
  const report = JSON.parse(json.text());
  assert.ok(report.status);
  assert.equal(typeof report.server_version, 'string');
  assert.equal(typeof report.runtime_path, 'string');
  assert.deepEqual(Object.keys(report.backends), ['codex']);
  assert.ok(report.ready_backends);

  // Compare structured data agreement with MCP doctor
  const mcpRes = await handleDoctor({ scope: 'health', backend: 'codex', detail: 'full' });
  const mcpData = JSON.parse(mcpRes.content[0].text);
  assert.equal(report.status, mcpData.status);
  assert.equal(report.server_version, mcpData.server_version);
  assert.equal(report.runtime_path, mcpData.runtime_path);
  assert.deepEqual(report.ready_backends, mcpData.ready_backends);
});

test('coagent8 doctor refuses unknown arguments, invalid scope, and invalid backend with usage', async () => {
  const invalidCases = [
    ['--bogus'],
    ['--scope', 'invalid-scope'],
    ['--scope=invalid-scope'],
    ['--scope'],
    ['--backend', 'gemini'],
    ['--backend=gemini'],
    ['--backend'],
    ['--', 'extra-arg'],
  ];

  for (const args of invalidCases) {
    const out = sink(), err = sink();
    assert.equal(await runDoctorCli(args, out.stream, err.stream), 2, args.join(' '));
    assert.match(err.text(), /Usage: coagent8 doctor \[--scope models\|health\] \[--backend codex\|claude\|agy\] \[--json\]/);
    assert.equal(out.text(), '');
  }

  const help = sink();
  assert.equal(await runDoctorCli(['--help'], help.stream), 0);
  assert.match(help.text(), /^Usage: coagent8 doctor/);

  const shortHelp = sink();
  assert.equal(await runDoctorCli(['-h'], shortHelp.stream), 0);
  assert.match(shortHelp.text(), /^Usage: coagent8 doctor/);
});

test('coagent8 doctor aborts with exit code 130 on aborted signal', async () => {
  const out = sink(), err = sink();
  const ac = new AbortController();
  ac.abort();
  const code = await runDoctorCli([], out.stream, err.stream, ac.signal);
  assert.equal(code, 130);
});

test('coagent8 doctor creates no execution sessions', async () => {
  const sessionsDir = path.join(os.homedir(), '.coagent8', 'sessions');
  const filesBefore = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];

  const out = sink(), err = sink();
  assert.equal(await runDoctorCli(['--scope=health'], out.stream, err.stream), 0);

  const filesAfter = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.deepEqual(filesAfter, filesBefore, 'no session file created during doctor');
});

test('coagent8 doctor redacts home directory paths in text and JSON output', async () => {
  const original = os.homedir;
  const home = process.platform === 'win32' ? 'C:\\Users\\DoctorSyntheticUser' : '/home/DoctorSyntheticUser';
  os.homedir = () => home;
  try {
    const textSink = sink(), jsonSink = sink();
    assert.equal(await runDoctorCli(['--scope=health'], textSink.stream), 0);
    assert.ok(!textSink.text().includes('DoctorSyntheticUser'));

    assert.equal(await runDoctorCli(['--scope=health', '--json'], jsonSink.stream), 0);
    assert.ok(!jsonSink.text().includes('DoctorSyntheticUser'));
  } finally {
    os.homedir = original;
  }
});
