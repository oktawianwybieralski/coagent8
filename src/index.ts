#!/usr/bin/env node

import { redactDiagnostic } from './redaction.js';
import { runSetupCli } from './integrations/setup-cli.js';
import { serveStdio } from './stdio-server.js';

async function run(): Promise<void> {
  if (await runSetupCli(process.argv.slice(2))) return;
  await serveStdio();
}

run().catch((error) => {
  process.stderr.write(`Fatal error in main(): ${redactDiagnostic(error?.message)}\n`);
  process.exit(1);
});
