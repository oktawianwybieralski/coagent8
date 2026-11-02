/**
 * The `delegate` tool (`DELEGATE-001w`): another backend makes a change in the workspace, and
 * the result reports what the server observed changing, separate from the worker's report.
 *
 * @packageDocumentation
 */
import type { ToolArguments, ToolProgress } from '../arguments.js';
import { EXECUTION_PARAMETERS } from '../schema.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { formatExecutionResult } from '../result.js';
import { executeDelegation, startDelegation, type Supervise } from '../../execution/delegation.js';
import { approveChecks, parseCheckCommand, type CheckApprovalPrompt } from '../../execution/checks.js';
import { reviewOnAnotherBackend, superviseChange } from '../../execution/loop.js';
import { resolveBackend } from '../../execution/routing.js';
import { loadConfig } from '../../config.js';
import { executeReview } from './review.tool.js';
import { getDataDir, getRuntimePath } from '../../paths.js';
import { endNotesPath, isTaskFinished, type DelegationTask } from '../../sessions/tasks.js';
import type { TaskOptions } from '../../execution/controller.js';
import { normalizeScopeEntry } from '../../workspace/changes.js';
import { ToolError } from '../../contracts/error.js';

/** Arguments of `delegate`; its `scope` is a path list, unlike the review range of `review`. */
export type DelegateArguments = Omit<ToolArguments, 'scope'> & {
  task?: string;
  scope?: string[];
  checks?: string[];
  loop?: boolean;
  mode?: 'async' | 'sync';
  request_id?: string;
};

/** Scope entries and checks accepted at most. */
const MAX_LIST_ENTRIES = 50;

export function getCanonicalDelegateToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.DELEGATE,
    description: 'Another agent edits code here, no commits; returns a task handle, then its report and files seen changing. Review it.',
    inputSchema: {
      type: 'object',
      properties: {
        // An empty task is refused by the handler; `minLength` would cost bytes on every Codex request.
        task: { type: 'string', description: 'Change and acceptance criteria; name files, do not paste.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Paths it may change.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Commands, e.g. npm test.' },
        loop: { type: 'boolean', description: 'Server checks, reviews.' },
        mode: { type: 'string', enum: ['async', 'sync'] },
        request_id: { type: 'string' },
        ...EXECUTION_PARAMETERS,
        // Said in full on consult; the budget of the tool definitions counts every copy.
        backend: { ...EXECUTION_PARAMETERS.backend, description: 'As in consult.' },
        reasoning_effort: { ...EXECUTION_PARAMETERS.reasoning_effort, description: 'As in consult.' },
      },
      required: ['task'],
    },
  };
}

function list(values: unknown, name: string): string[] {
  const entries = Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
  if (entries.length > MAX_LIST_ENTRIES) throw new ToolError('INPUT_LIMIT', `Too many ${name} entries (at most ${MAX_LIST_ENTRIES}).`);
  return entries.map(v => v.trim());
}

