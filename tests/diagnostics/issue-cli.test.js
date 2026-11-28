const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runIssueCli, openBrowser } = require('../../src/diagnostics/issue-cli.ts');
const { GITHUB_BUG_REPORT_TEMPLATE_URL } = require('../../src/diagnostics/issue.ts');

function createStream(isTTY = false) {
  const chunks = [];
  return {
    isTTY,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    get output() {
      return chunks.join('');
    },
  };
}

const noDoctor = async () => null;

test('coagent8 issue prints the report locally and does not open on non-TTY by default', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli([], out, err, {
    openBrowser: url => opened.push(url),
    runDoctorFn: noDoctor,
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 0, 'non-TTY default must not open the browser');
  assert.ok(out.output.includes('[Bug]: '), 'prints title locally');
  assert.ok(out.output.includes('### What happened'), 'prints report body locally');
  assert.ok(out.output.includes('### Environment'), 'prints environment locally');
  assert.ok(out.output.includes(GITHUB_BUG_REPORT_TEMPLATE_URL), 'prints form link');
  assert.ok(!out.output.includes('```'), 'nothing to copy');
});

test('coagent8 issue --open prints the report before opening the form', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];
  let outputAtOpen = '';

  const code = await runIssueCli(['--open'], out, err, {
    openBrowser: url => {
      outputAtOpen = out.output;
      opened.push(url);
    },
    runDoctorFn: noDoctor,
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 1, '--open opens the form');
  assert.ok(opened[0].startsWith(`${GITHUB_BUG_REPORT_TEMPLATE_URL}&title=`));
  const fields = new URL(opened[0]).searchParams;
  assert.match(fields.get('environment'), /CoAgent8 MCP Version/);
  assert.match(fields.get('what-happened'), /^Describe what you did/);
  assert.ok(outputAtOpen.includes('### What happened'), 'report body is printed before opening');
  assert.ok(outputAtOpen.includes('### Environment'), 'environment is printed before opening');
  assert.ok(outputAtOpen.includes(opened[0]), 'output must contain the opened link before opening');
});

test('coagent8 issue --no-open and --open flags on non-TTY', async () => {
  for (const [args, count] of [
    [[], 0],
    [['--no-open'], 0],
    [['--open'], 1],
    [['--open', '--no-open'], 0],
    [['--no-open', '--open'], 1],
  ]) {
    const opened = [];
    const code = await runIssueCli(args, createStream(), createStream(), {
      openBrowser: url => opened.push(url),
      runDoctorFn: noDoctor,
    });
    assert.equal(code, 0);
    assert.equal(opened.length, count, args.join(' '));
  }
});

test('coagent8 issue prompts on interactive TTY with default No and opens only on y/yes', async () => {
  for (const [reply, expectedOpens, label] of [
    ['\n', 0, 'empty enter defaults to No'],
    ['n\n', 0, 'n declines'],
    ['no\n', 0, 'no declines'],
    [null, 0, 'EOF declines'],
    ['y\n', 1, 'y opens'],
    ['YES\n', 1, 'YES opens'],
  ]) {
    const out = createStream(true);
    const err = createStream(true);
    const input = new PassThrough();
    input.isTTY = true;
    const opened = [];
    let outputAtOpen = '';

    const runPromise = runIssueCli([], out, err, {
      input,
      openBrowser: url => {
        outputAtOpen = out.output;
        opened.push(url);
      },
      runDoctorFn: noDoctor,
    });

    if (reply === null) input.end();
    else input.write(reply);

    const code = await runPromise;
    assert.equal(code, 0, label);
    assert.equal(err.output, '', label);
    assert.equal(opened.length, expectedOpens, label);
    const reportPos = out.output.indexOf('### What happened');
    const promptPos = out.output.indexOf('Open the GitHub form with this report? [y/N]');
    assert.ok(reportPos >= 0 && promptPos > reportPos, `${label}: prints report before asking`);
    if (expectedOpens) {
      assert.ok(outputAtOpen.includes('### What happened'), `${label}: report printed before open`);
    }
  }

  // --no-open skips the prompt even on an interactive TTY.
  const noOpenOut = createStream(true);
  const noOpenInput = new PassThrough();
  noOpenInput.isTTY = true;
  const noOpenUrls = [];
  const noOpenCode = await runIssueCli(['--no-open'], noOpenOut, createStream(true), {
    input: noOpenInput,
    openBrowser: url => noOpenUrls.push(url),
    runDoctorFn: noDoctor,
  });
  assert.equal(noOpenCode, 0);
  assert.equal(noOpenUrls.length, 0);
  assert.ok(!noOpenOut.output.includes('Open the GitHub form'));

  // --open skips the prompt on an interactive TTY.
  const openOut = createStream(true);
  const openInput = new PassThrough();
  openInput.isTTY = true;
  const openUrls = [];
  const openCode = await runIssueCli(['--open'], openOut, createStream(true), {
    input: openInput,
    openBrowser: url => openUrls.push(url),
    runDoctorFn: noDoctor,
  });
  assert.equal(openCode, 0);
  assert.equal(openUrls.length, 1);
  assert.ok(!openOut.output.includes('Open the GitHub form'));
});

