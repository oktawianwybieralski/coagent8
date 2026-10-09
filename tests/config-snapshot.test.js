'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-snapshot-test-'));
const testConfigFile = path.join(tempDir, 'custom-config.json');

const {
  loadConfigSnapshot,
  loadConfigSnapshotForDiagnostics,
  getConfigFileOrigin,
  loadConfig,
  saveConfig,
} = require('../src/config.ts');
const { runDoctor, runModelReport } = require('../src/diagnostics/doctor.ts');
const { EDITOR_SETTINGS_ENV } = require('../src/config-overrides.ts');
const { executeTask } = require('../src/execution/controller.ts');
const { adapterRegistry } = require('../src/backends/registry.ts');

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

test('EXEC-001-T03: loadConfigSnapshot provides effective settings, disk provenance, and deterministic identity', () => {
  const savedConfigEnv = process.env.coagent8_CONFIG;
  const savedEditorEnv = process.env[EDITOR_SETTINGS_ENV];
  delete process.env.coagent8_CONFIG;
  delete process.env[EDITOR_SETTINGS_ENV];

  try {
    // 1. Defaults when file does not exist
    const nonExistentPath = path.join(tempDir, 'does-not-exist.json');
    const defaultSnapshot = loadConfigSnapshot(nonExistentPath);

    assert.equal(defaultSnapshot.config.schemaVersion, 1);
    assert.equal(defaultSnapshot.config.defaultBackend, null);
    assert.equal(defaultSnapshot.provenance.fileExisted, false);
    assert.equal(defaultSnapshot.provenance.configFileOrigin, 'default-path');
    assert.equal(defaultSnapshot.provenance.sources.defaultBackend, 'default');
    assert.equal(defaultSnapshot.provenance.sources['routing.strategy'], 'default');
    assert.equal(defaultSnapshot.provenance.editorOverridesApplied.length, 0);
    assert.match(defaultSnapshot.changeIdentity, /^[0-9a-f]{16}$/);

    // 2. File settings when file exists
    fs.writeFileSync(
      testConfigFile,
      JSON.stringify({
        schemaVersion: 1,
        defaultBackend: 'claude',
        routing: { strategy: 'fixed', allowedBackends: ['claude'] },
        governance: { priceMultiplier: 3, askAbovePrice: 15, alwaysAsk: ['model-a'] },
      }),
      'utf8'
    );
    process.env.coagent8_CONFIG = testConfigFile;
    assert.equal(getConfigFileOrigin(), 'custom-env');

    const fileSnapshot = loadConfigSnapshot(testConfigFile);
    assert.equal(fileSnapshot.config.defaultBackend, 'claude');
    assert.equal(fileSnapshot.provenance.fileExisted, true);
    assert.equal(fileSnapshot.provenance.configFileOrigin, 'custom-env');
    assert.equal(fileSnapshot.provenance.sources.defaultBackend, 'file');
    assert.equal(fileSnapshot.provenance.sources['routing.strategy'], 'file');
    assert.equal(fileSnapshot.provenance.sources['governance.alwaysAsk'], 'file');
    assert.equal(fileSnapshot.provenance.sources['governance.neverAsk'], 'default');
    assert.ok(fileSnapshot.provenance.fileStat);
    assert.ok(fileSnapshot.provenance.fileStat.size > 0);
    assert.notEqual(fileSnapshot.changeIdentity, defaultSnapshot.changeIdentity);

    // 3. VS Code editor settings override
    process.env[EDITOR_SETTINGS_ENV] = JSON.stringify({
      defaultBackend: 'codex',
      'approval.alwaysAskModels': ['model-b'],
    });

    const editorSnapshot = loadConfigSnapshot(testConfigFile);
    assert.equal(editorSnapshot.config.defaultBackend, 'codex');
    assert.equal(editorSnapshot.provenance.sources.defaultBackend, 'editor');
    // List merge: file had model-a, editor added model-b -> merged
    assert.equal(editorSnapshot.provenance.sources['governance.alwaysAsk'], 'merged');
    assert.deepEqual(editorSnapshot.config.governance.alwaysAsk, ['model-a', 'model-b']);
    assert.deepEqual(editorSnapshot.provenance.editorOverridesApplied, [
      'defaultBackend',
      'approval.alwaysAskModels',
    ]);
    assert.notEqual(editorSnapshot.changeIdentity, fileSnapshot.changeIdentity);
  } finally {
    if (savedConfigEnv !== undefined) process.env.coagent8_CONFIG = savedConfigEnv;
    else delete process.env.coagent8_CONFIG;
    if (savedEditorEnv !== undefined) process.env[EDITOR_SETTINGS_ENV] = savedEditorEnv;
    else delete process.env[EDITOR_SETTINGS_ENV];
  }
});

