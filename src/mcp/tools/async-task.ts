/**
 * Shared MCP presentation and mode validation for asynchronous execution tools (`delegate`, `review`, `consult`).
 *
 * @packageDocumentation
 */
import { ToolError, type TaskExecutionResult, type TaskRole } from '../../contracts/index.js';
import { getDataDir, getRuntimePath } from '../../paths.js';
import { endNotesPath, isTaskFinished, type DelegationTask } from '../../sessions/tasks.js';
import { formatExecutionResult, TIMEOUT_BOUND_LABELS } from '../result.js';

/** Clients observed to start a new agent turn when a background command exits (`DELEGATE-001a`). */
const BACKGROUND_WAKE_CLIENTS = /^claude-code/i;

/**
 * Validates `mode` and returns the effective execution mode for a tool.
 * @param mode - Caller-supplied mode argument.
 * @param defaultMode - Tool's default mode (`'async'` for `delegate`, `'sync'` for `review` and `consult`).
 * @throws `ToolError` (`INPUT_LIMIT`) when `mode` is neither `'async'`, `'sync'`, nor `undefined`.
 */
export function resolveExecutionMode(mode: unknown, defaultMode: 'async' | 'sync'): 'async' | 'sync' {
  if (mode === undefined) return defaultMode;
  if (mode === 'async' || mode === 'sync') return mode;
  throw new ToolError('INPUT_LIMIT', 'mode must be async or sync.');
}

/**
 * Formats a {@link TaskExecutionResult} into the text/error pair persisted on a {@link DelegationTask}.
 */
export function formatTaskOutcome(outcome: TaskExecutionResult): { text: string; isError: boolean } {
  const formatted = formatExecutionResult(outcome);
  return { text: formatted.content.map(part => part.text).join('\n'), isError: Boolean(formatted.isError) };
}

/**
 * Builds the `coagent8 wait` command for a task handle using this server's runtime and data store.
 */
export function waitCommand(taskHandle: string): { argv: string[]; env: Record<string, string> } {
  return {
    argv: [process.execPath, getRuntimePath(), 'wait', '--data-dir', getDataDir(), '--notes-dir', endNotesPath(), taskHandle],
    // VS Code's Electron runs a script only with this set.
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

const ROLE_LABELS: Readonly<Record<TaskRole, string>> = Object.freeze({
  delegate: 'Delegation',
  review: 'Review',
  consult: 'Consult',
});

/**
 * Formats the immediate handle response returned when an asynchronous tool call starts.
 * @param task - Recorded task handle and metadata.
 * @param options - Role label and connected client name for wake-up guidance.
 */
export function formatTaskStarted(task: DelegationTask, options: { role: TaskRole; clientName?: string }) {
  const { argv, env } = waitCommand(task.taskHandle);
  const wakeup = BACKGROUND_WAKE_CLIENTS.test(options.clientName ?? '') ? 'background_wait' : 'none';
  const finished = isTaskFinished(task.state);
  const label = ROLE_LABELS[options.role];
  const editWarning =
    options.role === 'delegate'
      ? ' Do not edit this work tree while the worker runs.'
      : options.role === 'review'
        ? ' Do not edit this work tree while the review runs.'
        : '';
  const boundLine =
    task.timeoutMs !== undefined && task.timeoutBound
      ? `budget: ${task.timeoutMs} ms (${TIMEOUT_BOUND_LABELS[task.timeoutBound]})`
      : undefined;
  const lines = [
    `${label} ${finished ? 'already finished.' : 'started.'}`,
    `task_handle: ${task.taskHandle}`,
    ...(task.rootHandle ? [`root_handle: ${task.rootHandle}`] : []),
    `session_handle: ${task.sessionHandle}`,
    `state: ${task.state}`,
    ...(boundLine ? [boundLine] : []),
    `wakeup: ${wakeup}`,
    `wait_argv: ${JSON.stringify(argv)}`,
    ...(Object.keys(env).length ? [`wait_env: ${JSON.stringify(env)}`] : []),
    '',
    finished
      ? 'Read the result with the session tool, action task.'
      : wakeup === 'background_wait'
        ? `Start wait_argv now as a background command: you are woken when it exits.${editWarning}`
        : `Read the result later with the session tool, action task, or run wait_argv.${editWarning}`,
    ...(finished || !task.rootHandle || options.role !== 'delegate'
      ? []
      : [
          'For more workers under the same limits pass root_handle; cancel with root_handle stops them all. A worker finishing does not accept the work: that stays yours.',
        ]),
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      schemaVersion: 1,
      taskHandle: task.taskHandle,
      ...(task.rootHandle ? { rootHandle: task.rootHandle } : {}),
      ...(task.parentTask ? { parentTask: task.parentTask } : {}),
      sessionHandle: task.sessionHandle,
      state: task.state,
      ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
      ...(task.timeoutBound ? { timeoutBound: task.timeoutBound } : {}),
      wakeup,
      waitArgv: argv,
      waitEnv: env,
    },
  };
}
