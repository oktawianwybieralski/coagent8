import type { ToolArguments, ToolProgress } from './arguments.js';
import { closeSession, cancelSession, listSessions } from '../sessions/session.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { WORKSPACE_PARAMETER } from './schema.js';
import { deleteHistory, getTurnMapping, sessionHistory } from '../sessions/history.js';
import { resolveWorkspacePath } from '../paths.js';
import { ToolError } from '../conversation.js';

export const sessionToolDefinition = {
  name: CANONICAL_TOOL_NAMES.SESSION,
  description: 'List sessions, read a session history or close a session.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'history', 'close'] },
      session_handle: { type: 'string', description: 'Required for history and close.' },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      delete_history: { type: 'boolean', description: 'close: also delete the history.' },
      ...WORKSPACE_PARAMETER,
    },
    required: ['action'],
  },
};

export const cancelToolDefinition = {
  name: CANONICAL_TOOL_NAMES.CANCEL,
  description: 'Cancel the running turn of a session.',
  inputSchema: {
    type: 'object',
    properties: {
      session_handle: { type: 'string' },
      ...WORKSPACE_PARAMETER,
    },
    required: ['session_handle'],
  },
};

/** @param workspace - The workspace the server resolved for this call; history and close are scoped to it. */
export async function handleSession(args: ToolArguments, workspace = resolveWorkspacePath(args?.workspace_path)) {
  const action = args?.action;
  if (!action || !['list', 'history', 'close'].includes(action)) {
    throw new ToolError('INPUT_LIMIT', 'Validation Error: action must be one of "list", "history", "close".');
  }
  if (action === 'list') {
    const sessions = listSessions(workspace);
    if (!sessions.length) {
      return {
        content: [{ type: 'text' as const, text: '> CoAgent8: No active sessions found.' }],
        structuredContent: { schemaVersion: 1, sessions: [] },
      };
    }
    const lines = ['## Active CoAgent8 Sessions', ''];
    for (const s of sessions) {
      lines.push(`- \`${s.sessionHandle}\`: ${s.backend} (${s.model || 'default'}) · turns: ${s.turnCount || 0} · state: ${s.state}`);
    }
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: { schemaVersion: 1, sessions },
    };
  }
  if (action === 'history') {
    if (!args.session_handle || typeof args.session_handle !== 'string') {
      throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required for action "history".');
    }
    return await handleSessionHistory({ ...args, session_handle: args.session_handle }, workspace);
  }
  if (action === 'close') {
    if (!args.session_handle || typeof args.session_handle !== 'string') {
      throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required for action "close".');
    }
    return await handleCloseSession(args, workspace);
  }
  throw new ToolError('INPUT_LIMIT', `Unknown action: ${action}`);
}

export async function handleCancelSession(args: { session_handle: string; workspace_path?: string }) {
  if (!args?.session_handle || typeof args.session_handle !== 'string') {
    throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required and must be a string.');
  }
  const workspace = args.workspace_path ? resolveWorkspacePath(args.workspace_path) : undefined;
  const result = await cancelSession(args.session_handle, workspace);
  return {
    content: [
      {
        type: 'text' as const,
        text: `> CoAgent8: ${result.message}`,
      },
    ],
    structuredContent: {
      schemaVersion: 1,
      sessionHandle: args.session_handle,
      cancelled: result.cancelled,
      message: result.message,
    },
  };
}

export async function handleCloseSession(args: ToolArguments, workspace = resolveWorkspacePath(args.workspace_path)) {
  if (typeof args.session_handle !== 'string' || !args.session_handle) throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required for action "close".');
  const closed = await closeSession(args.session_handle, workspace);
  if (args.delete_history) await deleteHistory(args.session_handle, workspace);
  return {
    content: [
      {
        type: 'text',
        text: closed
          ? `Session '${args.session_handle}' closed successfully.`
          : `Session '${args.session_handle}' not found or already closed.`,
      },
    ],
  };
}

export async function handleSessionHistory(args: { session_handle: string; workspace_path?: string; cursor?: string; limit?: number }, workspace = resolveWorkspacePath(args.workspace_path)) {
  const history = await sessionHistory(args.session_handle, workspace, args.cursor, args.limit);
  if (!history.events.length) {
    return { content: [{ type: 'text' as const, text: 'No public events found on this page.' }], structuredContent: history };
  }

  const turnNumberMap = await getTurnMapping(args.session_handle, workspace);
  const sections: string[] = [`## Session History: \`${args.session_handle}\``];
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

  const text = sections.filter(Boolean).join('\n\n').trim();
  return { content: [{ type: 'text' as const, text: text || 'No public events on this page.' }], structuredContent: history };
}
