'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('S5 layout: retired internal forwarding shims are deleted and cannot be imported', () => {
  const retiredPaths = [
    'src/conversation.ts',
    'src/redaction.ts',
    'src/server.ts',
    'src/stdio-server.ts',
    'src/backends/consent.ts',
    'src/backends/governance.ts',
    'src/backends/model-catalog.ts',
    'src/backends/model-identifier.ts',
    'src/backends/model-selection.ts',
    'src/backends/model-store.ts',
    'src/backends/prices.ts',
    'src/backends/routing.ts',
    'src/execution/git.ts',
    'src/execution/stream.ts',
    'src/sessions/history.ts',
    'src/sessions/history-page.ts',
    'src/sessions/lock.ts',
    'src/tools',
  ];

  for (const rel of retiredPaths) {
    const full = path.join(root, rel);
    assert.equal(fs.existsSync(full), false, `Retired path must not exist: ${rel}`);
  }
});

test('S5 integrations: cli-readiness type cycle with setup.ts is eliminated', () => {
  const readinessPath = path.join(root, 'src', 'integrations', 'cli-readiness.ts');
  const content = fs.readFileSync(readinessPath, 'utf8');

  // Must import SetupClient from setup-clients.js, NOT setup.js
  assert.ok(content.includes("from './setup-clients.js'"), 'cli-readiness.ts must import from setup-clients.js');
  assert.ok(!content.includes("from './setup.js'"), 'cli-readiness.ts must not import from setup.js');
});

test('S5 layout: tests mirror source structure while preserving distinct purposes', () => {
  const mirroredDirs = [
    'tests/models',
    'tests/review',
    'tests/security',
    'tests/storage',
    'tests/workspace',
    'tests/mcp',
    'tests/backends',
    'tests/diagnostics',
    'tests/execution',
    'tests/integrations',
    'tests/sessions',
  ];

  for (const d of mirroredDirs) {
    const full = path.join(root, d);
    assert.ok(fs.existsSync(full), `Mirrored test directory must exist: ${d}`);
    assert.ok(fs.statSync(full).isDirectory(), `Must be directory: ${d}`);
  }

  // Preserved distinct test purposes
  const distinctDirs = ['tests/consumer', 'tests/e2e', 'tests/fixtures', 'tests/helpers'];

  for (const d of distinctDirs) {
    const full = path.join(root, d);
    assert.ok(fs.existsSync(full), `Distinct test purpose directory must exist: ${d}`);
    assert.ok(fs.statSync(full).isDirectory(), `Must be directory: ${d}`);
  }

  // tests/tools should be retired
  assert.equal(fs.existsSync(path.join(root, 'tests/tools')), false, 'tests/tools directory must be retired');
});

test('S5 graph: zero imports across the entire repository reference retired shims', () => {
  function walk(dir) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== '.artifacts') {
          files = files.concat(walk(full));
        }
      } else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) {
        files.push(full);
      }
    }
    return files;
  }

  const allFiles = walk(root);
  const retiredKeywords = [
    'src/conversation',
    'src/redaction',
    'src/server.',
    'src/stdio-server',
    'src/backends/consent',
    'src/backends/governance',
    'src/backends/model-catalog',
    'src/backends/model-identifier',
    'src/backends/model-selection',
    'src/backends/model-store',
    'src/backends/prices',
    'src/backends/routing',
    'src/execution/git.',
    'src/execution/stream.',
    'src/sessions/history.',
    'src/sessions/history-page',
    'src/sessions/lock',
    'src/tools/',
  ];

  const violations = [];
  const importRegex = /(?:import|export|require\()\s*(?:.*?from\s+)?['"]([^'"]+)['"]/g;

  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec).replace(/\\/g, '/');
        for (const kw of retiredKeywords) {
          if (resolved.includes(kw)) {
            violations.push(`${path.relative(root, file)} -> ${spec} (matches ${kw})`);
          }
        }
      }
    }
  }

  assert.deepEqual(violations, [], `Found imports referencing retired paths: ${violations.join(', ')}`);
});

test('S5 public entrypoints: index.js compatibility wrapper and package.json entries are intact', () => {
  const indexJs = path.join(root, 'index.js');
  assert.ok(fs.existsSync(indexJs), 'index.js compatibility wrapper must exist');
  const indexContent = fs.readFileSync(indexJs, 'utf8');
  assert.ok(indexContent.includes("require('./dist/index.cjs')"), 'index.js must delegate to dist/index.cjs');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'dist/index.cjs');
  assert.equal(pkg.bin.coagent8, './dist/index.cjs');
  assert.equal(pkg.bin['coagent8-mcp'], './dist/index.cjs');
});
