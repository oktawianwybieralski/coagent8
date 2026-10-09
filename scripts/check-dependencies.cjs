'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

function resolveTypeScript(customRoot) {
  const searchRoots = [
    path.resolve(__dirname, '../tooling/documentation'),
    customRoot || path.resolve(__dirname, '..'),
    process.cwd(),
  ];

  for (const root of searchRoots) {
    try {
      const resolved = require.resolve('typescript', { paths: [root] });
      const ts = require(resolved);
      if (typeof ts.createSourceFile === 'function') {
        return ts;
      }
    } catch {
      // try next path
    }
  }

  throw new Error(
    'TypeScript compiler API not found. Ensure tooling dependencies are installed (e.g. npm ci --prefix tooling/documentation).'
  );
}

const RUNTIME_PRIMITIVES = new Set([
  'src/execution/process.ts',
  'src/execution/cli-resolver.ts',
  'src/execution/nested-turn.ts',
  'src/execution/stream-reducer.ts',
]);

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function getOwner(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.startsWith('extensions/')) return 'extensions';
  if (!normalized.startsWith('src/')) return 'other';

  const p = normalized.slice(4); // strip 'src/'
  if (p.startsWith('contracts/')) return 'contracts';
  if (p.startsWith('storage/')) return 'storage';
  if (p.startsWith('security/')) return 'security';
  if (p.startsWith('workspace/')) return 'workspace';
  if (p.startsWith('review/')) return 'review';
  if (p === 'config.ts' || p === 'config-overrides.ts' || p === 'paths.ts') return 'config';
  if (p.startsWith('sessions/')) return 'sessions';
  if (p.startsWith('models/')) return 'models';
  if (p.startsWith('backends/')) return 'backends';
  if (p.startsWith('execution/runtime/') || RUNTIME_PRIMITIVES.has(normalized)) return 'execution/runtime';
  if (p.startsWith('execution/')) return 'execution';
  if (p.startsWith('diagnostics/')) return 'diagnostics';
  if (p.startsWith('mcp/')) return 'mcp';
  if (p.startsWith('integrations/')) return 'integrations';
  if (p.startsWith('generated/')) return 'generated';
  if (p === 'brand.ts') return 'brand';
  if (p === 'constants.ts') return 'constants';
  if (p === 'index.ts') return 'root';
  return 'root';
}

