import type { ToolArguments, ToolProgress } from '../arguments.js';
import { closeSession, cancelSession, listSessions } from '../../sessions/session.js';
import { cancelCoordinator, cancelRootTasks, captureDelegation } from '../../execution/delegation.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { WORKSPACE_PARAMETER } from '../schema.js';
import { deleteHistory, getTurnMapping, sessionHistory } from '../../sessions/history/index.js';
import { resolveWorkspacePath } from '../../workspace/workspace.js';
import { ToolError } from '../../contracts/index.js';
import { DEFAULT_ROOT_LIMITS } from '../../contracts/execution.js';
import { redactDiagnostic } from '../../security/redaction.js';
import { finishedTaskText, readTask } from '../../sessions/tasks.js';
import { isRootTaskActive, readRoot, requestCoordinatorCancel, runningTasks } from '../../sessions/roots.js';
import type { SessionRecord } from '../../sessions/types.js';

export const sessionToolDefinition = {
  name: CANONICAL_TOOL_NAMES.SESSION,
  description: 'List, page history, close sessions; read a delegate task.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'history', 'messages', 'close', 'task', 'root'] },
      task_handle: { type: 'string' },
      root_handle: { type: 'string' },
      mine: { type: 'boolean' },
      session_handle: { type: 'string', description: 'history/close.' },
      cursor: { type: 'string', description: 'history.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'history.' },
      delete_history: { type: 'boolean', description: 'close: drop it.' },
      ...WORKSPACE_PARAMETER,
    },
    required: ['action'],
  },
};

export const cancelToolDefinition = {
  name: CANONICAL_TOOL_NAMES.CANCEL,
  description: 'Stop the running turn: interrupt if possible, then end the CLI.',
  inputSchema: {
    type: 'object',
    properties: {
      session_handle: { type: 'string' },
      root_handle: { type: 'string' },
      ...WORKSPACE_PARAMETER,
    },
  },
};

/**
 * A session record as shown to clients: the workspace path with the home directory as `~`.
 * `activePid` identifies the CoAgent8 server process owning the active turn, not the backend CLI child PID.
 */
export function publicSessionRecord(record: SessionRecord): SessionRecord {
  return { ...record, workspace: redactDiagnostic(record.workspace, 1024) };
}

/**
 * Lists, pages history or closes sessions owned by the resolved workspace.
 * @param args - Validated session-tool arguments.
 * @param workspace - Workspace resolved by the server; direct callers default from the argument/cwd.
 */
export async function handleSession(args: ToolArguments, workspace = resolveWorkspacePath(args?.workspace_path)) {
  const action = args?.action;
  if (!action || !['list', 'history', 'messages', 'close', 'task', 'root'].includes(action)) {
    throw new ToolError('INPUT_LIMIT', 'Validation Error: action must be one of "list", "history", "messages", "close", "task", "root".');
  }
  if (action === 'root') return rootReport((args as { root_handle?: unknown }).root_handle);
  if (action === 'task') {
    const handle = (args as { task_handle?: unknown }).task_handle;
    if (typeof handle !== 'string' || !handle)
      throw new ToolError('INPUT_LIMIT', 'Validation Error: task_handle is required for action task.');
    const task = readTask(handle);
    if (!task) throw new ToolError('SESSION_INVALID', `No task ${handle.slice(0, 80)}.`);
    const header = `task_handle: ${task.taskHandle}\nsession_handle: ${task.sessionHandle}\nstate: ${task.state}`;
    // A stored result is final only with the state: until then the writer is still held.
    const running = task.state === 'running';
    const body = running ? 'The worker is still running.' : finishedTaskText(task);
    return {
      content: [{ type: 'text' as const, text: `${header}\n\n${body}` }],
      structuredContent: { ...task, ...(running ? { result: undefined } : {}), workspace: redactDiagnostic(task.workspace, 1024) },
      ...(task.state === 'interrupted' || (!running && task.result?.isError) ? { isError: true } : {}),
    };
  }
  if (action === 'list') {
    const caller = process.env.CLAUDE_CODE_SESSION_ID;
    const onlyMine = (args as { mine?: unknown }).mine === true;
    if (onlyMine && !caller) {
      throw new ToolError('INPUT_LIMIT', 'This client exposes no session id to filter by; list without mine.');
    }
    const sessions = listSessions(workspace)
      .filter(session => !onlyMine || session.callerSession === caller)
      .map(publicSessionRecord);
    if (!sessions.length) {
      return {
        content: [{ type: 'text' as const, text: '> CoAgent8: No active sessions found.' }],
        structuredContent: { schemaVersion: 1, sessions: [] },
      };
    }
    const lines = ['## Active CoAgent8 Sessions', ''];
    for (const s of sessions) {
      lines.push(`- \`${s.sessionHandle}\`: ${s.backend} (${s.model || 'default'}) - turns: ${s.turnCount || 0} - state: ${s.state}`);
    }
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: { schemaVersion: 1, sessions },
    };
  }
  if (action === 'history' || action === 'messages') {
    if (!args.session_handle || typeof args.session_handle !== 'string') {
      throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required for action "history".');
    }
    return await handleSessionHistory({ ...args, session_handle: args.session_handle, messages_only: action === 'messages' }, workspace);
  }
  if (action === 'close') {
    if (!args.session_handle || typeof args.session_handle !== 'string') {
      throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required for action "close".');
    }
    return await handleCloseSession(args, workspace);
  }
  throw new ToolError('INPUT_LIMIT', `Unknown action: ${action}`);
}

