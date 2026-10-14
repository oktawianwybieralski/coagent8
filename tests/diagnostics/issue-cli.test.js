const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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
    openBrowser: (url) => {
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

test('openBrowser bounds observation and destroys stderr pipe when opener retains stderr', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};

  const warnings = [];
  const resultPromise = openBrowser(
    'https://example.com',
    (w) => warnings.push(w),
    {
      spawnFn: () => child,
      timeoutMs: 40,
    }
  );

  const result = await resultPromise;
  assert.equal(result, true);
  assert.equal(warnings.length, 0);
  assert.equal(child.stderr.destroyed, true, 'stderr pipe must be destroyed after observation to release event loop');
});

test('openBrowser caps stderr buffering and formats exit warning on non-zero exit', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};

  const warnings = [];
  const resultPromise = openBrowser(
    'https://example.com',
    (w) => warnings.push(w),
    {
      spawnFn: () => child,
      timeoutMs: 1000,
    }
  );

  // Emit 2000 bytes into stderr
  child.stderr.write('A'.repeat(2000));
  child.emit('exit', 42);

  const result = await resultPromise;
  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('browser opener exited with code 42'));
  // Ensure the warning detail is capped and does not contain all 2000 characters
  assert.ok(warnings[0].length < 600, 'warning text must be bounded and redacted');
  assert.equal(child.stderr.destroyed, true);
});

test('openBrowser handles child process error event and returns false', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};

  const warnings = [];
  const resultPromise = openBrowser(
    'https://example.com',
    (w) => warnings.push(w),
    {
      spawnFn: () => child,
      timeoutMs: 1000,
    }
  );

  child.emit('error', new Error('spawn ENOENT fake-browser'));

  const result = await resultPromise;
  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('failed to launch browser: spawn ENOENT fake-browser'));
  assert.equal(child.stderr.destroyed, true);
});

test('openBrowser safely redacts credentials crossing the stderr cutoff boundary', async () => {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};

  const warnings = [];
  const resultPromise = openBrowser(
    'https://example.com',
    (w) => warnings.push(w),
    {
      spawnFn: () => child,
      timeoutMs: 1000,
    }
  );

  // 490 spaces followed by ghp_ and 36 alphanumeric characters (total 530 chars, crossing 512 cutoff)
  const fullToken = 'ghp_' + 'A'.repeat(36);
  child.stderr.write(' '.repeat(490) + fullToken);
  child.emit('exit', 1);

  const result = await resultPromise;
  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('ghp_'), 'partial token prefix must never appear in the warning');
  assert.ok(!warnings[0].includes('AAA'), 'token characters must never appear in the warning');
  assert.equal(child.stderr.destroyed, true);
});