const BOUNDARY_RULES = [
  {
    from: 'contracts',
    forbidden: [
      'storage', 'security', 'workspace', 'review', 'config', 'sessions',
      'models', 'backends', 'execution', 'execution/runtime', 'diagnostics',
      'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'contracts/ defines pure types and shared constants; it must not import any implementation module.',
  },
  {
    from: 'storage',
    forbidden: [
      'security', 'workspace', 'review', 'config', 'sessions',
      'models', 'backends', 'execution', 'execution/runtime', 'diagnostics',
      'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'storage/ owns file locking and atomic writes; it must not import application policy or higher-level mechanisms.',
  },
  {
    from: 'security',
    forbidden: [
      'storage', 'workspace', 'review', 'config', 'sessions',
      'models', 'backends', 'execution', 'diagnostics',
      'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'security/ owns redaction and credential boundaries; it must not depend on sessions, models, backends, or presentation.',
  },
  {
    from: 'workspace',
    forbidden: [
      'review', 'config', 'sessions', 'models', 'backends', 'execution',
      'diagnostics', 'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'workspace/ owns workspace resolution and bounded git evidence; it must not import sessions, application execution, or transport.',
  },
  {
    from: 'review',
    forbidden: [
      'sessions', 'models', 'backends', 'execution', 'diagnostics',
      'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'review/ evaluates input completeness and state envelope gates; it must not format MCP envelopes or depend on execution.',
  },
  {
    from: 'config',
    forbidden: [
      'review', 'sessions', 'models', 'backends', 'execution',
      'execution/runtime', 'diagnostics', 'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'config owns validated settings and paths; it must not import models/backends implementations, session service, or execution.',
  },
  {
    from: 'sessions',
    forbidden: [
      'review', 'models', 'backends', 'execution', 'diagnostics',
      'mcp', 'integrations', 'root', 'extensions'
    ],
    reason: 'sessions/ owns continuation and history; it must not import the controller, backends, models, or transport.',
  },
  {
    from: 'models',
    forbidden: [
      'backends', 'execution', 'execution/runtime', 'diagnostics',
      'mcp', 'integrations', 'sessions', 'review', 'root', 'extensions'
    ],
    reason: 'models/ owns catalog/price policy and store; it must not import backend adapters, probes, discovery, or execution.',
  },
  {
    from: 'backends',
    forbidden: [
      'execution', 'diagnostics', 'mcp', 'integrations', 'sessions',
      'review', 'root', 'extensions'
    ],
    reason: 'backends/ owns CLI adapters, discovery, and probes; it must not import application selection (execution/) or transport (mcp/).',
  },
  {
    from: 'execution/runtime',
    forbidden: [
      'execution', 'backends', 'models', 'diagnostics', 'mcp',
      'integrations', 'sessions', 'review', 'config', 'root', 'extensions'
    ],
    reason: 'execution/runtime primitives must never import application policy or controller.',
  },
  {
    from: 'execution',
    forbidden: ['mcp', 'diagnostics', 'integrations', 'root', 'extensions'],
    reason: 'execution/ returns transport-neutral results; it must not import MCP presentation, diagnostic issue reports, or client setup.',
  },
  {
    from: 'diagnostics',
    forbidden: ['mcp', 'integrations', 'sessions', 'review', 'root', 'extensions'],
    reason: 'diagnostics/ composes domain services for doctor and issue reports; it must not depend on MCP presentation.',
  },
  {
    from: '*',
    forbidden: ['extensions'],
    reason: 'Core server/runtime in src/ must never import client extensions/ UI.',
  },
];

function isAllowedRootSetupCall(file, node, ts) {
  if (normalizePath(file) !== 'src/index.ts') return false;
  if (!node.arguments || node.arguments.length !== 1) return false;
  const arg = node.arguments[0];
  if (!ts.isCallExpression(arg)) return false;
  const callee = arg.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.expression?.text !== 'path' || callee.name?.text !== 'join') return false;
  if (!arg.arguments || arg.arguments.length !== 2) return false;
  const [a0, a1] = arg.arguments;
  if (!ts.isIdentifier(a0) || a0.text !== '__dirname') return false;
  if (!ts.isStringLiteral(a1) || a1.text !== 'setup.cjs') return false;
  return true;
}

function resolveSpecifier(fromFile, specifier, rootDir) {
  if (!specifier.startsWith('.')) return null;

  const fromAbs = path.resolve(rootDir, fromFile);
  const base = path.resolve(path.dirname(fromAbs), specifier);

  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.cjs$/, '.cts'),
    base.replace(/\.mjs$/, '.mts'),
    base + '.ts',
    base + '.js',
    base + '.cjs',
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return normalizePath(path.relative(rootDir, candidate));
    }
  }

  return 'UNRESOLVED:' + specifier;
}

function buildModuleGraph(files, options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const ts = options.ts || resolveTypeScript(rootDir);

  const edges = [];
  const computed = [];
  const parseErrors = [];

  for (const file of files) {
    const fullPath = path.resolve(rootDir, file);
    if (!fs.existsSync(fullPath)) continue;

    const sourceText = fs.readFileSync(fullPath, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

    for (const d of sourceFile.parseDiagnostics || []) {
      parseErrors.push({
        file,
        start: d.start,
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      });
    }

    const addEdge = (node, spec, kind, bindings = []) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const target = resolveSpecifier(file, spec, rootDir);
      edges.push({
        from: normalizePath(file),
        line,
        spec,
        to: target,
        kind,
        bindings,
      });
    };

    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const namedBindings = clause?.namedBindings;
        const bindings = ts.isNamedImports(namedBindings || {})
          ? namedBindings.elements.map(e => ({
              name: e.propertyName?.text || e.name.text,
              typeOnly: Boolean(clause?.isTypeOnly || e.isTypeOnly),
            }))
          : [];
        const typeOnly = Boolean(
          clause && (clause.isTypeOnly || (!clause.name && bindings.length > 0 && bindings.every(e => e.typeOnly)))
        );
        addEdge(node, node.moduleSpecifier.text, typeOnly ? 'type-import' : 'import', bindings);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const bindings = node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map(e => ({
              name: e.propertyName?.text || e.name.text,
              typeOnly: Boolean(node.isTypeOnly || e.isTypeOnly),
            }))
          : [];
        const typeOnly = Boolean(node.isTypeOnly || (bindings.length > 0 && bindings.every(e => e.typeOnly)));
        addEdge(node, node.moduleSpecifier.text, typeOnly ? 'type-reexport' : 'reexport', bindings);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        addEdge(node, node.argument.literal.text, 'type-query');
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        addEdge(
          node,
          node.moduleReference.expression.text,
          node.isTypeOnly ? 'type-import' : 'import-equals'
        );
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require';
        if (node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
          addEdge(node, node.arguments[0].text, kind);
        } else {
          const isAllowedRoot = isAllowedRootSetupCall(file, node, ts);
          computed.push({
            from: normalizePath(file),
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            kind,
            expression: node.getText(sourceFile),
            allowed: isAllowedRoot,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  // Classify runtime vs elided type imports using in-memory program emit (handles both CJS and ESM)
  const emittedImports = new Map();
  try {
    const tsconfigPath = path.resolve(rootDir, 'tsconfig.json');
    let compilerOptions = options.compilerOptions;
    if (!compilerOptions) {
      if (fs.existsSync(tsconfigPath)) {
        const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootDir);
        compilerOptions = { ...parsed.options, noEmit: false };
      } else {
        compilerOptions = { noEmit: false, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.CommonJS };
      }
    }

    const programFiles = files.map(f => path.resolve(rootDir, f)).filter(f => fs.existsSync(f));
    const program = ts.createProgram(programFiles, compilerOptions);

    program.emit(undefined, (filename, text, _bom, _err, sources) => {
      if (!sources?.length) return;
      const from = normalizePath(path.relative(rootDir, sources[0].fileName));
      const emittedSource = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
      const specs = new Set();
      function walk(n) {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'require' &&
          n.arguments.length &&
          ts.isStringLiteralLike(n.arguments[0])
        ) {
          specs.add(n.arguments[0].text);
        } else if (
          ts.isImportDeclaration(n) &&
          n.moduleSpecifier &&
          ts.isStringLiteralLike(n.moduleSpecifier)
        ) {
          specs.add(n.moduleSpecifier.text);
        } else if (
          ts.isExportDeclaration(n) &&
          n.moduleSpecifier &&
          ts.isStringLiteralLike(n.moduleSpecifier)
        ) {
          specs.add(n.moduleSpecifier.text);
        } else if (
          ts.isCallExpression(n) &&
          n.expression.kind === ts.SyntaxKind.ImportKeyword &&
          n.arguments.length &&
          ts.isStringLiteralLike(n.arguments[0])
        ) {
          specs.add(n.arguments[0].text);
        }
        ts.forEachChild(n, walk);
      }
      walk(emittedSource);
      emittedImports.set(from, specs);
    });
  } catch {
    // If emit fails for isolated fixtures, fall back to syntactic kind classification
  }

  for (const edge of edges) {
    if (['dynamic-import', 'require'].includes(edge.kind)) {
      edge.runtime = true;
    } else if (['type-import', 'type-reexport', 'type-query'].includes(edge.kind)) {
      edge.runtime = false;
    } else if (['import', 'reexport', 'import-equals'].includes(edge.kind)) {
      const emittedForFile = emittedImports.get(edge.from);
      edge.runtime = emittedForFile ? emittedForFile.has(edge.spec) : true;
    } else {
      edge.runtime = false;
    }
  }

  return { edges, computed, parseErrors };
}

function findCycles(files, edges, runtimeOnly = false) {
  const nodes = files.map(normalizePath);
  const adj = new Map(nodes.map(n => [n, []]));

  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to) && (!runtimeOnly || e.runtime)) {
      adj.get(e.from).push(e.to);
    }
  }

  let counter = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  function stronglyConnect(node) {
    indices.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of adj.get(node) || []) {
      if (!indices.has(neighbor)) {
        stronglyConnect(neighbor);
        low.set(node, Math.min(low.get(node), low.get(neighbor)));
      } else if (onStack.has(neighbor)) {
        low.set(node, Math.min(low.get(node), indices.get(neighbor)));
      }
    }

    if (low.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);

      if (component.length > 1 || (adj.get(node) && adj.get(node).includes(node))) {
        cycles.push(component.sort());
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      stronglyConnect(node);
    }
  }

  return cycles;
}

