#!/usr/bin/env node

import { redactDiagnostic } from './security/redaction.js';
import path from 'node:path';
import { serveStdio } from './mcp/stdio-server.js';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (['setup', 'repair', 'status', 'cleanup', '--help', '-h'].includes(args[0])) {
    // Optional installation code lives in a separate sibling bundle. Unknown
    // host arguments continue to start MCP instead of disabling the server.
    const setup: typeof import('./integrations/setup-cli.js') = require(path.join(__dirname, 'setup.cjs'));
    await setup.runSetupCli(args);
    return;
  }
  await serveStdio();
}

run().catch((error) => {
  process.stderr.write(`Fatal error in main(): ${redactDiagnostic(error?.message)}\n`);
  process.exit(1);
});
