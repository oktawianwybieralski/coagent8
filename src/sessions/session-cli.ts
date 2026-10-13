/**
 * `coagent8 session`: command-line inspection of workspace sessions and history (`CLI-FIRST-001d`).
 * Supports `session list` and `session history <handle>` with full workspace isolation,
 * human-readable Markdown text or JSON output, and strict argument/error exit codes.
 *
 * @packageDocumentation
 */

import { redactDiagnostic, redactHomePath, redactPublicContent, redactPublicData } from '../security/redaction.js';
import { truncateToByteLength } from '../execution/runtime/stream.js';
import { resolveWorkspacePath } from '../workspace/workspace.js';
import { listSessions } from './session.js';
import { getTurnMapping, sessionHistory } from './history/index.js';
import type { SessionRecord } from './types.js';
import type { ConversationEvent } from '../contracts/index.js';

const SESSION_OUTPUT_MAX_BYTES = 512 * 1024;

const USAGE = `Usage: coagent8 session <list|history> [options]
  coagent8 session list [--json]
  coagent8 session history <handle> [--cursor <cursor>] [--limit <limit>] [--json]`;

const LIST_USAGE = 'Usage: coagent8 session list [--json]';

const HISTORY_USAGE = 'Usage: coagent8 session history <handle> [--cursor <cursor>] [--limit <limit>] [--json]';

/**
 * Redacts sensitive paths in session records for public presentation.
 * @param record - Raw session record from storage.
 * @returns Public record with redacted workspace path.
 */
export function publicSessionRecord(record: SessionRecord): SessionRecord {
  return { ...record, workspace: redactHomePath(record.workspace) };
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
 * Formats human-readable Markdown text for a paginated session history page.
 * @param handle - Session handle.
 * @param history - History page containing events and optional continuation cursor.
 * @param turnNumberMap - Map from turnId UUIDs to 1-based chronological turn numbers.
 * @returns Formatted Markdown text.
 */
export function formatSessionHistoryText(
  handle: string,
  history: { events: ConversationEvent[]; nextCursor?: string | null },
  turnNumberMap: Map<string, number>
): string {
  if (!history.events.length) {
    return 'No public events found on this page.';
  }

  const sections: string[] = [`## Session History: \`${handle}\``];
  let lastTurn = 0;

  for (const e of history.events) {
    const turn = turnNumberMap.get(e.turnId) || 1;
    if (turn !== lastTurn) {
      if (lastTurn !== 0) sections.push('---');
      sections.push(`### Turn ${turn}`);
      lastTurn = turn;
    }

    if (e.type === 'user_message') {
      const fragmentNotice = (e as { fragment?: { offsetBytes: number; complete: boolean } }).fragment;
      let text = e.text;
      if (fragmentNotice && fragmentNotice.offsetBytes > 0) text = `*[continued from previous page]*\n\n${text}`;
      if (fragmentNotice && !fragmentNotice.complete) text = `${text}\n\n*[message continued on next page...]*`;
      sections.push(`**User:**\n\n${text}`);
    } else if (e.type === 'assistant_message') {
      const fragmentNotice = (e as { fragment?: { offsetBytes: number; complete: boolean } }).fragment;
      let text = e.text;
      if (fragmentNotice && fragmentNotice.offsetBytes > 0) text = `*[continued from previous page]*\n\n${text}`;
      if (fragmentNotice && !fragmentNotice.complete) text = `${text}\n\n*[message continued on next page...]*`;
      sections.push(`**Assistant (${e.provider}):**\n\n${text}`);
    } else if (e.type === 'tool_finished') {
      sections.push(`*Tool \`${e.name}\` finished (${e.success ? 'success' : 'error'})*`);
    } else if (e.type === 'turn_finished') {
      sections.push(`*Turn status: \`${e.status}\`*`);
    } else if (e.type === 'error') {
      sections.push(`> Error [${e.error.code}]: ${e.error.message}`);
    } else if (e.type === 'warning') {
      sections.push(`> Warning: ${e.message}`);
    }
  }

  if (history.nextCursor) {
    sections.push(`---\n*Next page available. Pass cursor:* \`${history.nextCursor}\``);
  }

  return sections.filter(Boolean).join('\n\n').trim();
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

      if (effectiveSignal.aborted) {
        return 130;
      }

      if (json) {
        out.write(`${JSON.stringify(redactPublicData(sessions))}\n`);
      } else {
        const text = formatSessionListText(sessions);
        out.write(`${truncateToByteLength(redactHomePath(text), SESSION_OUTPUT_MAX_BYTES)}\n`);
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

  if (subcmd === 'history') {
    let handle: string | undefined;
    let cursor: string | undefined;
    let limit = 20;
    let json = false;
    let stopParsing = false;

    for (let index = 0; index < subArgs.length; index++) {
      const arg = subArgs[index]!;
      if (stopParsing) {
        if (!handle) {
          handle = arg;
          continue;
        }
        err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${HISTORY_USAGE}\n`);
        return 2;
      }
      if (arg === '--') {
        stopParsing = true;
        continue;
      }
      if (arg === '--json') {
        json = true;
      } else if (arg === '--help' || arg === '-h') {
        out.write(`${HISTORY_USAGE}\n`);
        return 0;
      } else if (arg === '--cursor') {
        const next = subArgs[++index];
        if (next === undefined) {
          err.write(`Missing value for argument '--cursor'. ${HISTORY_USAGE}\n`);
          return 2;
        }
        cursor = next;
      } else if (arg.startsWith('--cursor=')) {
        cursor = arg.slice('--cursor='.length);
      } else if (arg === '--limit') {
        const next = subArgs[++index];
        if (next === undefined) {
          err.write(`Missing value for argument '--limit'. ${HISTORY_USAGE}\n`);
          return 2;
        }
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
          err.write(`Invalid limit '${redactDiagnostic(next, 64)}'. History limit must be 1..100.\n`);
          return 2;
        }
        limit = parsed;
      } else if (arg.startsWith('--limit=')) {
        const val = arg.slice('--limit='.length);
        const parsed = Number(val);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
          err.write(`Invalid limit '${redactDiagnostic(val, 64)}'. History limit must be 1..100.\n`);
          return 2;
        }
        limit = parsed;
      } else if (arg.startsWith('-')) {
        err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${HISTORY_USAGE}\n`);
        return 2;
      } else {
        if (!handle) {
          handle = arg;
        } else {
          err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${HISTORY_USAGE}\n`);
          return 2;
        }
      }
    }

    if (!handle) {
      err.write(`Missing required session handle. ${HISTORY_USAGE}\n`);
      return 2;
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
      const history = await sessionHistory(handle, resolvedWorkspace, cursor, limit);

      if (effectiveSignal.aborted) {
        return 130;
      }

      if (json) {
        out.write(`${JSON.stringify(redactPublicData(history))}\n`);
      } else {
        const turnMap = await getTurnMapping(handle, resolvedWorkspace);
        if (effectiveSignal.aborted) {
          return 130;
        }
        const text = formatSessionHistoryText(handle, history, turnMap);
        out.write(`${truncateToByteLength(redactPublicContent(text), SESSION_OUTPUT_MAX_BYTES)}\n`);
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
