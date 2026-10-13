/**
 * `coagent8 session`: command-line inspection of workspace sessions (`CLI-FIRST-001d1`).
 * Supports `session list` with full workspace isolation, human-readable Markdown text
 * or JSON output, and strict argument/error exit codes.
 *
 * @packageDocumentation
 */

import { redactDiagnostic, redactDiagnosticData } from '../security/redaction.js';
import { resolveWorkspacePath } from '../workspace/workspace.js';
import { listSessions } from './session.js';
import type { SessionRecord } from './types.js';

const SESSION_OUTPUT_MAX_BYTES = 512 * 1024;

const USAGE = `Usage: coagent8 session <command> [options]
  coagent8 session list [--json]`;

const LIST_USAGE = 'Usage: coagent8 session list [--json]';

/**
 * Redacts sensitive paths in session records for public presentation.
 * @param record - Raw session record from storage.
 * @returns Public record with redacted workspace path.
 */
export function publicSessionRecord(record: SessionRecord): SessionRecord {
  return { ...record, workspace: redactDiagnostic(record.workspace, 1024) };
}

/**
 * Formats a human-readable summary of active sessions in a workspace.
 * @param sessions - Array of session records for the workspace.
 * @returns Markdown text listing active sessions.
 */
export function formatSessionListText(sessions: SessionRecord[]): string {
  if (!sessions.length) {
    return '> CoAgent8: No active sessions found.';
  }
  const lines = ['## Active CoAgent8 Sessions', ''];
  for (const s of sessions) {
    lines.push(`- \`${s.sessionHandle}\`: ${s.backend} (${s.model || 'default'}) · turns: ${s.turnCount || 0} · state: ${s.state}`);
  }
  return lines.join('\n');
}

/**
 * Runs `coagent8 session` CLI command dispatch.
 *
 * @param args - Arguments following `coagent8 session`.
 * @param out - Standard output stream.
 * @param err - Standard error stream.
 * @param signal - Optional cancellation signal.
 * @param workspace - Optional workspace path override (defaults to current working directory).
 * @returns Process exit code: 0 for success, 2 for syntax/argument errors, 1 for runtime errors, 130 on SIGINT.
 */
export async function runSessionCli(
  args: string[],
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  signal?: AbortSignal,
  workspace?: string
): Promise<number> {
  if (args.length === 0) {
    err.write(`Unknown command or missing subcommand. ${USAGE}\n`);
    return 2;
  }

  const [subcmd, ...subArgs] = args;

  if (subcmd === '--help' || subcmd === '-h') {
    out.write(`${USAGE}\n`);
    return 0;
  }

  if (subcmd === 'list') {
    let json = false;
    let stopParsing = false;

    for (let index = 0; index < subArgs.length; index++) {
      const arg = subArgs[index]!;
      if (stopParsing) {
        err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${LIST_USAGE}\n`);
        return 2;
      }
      if (arg === '--') {
        stopParsing = true;
        continue;
      }
      if (arg === '--json') {
        json = true;
      } else if (arg === '--help' || arg === '-h') {
        out.write(`${LIST_USAGE}\n`);
        return 0;
      } else {
        err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${LIST_USAGE}\n`);
        return 2;
      }
    }

    const ac = new AbortController();
    const onSigInt = () => {
      ac.abort();
      process.exitCode = 130;
    };
    const effectiveSignal = signal ?? ac.signal;
    if (!signal) {
      process.once('SIGINT', onSigInt);
    }

    try {
      if (effectiveSignal.aborted) {
        return 130;
      }
      const resolvedWorkspace = workspace ? resolveWorkspacePath(workspace) : resolveWorkspacePath();
      const sessions = listSessions(resolvedWorkspace).map(publicSessionRecord);

      if (json) {
        out.write(`${JSON.stringify(redactDiagnosticData(sessions))}\n`);
      } else {
        out.write(`${redactDiagnostic(formatSessionListText(sessions), SESSION_OUTPUT_MAX_BYTES)}\n`);
      }
      return 0;
    } catch (error: unknown) {
      const isAbort =
        effectiveSignal.aborted ||
        (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'ABORTED')));
      if (isAbort) {
        return 130;
      }
      const message = error instanceof Error ? error.message : String(error);
      err.write(`Error: ${redactDiagnostic(message, 256)}\n`);
      return 1;
    } finally {
      if (!signal) {
        process.removeListener('SIGINT', onSigInt);
      }
    }
  }

  err.write(`Unknown subcommand '${redactDiagnostic(subcmd, 64)}'. ${USAGE}\n`);
  return 2;
}
