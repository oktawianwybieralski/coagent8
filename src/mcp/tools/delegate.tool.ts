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
import { executeDelegation } from '../../execution/delegation.js';
import type { TaskOptions } from '../../execution/controller.js';
import { normalizeScopeEntry } from '../../workspace/changes.js';
import { ToolError } from '../../contracts/error.js';

/** Arguments of `delegate`; its `scope` is a path list, unlike the review range of `review`. */
export type DelegateArguments = Omit<ToolArguments, 'scope'> & { task?: string; scope?: string[]; checks?: string[] };

/** Scope entries and checks accepted at most. */
const MAX_LIST_ENTRIES = 50;

export function getCanonicalDelegateToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.DELEGATE,
    description: 'Another agent changes code here, without commits; returns its report and the files seen changing. Review it.',
    inputSchema: {
      type: 'object',
      properties: {
        // An empty task is refused by the handler; `minLength` would cost bytes on every Codex request.
        task: { type: 'string', description: 'Change and acceptance criteria; name files, do not paste them.' },
        scope: { type: 'array', items: { type: 'string' }, description: 'Paths it may change; default all.' },
        checks: { type: 'array', items: { type: 'string' }, description: 'Commands it runs, e.g. npm test.' },
        ...EXECUTION_PARAMETERS,
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
export function delegatePrompt(task: string, scope: readonly string[], checks: readonly string[]): string {
  return [
    '[TASK: DELEGATED CODE CHANGE]',
    'Another agent delegates this change to you. Make it by editing files in this workspace, then report.',
    `Change only: ${scope.length ? scope.join(', ') : 'files in this workspace'}.`,
    'Do not commit, push, reset, stash, check out or switch branches, and do not change Git configuration or files outside the workspace; leave your changes in the working tree.',
    checks.length
      ? 'Run the checks below and fix failures your change causes.'
      : 'Run the project\'s relevant tests or checks if there are any, and fix failures your change causes.',
    // agy writers may not run commands, and a sandbox can deny one (DELEGATE-001w).
    'If a command is denied or cannot start, do not work around the restriction: report that check as NOT_RUN; the calling agent runs it.',
    'End with a short report: the files you changed and why, each check with PASS, FAIL or NOT_RUN, and anything left undone.',
    'TASK:',
    task,
    checks.length ? 'CHECKS:' : '',
    ...checks.map(check => `- ${check}`),
  ].filter(Boolean).join('\n');
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
  options: Pick<TaskOptions, 'askConsent' | 'budget' | 'context' | 'clock' | 'warnings'> = {}
) {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) throw new ToolError('INPUT_LIMIT', 'task is required.');
  const scope = list(args.scope, 'scope').map(entry => {
    const normalized = normalizeScopeEntry(entry);
    if (normalized === null) throw new ToolError('INPUT_LIMIT', `Scope entry '${entry.slice(0, 120)}' is absolute or leaves the workspace.`);
    return normalized;
  });
  const checks = list(args.checks, 'checks');
  const wholeWorkspace = scope.includes('');
  const effectiveScope = wholeWorkspace ? [] : scope;
  // History keeps what was asked: the task, its scope and its checks.
  const publicInput = [task, effectiveScope.length ? `Scope: ${effectiveScope.join(', ')}` : '', checks.length ? `Checks: ${checks.join('; ')}` : '']
    .filter(Boolean).join('\n');
  const { scope: _scope, checks: _checks, task: _task, ...request } = args;
  const outcome = await executeDelegation(delegatePrompt(task, effectiveScope, checks), publicInput, request, workspaceCwd, effectiveScope,
    abortSignal, onProgress, { requireEnvelope: false, ...options });
  return formatExecutionResult(outcome);
}
