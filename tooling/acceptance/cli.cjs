#!/usr/bin/env node
/**
 * CLI entrypoint for `npm run acceptance:native` (ACCEPT-001a1).
 */
const { runAcceptance } = require('./runner.cjs');
const { BACKENDS } = require('./backends.cjs');

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tarball: null,
    vsix: null,
    evidencePath: null,
    codePath: null,
    keepTemp: false,
    withBackendAuth: false,
    backends: null,
    models: {},
    cheapest: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--keep-temp') {
      options.keepTemp = true;
    } else if (arg === '--cheapest') {
      options.cheapest = true;
    } else if (arg === '--with-backend-auth') {
      options.withBackendAuth = true;
    } else if (arg === '--backends' && i + 1 < argv.length) {
      options.backends = argv[++i]
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
      for (const id of options.backends) if (!BACKENDS.includes(id)) throw new Error(`Unknown backend: ${id}`);
    } else if (arg === '--model' && i + 1 < argv.length) {
      const [id, model] = argv[++i].split('=');
      if (!BACKENDS.includes(id) || !model) throw new Error('Pass --model <backend>=<model>.');
      options.models[id] = model;
    } else if (arg === '--tarball' && i + 1 < argv.length) {
      options.tarball = argv[++i];
    } else if (arg === '--vsix' && i + 1 < argv.length) {
      options.vsix = argv[++i];
    } else if (arg === '--evidence' && i + 1 < argv.length) {
      options.evidencePath = argv[++i];
    } else if (arg === '--code-path' && i + 1 < argv.length) {
      options.codePath = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: node tooling/acceptance/cli.cjs [--dry-run] [--tarball <path>] [--vsix <path>] [--evidence <path>]',
          '         [--code-path <path>] [--keep-temp] [--with-backend-auth] [--backends codex,claude,agy] [--model <backend>=<model>] [--cheapest]',
          '',
          '--with-backend-auth  Let the scenario servers use your real Codex, Claude Code and agy sign-in in place',
          '                     (shared writable backend state; credentials are never copied). Without it the',
          '                     scenarios N2-N4 are NOT_RUN.',
          '--cheapest           Use the lowest-priced model of each backend instead of its default (what users get).',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Starting CoAgent8 native acceptance (${options.dryRun ? 'dry-run' : 'native'})...`);

  // An interrupt aborts the running step; the runner then stops its owned processes,
  // writes the evidence and removes its temporary root before the CLI exits.
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Acceptance run interrupted.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let result;
  try {
    result = await runAcceptance({ ...options, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log(`Acceptance status: ${result.status}`);
  console.log(`Evidence written to: ${result.evidencePath}`);
  if (result.tempRoot) console.log(`Isolated root kept at: ${result.tempRoot}`);

  if (result.status === 'FAIL') {
    if (result.error) {
      console.error(`Acceptance error: ${result.error.message}`);
    }
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }
}

main().catch(err => {
  console.error(`Fatal acceptance error: ${err.message}`);
  process.exitCode = 1;
});
