/**
 * Acceptance test for native acceptance runner skeleton (ACCEPT-001a1, row 2.16).
 *
 * @remarks
 * Proves that `runAcceptance` in `--dry-run` mode executes hermetically without
 * backend CLIs or GUI, verifies artifacts and versions in isolation, produces
 * compliant evidence JSON, and guarantees process hygiene and directory cleanup.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAcceptance, resolveCodeCli, SCHEMA_VERSION } = require('../../tooling/acceptance/runner.cjs');
const { createSyntheticArtifacts } = require('../../tooling/acceptance/artifacts.cjs');

test('runner skeleton completes dry run and produces valid evidence JSON (ACCEPT-001a1)', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-test-'));
  const evidencePath = path.join(testRoot, 'evidence.json');
  const tempInstanceRoot = path.join(testRoot, 'instance');

  t.after(() => {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  const result = await runAcceptance({
    dryRun: true,
    evidencePath,
    tempParent: tempInstanceRoot,
  });

  // Verify result status
  assert.equal(result.status, 'INCOMPLETE', 'Dry run status is INCOMPLETE because live scenarios N2-N4 are deferred');
  assert.ok(fs.existsSync(evidencePath), 'Evidence JSON file must be written');

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));

  // 1. Validate top-level schema fields
  assert.equal(evidence.schemaVersion, SCHEMA_VERSION);
  assert.equal(evidence.mode, 'dry-run');
  assert.ok(evidence.startedAt);
  assert.ok(evidence.completedAt);
  assert.ok(typeof evidence.durationMs === 'number');
  assert.equal(evidence.status, 'INCOMPLETE');

  // 2. Validate artifacts
  assert.ok(evidence.artifacts.tarball);
  assert.ok(evidence.artifacts.tarball.path);
  assert.ok(evidence.artifacts.tarball.sha256);
  assert.ok(evidence.artifacts.tarball.version);

  assert.ok(evidence.artifacts.vsix);
  assert.ok(evidence.artifacts.vsix.path);
  assert.ok(evidence.artifacts.vsix.sha256);
  assert.ok(evidence.artifacts.vsix.version);

  // 3. Validate host info
  assert.ok(evidence.host.node);
  assert.ok(evidence.host.platform);
  assert.ok(evidence.host.arch);
  assert.ok(evidence.host.osRelease);

  // 4. Validate runtime probe
  assert.ok(evidence.runtime.startedVersion);
  assert.equal(evidence.runtime.versionAgreement, true);
  assert.equal(evidence.runtime.serverStatus, 'operational');

  // 5. Validate steps
  assert.ok(Array.isArray(evidence.steps));
  const stepIds = evidence.steps.map(s => s.id);
  assert.ok(stepIds.includes('step_env_init'));
  assert.ok(stepIds.includes('step_artifacts'));
  assert.ok(stepIds.includes('step_host_probe'));
  assert.ok(stepIds.includes('step_tarball_install'));
  assert.ok(stepIds.includes('step_vsix_install'));
  assert.ok(stepIds.includes('step_runtime_probe'));
  assert.ok(stepIds.includes('step_scenarios_n2_n4'));
  assert.ok(stepIds.includes('step_home_preservation'));

  const scenarioStep = evidence.steps.find(s => s.id === 'step_scenarios_n2_n4');
  assert.equal(scenarioStep.status, 'NOT_RUN');
  assert.match(scenarioStep.details, /2\.17/);

  // 6. Validate cleanup of temp root
  assert.deepEqual(fs.readdirSync(tempInstanceRoot), [], 'Temporary instance root must be cleaned up on success');
});

test('runner skeleton cleans up temporary root on failure', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-fail-test-'));
  const evidencePath = path.join(testRoot, 'evidence-fail.json');
  const tempInstanceRoot = path.join(testRoot, 'instance-fail');

  t.after(() => {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  const result = await runAcceptance({
    dryRun: false,
    tarball: path.join(testRoot, 'non-existent.tgz'),
    vsix: path.join(testRoot, 'non-existent.vsix'),
    evidencePath,
    tempParent: tempInstanceRoot,
  });

  assert.equal(result.status, 'FAIL');
  assert.ok(fs.existsSync(evidencePath), 'Evidence JSON must still be written on failure');
  assert.deepEqual(fs.readdirSync(tempInstanceRoot), [], 'Temporary instance root must be cleaned up on failure');
});

test('resolveCodeCli resolves JS scripts and parses code.cmd', async t => {
  // Test direct JS resolution
  const mockScript = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const resScript = resolveCodeCli(mockScript);
  assert.equal(resScript.command, process.execPath);
  assert.deepEqual(resScript.prefixArgs, [mockScript]);
  assert.deepEqual(resScript.extraEnv, {});

  // Test Windows code.cmd structure parsing
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-codecli-test-'));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));

  const binDir = path.join(testRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const codeCmd = path.join(binDir, 'code.cmd');
  const codeExe = path.join(testRoot, 'Code.exe');
  const cliJs = path.join(testRoot, 'resources', 'app', 'out', 'cli.js');
  fs.mkdirSync(path.dirname(cliJs), { recursive: true });

  fs.writeFileSync(codeExe, 'mock exe', 'utf8');
  fs.writeFileSync(cliJs, 'mock cli js', 'utf8');
  const shim = '@echo off\nsetlocal\nset ELECTRON_RUN_AS_NODE=1\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\n';
  fs.writeFileSync(codeCmd, shim, 'utf8');

  if (process.platform === 'win32') {
    const resCmd = resolveCodeCli(codeCmd);
    assert.equal(resCmd.command, codeExe);
    assert.deepEqual(resCmd.prefixArgs, [cliJs]);
    assert.equal(resCmd.extraEnv.ELECTRON_RUN_AS_NODE, '1');

    // Discovery reads the search path whatever the key's spelling (Windows uses Path).
    const discovered = resolveCodeCli(null, { Path: binDir });
    assert.equal(discovered.command, codeExe);

    // A shim of another shape is refused instead of running through cmd.exe.
    fs.writeFileSync(codeCmd, '@echo off\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\n', 'utf8');
    assert.throws(() => resolveCodeCli(codeCmd), /Unsupported VS Code shim/);
  }

  assert.throws(() => resolveCodeCli(null, { PATH: path.join(testRoot, 'empty') }), /VS Code CLI not found/);
});

test('runner executes native mode with mock code CLI and verifies args and home preservation', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-native-test-'));
  const evidencePath = path.join(testRoot, 'evidence-native.json');
  const tempInstanceRoot = path.join(testRoot, 'instance-native');
  const synDir = path.join(testRoot, 'synthetic');

  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));

  const syn = createSyntheticArtifacts(synDir, '0.6.1');

  // Mock code runner recording invocation args
  const logFile = path.join(testRoot, 'code-invocations.log');
  const mockCodeRunner = path.join(testRoot, 'mock-code.cjs');
  const mockCodeContent = `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
    if (args.includes('--version')) {
      console.log('1.90.0');
      process.exit(0);
    }
    if (args.includes('--install-extension')) {
      console.log('Extension installed successfully');
      process.exit(0);
    }
    process.exit(0);
  `;
  fs.writeFileSync(mockCodeRunner, mockCodeContent, 'utf8');

  const result = await runAcceptance({
    dryRun: false,
    tarball: syn.tarballPath,
    vsix: syn.vsixPath,
    codePath: mockCodeRunner,
    evidencePath,
    tempParent: tempInstanceRoot,
  });

  assert.equal(result.status, 'INCOMPLETE', 'Status is INCOMPLETE because scenarios N2-N4 are deferred');
  assert.ok(fs.existsSync(evidencePath), 'Evidence JSON must be written');

  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.equal(evidence.mode, 'native');
  assert.equal(evidence.host.vscode, '1.90.0');
  assert.equal(evidence.runtime.serverStatus, 'operational');

  // Verify invocations of code
  assert.ok(fs.existsSync(logFile), 'Mock code CLI must have been invoked');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.length >= 2, 'Must have at least 2 code invocations: version probe and install');

  const probeCall = lines.find(args => args.includes('--version'));
  assert.ok(probeCall, 'Probe call must exist');
  assert.ok(probeCall.includes('--user-data-dir'));
  assert.ok(probeCall.includes('--extensions-dir'));

  const installCall = lines.find(args => args.includes('--install-extension'));
  assert.ok(installCall, 'Install call must exist');
  assert.ok(installCall.includes('--install-extension'));
  assert.ok(installCall.includes('--user-data-dir'));
  assert.ok(installCall.includes('--extensions-dir'));

  // Verify step_home_preservation succeeded
  const preservationStep = evidence.steps.find(s => s.id === 'step_home_preservation');
  assert.ok(preservationStep);
  assert.equal(preservationStep.status, 'PASS');
});

test('runner fails and reports violation when home preservation is broken', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-violation-test-'));
  const fakeHome = path.join(testRoot, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const fakeClaude = path.join(fakeHome, '.claude.json');
  fs.writeFileSync(fakeClaude, 'original content', 'utf8');

  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));

  const synDir = path.join(testRoot, 'synthetic');
  const syn = createSyntheticArtifacts(synDir, '0.6.1');
  const evidencePath = path.join(testRoot, 'evidence-violation.json');

  // Tamper with fake home during runtime probe by monkey-patching in synthetic stub
  const hostileParentEnv = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
  };

  // Modify fakeClaude right before run completes
  const mockCodeRunner = path.join(testRoot, 'mock-tamper-code.cjs');
  const mockCodeContent = `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('1.90.0');
      process.exit(0);
    }
    if (args.includes('--install-extension')) {
      // Tamper with the watched real home file
      fs.writeFileSync(${JSON.stringify(fakeClaude)}, 'tampered content', 'utf8');
      process.exit(0);
    }
    process.exit(0);
  `;
  fs.writeFileSync(mockCodeRunner, mockCodeContent, 'utf8');

  const result = await runAcceptance({
    dryRun: false,
    tarball: syn.tarballPath,
    vsix: syn.vsixPath,
    codePath: mockCodeRunner,
    parentEnv: hostileParentEnv,
    evidencePath,
  });

  assert.equal(result.status, 'FAIL');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const failStep = evidence.steps.find(s => s.status === 'FAIL');
  assert.ok(failStep);
  assert.equal(failStep.id, 'step_home_preservation');
  assert.match(failStep.error, /Home preservation violation/);
});


function writeMockCode(file, body) {
  fs.writeFileSync(file, `const args = process.argv.slice(2);\n${body}\nprocess.exit(0);\n`, 'utf8');
}

test('runner keeps a caller directory and only removes the root it created', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-owned-test-'));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));
  const parent = path.join(testRoot, 'parent');
  fs.mkdirSync(parent);
  const unrelated = path.join(parent, 'unrelated.txt');
  fs.writeFileSync(unrelated, 'keep', 'utf8');

  const result = await runAcceptance({ dryRun: true, evidencePath: path.join(testRoot, 'evidence.json'), tempParent: parent });

  assert.equal(result.status, 'INCOMPLETE');
  assert.deepEqual(fs.readdirSync(parent), ['unrelated.txt']);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('a failed VS Code version probe fails the host step and evidence keeps artifact digests', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-probe-test-'));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));
  const syn = createSyntheticArtifacts(path.join(testRoot, 'synthetic'), '0.6.1');
  const mockCode = path.join(testRoot, 'mock-code.cjs');
  writeMockCode(mockCode, "if (args.includes('--version')) { console.error('probe broke'); process.exit(3); }");
  const evidencePath = path.join(testRoot, 'evidence.json');

  const result = await runAcceptance({
    dryRun: false, tarball: syn.tarballPath, vsix: syn.vsixPath, codePath: mockCode, evidencePath, tempParent: testRoot,
  });

  assert.equal(result.status, 'FAIL');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const probe = evidence.steps.find(s => s.id === 'step_host_probe');
  assert.equal(probe.status, 'FAIL');
  assert.match(probe.error, /exit code 3/);
  assert.equal(evidence.host.vscode, null);
  assert.match(evidence.artifacts.tarball.sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.artifacts.vsix.version, '0.6.1');
  assert.equal(evidence.version, '0.6.1');
  // The home check still runs after the failure.
  assert.equal(evidence.steps.find(s => s.id === 'step_home_preservation').status, 'PASS');
});

test('credentials in subprocess output never reach the evidence file', async t => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-runner-secret-test-'));
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5 }));
  const syn = createSyntheticArtifacts(path.join(testRoot, 'synthetic'), '0.6.1');
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const mockCode = path.join(testRoot, 'mock-code.cjs');
  writeMockCode(mockCode, `if (args.includes('--version')) { console.log('1.90.0'); process.exit(0); }
if (args.includes('--install-extension')) { console.error('auth failed for https://user:hunter2secret@example.com token ${token}'); process.exit(1); }`);
  const evidencePath = path.join(testRoot, 'evidence.json');

  const result = await runAcceptance({
    dryRun: false, tarball: syn.tarballPath, vsix: syn.vsixPath, codePath: mockCode, evidencePath, tempParent: testRoot,
  });

  assert.equal(result.status, 'FAIL');
  const text = fs.readFileSync(evidencePath, 'utf8');
  assert.match(text, /VS Code extension installation failed/);
  assert.doesNotMatch(text, /hunter2secret/);
  assert.doesNotMatch(text, new RegExp(token));
});
