'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { checkModelGovernance, resolveWorkspacePath } = require('../src/backends/policy.ts');

test('checkModelGovernance blocks astra and opus without user confirmation', () => {
  const astraBlocked = checkModelGovernance('astra', false);
  assert.ok(astraBlocked);
  assert.equal(astraBlocked.isError, true);
  assert.match(astraBlocked.content[0].text, /GOVERNANCE ERROR/);

  const opusBlocked = checkModelGovernance('claude-3-opus', false);
  assert.ok(opusBlocked);
  assert.equal(opusBlocked.isError, true);

  // When user confirms
  const astraAllowed = checkModelGovernance('astra', true);
  assert.equal(astraAllowed, null);

  const opusAllowed = checkModelGovernance('claude-3-opus', true);
  assert.equal(opusAllowed, null);

  // Standard models do not require confirmation
  assert.equal(checkModelGovernance('gpt-6.1-sol', false), null);
  assert.equal(checkModelGovernance('claude-3-7-sonnet', false), null);
});

test('resolveWorkspacePath validates directories strictly', () => {
  const cwd = resolveWorkspacePath(process.cwd());
  assert.equal(cwd, process.cwd());
  assert.equal(resolveWorkspacePath('.'),process.cwd());

  assert.throws(() => {
    resolveWorkspacePath('C:\\path\\that\\definitely\\does\\not\\exist_12345');
  }, /does not exist/);
});
