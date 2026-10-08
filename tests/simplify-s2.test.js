'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { executeTask } = require('../src/execution/controller.ts');
const { adapterRegistry } = require('../src/backends/registry.ts');
const { saveConfig } = require('../src/config.ts');
const { evaluateStateEnvelopeGate } = require('../src/review/gate.ts');
const { formatExecutionResult } = require('../src/mcp/result.ts');

test('S2 neutral controller: executeTask returns neutral object without MCP markdown content', async () => {
  const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'coagent8-s2-test-'));
  const originalAgy = adapterRegistry.agy;
  try {
    adapterRegistry.agy = {
      id: 'agy',
      name: 'fixture',
      probe: async () => ({
        installed: true,
        version: '1.0.0',
        authStatus: 'authenticated',
        executionSupported: true,
        capabilities: { readOnlyVerified: true, resume: true, streaming: true, reasoningEffort: true },
        config: { defaultModel: 'gemini-3.8-flash' },
      }),
      execute: async (_prompt, _opts) => ({
        status: 'completed',
        isError: false,
        output: 'Neutral evidence output',
        model: 'gemini-3.8-flash',
        truncated: false,
        continuationAvailable: true,
        nativeSessionId: 'sess-neutral-123',
      }),
    };

    saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

    const outcome = await executeTask('Neutral prompt', 'Public question', { backend: 'agy' }, tempDir);

    // Verify neutral contract
    assert.equal(outcome.isError, false);
    assert.equal(outcome.provider, 'agy');
    assert.equal(typeof outcome.sessionHandle, 'string');
    assert.equal(outcome.result.output, 'Neutral evidence output');
    assert.equal(outcome.result.model, 'gemini-3.8-flash');
    assert.equal(typeof outcome.meta.durationMs, 'number');
    assert.equal(outcome.meta.turn, 1);
    assert.ok(Array.isArray(outcome.warnings));

    // Crucial: No MCP formatting / content field in neutral result
    assert.equal(outcome.content, undefined, 'Neutral TaskExecutionResult must not contain MCP content array');

    // Transport edge formatting
    const formatted = formatExecutionResult(outcome);
    assert.equal(formatted.isError, false);
    assert.equal(formatted.content.length, 1);
    assert.equal(formatted.content[0].type, 'text');
    assert.ok(formatted.content[0].text.includes('Neutral evidence output'));
    assert.ok(formatted.content[0].text.includes('> CoAgent8: agy · gemini-3.8-flash'));
  } finally {
    adapterRegistry.agy = originalAgy;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('S2 review module: review gate and verdict policy evaluate properly', () => {
  const envelope = [
    'REVIEW: 1',
    'SNAPSHOT: sha123#digest456',
    'COVERAGE: COMPLETE',
    'VERDICT: READY',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  const evalResult = evaluateStateEnvelopeGate(envelope, false, true);
  assert.equal(evalResult.verdict, 'READY');

  const blockedEnvelope = [
    'REVIEW: 1',
    'SNAPSHOT: sha123#digest456',
    'COVERAGE: PARTIAL',
    'VERDICT: READY',
    'CHECKS: typecheck=PASS; tests=PASS',
    'END_REVIEW',
  ].join('\n');

  const blockedResult = evaluateStateEnvelopeGate(blockedEnvelope, false, true);
  assert.equal(blockedResult.verdict, 'BLOCKED');
  assert.equal(blockedResult.reason, 'Review coverage is partial; the reviewer answered READY');

});

test('S2 boundaries: execution and review have zero imports from mcp or sdk', () => {
  const root = path.resolve(__dirname, '..');
  const checkDir = (dirRel) => {
    const dirAbs = path.join(root, dirRel);
    const files = fs.readdirSync(dirAbs, { recursive: true })
      .filter(f => typeof f === 'string' && f.endsWith('.ts'))
      .map(f => path.join(dirAbs, f));

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
      for (const match of importMatches) {
        const specifier = match[1];
        assert.ok(
          !specifier.includes('/mcp/') && !specifier.includes('@modelcontextprotocol'),
          `Forbidden MCP import in ${path.relative(root, file)}: ${specifier}`
        );
      }
    }
  };

  checkDir('src/execution');
  checkDir('src/review');

  const checkNoMcpOrConstants = (dirRel) => {
    const dirAbs = path.join(root, dirRel);
    const files = fs.readdirSync(dirAbs, { recursive: true })
      .filter(f => typeof f === 'string' && f.endsWith('.ts'))
      .map(f => path.join(dirAbs, f));

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
      for (const match of importMatches) {
        const specifier = match[1];
        assert.ok(
          !specifier.includes('/mcp/') && !specifier.includes('@modelcontextprotocol') && !specifier.includes('constants.js'),
          `Forbidden MCP/constants import in ${path.relative(root, file)}: ${specifier}`
        );
      }
    }
  };

  checkNoMcpOrConstants('src/backends');
  checkNoMcpOrConstants('src/diagnostics');
});