function verifyBoundaries(edges, options = {}) {
  const allowedLegacyEdges = options.allowedLegacyEdges || [];
  const legacyMatch = (e) => {
    return allowedLegacyEdges.some(legacy => legacy.from === e.from && legacy.to === e.to);
  };

  const forbiddenRulesMap = new Map();
  for (const rule of BOUNDARY_RULES) {
    forbiddenRulesMap.set(rule.from, { set: new Set(rule.forbidden), reason: rule.reason });
  }

  const violations = [];

  for (const edge of edges) {
    if (!edge.to || edge.to.startsWith('UNRESOLVED:')) continue;

    const fromOwner = getOwner(edge.from);
    const toOwner = getOwner(edge.to);

    if (fromOwner === toOwner) continue;

    const checkRule = (ruleKey) => {
      const rule = forbiddenRulesMap.get(ruleKey);
      if (rule && rule.set.has(toOwner)) {
        if (!legacyMatch(edge)) {
          violations.push({
            from: edge.from,
            to: edge.to,
            fromOwner,
            toOwner,
            line: edge.line,
            spec: edge.spec,
            kind: edge.kind,
            runtime: edge.runtime,
            reason: rule.reason,
          });
        }
      }
    };

    checkRule(fromOwner);
    checkRule('*');

    // Specific additional checks:
    // 1. Only root (index.ts) and constants.ts may import mcp/
    if (toOwner === 'mcp' && fromOwner !== 'root' && fromOwner !== 'constants') {
      if (!legacyMatch(edge)) {
        violations.push({
          from: edge.from,
          to: edge.to,
          fromOwner,
          toOwner,
          line: edge.line,
          spec: edge.spec,
          kind: edge.kind,
          runtime: edge.runtime,
          reason: 'mcp/ is the transport edge; no application/domain module may import it.',
        });
      }
    }

    // 2. Only root (index.ts) may import integrations/ (lazy require)
    if (toOwner === 'integrations' && fromOwner !== 'root') {
      if (!legacyMatch(edge)) {
        violations.push({
          from: edge.from,
          to: edge.to,
          fromOwner,
          toOwner,
          line: edge.line,
          spec: edge.spec,
          kind: edge.kind,
          runtime: edge.runtime,
          reason: 'integrations/ owns optional setup and registrations; core server/domain modules must not import it.',
        });
      }
    }
  }

  return violations;
}

