const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createToolDefinitions,
  getCoreCanonicalTools,
  getLegacyAliasTools,
  getAllCallableToolDefinitions,
} = require('../src/server.ts');
const {
  CANONICAL_TOOL_NAMES,
  CORE_CANONICAL_TOOL_NAMES,
  DEPRECATED_LEGACY_TOOL_NAMES,
} = require('../src/constants/index.ts');
const { handleConsult } = require('../src/tools/consult.tool.ts');
const { handleAnalyze } = require('../src/tools/analyze.tool.ts');
const { handleDebugError } = require('../src/tools/debug.tool.ts');
const { handleImplement } = require('../src/tools/implement.tool.ts');
const { handleRun, runToolDefinition } = require('../src/tools/run.tool.ts');

test('SURFACE-001: core canonical tools interface defines exactly 6 canonical tools', () => {
  const coreTools = getCoreCanonicalTools();
  assert.equal(coreTools.length, 6, 'Must define exactly 6 core canonical tools');
  const names = coreTools.map(t => t.name).sort();
  assert.deepEqual(names, [
    'cancel',
    'consult',
    'doctor',
    'issue',
    'review',
    'session',
  ]);
  assert.deepEqual([...CORE_CANONICAL_TOOL_NAMES].sort(), names);
});

test('SURFACE-001: legacy aliases define analyze, debug, implement with deprecation notice', () => {
  const legacyTools = getLegacyAliasTools();
  assert.equal(legacyTools.length, 3);
  const names = legacyTools.map(t => t.name).sort();
  assert.deepEqual(names, ['analyze', 'debug', 'implement']);
  assert.deepEqual([...DEPRECATED_LEGACY_TOOL_NAMES].sort(), names);

  for (const tool of legacyTools) {
    assert.ok(
      tool.description.includes('[Deprecated: Use consult with task_type='),
      `Tool ${tool.name} must have deprecation notice in description`
    );
  }
});

test('SURFACE-001: consult inputSchema supports optional task_type and context_files', () => {
  const tools = createToolDefinitions();
  const consult = tools.find(t => t.name === 'consult');
  assert.ok(consult, 'consult tool must be present');

  const schema = consult.inputSchema;
  assert.ok(schema.properties.task_type, 'task_type property must exist');
  assert.deepEqual(schema.properties.task_type.enum, ['architecture', 'debug', 'implementation']);
  assert.ok(schema.properties.context_files, 'context_files property must exist');
  assert.ok(schema.properties.file_paths, 'file_paths property must exist');
  assert.deepEqual(schema.required, ['proposal']);
});

test('SURFACE-001: debug inputSchema does not expose phantom context_files property', () => {
  const tools = createToolDefinitions();
  const debug = tools.find(t => t.name === 'debug');
  assert.ok(debug, 'debug tool must be present');
  assert.equal(debug.inputSchema.properties.context_files, undefined, 'debug schema must not contain phantom context_files');
  assert.ok(debug.inputSchema.properties.file_paths, 'debug schema must contain file_paths');
});

test('SURFACE-001: run tool inputSchema supports both canonical and legacy actions', () => {
  const actions = runToolDefinition.inputSchema.properties.action.enum;
  assert.deepEqual(actions, ['consult', 'review', 'issue', 'analyze', 'debug', 'implement']);
  assert.ok(runToolDefinition.inputSchema.properties.task_type, 'run gateway must accept task_type');
});

test('SURFACE-001: run gateway validates required parameters per action', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-surface-'));
  try {
    // consult requires proposal
    await assert.rejects(
      async () => handleRun({ action: 'consult' }, tempDir),
      /proposal must be a non-empty string for action "consult"/
    );

    // analyze requires task
    await assert.rejects(
      async () => handleRun({ action: 'analyze' }, tempDir),
      /task must be a non-empty string for action "analyze"/
    );

    // debug requires error_message
    await assert.rejects(
      async () => handleRun({ action: 'debug' }, tempDir),
      /error_message must be a non-empty string for action "debug"/
    );

    // implement requires specification
    await assert.rejects(
      async () => handleRun({ action: 'implement' }, tempDir),
      /specification must be a non-empty string for action "implement"/
    );

    // unknown action throws
    await assert.rejects(
      async () => handleRun({ action: 'unknown_action' }, tempDir),
      /Unknown action "unknown_action"/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('SURFACE-001: direct legacy handlers validate required parameters', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-surface-direct-'));
  try {
    const analyzeRes = await handleAnalyze('analyze', { task: '' }, tempDir);
    assert.equal(analyzeRes.isError, true);
    assert.ok(analyzeRes.content[0].text.includes('Validation Error: task must be a non-empty string.'));

    const debugRes = await handleDebugError({ error_message: '' }, tempDir);
    assert.equal(debugRes.isError, true);
    assert.ok(debugRes.content[0].text.includes('Validation Error: error_message must be a non-empty string.'));

    const implementRes = await handleImplement({ specification: '' }, tempDir);
    assert.equal(implementRes.isError, true);
    assert.ok(implementRes.content[0].text.includes('Validation Error: specification must be a non-empty string.'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

