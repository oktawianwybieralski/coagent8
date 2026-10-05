import type { ToolArguments, ToolProgress } from './arguments.js';
import { closeSession, cancelSession, listSessions } from '../sessions/session.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';
import { deleteHistory, getTurnMapping, sessionHistory } from '../sessions/history.js';
import { resolveWorkspacePath } from '../backends/policy.js';

export const sessionToolDefinition = {
  name: CANONICAL_TOOL_NAMES.SESSION,
  description:
    'Unified session lifecycle & history management: list active sessions, inspect history events, or close sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'history', 'close'],
        description: 'Action to perform: "list" active sessions, "history" of conversation events, or "close" a session.',
      },
      session_handle: {
        type: 'string',
        description: 'The opaque session handle (required for "history" and "close").',
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor for "history" action.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of history events to return.',
      },
      delete_history: {
        type: 'boolean',
        description: 'For "close" action: also permanently remove durable event log files.',
      },
      workspace_path: {
        type: 'string',
        description: 'Optional workspace path.',
      },
    },
    required: ['action'],
  },
};

export const cancelToolDefinition = {
  name: CANONICAL_TOOL_NAMES.CANCEL,
  description:
    'Explicit subprocess teardown and lock recovery for an active or hung session.',
  inputSchema: {
    type: 'object',
    properties: {
      session_handle: {
        type: 'string',
        description: 'The opaque session handle whose execution should be cancelled.',
      },
      workspace_path: {
        type: 'string',
        description: 'Optional workspace path.',
      },
    },
    required: ['session_handle'],
  },
};

export async function handleSession(args: ToolArguments) {
  const action = args?.action;
  if (!action || !['list', 'history', 'close'].includes(action)) {
    throw new Error('Validation Error: action must be one of "list", "history", "close".');
  }
  if (action === 'list') {
    const sessions = listSessions();
    if (!sessions.length) {
      return {
        content: [{ type: 'text' as const, text: '> CoAgent: No active sessions found.' }],
        structuredContent: { schemaVersion: 1, sessions: [] },
      };
    }
    const lines = ['## Active CoAgent Sessions', ''];
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
      throw new Error('Validation Error: session_handle is required for action "history".');
    }
    return await handleSessionHistory({ ...args, session_handle: args.session_handle });
  }
  if (action === 'close') {
    if (!args.session_handle || typeof args.session_handle !== 'string') {
      throw new Error('Validation Error: session_handle is required for action "close".');
    }
    return await handleCloseSession(args);
  }
  throw new Error(`Unknown action: ${action}`);
}

export async function handleCancelSession(args: { session_handle: string; workspace_path?: string }) {
  if (!args?.session_handle || typeof args.session_handle !== 'string') {
    throw new Error('Validation Error: session_handle is required and must be a string.');
  }
  const workspace = args.workspace_path ? resolveWorkspacePath(args.workspace_path) : undefined;
  const result = await cancelSession(args.session_handle, workspace);
  return {
    content: [
      {
        type: 'text' as const,
        text: `> CoAgent: ${result.message}`,
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

export async function handleCloseSession(args: ToolArguments) {
  if (typeof args.session_handle !== 'string' || !args.session_handle) throw new Error('Validation Error: session_handle is required for action "close".');
  const workspace = resolveWorkspacePath(args.workspace_path);
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

export async function handleSessionHistory(args: { session_handle: string; workspace_path?: string; cursor?: string; limit?: number }) {
  const workspace = resolveWorkspacePath(args.workspace_path);
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
