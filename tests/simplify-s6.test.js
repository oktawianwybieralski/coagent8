'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  checkDependencies,
  buildModuleGraph,
  findCycles,
  verifyBoundaries,
  getOwner,
  resolveTypeScript,
} = require('../scripts/check-dependencies.cjs');

const root = path.resolve(__dirname, '..');

function checkFixture(sources) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-boundary-regression-'));
  try {
    for (const [file, source] of Object.entries(sources)) {
      const target = path.join(fixtureRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    return checkDependencies({ rootDir: fixtureRoot, files: Object.keys(sources) });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test('S6 SDK boundaries: rejects transport SDK dependencies in every supported declaration form', () => {
  const sdk = '@modelcontextprotocol/sdk/types.js';
  const declarations = {
    'import.ts': `import { value } from '${sdk}'; export const result = value;`,
    'type-import.ts': `import type { Result } from '${sdk}'; export type Value = Result;`,
    'reexport.ts': `export { value } from '${sdk}';`,
    'type-reexport.ts': `export type { Result } from '${sdk}';`,
    'type-query.ts': `export type Value = import('${sdk}').Result;`,
    'dynamic.ts': `export const result = import('${sdk}');`,
    'require.ts': `export const result = require('${sdk}');`,
    'import-equals.cts': `import sdk = require('${sdk}'); export const result = sdk;`,
  };
  const sources = Object.fromEntries(Object.entries(declarations).map(([name, source]) => [`src/contracts/${name}`, source]));
  const result = checkFixture(sources);
  assert.equal(result.valid, false);
  for (const file of Object.keys(sources)) {
    assert.ok(result.violations.some(v => v.from === file && v.spec === sdk), `SDK dependency must be rejected: ${file}`);
  }
});

test('S6 SDK boundaries: preserves transport assets and Node imports, rejects editor SDK in core', () => {
  const allowed = checkFixture({
    'src/mcp/server.ts': "import type { Result } from '@modelcontextprotocol/sdk/types.js'; export type Value = Result;",
    'src/generated/server-icon.ts': "import type { Icon } from '@modelcontextprotocol/sdk/types.js'; export type Value = Icon;",
    'src/contracts/node.ts': "import type { Buffer } from 'node:buffer'; export type Value = Buffer;",
  });
  assert.equal(allowed.valid, true, JSON.stringify(allowed.violations));
  const rejected = checkFixture({
    'src/contracts/editor.ts': "import type { ExtensionContext } from 'vscode'; export type Value = ExtensionContext;",
    'src/generated/unrelated.ts': "export type { Result } from '@modelcontextprotocol/sdk/types.js';",
  });
  assert.equal(rejected.valid, false);
  assert.ok(rejected.violations.some(v => v.from === 'src/contracts/editor.ts'));
  assert.ok(rejected.violations.some(v => v.from === 'src/generated/unrelated.ts'));
});

test('S6 transitive boundaries: rejects the constants forwarding path and reports the complete path', () => {
  const result = checkFixture({
    'src/contracts/bad.ts': "export { value } from '../constants.js';",
    'src/constants.ts': "export { value } from './mcp/constants.js';",
    'src/mcp/constants.ts': 'export const value = 1;',
  });
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(v => v.from === 'src/constants.ts' && v.to === 'src/mcp/constants.ts'));
  const transitive = result.violations.find(v => v.from === 'src/contracts/bad.ts' && v.to === 'src/mcp/constants.ts');
  assert.ok(transitive, 'The contract must not acquire a transport dependency through a forwarding module');
  assert.deepEqual(transitive.dependencyPath, ['src/contracts/bad.ts', 'src/constants.ts', 'src/mcp/constants.ts']);
});

test('S6 transitive boundaries: follows type-only and dynamic paths to SDK and optional setup', () => {
  const result = checkFixture({
    'src/contracts/bad.ts': "export type { Value } from '../brand.js';",
    'src/brand.ts': "export type Value = import('@modelcontextprotocol/sdk/types.js').Result;",
    'src/execution/bad.ts': "export const result = import('../generated/bridge.js');",
    'src/generated/bridge.ts': "export { value } from '../integrations/setup.js';",
    'src/integrations/setup.ts': 'export const value = 1;',
  });
  assert.equal(result.valid, false);
  const sdk = result.violations.find(v => v.from === 'src/contracts/bad.ts' && v.toOwner === 'mcp-sdk');
  assert.ok(sdk, 'Type-only forwarding must not hide an SDK dependency');
  assert.equal(sdk.runtime, false);
  assert.ok(result.violations.some(v => v.from === 'src/execution/bad.ts' && v.to === 'src/integrations/setup.ts'));
});

test('S6 boundary checker: real repository passes with 0 violations and 0 cycles', () => {
  const result = checkDependencies({ rootDir: root });

  assert.equal(result.valid, true, 'checkDependencies must report valid: true for the repository');
  assert.equal(result.parseErrors.length, 0, `Expected 0 parse errors, got: ${JSON.stringify(result.parseErrors)}`);
  assert.equal(result.unresolved.length, 0, `Expected 0 unresolved imports, got: ${JSON.stringify(result.unresolved)}`);
  assert.equal(result.cycles.runtime.length, 0, `Expected 0 runtime cycles, got: ${JSON.stringify(result.cycles.runtime)}`);
  assert.equal(result.cycles.all.length, 0, `Expected 0 type/all cycles, got: ${JSON.stringify(result.cycles.all)}`);
  assert.equal(result.violations.length, 0, `Expected 0 boundary violations, got: ${JSON.stringify(result.violations)}`);
  assert.equal(result.allowedLegacyEdges.length, 0, 'No legacy exemptions should remain after S5');
  assert.ok(result.files.length >= 100, `Expected >= 100 source files, got: ${result.files.length}`);
});

test('S6 owner mapping: accurately categorizes all layers', () => {
  assert.equal(getOwner('src/contracts/models.ts'), 'contracts');
  assert.equal(getOwner('src/storage/lock.ts'), 'storage');
  assert.equal(getOwner('src/security/redaction.ts'), 'security');
  assert.equal(getOwner('src/workspace/git.ts'), 'workspace');
  assert.equal(getOwner('src/review/gate.ts'), 'review');
  assert.equal(getOwner('src/config.ts'), 'config');
  assert.equal(getOwner('src/paths.ts'), 'config');
  assert.equal(getOwner('src/sessions/session.ts'), 'sessions');
  assert.equal(getOwner('src/models/catalog.ts'), 'models');
  assert.equal(getOwner('src/backends/codex/adapter.ts'), 'backends');
  assert.equal(getOwner('src/execution/process.ts'), 'execution/runtime');
  assert.equal(getOwner('src/execution/runtime/stream.ts'), 'execution/runtime');
  assert.equal(getOwner('src/execution/controller.ts'), 'execution');
  assert.equal(getOwner('src/execution/selection.ts'), 'execution');
  assert.equal(getOwner('src/diagnostics/doctor.ts'), 'diagnostics');
  assert.equal(getOwner('src/mcp/server.ts'), 'mcp');
  assert.equal(getOwner('src/integrations/setup.ts'), 'integrations');
  assert.equal(getOwner('src/index.ts'), 'root');
  assert.equal(getOwner('src/brand.ts'), 'brand');
  assert.equal(getOwner('src/constants.ts'), 'unknown');
  assert.equal(getOwner('src/unassigned.ts'), 'unknown');
  assert.equal(getOwner('extensions/vscode/src/extension.ts'), 'extensions');
});

test('S6 fixtures: detects forbidden architectural boundary edges', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-boundary-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(path.join(srcDir, 'models'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'backends'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'execution'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'contracts'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'storage'), { recursive: true });

    // 1. models importing backends (forbidden)
    fs.writeFileSync(path.join(srcDir, 'backends', 'adapter.ts'), 'export const adapter = true;\n');
    fs.writeFileSync(
      path.join(srcDir, 'models', 'bad.ts'),
      "import { adapter } from '../backends/adapter.js';\nexport const m = adapter;\n"
    );

    // 2. execution importing mcp (forbidden)
    fs.writeFileSync(path.join(srcDir, 'mcp', 'view.ts'), 'export const view = true;\n');
    fs.writeFileSync(
      path.join(srcDir, 'execution', 'bad.ts'),
      "import { view } from '../mcp/view.js';\nexport const e = view;\n"
    );

    // 3. contracts importing storage (forbidden)
    fs.writeFileSync(path.join(srcDir, 'storage', 'disk.ts'), 'export const disk = true;\n');
    fs.writeFileSync(
      path.join(srcDir, 'contracts', 'bad.ts'),
      "import { disk } from '../storage/disk.js';\nexport const c = disk;\n"
    );

    const files = [
      'src/backends/adapter.ts',
      'src/models/bad.ts',
      'src/mcp/view.ts',
      'src/execution/bad.ts',
      'src/storage/disk.ts',
      'src/contracts/bad.ts',
    ];

    const result = checkDependencies({ rootDir: tmpDir, files });
    assert.equal(result.valid, false, 'Fixture with boundary violations must be invalid');
    assert.ok(result.violations.length >= 3, `Expected at least 3 violations, got: ${result.violations.length}`);

    const hasModelsToBackends = result.violations.some(
      v => v.fromOwner === 'models' && v.toOwner === 'backends'
    );
    assert.equal(hasModelsToBackends, true, 'Must detect models -> backends violation');

    const hasExecToMcp = result.violations.some(
      v => v.fromOwner === 'execution' && v.toOwner === 'mcp'
    );
    assert.equal(hasExecToMcp, true, 'Must detect execution -> mcp violation');

    const hasContractsToStorage = result.violations.some(
      v => v.fromOwner === 'contracts' && v.toOwner === 'storage'
    );
    assert.equal(hasContractsToStorage, true, 'Must detect contracts -> storage violation');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: detects runtime dependency cycles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-cycle-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src', 'cycle');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      "import { b } from './b.js';\nexport const a = () => b();\n"
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      "import { a } from './a.js';\nexport const b = () => a();\n"
    );

    const files = ['src/cycle/a.ts', 'src/cycle/b.ts'];
    const result = checkDependencies({ rootDir: tmpDir, files });

    assert.equal(result.valid, false, 'Cycle must cause checkDependencies to fail');
    assert.ok(result.cycles.runtime.length > 0, 'Must detect runtime cycle');
    assert.deepEqual(result.cycles.runtime[0].sort(), ['src/cycle/a.ts', 'src/cycle/b.ts']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: detects type-only dependency cycles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-type-cycle-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src', 'typecycle');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'foo.ts'),
      "import type { Bar } from './bar.js';\nexport interface Foo { bar: Bar; }\n"
    );
    fs.writeFileSync(
      path.join(srcDir, 'bar.ts'),
      "import type { Foo } from './foo.js';\nexport interface Bar { foo: Foo; }\n"
    );

    const files = ['src/typecycle/foo.ts', 'src/typecycle/bar.ts'];
    const result = checkDependencies({ rootDir: tmpDir, files });

    assert.equal(result.valid, false, 'Type cycle must cause checkDependencies to fail');
    assert.equal(result.cycles.runtime.length, 0, 'Should not detect as runtime cycle');
    assert.ok(result.cycles.all.length > 0, 'Must detect type cycle in all cycles');
    assert.deepEqual(result.cycles.all[0].sort(), ['src/typecycle/bar.ts', 'src/typecycle/foo.ts']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: detects unresolved relative imports', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-unresolved-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src', 'broken');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      "import { missing } from './does-not-exist.js';\nexport const x = missing;\n"
    );

    const files = ['src/broken/main.ts'];
    const result = checkDependencies({ rootDir: tmpDir, files });

    assert.equal(result.valid, false, 'Unresolved import must cause checkDependencies to fail');
    assert.equal(result.unresolved.length, 1, 'Must record 1 unresolved import');
    assert.equal(result.unresolved[0].spec, './does-not-exist.js');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 legacy tracking: allows individually recorded legacy edges and rejects others', () => {
  const edges = [
    {
      from: 'src/models/legacy.ts',
      to: 'src/backends/adapter.ts',
      line: 1,
      spec: '../backends/adapter.js',
      kind: 'import',
      runtime: true,
    },
    {
      from: 'src/models/unrecorded.ts',
      to: 'src/backends/adapter.ts',
      line: 1,
      spec: '../backends/adapter.js',
      kind: 'import',
      runtime: true,
    },
  ];

  const allowedLegacyEdges = [
    {
      from: 'src/models/legacy.ts',
      to: 'src/backends/adapter.ts',
      removalStage: 'S6',
    },
  ];

  const violations = verifyBoundaries(edges, { allowedLegacyEdges });
  assert.equal(violations.length, 1, 'Only unrecorded edge should be reported as violation');
  assert.equal(violations[0].from, 'src/models/unrecorded.ts');
});