/** Builds the worker's prompt: the task, its scope and checks, and the rules of a delegated change. */
export function delegatePrompt(task: string, scope: readonly string[], checks: readonly string[], loop = false): string {
  return [
    '[TASK: DELEGATED CODE CHANGE]',
    'Another agent delegates this change to you. Make it by editing files in this workspace, then report.',
    `Change only: ${scope.length ? scope.join(', ') : 'files in this workspace'}.`,
    'Do not commit, push, reset, stash, check out or switch branches, and do not change Git configuration or files outside the workspace; leave your changes in the working tree.',
    ...(loop ? ['The server runs the checks below and an independent review after you finish, and returns failures to you.'] : []),
    checks.length
      ? 'Run the checks below and fix failures your change causes.'
      : "Run the project's relevant tests or checks if there are any, and fix failures your change causes.",
    // agy writers may not run commands, and a sandbox can deny one (DELEGATE-001w).
    'A command that fails for another reason is no denial: try another way to make the change.',
    'If a command is denied or cannot start, do not work around the restriction: report that check as NOT_RUN; the calling agent runs it.',
    'End with a short report: the files you changed and why, each check with PASS, FAIL or NOT_RUN, and anything left undone.',
    'TASK:',
    task,
    checks.length ? 'CHECKS:' : '',
    ...checks.map(check => `- ${check}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/** The loop of one delegation: the review runs on another backend, in one session across rounds. */
function loopSupervisor(task: string, checks: readonly string[], workspaceCwd: string, clock: TaskOptions['clock']): Supervise {
  return (first, turn) => {
    let reviewSession: string | undefined;
    let reviewBackend: string | undefined;
    return superviseChange(first, {
      checks,
      cwd: workspaceCwd,
      signal: turn.signal,
      remainingMs: () => turn.budget?.remainingExecutionMs() ?? Number.POSITIVE_INFINITY,
      fix: turn.fix,
      review: async () => {
        // The backend and its session stay across rounds, so a later round compares with the earlier one.
        const reviewed = await reviewOnAnotherBackend(
          first.provider,
          async excluded =>
            reviewBackend && !excluded.has(reviewBackend)
              ? reviewBackend
              : (
                  await resolveBackend('auto', {
                    context: turn.context,
                    eligible: async id =>
                      excluded.has(id) ? new ToolError('CLI_NOT_FOUND', `${id} wrote this change or is out of quota.`) : undefined,
                  })
                ).id,
          backend =>
            turn.inRound(round =>
              executeReview(
                {
                  backend,
                  scope: 'uncommitted',
                  instructions: `A change delegated with this task: ${task}`,
                  ...(backend === reviewBackend && reviewSession ? { session_handle: reviewSession } : {}),
                },
                workspaceCwd,
                turn.signal,
                null,
                { ...round, clock },
              ),
            ),
        );
        reviewBackend = reviewed.provider ?? reviewBackend;
        reviewSession = reviewed.sessionHandle ?? reviewSession;
        return reviewed;
      },
    });
  };
}

/** The command that blocks until a task finishes, built from this server's own process. */
export function waitCommand(taskHandle: string): { argv: string[]; env: Record<string, string> } {
  return {
    argv: [process.execPath, getRuntimePath(), 'wait', '--data-dir', getDataDir(), '--notes-dir', endNotesPath(), taskHandle],
    // VS Code's Electron runs a script only with this set.
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

/** Clients observed to start a new agent turn when a background command exits (`DELEGATE-001a`). */
const BACKGROUND_WAKE_CLIENTS = /^claude-code/i;

function delegationStarted(task: DelegationTask, clientName?: string) {
  const { argv, env } = waitCommand(task.taskHandle);
  const wakeup = BACKGROUND_WAKE_CLIENTS.test(clientName ?? '') ? 'background_wait' : 'none';
  const finished = isTaskFinished(task.state);
  const lines = [
    finished ? 'Delegation already finished.' : 'Delegation started.',
    `task_handle: ${task.taskHandle}`,
    `session_handle: ${task.sessionHandle}`,
    `state: ${task.state}`,
    `wakeup: ${wakeup}`,
    `wait_argv: ${JSON.stringify(argv)}`,
    ...(Object.keys(env).length ? [`wait_env: ${JSON.stringify(env)}`] : []),
    '',
    finished
      ? 'Read the result with the session tool, action task.'
      : wakeup === 'background_wait'
        ? 'Start wait_argv now as a background command: you are woken when it exits. Do not edit this work tree while the worker runs.'
        : 'Read the result later with the session tool, action task, or run wait_argv. Do not edit this work tree while the worker runs.',
  ];
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: {
      schemaVersion: 1,
      taskHandle: task.taskHandle,
      sessionHandle: task.sessionHandle,
      state: task.state,
      wakeup,
      waitArgv: argv,
      waitEnv: env,
    },
  };
}

/**
 * Runs a delegated change.
 * @throws `INPUT_LIMIT` for a scope entry that is absolute or leaves the workspace, or too many entries.
 */
export async function handleDelegate(
  args: DelegateArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: Pick<TaskOptions, 'askConsent' | 'budget' | 'context' | 'clock' | 'warnings'> & {
    clientName?: string;
    askChecks?: CheckApprovalPrompt;
  } = {},
) {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) throw new ToolError('INPUT_LIMIT', 'task is required.');
  const scope = list(args.scope, 'scope').map(entry => {
    const normalized = normalizeScopeEntry(entry);
    if (normalized === null)
      throw new ToolError('INPUT_LIMIT', `Scope entry '${entry.slice(0, 120)}' is absolute or leaves the workspace.`);
    return normalized;
  });
  const checks = list(args.checks, 'checks');
  const wholeWorkspace = scope.includes('');
  const effectiveScope = wholeWorkspace ? [] : scope;
  // History keeps what was asked: the task, its scope and its checks.
  const publicInput = [
    task,
    effectiveScope.length ? `Scope: ${effectiveScope.join(', ')}` : '',
    checks.length ? `Checks: ${checks.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const { scope: _scope, checks: _checks, task: _task, loop: loopArgument, mode, request_id: requestId, ...request } = args;
  const loop = loopArgument === true;
  // A check that cannot run is refused now, not after the worker's turn.
  if (loop) checks.forEach(parseCheckCommand);
  const approve = async () => {
    if (loop) await approveChecks(checks, loadConfig().allowedChecks ?? [], options.askChecks, abortSignal);
  };
  const supervise = loop ? loopSupervisor(task, checks, workspaceCwd, options.clock) : undefined;
  const prompt = delegatePrompt(task, effectiveScope, checks, loop);
  if (mode !== undefined && mode !== 'async' && mode !== 'sync') throw new ToolError('INPUT_LIMIT', 'mode must be async or sync.');
  if (mode !== 'sync') {
    const started = await startDelegation({
      prompt,
      publicInput,
      approve,
      supervise,
      args: request,
      cwd: workspaceCwd,
      scope: effectiveScope,
      requestId: typeof requestId === 'string' && requestId ? requestId : undefined,
      requestSignal: abortSignal,
      format: outcome => {
        const formatted = formatExecutionResult(outcome);
        return { text: formatted.content.map(part => part.text).join('\n'), isError: Boolean(formatted.isError) };
      },
      options: { requireEnvelope: false, askConsent: options.askConsent, warnings: options.warnings, clock: options.clock },
    });
    if ('outcome' in started) return formatExecutionResult(started.outcome);
    return delegationStarted(started.task, options.clientName);
  }
  await approve();
  const { askChecks: _askChecks, clientName: _clientName, ...taskOptions } = options;
  const outcome = await executeDelegation(prompt, publicInput, request, workspaceCwd, effectiveScope, abortSignal, onProgress, {
    requireEnvelope: false,
    ...taskOptions,
    supervise,
  });
  return formatExecutionResult(outcome);
}
