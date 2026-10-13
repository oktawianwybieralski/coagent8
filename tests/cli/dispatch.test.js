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
  let doctorRan = false;
  let sessionRan = false;

  const deps = {
    serveStdio: async () => {
      servedStdio = true;
    },
    runModelsCli: async () => {
      modelsRan = true;
      return 0;
    },
    runDoctorCli: async () => {
      doctorRan = true;
      return 0;
    },
    runSessionCli: async () => {
      sessionRan = true;
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
    get doctorRan() { return doctorRan; },
    get sessionRan() { return sessionRan; },
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

test('CLI-FIRST-001c/001e: models and doctor subcommands route to their CLI runners', async () => {
  const modelsHarness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const modelsCode = await runCli(['models', '--backend', 'codex'], modelsHarness.streams, modelsHarness.deps);
  assert.equal(modelsCode, 0);
  assert.equal(modelsHarness.modelsRan, true);
  assert.equal(modelsHarness.doctorRan, false);
  assert.equal(modelsHarness.setupLoaded, false);
  assert.equal(modelsHarness.servedStdio, false);

  const doctorHarness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const doctorCode = await runCli(['doctor', '--scope', 'health'], doctorHarness.streams, doctorHarness.deps);
  assert.equal(doctorCode, 0);
  assert.equal(doctorHarness.doctorRan, true);
  assert.equal(doctorHarness.modelsRan, false);
  assert.equal(doctorHarness.setupLoaded, false);
  assert.equal(doctorHarness.servedStdio, false);
});

test('CLI-FIRST-001b1/001c/001e: subprocess execution verifies clean exits and streams', () => {
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
  assert.ok(helpRes.stdout.includes('doctor'));

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

  // 5. models command subprocess
  const modelsRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'models'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(modelsRes.status, 0);
  assert.match(modelsRes.stdout, /^CoAgent8 models · /);

  // 6. models --json subprocess
  const modelsJsonRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'models', '--backend', 'codex', '--json'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(modelsJsonRes.status, 0);
  const modelsJson = JSON.parse(modelsJsonRes.stdout);
  assert.equal(modelsJson.scope, 'models');
  assert.deepEqual(Object.keys(modelsJson.backends), ['codex']);

  // 7. doctor command subprocess (default scope models)
  const doctorRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'doctor'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(doctorRes.status, 0);
  assert.match(doctorRes.stdout, /^CoAgent8 models · /);

  // 8. doctor --scope health --json subprocess
  const doctorHealthJsonRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'doctor', '--scope=health', '--backend=codex', '--json'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(doctorHealthJsonRes.status, 0);
  const doctorHealthJson = JSON.parse(doctorHealthJsonRes.stdout);
  assert.ok(doctorHealthJson.status);
  assert.deepEqual(Object.keys(doctorHealthJson.backends), ['codex']);

  // 9. doctor invalid option
  const doctorInvalidRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'doctor', '--invalid-opt'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(doctorInvalidRes.status, 2);
  assert.match(doctorInvalidRes.stderr, /Usage: coagent8 doctor/);

  // 10. models invalid option
  const modelsInvalidRes = spawnSync(process.execPath, ['--require', 'tsx/cjs', indexPath, 'models', '--invalid-opt'], {
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(modelsInvalidRes.status, 2);
  assert.match(modelsInvalidRes.stderr, /Usage: coagent8 models/);
});

test('CLI-FIRST-001b1: sensitive flag-value pairs are redacted in fallback warning', async () => {
  const harness = createHarness({ stdinTTY: false, stdoutTTY: false });
  const code = await runCli(['--password', 'super-secret-val', '--token', 'secret-tok-123'], harness.streams, harness.deps);
  assert.equal(code, 0);
  assert.equal(harness.servedStdio, true);
  assert.ok(!harness.stderr.output.includes('super-secret-val'));
  assert.ok(!harness.stderr.output.includes('secret-tok-123'));
  // Hyphen-prefixed sensitive values must also be redacted
  const hyphenHarness = createHarness({ stdinTTY: false, stdoutTTY: false });
  const hyphenCode = await runCli(['--password', '-private-value', '--api-key', '--secret-flag-val'], hyphenHarness.streams, hyphenHarness.deps);
  assert.equal(hyphenCode, 0);
  assert.equal(hyphenHarness.servedStdio, true);
  assert.ok(!hyphenHarness.stderr.output.includes('-private-value'));
  assert.ok(!hyphenHarness.stderr.output.includes('--secret-flag-val'));
  assert.match(hyphenHarness.stderr.output, /Warning: unrecognized arguments \[--password, \*\*\*\[REDACTED\]\*\*\*, --api-key, \*\*\*\[REDACTED\]\*\*\*\] ignored/);

  // Adjacent sensitive flags must preserve flag detection and redact subsequent values
  const adjacentHarness = createHarness({ stdinTTY: false, stdoutTTY: false });
  const adjacentCode = await runCli(['--password', '--token', 'private-token-value'], adjacentHarness.streams, adjacentHarness.deps);
  assert.equal(adjacentCode, 0);
  assert.equal(adjacentHarness.servedStdio, true);
  assert.ok(!adjacentHarness.stderr.output.includes('private-token-value'));
  assert.match(adjacentHarness.stderr.output, /Warning: unrecognized arguments \[--password, --token, \*\*\*\[REDACTED\]\*\*\*\] ignored/);
});

test('CLI-FIRST-001d: coagent8 session dispatches to runSessionCli without loading setup or starting MCP', async () => {
  const harness = createHarness({ stdinTTY: true, stdoutTTY: true });
  const code = await runCli(['session', 'list'], harness.streams, harness.deps);
  assert.equal(code, 0);
  assert.equal(harness.sessionRan, true);
  assert.equal(harness.servedStdio, false);
  assert.equal(harness.setupLoaded, false);
});

test('CLI-FIRST-001b1/001c/001d/001e: none of --help, --version, bare TTY, mcp, models, doctor, or session loads setup.cjs eagerly', async () => {
  const root = path.resolve(__dirname, '../..');

  // Verify in separate node executions that setup.cjs is never in module cache
  const script = `
    const { runCli, formatRootHelp } = require('./src/index.ts');
    const { BRAND } = require('./src/brand.ts');
    (async () => {
      const mode = process.argv[1];
      const stdinTTY = mode === 'bare-tty' || mode === 'help' || mode === 'version';
      const stdoutTTY = stdinTTY;
      const args = mode === 'help' ? ['--help'] : mode === 'version' ? ['--version'] : mode === 'mcp' ? ['mcp'] : mode === 'models' ? ['models', '--help'] : mode === 'doctor' ? ['doctor', '--help'] : mode === 'session' ? ['session', '--help'] : [];
      let serveCalled = false;
      let stdout = '';
      await runCli(args, { stdin: { isTTY: stdinTTY }, stdout: { isTTY: stdoutTTY, write(c) { stdout += c; } }, stderr: { write() {} } }, {
        serveStdio: async () => { serveCalled = true; }
      });
      if (mode === 'bare-tty' && (serveCalled || !stdout.includes('CoAgent8'))) {
        process.stderr.write('bare-tty failed: serveCalled=' + serveCalled + ' stdout=' + stdout);
        process.exit(2);
      }
      if (mode === 'bare-nontty' && !serveCalled) {
        process.stderr.write('bare-nontty failed: serveCalled must be true');
        process.exit(2);
      }
      if (mode === 'mcp' && !serveCalled) {
        process.stderr.write('mcp failed: serveCalled must be true');
        process.exit(2);
      }
      if (mode === 'help' && (serveCalled || stdout !== formatRootHelp())) {
        process.stderr.write('help failed');
        process.exit(2);
      }
      if (mode === 'version' && (serveCalled || stdout.trim() !== BRAND.SERVER_VERSION)) {
        process.stderr.write('version failed');
        process.exit(2);
      }
      if ((mode === 'models' || mode === 'doctor' || mode === 'session') && !stdout.includes('Usage: coagent8')) {
        process.stderr.write(mode + ' failed');
        process.exit(2);
      }
      const loaded = Object.keys(require.cache).filter(k => k.includes('setup.cjs'));
      if (loaded.length > 0) {
        process.stderr.write('setup.cjs was eagerly loaded: ' + loaded.join(', '));
        process.exit(1);
      }
      process.exit(0);
    })();
  `;

  for (const mode of ['help', 'version', 'bare-tty', 'bare-nontty', 'mcp', 'models', 'doctor', 'session']) {
    const res = spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', script, mode], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(res.status, 0, `mode ${mode} failed: ${res.stderr}`);
  }
});
