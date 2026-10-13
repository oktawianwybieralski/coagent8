const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.COAGENT8_DISABLE_AUTORUN = '1';
const { runCli, formatRootHelp, formatMcpHelp } = require('../../src/index.ts');
const { BRAND } = require('../../src/brand.ts');

function createMockStream(isTTY = false) {
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

function createHarness({ stdinTTY = false, stdoutTTY = false } = {}) {
  const stdin = { isTTY: stdinTTY };
  const stdout = createMockStream(stdoutTTY);
  const stderr = createMockStream(false);
  let servedStdio = false;
  let setupLoaded = false;
  let modelsRan = false;

  const deps = {
    serveStdio: async () => {
      servedStdio = true;
    },
    runModelsCli: async () => {
      modelsRan = true;
      return 0;
    },
    loadSetupCli: async () => {
      setupLoaded = true;
      return {
        runSetupCli: async () => true,
      };
    },
  };

  return {
    streams: { stdin, stdout, stderr },
    deps,
    get servedStdio() { return servedStdio; },
    get setupLoaded() { return setupLoaded; },
    get modelsRan() { return modelsRan; },
    stdout,
    stderr,
  };
}

test('CLI-FIRST-001b1: --help and -h print root help and exit 0 without loading setup or starting MCP', async () => {
  for (const flag of ['--help', '-h']) {
    const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
    const code = await runCli([flag], harness.streams, harness.deps);
    assert.equal(code, 0);
    assert.equal(harness.stdout.output, formatRootHelp());
    assert.ok(harness.stdout.output.includes('cleanup'));
    assert.ok(harness.stdout.output.includes('mcp'));
    assert.equal(harness.stderr.output, '');
    assert.equal(harness.servedStdio, false);
    assert.equal(harness.setupLoaded, false);
  }
});

test('CLI-FIRST-001b1: --version and -v print package version and exit 0 without loading setup or starting MCP', async () => {
  for (const flag of ['--version', '-v']) {
    const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
    const code = await runCli([flag], harness.streams, harness.deps);
    assert.equal(code, 0);
    assert.equal(harness.stdout.output, `${BRAND.SERVER_VERSION}\n`);
    assert.equal(harness.stderr.output, '');
    assert.equal(harness.servedStdio, false);
    assert.equal(harness.setupLoaded, false);
  }
});

test('CLI-FIRST-001b1: bare invocation with both stdin and stdout TTY prints root help and exits 0', async () => {
  const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const code = await runCli([], harness.streams, harness.deps);
  assert.equal(code, 0);
  assert.equal(harness.stdout.output, formatRootHelp());
  assert.equal(harness.stderr.output, '');
  assert.equal(harness.servedStdio, false);
  assert.equal(harness.setupLoaded, false);
});

test('CLI-FIRST-001b1: bare invocation with non-TTY streams starts legacy MCP stdio server', async () => {
  // Test combinations where at least one stream is non-TTY
  const combos = [
    { stdinTTY: false, stdoutTTY: false, label: 'piped both non-TTY' },
    { stdinTTY: false, stdoutTTY: true, label: 'stdin non-TTY, stdout TTY' },
    { stdinTTY: true, stdoutTTY: false, label: 'stdin TTY, stdout non-TTY' },
  ];

  for (const combo of combos) {
    const harness = createHarness(combo);
    const code = await runCli([], harness.streams, harness.deps);
    assert.equal(code, 0, combo.label);
    assert.equal(harness.servedStdio, true, `servedStdio must be true for ${combo.label}`);
    assert.equal(harness.setupLoaded, false, `setupLoaded must be false for ${combo.label}`);
    assert.equal(harness.stdout.output, '', combo.label);
    assert.equal(harness.stderr.output, '', combo.label);
  }
});

test('CLI-FIRST-001b1: coagent8 mcp always starts MCP stdio server regardless of TTY state', async () => {
  const combos = [
    { stdinTTY: true, stdoutTTY: true },
    { stdinTTY: false, stdoutTTY: false },
    { stdinTTY: true, stdoutTTY: false },
    { stdinTTY: false, stdoutTTY: true },
  ];

  for (const combo of combos) {
    const harness = createHarness(combo);
    const code = await runCli(['mcp'], harness.streams, harness.deps);
    assert.equal(code, 0);
    assert.equal(harness.servedStdio, true);
    assert.equal(harness.setupLoaded, false);
    assert.equal(harness.stdout.output, '');
    assert.equal(harness.stderr.output, '');
  }
});

test('CLI-FIRST-001b1: coagent8 mcp --help / -h prints mcp help and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
    const code = await runCli(['mcp', flag], harness.streams, harness.deps);
    assert.equal(code, 0);
    assert.equal(harness.stdout.output, formatMcpHelp());
    assert.equal(harness.stderr.output, '');
    assert.equal(harness.servedStdio, false);
    assert.equal(harness.setupLoaded, false);
  }
});

test('CLI-FIRST-001b1: coagent8 mcp with unrecognized arguments exits 2 with stderr error', async () => {
  const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const code = await runCli(['mcp', '--bogus-flag'], harness.streams, harness.deps);
  assert.equal(code, 2);
  assert.equal(harness.servedStdio, false);
  assert.equal(harness.setupLoaded, false);
  assert.match(harness.stderr.output, /Unknown argument '--bogus-flag'\. Usage: coagent8 mcp/);
});