function verifyComputedCalls(computedCalls) {
  const violations = [];
  for (const call of computedCalls) {
    if (!call.from.startsWith('src/')) continue;
    if (!call.allowed) {
      violations.push({
        from: call.from,
        line: call.line,
        kind: call.kind,
        expression: call.expression,
        reason:
          'Computed require/import calls cannot be statically verified and are forbidden in src/ (permitted only for fixed sibling bundle path.join(__dirname, "setup.cjs") in src/index.ts).',
      });
    }
  }
  return violations;
}

function crawlDirectory(dir, rootDir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      found.push(...crawlDirectory(full, rootDir));
    } else if (entry.isFile() && /\.(?:ts|js|cjs|mjs|cts|mts)$/.test(entry.name)) {
      found.push(normalizePath(path.relative(rootDir, full)));
    }
  }
  return found;
}

function checkDependencies(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  let files = options.files;

  if (!files) {
    const fileSet = new Set();
    try {
      // Discover both tracked and untracked (non-ignored) source files via git
      const stdout = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && trimmed.startsWith('src/') && /\.(?:ts|js|cjs|mjs|cts|mts)$/.test(trimmed)) {
          fileSet.add(normalizePath(trimmed));
        }
      }
    } catch {
      // Git command failed; crawl src/ directly
    }

    // Always merge with direct directory crawl of src/ to guarantee no untracked file is excluded
    const srcPath = path.join(rootDir, 'src');
    if (fs.existsSync(srcPath)) {
      for (const f of crawlDirectory(srcPath, rootDir)) {
        fileSet.add(f);
      }
    }

    files = Array.from(fileSet).sort();
  }

  const { edges, computed, parseErrors } = buildModuleGraph(files, {
    rootDir,
    ts: options.ts,
    compilerOptions: options.compilerOptions,
  });

  const unresolved = edges.filter(e => typeof e.to === 'string' && e.to.startsWith('UNRESOLVED:'));
  const runtimeCycles = findCycles(files, edges, true);
  const allCycles = findCycles(files, edges, false);
  const violations = verifyBoundaries(edges, { allowedLegacyEdges: options.allowedLegacyEdges || [] });
  const computedViolations = verifyComputedCalls(computed);

  const valid =
    parseErrors.length === 0 &&
    unresolved.length === 0 &&
    runtimeCycles.length === 0 &&
    allCycles.length === 0 &&
    violations.length === 0 &&
    computedViolations.length === 0;

  return {
    valid,
    files,
    edges,
    computed,
    computedViolations,
    parseErrors,
    unresolved,
    cycles: {
      runtime: runtimeCycles,
      all: allCycles,
    },
    violations,
    allowedLegacyEdges: options.allowedLegacyEdges || [],
  };
}

