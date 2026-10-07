'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { isGovernedModel } = require('../../src/backends/governance.ts');
const { resolveWorkspacePath } = require('../../src/paths.ts');

test('isGovernedModel classifies astra and opus models as top-tier', () => {
  for (const model of ['astra', 'claude-3-opus', 'Opus', 'best', 'claude-opus-4-6-thinking', 'gpt-6-astra']) assert.equal(isGovernedModel(model), true, model);
  for (const model of ['gpt-6.1-sol', 'claude-3-7-sonnet', 'gemini-3.8-flash-high', undefined, null]) assert.equal(isGovernedModel(model), false, String(model));
});

test('resolveWorkspacePath validates directories strictly', () => {
  const cwd = resolveWorkspacePath(process.cwd());
  assert.equal(cwd, process.cwd());
  assert.equal(resolveWorkspacePath('.'),process.cwd());

  assert.throws(() => {
    resolveWorkspacePath('C:\\path\\that\\definitely\\does\\not\\exist_12345');
  }, /does not exist/);
});
