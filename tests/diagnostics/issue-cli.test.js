const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runIssueCli, openBrowser } = require('../../src/diagnostics/issue-cli.ts');
const { GITHUB_BUG_REPORT_TEMPLATE_URL } = require('../../src/diagnostics/issue.ts');

function createStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    get output() {
      return chunks.join('');
    },
  };
}

test('coagent8 issue prints sanitized report and does not open browser automatically', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli([], out, err, {
    openBrowser: url => opened.push(url),
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 0, 'browser must never open automatically without --open');
  assert.ok(out.output.includes(GITHUB_BUG_REPORT_TEMPLATE_URL), 'output must contain form link');
  assert.ok(out.output.includes('CoAgent8 issue output'), 'output must contain paste field instructions');
  assert.ok(out.output.includes('```'), 'output must contain fenced report block');
});

test('coagent8 issue --open prints report and opens browser with the form link', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli(['--open'], out, err, {
    openBrowser: url => opened.push(url),
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 1);
  assert.equal(opened[0], GITHUB_BUG_REPORT_TEMPLATE_URL);
  assert.ok(out.output.includes(GITHUB_BUG_REPORT_TEMPLATE_URL));
});

test('coagent8 issue --json outputs structured report without opening browser', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli(['--json'], out, err, {
    openBrowser: url => opened.push(url),
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 0);

  const payload = JSON.parse(out.output);
  assert.equal(payload.issueUrl, GITHUB_BUG_REPORT_TEMPLATE_URL);
  assert.equal(payload.pasteRequired, true);
  assert.ok(typeof payload.title === 'string');
  assert.ok(typeof payload.body === 'string');
  assert.ok(typeof payload.prompt === 'string');
});

test('coagent8 issue --open --json outputs structured report and opens browser', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli(['--open', '--json'], out, err, {
    openBrowser: url => opened.push(url),
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 1);
  assert.equal(opened[0], GITHUB_BUG_REPORT_TEMPLATE_URL);
  const payload = JSON.parse(out.output);
  assert.equal(payload.issueUrl, GITHUB_BUG_REPORT_TEMPLATE_URL);
  assert.equal(payload.pasteRequired, true);
});

test('coagent8 issue --help and -h print usage', async () => {
  for (const flag of ['--help', '-h']) {
    const out = createStream();
    const err = createStream();
    const opened = [];

    const code = await runIssueCli([flag], out, err, {
      openBrowser: url => opened.push(url),
    });

    assert.equal(code, 0);
    assert.equal(err.output, '');
    assert.equal(opened.length, 0);
    assert.ok(out.output.includes('Usage: coagent8 issue [--open] [--json]'));
  }
});

test('coagent8 issue with unknown arguments exits code 2', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli(['--unknown-flag'], out, err, {
    openBrowser: url => opened.push(url),
  });

  assert.equal(code, 2);
  assert.equal(out.output, '');
  assert.equal(opened.length, 0);
  assert.ok(err.output.includes("Unknown argument '--unknown-flag'"));
});

test('coagent8 issue isolates secondary failures (browser open or doctor failure)', async () => {
  const out = createStream();
  const err = createStream();

  const code = await runIssueCli(['--open'], out, err, {
    openBrowser: () => {
      throw new Error('browser opener crashed');
    },
    runDoctorFn: async () => {
      throw new Error('doctor probe timed out');
    },
  });

  assert.equal(code, 0, 'secondary failures must not cause CLI failure');
  assert.ok(out.output.includes(GITHUB_BUG_REPORT_TEMPLATE_URL));
  assert.ok(err.output.includes('Warning: failed to launch browser: browser opener crashed'));
});

test('coagent8 issue --open reports warning from opener callback on stderr', async () => {
  const out = createStream();
  const err = createStream();
  let calledUrl = null;

  const code = await runIssueCli(['--open'], out, err, {
    openBrowser: (url, onWarning) => {
      calledUrl = url;
      onWarning?.('Warning: browser opener exited with code 1: command not found');
      return false;
    },
  });

  assert.equal(code, 0);
  assert.equal(calledUrl, GITHUB_BUG_REPORT_TEMPLATE_URL);
  assert.ok(out.output.includes(GITHUB_BUG_REPORT_TEMPLATE_URL));
  assert.ok(err.output.includes('Warning: browser opener exited with code 1'));
});

test('coagent8 issue --open always opens GITHUB_BUG_REPORT_TEMPLATE_URL even if report has generic URL', async () => {
  const out = createStream();
  const err = createStream();
  let openedUrl = null;

  const code = await runIssueCli(['--open'], out, err, {
    generateReportFn: () => ({
      title: 'custom title',
      body: 'custom body',
      issueUrl: 'https://github.com/oktawianwybieralski/coagent8/issues/new',
      prompt: 'custom prompt with https://github.com/oktawianwybieralski/coagent8/issues/new',
    }),
    openBrowser: url => {
      openedUrl = url;
      return true;
    },
  });

  assert.equal(code, 0);
  assert.equal(openedUrl, GITHUB_BUG_REPORT_TEMPLATE_URL, 'must strictly open bug report template form URL');
});

test('coagent8 issue handles cancellation signal with exit code 130', async () => {
  const out = createStream();
  const err = createStream();
  const ac = new AbortController();
  ac.abort();

  const code = await runIssueCli([], out, err, ac.signal);
  assert.equal(code, 130);
});

function fakeOpener() {
  const child = new EventEmitter();
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { child, calls, spawnFn };
}

test('openBrowser spawns a quiet, non-detached opener that ignores its output', async () => {
  const { child, calls, spawnFn } = fakeOpener();
  const resultPromise = openBrowser('https://example.com', undefined, { spawnFn, timeoutMs: 1000 });
  child.emit('exit', 0);

  assert.equal(await resultPromise, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('https://example.com'));
  assert.equal(calls[0].options.detached, undefined, 'a detached child can show a console window on Windows');
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
});

test('openBrowser stops waiting for a long-running opener and releases it', async () => {
  const { child, spawnFn } = fakeOpener();
  const warnings = [];
  const result = await openBrowser('https://example.com', w => warnings.push(w), { spawnFn, timeoutMs: 20 });

  assert.equal(result, true);
  assert.deepEqual(warnings, []);
  assert.equal(child.unrefCalls, 1);
});

test('openBrowser reports a non-zero opener exit code without its output', async () => {
  const { child, spawnFn } = fakeOpener();
  const warnings = [];
  const resultPromise = openBrowser('https://example.com', w => warnings.push(w), { spawnFn, timeoutMs: 1000 });
  child.emit('exit', 42);

  assert.equal(await resultPromise, false);
  assert.deepEqual(warnings, ['Warning: browser opener exited with code 42']);
});

test('openBrowser reports child process error events', async () => {
  const { child, spawnFn } = fakeOpener();
  const warnings = [];
  const resultPromise = openBrowser('https://example.com', w => warnings.push(w), { spawnFn, timeoutMs: 1000 });
  child.emit('error', new Error('spawn ENOENT fake-browser'));

  assert.equal(await resultPromise, false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('failed to launch browser: spawn ENOENT fake-browser'));
});

test('openBrowser reports a synchronous spawn failure', async () => {
  const warnings = [];
  const result = await openBrowser('https://example.com', w => warnings.push(w), {
    spawnFn: () => {
      throw new Error('spawn EPERM');
    },
    timeoutMs: 1000,
  });

  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('failed to launch browser: spawn EPERM'));
});