test('EXEC-001-T03: malformed configuration fails closed for execution but loads diagnostic provenance for doctor', () => {
  const malformedPath = path.join(tempDir, 'malformed.json');
  fs.writeFileSync(malformedPath, '{"broken": [true,', 'utf8');

  // loadConfigSnapshot throws POLICY_DENIED
  assert.throws(
    () => loadConfigSnapshot(malformedPath),
    err => err.code === 'POLICY_DENIED' && /Malformed JSON/.test(err.message)
  );

  // loadConfigSnapshotForDiagnostics catches and provides fallback with error
  const diagnosticSnapshot = loadConfigSnapshotForDiagnostics(malformedPath);
  assert.equal(diagnosticSnapshot.config.schemaVersion, 1);
  assert.equal(diagnosticSnapshot.provenance.fileExisted, true);
  assert.ok(diagnosticSnapshot.error);
  assert.match(diagnosticSnapshot.error, /Malformed JSON/);
  assert.match(diagnosticSnapshot.changeIdentity, /^[0-9a-f]{16}$/);

  // With editor overrides present, fallback provenance must describe returned defaults,
  // recording attempted editor settings separately without claiming they were applied
  const savedEditorEnv = process.env[EDITOR_SETTINGS_ENV];
  process.env[EDITOR_SETTINGS_ENV] = JSON.stringify({ defaultBackend: 'codex' });
  try {
    const fallbackWithOverrides = loadConfigSnapshotForDiagnostics(malformedPath);
    assert.equal(fallbackWithOverrides.config.defaultBackend, null, 'returns untouched defaultBackend');
    assert.deepEqual(fallbackWithOverrides.provenance.editorOverridesApplied, [], 'no overrides applied');
    assert.deepEqual(fallbackWithOverrides.provenance.editorOverridesAttempted, ['defaultBackend'], 'attempted recorded');
    assert.equal(fallbackWithOverrides.provenance.sources.defaultBackend, 'default', 'attributes to defaults');
  } finally {
    if (savedEditorEnv !== undefined) process.env[EDITOR_SETTINGS_ENV] = savedEditorEnv;
    else delete process.env[EDITOR_SETTINGS_ENV];
  }
});

test('EXEC-001-T03: doctor includes redacted configuration provenance and custom-env recommendations', async () => {
  const savedConfigEnv = process.env.coagent8_CONFIG;
  const savedEditorEnv = process.env[EDITOR_SETTINGS_ENV];
  process.env.coagent8_CONFIG = testConfigFile;
  process.env[EDITOR_SETTINGS_ENV] = JSON.stringify({
    defaultBackend: 'codex',
  });

  try {
    fs.writeFileSync(
      testConfigFile,
      JSON.stringify({
        schemaVersion: 1,
        defaultBackend: 'claude',
        routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'agy'] },
      }),
      'utf8'
    );

    const report = await runDoctor({ quota: false });
    assert.ok(report.configProvenance);
    assert.equal(report.configProvenance.origin, 'custom-env');
    assert.equal(report.configProvenance.existed, true);
    assert.deepEqual(report.configProvenance.overrides, ['defaultBackend']);
    assert.match(report.configProvenance.changeIdentity, /^[0-9a-f]{16}$/);
    // Home directory path must be redacted if inside user home
    if (testConfigFile.startsWith(os.homedir())) {
      assert.match(report.configProvenance.path, /^~/);
    }

    // Recommendation explains active coagent8_CONFIG override
    assert.ok(
      report.recommendations.some(r => r.includes('custom path active from coagent8_CONFIG')),
      'doctor explains custom config path'
    );
    assert.ok(
      report.recommendations.some(r => r.includes('editor setting override(s) active')),
      'doctor explains active editor overrides'
    );

    // Model report also includes configProvenance
    const modelReport = await runModelReport({});
    assert.ok(modelReport.configProvenance);
    assert.equal(modelReport.configProvenance.origin, 'custom-env');
  } finally {
    if (savedConfigEnv !== undefined) process.env.coagent8_CONFIG = savedConfigEnv;
    else delete process.env.coagent8_CONFIG;
    if (savedEditorEnv !== undefined) process.env[EDITOR_SETTINGS_ENV] = savedEditorEnv;
    else delete process.env[EDITOR_SETTINGS_ENV];
  }
});

test('EXEC-001-T03: execution preparation loads configuration snapshot once and passes through routing and selection', async () => {
  const { setConfigLoadObserver } = require('../src/config.ts');
  let snapshotLoadCount = 0;

  setConfigLoadObserver(() => {
    snapshotLoadCount++;
  });

  const origCodex = adapterRegistry.codex;
  adapterRegistry.codex = {
    ...origCodex,
    probe: async () => ({
      id: 'codex',
      installed: true,
      executionSupported: true,
      authStatus: 'authenticated',
      capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
    }),
    listModels: async () => ({
      source: 'codex models',
      models: [{ id: 'gpt-6.1-sol', efforts: ['low', 'high'], effortRequired: false }],
    }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'test answer',
      nativeSessionId: 'test-native-1',
      continuationAvailable: true,
    }),
  };

  try {
    snapshotLoadCount = 0;
    const result = await executeTask(
      'test prompt',
      'test input',
      { backend: 'codex', model: 'gpt-6.1-sol' },
      tempDir
    );

    assert.equal(result.isError, false);
    // Verified: Exactly ONE config snapshot loaded during preparation (not separate reads across routing, selection, and consent)
    assert.equal(snapshotLoadCount, 1, `expected 1 snapshot load during preparation, got ${snapshotLoadCount}`);
  } finally {
    setConfigLoadObserver(null);
    adapterRegistry.codex = origCodex;
  }
});