/** What a root may use, what it used and how its tasks stand; a root has no state of acceptance. */
function rootReport(handle: unknown) {
  if (typeof handle !== 'string' || !handle)
    throw new ToolError('INPUT_LIMIT', 'Validation Error: root_handle is required for action root.');
  const root = readRoot(handle);
  if (!root) throw new ToolError('SESSION_INVALID', `No root ${handle.slice(0, 80)} in this data directory.`);
  const tasks = root.tasks.map(task => ({
    taskHandle: task.taskHandle,
    ...(task.parentTask ? { parentTask: task.parentTask } : {}),
    depth: task.depth,
    ...(task.coordinator ? { coordinator: true } : {}),
    // A reservation has no task record until its turn is about to start.
    state: readTask(task.taskHandle)?.state ?? (isRootTaskActive(task) ? 'starting' : 'not_started'),
  }));
  const lines = [
    `root_handle: ${root.rootHandle}`,
    `state: ${root.state}`,
    `calls: ${root.calls} of ${root.limits.maxCalls}`,
    `running: ${runningTasks(root).length} of ${root.limits.maxConcurrent}`,
    `children per task: ${root.limits.maxChildren ?? DEFAULT_ROOT_LIMITS.maxChildren}`,
    `depth limit: ${root.limits.maxDepth}`,
    `time until: ${root.deadlineAt}`,
    '',
    ...tasks.map(
      task =>
        `- ${task.taskHandle}: ${task.state}${task.coordinator ? ' (coordinator)' : ''}${task.parentTask ? ` (parent ${task.parentTask})` : ''}`,
    ),
    '',
    'Finished workers do not make the root accepted: check and review the work yourself.',
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { ...root, tasks },
  };
}

/** Cancels a root and reports what its tasks did within the wait. */
async function cancelRootHandle(rootHandle: string) {
  const { ended, running, interrupted } = await cancelRootTasks(rootHandle);
  const parts = [`Root ${rootHandle} is cancelled: ${ended.length} task(s) ended.`];
  if (running.length) parts.push(`Still stopping: ${running.join(', ')}; read the root again shortly.`);
  if (interrupted.length) parts.push(`Their server ended, so their processes may still run on Linux and macOS: ${interrupted.join(', ')}.`);
  const message = parts.join(' ');
  return {
    content: [{ type: 'text' as const, text: `> CoAgent8: ${message}` }],
    structuredContent: { schemaVersion: 1, rootHandle, cancelled: true, ended, running, interrupted, message },
  };
}

/**
 * Cancels the active turn of a session owned by this CoAgent8 server process (`activePid`),
 * or reclaims a stale turn lease from a dead server process.
 */
export async function handleCancelSession(args: { session_handle?: string; root_handle?: string; workspace_path?: string }) {
  if (args?.root_handle) {
    if (args.session_handle) throw new ToolError('INPUT_LIMIT', 'Validation Error: pass session_handle or root_handle, not both.');
    return cancelRootHandle(args.root_handle);
  }
  if (!args?.session_handle || typeof args.session_handle !== 'string') {
    throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required and must be a string.');
  }
  const workspace = args.workspace_path ? resolveWorkspacePath(args.workspace_path) : undefined;
  // Looked up before the cancel, so a delegation that ends during it still reports its outcome.
  const awaitDelegation = captureDelegation(args.session_handle);
  // A coordinator between turns has no turn to cancel: this stops it, and it stops its workers.
  // One of another server process hears of it through its root, within its next look.
  const coordinator = cancelCoordinator(args.session_handle) || (await requestCoordinatorCancel(args.session_handle));
  const result = await cancelSession(args.session_handle, workspace);
  if (coordinator) {
    result.cancelled = true;
    result.message = `Coordinator ${args.session_handle} is stopping, with its workers.`;
  }
  // A delegation's task turns final after its evidence and release: wait, so a read that follows
  // does not report the worker as running (#136).
  // Also when no turn was running any more: the delegation may still be storing its final state.
  const settled = await awaitDelegation();
  if (settled === 'pending') result.message += ' The delegation has not stored its final state yet; read its task again shortly.';
  if (settled === 'unstored')
    result.message += ' The delegation ended, but its final state could not be stored: check the work tree with git status.';
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
  if (typeof args.session_handle !== 'string' || !args.session_handle)
    throw new ToolError('INPUT_LIMIT', 'Validation Error: session_handle is required for action "close".');
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

/**
 * Pages and renders public conversation history for a session handle.
 *
 * @remarks
 * Each event's `sequence` is its stored log position. Consolidated snapshots
 * combine streaming deltas into messages and the Markdown view filters internal
 * lifecycle events (such as `turn_started` and `tool_started`), so gaps in
 * `sequence` numbering do not indicate lost events.
 */
export async function handleSessionHistory(
  args: { session_handle: string; workspace_path?: string; cursor?: string; limit?: number; messages_only?: boolean },
  workspace = resolveWorkspacePath(args.workspace_path),
) {
  let history = await sessionHistory(args.session_handle, workspace, args.cursor, args.limit);
  if (args.messages_only === true) {
    // Filtered page by page, so that a page of tool events alone does not read as the end.
    const isMessage = (event: { type: string }) => event.type === 'user_message' || event.type === 'assistant_message';
    let events = history.events.filter(isMessage);
    while (!events.length && history.nextCursor) {
      history = await sessionHistory(args.session_handle, workspace, history.nextCursor, args.limit);
      events = history.events.filter(isMessage);
    }
    history = { ...history, events };
  }
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
