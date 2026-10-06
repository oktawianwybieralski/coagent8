#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { BRAND } from './constants/index.js';
import { shutdownProcessRunner } from './execution/process.js';
import { redactDiagnostic } from './redaction.js';
import { pruneExpiredSessions } from './sessions/session.js';
import { waitForActiveExecutionTasks } from './execution/controller.js';
import { runSetupCli } from './integrations/setup-cli.js';

async function run(): Promise<void> {
  if (await runSetupCli(process.argv.slice(2))) return;
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${BRAND.NAME} MCP Server (${BRAND.TAGLINE}) running on stdio\n`);

  const backgroundMaintenance: Promise<void> = pruneExpiredSessions(true).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: background session maintenance failed: ${redactDiagnostic(message)}\n`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    try {
      await backgroundMaintenance;
    } catch {}
    await shutdownProcessRunner();
    await waitForActiveExecutionTasks();
    try { await server.close(); } catch {}
    try { process.stdin.destroy(); } catch {}
    process.exit(0);
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

run().catch((error) => {
  process.stderr.write(`Fatal error in main(): ${redactDiagnostic(error?.message)}\n`);
  process.exit(1);
});
