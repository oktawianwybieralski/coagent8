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
const { runAcceptance, SCHEMA_VERSION } = require('../../tooling/acceptance/runner.cjs');

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
    tempRoot: tempInstanceRoot,
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
  assert.equal(fs.existsSync(tempInstanceRoot), false, 'Temporary instance root must be cleaned up on success');
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
    tempRoot: tempInstanceRoot,
  });

  assert.equal(result.status, 'FAIL');
  assert.ok(fs.existsSync(evidencePath), 'Evidence JSON must still be written on failure');
  assert.equal(fs.existsSync(tempInstanceRoot), false, 'Temporary instance root must be cleaned up on failure');
});

