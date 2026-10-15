#!/usr/bin/env node
/**
 * CLI entrypoint for `npm run acceptance:native` (ACCEPT-001a1).
 */
const { runAcceptance } = require('./runner.cjs');

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tarball: null,
    vsix: null,
    evidencePath: null,
    keepTemp: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--keep-temp') {
      options.keepTemp = true;
    } else if (arg === '--tarball' && i + 1 < argv.length) {
      options.tarball = argv[++i];
    } else if (arg === '--vsix' && i + 1 < argv.length) {
      options.vsix = argv[++i];
    } else if (arg === '--evidence' && i + 1 < argv.length) {
      options.evidencePath = argv[++i];
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Starting CoAgent8 native acceptance (${options.dryRun ? 'dry-run' : 'native'})...`);

  const result = await runAcceptance(options);
  console.log(`Acceptance status: ${result.status}`);
  console.log(`Evidence written to: ${result.evidencePath}`);

  if (result.status === 'FAIL') {
    if (result.error) {
      console.error(`Acceptance error: ${result.error.message || result.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`Fatal acceptance error: ${err.message}`);
  process.exitCode = 1;
});