test('S6 fixtures: discovers untracked source files and detects their forbidden edges and cycles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-untracked-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(path.join(srcDir, 'models'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'backends'), { recursive: true });

    // Backends module
    fs.writeFileSync(path.join(srcDir, 'backends', 'adapter.ts'), 'export const adapter = 1;\n');

    // Untracked new model module with forbidden dependency to backends
    fs.writeFileSync(
      path.join(srcDir, 'models', 'untracked-forbidden.ts'),
      "import { adapter } from '../backends/adapter.js';\nexport const val = adapter;\n"
    );

    // Run without passing explicit files array (relies on directory crawling)
    const result = checkDependencies({ rootDir: tmpDir });

    assert.equal(result.valid, false, 'Untracked module with forbidden edge must fail verification');
    const hasViolation = result.violations.some(
      v => v.fromOwner === 'models' && v.toOwner === 'backends'
    );
    assert.equal(hasViolation, true, 'Must detect models -> backends violation from untracked file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: rejects unallowed computed require/import calls in source modules', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-computed-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src', 'models');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'sneaky.ts'),
      "const pkg = '../backends/adapter.js';\nconst mod = require(pkg);\nexport const x = mod;\n"
    );

    const files = ['src/models/sneaky.ts'];
    const result = checkDependencies({ rootDir: tmpDir, files });

    assert.equal(result.valid, false, 'Computed require in non-root module must cause verification failure');
    assert.ok(result.computedViolations.length >= 1, 'Must report computed call violation');
    assert.equal(result.computedViolations[0].from, 'src/models/sneaky.ts');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: correctly classifies runtime dependencies and cycles under ESM compiler options', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-esm-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src', 'esm');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      "import { b } from './b.js';\nexport const a = () => b();\n"
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      "import { a } from './a.js';\nexport const b = () => a();\n"
    );

    const ts = resolveTypeScript(tmpDir);
    const compilerOptions = {
      noEmit: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    };

    const files = ['src/esm/a.ts', 'src/esm/b.ts'];
    const result = checkDependencies({ rootDir: tmpDir, files, compilerOptions });

    assert.equal(result.valid, false, 'ESM runtime cycle must cause verification to fail');
    assert.ok(result.cycles.runtime.length > 0, 'Must detect ESM runtime cycle in cycles.runtime');
    assert.deepEqual(result.cycles.runtime[0].sort(), ['src/esm/a.ts', 'src/esm/b.ts']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: rejects arbitrary root targets containing setup.cjs in src/index.ts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-root-computed-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Arbitrary dynamic target in src/index.ts that mentions setup.cjs but is not the exact AST path.join(__dirname, 'setup.cjs')
    fs.writeFileSync(
      path.join(srcDir, 'index.ts'),
      "const target = 'bad';\nconst mod = require(target || './setup.cjs');\nexport const x = mod;\n"
    );

    const files = ['src/index.ts'];
    const result = checkDependencies({ rootDir: tmpDir, files });

    assert.equal(result.valid, false, 'Arbitrary root dynamic target must fail verification');
    assert.ok(result.computedViolations.length >= 1, 'Must report computed call violation');
    assert.equal(result.computedViolations[0].from, 'src/index.ts');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('S6 fixtures: discovers .mts and .cts modules and detects their forbidden edges and cycles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-mts-cts-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(path.join(srcDir, 'models'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'backends'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'cycle'), { recursive: true });

    // 1. .mts file in models importing backends
    fs.writeFileSync(path.join(srcDir, 'backends', 'adapter.cts'), 'export const adapter = 1;\n');
    fs.writeFileSync(
      path.join(srcDir, 'models', 'bad.mts'),
      "import { adapter } from '../backends/adapter.cjs';\nexport const x = adapter;\n"
    );

    // 2. .cts files in cycle
    fs.writeFileSync(
      path.join(srcDir, 'cycle', 'c1.cts'),
      "import { c2 } from './c2.cjs';\nexport const c1 = () => c2();\n"
    );
    fs.writeFileSync(
      path.join(srcDir, 'cycle', 'c2.cts'),
      "import { c1 } from './c1.cjs';\nexport const c2 = () => c1();\n"
    );

    const result = checkDependencies({ rootDir: tmpDir });

    assert.equal(result.valid, false, 'mts and cts modules with violations/cycles must fail');
    const hasModelsToBackends = result.violations.some(
      v => v.fromOwner === 'models' && v.toOwner === 'backends'
    );
    assert.equal(hasModelsToBackends, true, 'Must detect forbidden edge in .mts file');
    assert.ok(result.cycles.runtime.length > 0, 'Must detect cycle in .cts files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