test('coagent8 issue --json outputs structured report without opening browser', async () => {
  const out = createStream();
  const err = createStream();
  const opened = [];

  const code = await runIssueCli(['--json'], out, err, {
    openBrowser: url => opened.push(url),
    runDoctorFn: noDoctor,
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 0);

  const payload = JSON.parse(out.output);
  assert.ok(payload.issueUrl.startsWith(`${GITHUB_BUG_REPORT_TEMPLATE_URL}&title=`));
  assert.equal(payload.pasteRequired, false);
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
    runDoctorFn: noDoctor,
  });

  assert.equal(code, 0);
  assert.equal(err.output, '');
  const payload = JSON.parse(out.output);
  assert.deepEqual(opened, [payload.issueUrl]);
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
    assert.ok(out.output.includes('Usage: coagent8 issue [--title <text>] [--open] [--no-open] [--json] [what happened...]'));
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

test('coagent8 issue reports warning from opener callback on stderr', async () => {
  const out = createStream();
  const err = createStream();
  let calledUrl = null;

  const code = await runIssueCli(['--open'], out, err, {
    runDoctorFn: noDoctor,
    openBrowser: (url, onWarning) => {
      calledUrl = url;
      onWarning?.('Warning: browser opener exited with code 1: command not found');
      return false;
    },
  });

  assert.equal(code, 0);
  assert.ok(out.output.includes(calledUrl));
  assert.ok(err.output.includes('Warning: browser opener exited with code 1'));
});

test('coagent8 issue opens the link of the report it printed', async () => {
  const out = createStream();
  const err = createStream();
  let openedUrl = null;
  let outputAtOpen = '';

  const code = await runIssueCli(['--open'], out, err, {
    generateReportFn: () => ({
      title: 'custom title',
      body: 'custom body',
      issueUrl: 'https://github.com/oktawianwybieralski/coagent8/issues/new?template=bug_report.yml&title=x',
      prompt: 'custom prompt',
      pasteRequired: false,
    }),
    runDoctorFn: noDoctor,
    openBrowser: url => {
      outputAtOpen = out.output;
      openedUrl = url;
      return true;
    },
  });

  assert.equal(code, 0);
  assert.equal(openedUrl, 'https://github.com/oktawianwybieralski/coagent8/issues/new?template=bug_report.yml&title=x');
  assert.ok(outputAtOpen.includes('custom title'));
  assert.ok(outputAtOpen.includes('custom body'));
  assert.ok(outputAtOpen.includes('custom prompt'));
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
  const url = 'https://example.com/new?a=1&b=%25PATH%25';
  const resultPromise = openBrowser(url, undefined, { spawnFn, timeoutMs: 1000 });
  child.emit('exit', 0);

  assert.equal(await resultPromise, true);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].args.some(arg => arg === url),
    'the URL is passed as one argument',
  );
  if (process.platform === 'win32') {
    // cmd.exe would split the URL at '&' and expand %PATH%.
    assert.equal(calls[0].command, 'rundll32.exe');
  }
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

test('coagent8 issue fills the title and "What happened" from its arguments', async () => {
  const opened = [];
  const out = createStream();
  const err = createStream();
  const code = await runIssueCli(['--title', 'Root limit counts idle time', 'delegate', 'refused', '--no-open', '--', '--json'], out, err, {
    openBrowser: url => opened.push(url),
    runDoctorFn: noDoctor,
  });
  assert.equal(code, 0);
  assert.equal(err.output, '');
  assert.equal(opened.length, 0);
  const fields = new URL(out.output.match(/\(<([^>]+)>\)/)[1]).searchParams;
  assert.equal(fields.get('title'), '[Bug]: Root limit counts idle time');
  assert.match(fields.get('what-happened'), /^delegate refused --json/);

  const missing = createStream();
  assert.equal(await runIssueCli(['--title'], createStream(), missing, { openBrowser: () => true }), 2);
  assert.match(missing.output, /--title needs a value/);
});

test('coagent8 issue derives the title from the text and refuses an option as the title', async () => {
  const out = createStream();
  assert.equal(await runIssueCli(['--no-open', 'delegate', 'hangs'], out, createStream(), { runDoctorFn: noDoctor }), 0);
  assert.equal(new URL(out.output.match(/\(<([^>]+)>\)/)[1]).searchParams.get('title'), '[Bug]: delegate hangs');

  const opened = [];
  const err = createStream();
  assert.equal(await runIssueCli(['--title', '--no-open'], createStream(), err, { openBrowser: url => opened.push(url) }), 2);
  assert.equal(opened.length, 0);
  assert.match(err.output, /--title needs a value/);
});