test('CLI-FIRST-001b1: unrecognized arguments on TTY exit 2 with usage hint on stderr', async () => {
  const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const code = await runCli(['foobar'], harness.streams, harness.deps);
  assert.equal(code, 2);
  assert.equal(harness.servedStdio, false);
  assert.equal(harness.setupLoaded, false);
  assert.match(harness.stderr.output, /Unknown command or option 'foobar'\. Run 'coagent8 --help' for usage\./);
});

test('CLI-FIRST-001b1: unrecognized arguments on non-TTY emit stderr warning and fallback to legacy MCP', async () => {
  const combos = [
    { stdinTTY: false, stdoutTTY: false, label: 'piped both non-TTY' },
    { stdinTTY: false, stdoutTTY: true, label: 'stdin non-TTY, stdout TTY' },
    { stdinTTY: true, stdoutTTY: false, label: 'stdin TTY, stdout non-TTY' },
  ];

  for (const combo of combos) {
    const harness = createHarness(combo);
    const code = await runCli(['legacy-host-arg', '--extra'], harness.streams, harness.deps);
    assert.equal(code, 0, combo.label);
    assert.equal(harness.servedStdio, true, `servedStdio must be true for ${combo.label}`);
    assert.equal(harness.setupLoaded, false, `setupLoaded must be false for ${combo.label}`);
    assert.match(harness.stderr.output, /Warning: unrecognized arguments \[legacy-host-arg, --extra\] ignored; starting legacy MCP stdio server\./);
  }
});

test('CLI-FIRST-001b1: management commands load setup bundle lazily', async () => {
  for (const cmd of ['setup', 'repair', 'status', 'cleanup', 'skills']) {
    const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
    const code = await runCli([cmd], harness.streams, harness.deps);
    assert.equal(code, 0);
    assert.equal(harness.setupLoaded, true, `setup bundle must be loaded for ${cmd}`);
    assert.equal(harness.servedStdio, false);
  }
});

test('CLI-FIRST-001b1: models command dispatches to runModelsCli without loading setup or MCP', async () => {
  const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const code = await runCli(['models', '--backend', 'codex'], harness.streams, harness.deps);
  assert.equal(code, 0);
  assert.equal(harness.modelsRan, true);
  assert.equal(harness.setupLoaded, false);
  assert.equal(harness.servedStdio, false);
});

test('CLI-FIRST-001b1: subprocess execution verifies clean exits and streams', () => {
  const root = path.resolve(__dirname, '../..');
  const indexPath = path.join(root, 'src/index.ts');
  const childEnv = { ...process.env };
  delete childEnv.COAGENT8_DISABLE_AUTORUN;

  // 1. --version
  const versionRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, '--version'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(versionRes.status, 0);
  assert.equal(versionRes.stdout.trim(), BRAND.SERVER_VERSION);

  // 2. --help
  const helpRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, '--help'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(helpRes.status, 0);
  assert.ok(helpRes.stdout.includes('CoAgent8 - Cross-Agent CLI Bridge'));
  assert.ok(helpRes.stdout.includes('cleanup'));

  // 3. mcp --help
  const mcpHelpRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'mcp', '--help'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(mcpHelpRes.status, 0);
  assert.ok(mcpHelpRes.stdout.includes('Usage: coagent8 mcp'));

  // 4. mcp --invalid (exit 2)
  const mcpInvalidRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'mcp', '--unknown-flag'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(mcpInvalidRes.status, 2);
  assert.match(mcpInvalidRes.stderr, /Unknown argument '--unknown-flag'/);
});

test('CLI-FIRST-001b1: none of --help, --version, bare TTY, or mcp loads setup.cjs eagerly', async () => {
  const root = path.resolve(__dirname, '../..');
  const indexPath = path.join(root, 'src/index.ts');

  // Verify in separate node executions that setup.cjs is never in module cache
  const script = `
    const { runCli } = require('./src/index.ts');
    (async () => {
      const mode = process.argv[2];
      const stdinTTY = mode === 'bare-tty' || mode === 'help' || mode === 'version';
      const stdoutTTY = stdinTTY;
      const args = mode === 'help' ? ['--help'] : mode === 'version' ? ['--version'] : mode === 'mcp' ? ['mcp'] : [];
      let serveCalled = false;
      await runCli(args, { stdin: { isTTY: stdinTTY }, stdout: { isTTY: stdoutTTY, write() {} }, stderr: { write() {} } }, {
        serveStdio: async () => { serveCalled = true; }
      });
      const loaded = Object.keys(require.cache).filter(k => k.includes('setup.cjs'));
      if (loaded.length > 0) {
        process.stderr.write('setup.cjs was eagerly loaded: ' + loaded.join(', '));
        process.exit(1);
      }
      process.exit(0);
    })();
  `;

  for (const mode of ['help', 'version', 'bare-tty', 'bare-nontty', 'mcp']) {
    const res = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', script, mode], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(res.status, 0, `mode ${mode} failed: ${res.stderr}`);
  }
});
