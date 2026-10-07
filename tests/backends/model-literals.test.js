const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

// Owner decision of 2026-10-07 ("hardcoding is bad", EXEC-001): models, defaults and aliases
// come from the CLIs and the user's configuration, never from the bridge's source. Comments
// may quote recorded CLI output; the code itself may not name a model.
const MODEL_NAME = /\b(?:gpt-\d[\w.-]*|gemini-\d[\w.-]*|claude-(?:\d|opus|sonnet|haiku|fable)[\w.-]*|sonnet|haiku|opus|astra|luna|fable)\b/gi;
// Consent still uses name families until consent by relative price replaces them (EXEC-001).
const PENDING = new Set(['backends/governance.ts']);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

test('no model name in source code: defaults and aliases come from the CLIs and the configuration', () => {
  const root = path.join(__dirname, '../../src');
  const offenders = sourceFiles(root).flatMap(file => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (PENDING.has(relative)) return [];
    // esbuild drops every comment and keeps string, template and regular-expression literals.
    const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', legalComments: 'none' });
    return [...code.matchAll(MODEL_NAME)].map(match => `${relative}: ${match[0]}`);
  });
  assert.deepEqual(offenders, []);
});