function runCli() {
  const rootDir = path.resolve(__dirname, '..');
  const result = checkDependencies({ rootDir });

  console.log(`CoAgent8 Dependency & Boundary Verification (S6)`);
  console.log(`-----------------------------------------------`);
  console.log(`Source files analyzed: ${result.files.length}`);
  console.log(`Total dependency edges: ${result.edges.length}`);
  console.log(`Runtime internal edges: ${result.edges.filter(e => e.runtime && e.to?.startsWith('src/')).length}`);
  console.log(`Type-only internal edges: ${result.edges.filter(e => !e.runtime && e.to?.startsWith('src/')).length}`);
  console.log(`Computed calls: ${result.computed.length} (violations: ${result.computedViolations.length})`);
  console.log(`Allowed legacy exemptions: ${result.allowedLegacyEdges.length}`);
  console.log(``);

  if (result.parseErrors.length > 0) {
    console.error(`PARSE ERRORS (${result.parseErrors.length}):`);
    for (const err of result.parseErrors) {
      console.error(`  ${err.file}: ${err.message}`);
    }
    console.error(``);
  }

  if (result.unresolved.length > 0) {
    console.error(`UNRESOLVED IMPORTS (${result.unresolved.length}):`);
    for (const u of result.unresolved) {
      console.error(`  ${u.from}:${u.line} -> ${u.spec}`);
    }
    console.error(``);
  }

  if (result.cycles.runtime.length > 0) {
    console.error(`RUNTIME CYCLES (${result.cycles.runtime.length}):`);
    for (const c of result.cycles.runtime) {
      console.error(`  ${c.join(' -> ')}`);
    }
    console.error(``);
  }

  if (result.cycles.all.length > 0) {
    console.error(`TYPE / ALL CYCLES (${result.cycles.all.length}):`);
    for (const c of result.cycles.all) {
      console.error(`  ${c.join(' -> ')}`);
    }
    console.error(``);
  }

  if (result.violations.length > 0) {
    console.error(`BOUNDARY VIOLATIONS (${result.violations.length}):`);
    for (const v of result.violations) {
      console.error(`  ${v.from}:${v.line} (${v.fromOwner}) -> ${v.to} (${v.toOwner}) [${v.kind}]`);
      console.error(`    Rule: ${v.reason}`);
    }
    console.error(``);
  }

  if (result.computedViolations.length > 0) {
    console.error(`COMPUTED CALL VIOLATIONS (${result.computedViolations.length}):`);
    for (const cv of result.computedViolations) {
      console.error(`  ${cv.from}:${cv.line}: ${cv.expression}`);
      console.error(`    Rule: ${cv.reason}`);
    }
    console.error(``);
  }

  if (!result.valid) {
    console.error(`FAILED: Module boundary verification failed.`);
    process.exit(1);
  }

  console.log(`PASS: All dependency boundaries, cycles, and module rules verified cleanly.`);
  process.exit(0);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  checkDependencies,
  buildModuleGraph,
  findCycles,
  verifyBoundaries,
  verifyComputedCalls,
  getOwner,
  resolveTypeScript,
  normalizePath,
};
