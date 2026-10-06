const fs = require('node:fs');
const path = require('node:path');
const excluded = new Set(['fixtures', 'helpers', 'consumer', 'artifacts', 'node_modules']);
const FLAGS_WITH_ARG = new Set([
  '-r', '--require',
  '--import',
  '--loader',
  '-C', '--conditions',
  '--test-concurrency',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-shard',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-timeout',
]);

function discoverTests(root = path.resolve(__dirname, '..')) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(file);
    }
  }
  visit(root);
  if (!files.length) throw new Error('No *.test.js files discovered under tests/.');
  return files.sort();
}

function resolveTestTargets(rawArgs = [], root = path.resolve(__dirname, '../..')) {
  const flags = [];
  const positional = [];
  let parsingOptions = true;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg.startsWith('-')) {
      flags.push(arg);
      if (FLAGS_WITH_ARG.has(arg) && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        flags.push(rawArgs[++i]);
      }
    } else {
      positional.push(arg);
    }
  }

  const testsDir = path.resolve(root, 'tests');

  let testFiles;
  if (positional.length > 0) {
    testFiles = positional.map(file => {
      const fromCwd = path.resolve(process.cwd(), file);
      if (fs.existsSync(fromCwd)) return path.normalize(fromCwd);

      const fromRoot = path.resolve(root, file);
      if (fs.existsSync(fromRoot)) return path.normalize(fromRoot);

      const fromTests = path.resolve(testsDir, file);
      if (fs.existsSync(fromTests)) return path.normalize(fromTests);

      return path.normalize(fromCwd);
    });
  } else {
    testFiles = discoverTests(testsDir);
  }

  const hasConcurrency = flags.some(f => f.startsWith('--test-concurrency'));
  const effectiveFlags = hasConcurrency ? flags : ['--test-concurrency=2', ...flags];

  return { flags: effectiveFlags, testFiles };
}
module.exports = { discoverTests, resolveTestTargets };
