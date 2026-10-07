/** MCP server lifecycle on standard streams: start, background maintenance and shutdown. @packageDocumentation */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { BRAND } from './constants.js';
import { shutdownProcessRunner } from './execution/process.js';
import { redactDiagnostic } from './redaction.js';
import { pruneExpiredSessions } from './sessions/session.js';
import { waitForActiveExecutionTasks } from './execution/controller.js';

export interface StdioServerOptions {
  /** Background maintenance started after the connection; shutdown waits for it. Defaults to the session sweep. */
  maintenance?: () => Promise<void>;
}

/**
 * Serves MCP on stdin/stdout until stdin ends or SIGINT/SIGTERM arrives, then waits for
 * maintenance and running executions, closes the server and exits.
 */
export async function serveStdio(options: StdioServerOptions = {}): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${BRAND.NAME} MCP Server (${BRAND.TAGLINE}) running on stdio\n`);

  const maintenance = options.maintenance ?? (() => pruneExpiredSessions(true));
  const backgroundMaintenance: Promise<void> = maintenance().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: background session maintenance failed: ${redactDiagnostic(message)}\n`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    // backgroundMaintenance reports its own failure and never rejects.
    await backgroundMaintenance;
    await shutdownProcessRunner();
    await waitForActiveExecutionTasks();
    try { await server.close(); }
    catch (error) { process.stderr.write(`Warning: MCP server did not close cleanly: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}\n`); }
    process.stdin.destroy();
    process.exit(0);
  };
  process.stdin.once('end', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
