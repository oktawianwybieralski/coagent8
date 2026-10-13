#!/usr/bin/env node

/**
 * CoAgent8 entry point: command dispatch and MCP stdio server launcher.
 *
 * Dispatches public CLI subcommands (mcp, models, setup, repair, status,
 * cleanup, skills), handles root flags (--help, --version), and provides Option D
 * transport routing for bare and unrecognized invocations.
 *
 * @packageDocumentation
 */

import path from 'node:path';
import { redactDiagnostic } from './security/redaction.js';
import { BRAND } from './brand.js';
import { serveStdio } from './mcp/stdio-server.js';
import { runModelsCli } from './diagnostics/models-cli.js';

/** Standard stream interfaces for CLI execution. */
export interface CliStreams {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean; write(chunk: string): boolean | void };
  stderr: { write(chunk: string): boolean | void };
}

/** Dependencies that can be injected for hermetic testing. */
export interface CliDependencies {
  serveStdio?: () => Promise<void>;
  runModelsCli?: (args: string[], out?: NodeJS.WritableStream, err?: NodeJS.WritableStream) => Promise<number>;
  loadSetupCli?: () => Promise<{ runSetupCli(args: string[]): Promise<boolean> }>;
}

/**
 * Formats the root CLI help text.
 * @returns Human-readable usage text.
 */
export function formatRootHelp(): string {
  return [
    'CoAgent8 - Cross-Agent CLI Bridge',
    '',
    'Usage:',
    '  coagent8 [command] [options]',
    '  coagent8 mcp                     Start the standard MCP stdio JSON-RPC server',
    '  coagent8                         Interactive help in terminal, or legacy MCP over stdio pipe',
    '',
    'Commands:',
    '  mcp                              Start the standard MCP JSON-RPC server over stdio',
    '  models [--backend <name>] [--json]',
    '                                   List models, output prices and governance approvals',
    '  doctor [--scope <scope>] [--backend <name>] [--json]',
    '                                   Run diagnostics (models or health)',
    '  session list|history [...]       Inspect workspace session history',
    '  setup [--clients=...]            Register CoAgent8 with native CLI hosts',
    '  repair [--clients=...]           Restore missing or corrupted host registrations',
    '  status [--clients=...]           Check CLI readiness across supported hosts',
    '  cleanup [--clients=...] [--apply=<token>]',
    '                                   Preview or apply removal of owned registrations',
    '  skills <action> [...]            Manage client skills (status|install|uninstall|enable|disable)',
    '',
    'Global Options:',
    '  --help, -h                       Show command usage',
    '  --version, -v                    Show version number',
    '  --json                           Output structured JSON where supported',
    '',
    'Notes:',
    '  Changes to setup/cleanup/skills are previews; apply with --apply=<preview token>.',
    '  npm uninstall runs no cleanup: run cleanup first.',
    '',
  ].join('\n');
}

/**
 * Formats the help text for `coagent8 mcp`.
 * @returns Human-readable usage text for the mcp subcommand.
 */
export function formatMcpHelp(): string {
  return [
    'Usage: coagent8 mcp',
    '',
    'Starts the standard MCP JSON-RPC server over stdio. Protocol traffic uses stdout;',
    'diagnostics and operational logging use stderr.',
    '',
  ].join('\n');
}

/**
 * Executes CLI command dispatch per Option D specification.
 *
 * @param args - CLI arguments after node/binary.
 * @param streams - Standard I/O streams.
 * @param deps - Injected execution dependencies.
 * @returns Process exit code (0 for success, 2 for syntax/usage error, 1 for domain failure).
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
  streams: CliStreams = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  deps: CliDependencies = {}
): Promise<number> {
  const isTty = Boolean(streams.stdin.isTTY && streams.stdout.isTTY);

  // 1. Root --help / -h
  if (args.length >= 1 && (args[0] === '--help' || args[0] === '-h')) {
    streams.stdout.write(formatRootHelp());
    return 0;
  }

  // 2. Root --version / -v
  if (args.length >= 1 && (args[0] === '--version' || args[0] === '-v')) {
    streams.stdout.write(`${BRAND.SERVER_VERSION}\n`);
    return 0;
  }

  // 3. Bare invocation (Option D)
  if (args.length === 0) {
    if (isTty) {
      streams.stdout.write(formatRootHelp());
      return 0;
    }
    const serve = deps.serveStdio ?? serveStdio;
    await serve();
    return 0;
  }

  const [cmd, ...rest] = args;

  // 4. Explicit mcp
  if (cmd === 'mcp') {
    if (rest.length === 0) {
      const serve = deps.serveStdio ?? serveStdio;
      await serve();
      return 0;
    }
    if (rest[0] === '--help' || rest[0] === '-h') {
      streams.stdout.write(formatMcpHelp());
      return 0;
    }
    streams.stderr.write(`Unknown argument '${redactDiagnostic(rest[0])}'. Usage: coagent8 mcp\n`);
    return 2;
  }

  // 5. Models command
  if (cmd === 'models') {
    const runModels = deps.runModelsCli ?? runModelsCli;
    return await runModels(rest, streams.stdout as unknown as NodeJS.WritableStream, streams.stderr as unknown as NodeJS.WritableStream);
  }

  // 6. Management commands (lazily loaded setup bundle)
  if (['setup', 'repair', 'status', 'cleanup', 'skills'].includes(cmd)) {
    const loadSetup = deps.loadSetupCli ?? (async () => {
      // Optional installation code lives in a separate sibling bundle.
      const setup: typeof import('./integrations/setup-cli.js') = require(path.join(__dirname, 'setup.cjs'));
      return setup;
    });
    const setup = await loadSetup();
    await setup.runSetupCli(args);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  }

  // 7. Unrecognized command / arguments (Option D)
  if (isTty) {
    streams.stderr.write(`Unknown command or option '${redactDiagnostic(cmd)}'. Run 'coagent8 --help' for usage.\n`);
    return 2;
  }

  // Non-TTY fallback: warn to stderr and start legacy MCP stdio server
  streams.stderr.write(
    `Warning: unrecognized arguments [${args.map(a => redactDiagnostic(a)).join(', ')}] ignored; starting legacy MCP stdio server.\n`
  );
  const serve = deps.serveStdio ?? serveStdio;
  await serve();
  return 0;
}

function isDirectExecution(): boolean {
  if (!require.main) return false;
  if (require.main === module) return true;
  const mainFile = require.main.filename ?? '';
  if (path.basename(mainFile) === 'index.js' || path.basename(mainFile) === 'index.cjs') {
    return true;
  }
  const argv1 = process.argv[1] ?? '';
  if (/([\\/]index\.[ct]js|[\\/]coagent8(\.cmd)?)$/.test(argv1)) {
    return true;
  }
  return false;
}

async function run(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

if (isDirectExecution() && process.env.COAGENT8_DISABLE_AUTORUN !== '1') {
  run().catch((error) => {
    process.stderr.write(`Fatal error in main(): ${redactDiagnostic(error?.message)}\n`);
    process.exit(1);
  });
}
