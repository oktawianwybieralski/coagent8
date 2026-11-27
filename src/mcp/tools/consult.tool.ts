import type { ToolArguments, ToolProgress } from '../arguments.js';
import { EXECUTION_PARAMETERS } from '../schema.js';
import type { TaskOptions } from '../../execution/controller.js';
import { openCallScope, runTask, type CallScopeOptions } from '../../execution/task.js';
import { CANONICAL_TOOL_NAMES, HOST_TOOL_GUIDANCE, LEAVE_WORKSPACE_GUIDANCE } from '../constants.js';
import { formatExecutionResult } from '../result.js';
import { loadConfig, resolveExecutionLimits, resolveTurnTimeout } from '../../config.js';
import { startBackgroundTask } from '../../execution/delegation.js';
import { formatTaskOutcome, formatTaskStarted, resolveExecutionMode } from './async-task.js';

export function getCanonicalConsultToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.CONSULT,
    description:
      'Second opinion on a question, design, bug or plan. Sync by default; mode async returns a task_handle (read via wait_argv or session task).',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: { type: 'string', description: 'Self-contained question or plan; name files instead of pasting them. Bad: "thoughts?"' },
        task_type: {
          type: 'string',
          enum: ['architecture', 'debug', 'implementation'],
          description: 'Omit for plain question; else analysis kind.',
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace paths the agent reads itself; only the paths are sent.',
        },
        // Accepted alias of context_files.
        file_paths: { type: 'array', items: { type: 'string' } },
        specific_questions: { type: 'string', description: 'Extra questions or criteria.' },
        ...EXECUTION_PARAMETERS,
      },
      required: ['proposal'],
    },
  };
}

/** Per-call options of a consult. */
export type ConsultOptions = Pick<TaskOptions, 'warnings' | 'askConsent' | 'onTurnStart' | 'beforeExtraTurn'> &
  CallScopeOptions & {
    /** Connected MCP client name for wake-up capability detection in async mode. */
    clientName?: string;
  };

/** Runs a consult turn and returns its unformatted outcome. */
export async function executeConsult(
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: ConsultOptions = {},
) {
  const call = openCallScope(args.timeout_ms, abortSignal, options);
  call.assertLive('Request cancelled before consult execution.');

  const taskType = args.task_type;
  const rawFiles = Array.isArray(args.context_files) ? args.context_files : Array.isArray(args.file_paths) ? args.file_paths : [];
  const files = rawFiles.filter(f => typeof f === 'string' && f.trim().length > 0);
  const filesBlock = files.length > 0 ? `\nTarget files:\n${files.join('\n')}` : '';

  // A task type is the caller's request for a specific kind of analysis. Without one the
  // question is passed on as asked: a default focus such as "trade-offs and technical
  // advice" made backends append engineering sections to plain questions (CONTEXT-001).
  const focus =
    taskType === 'architecture'
      ? { header: '[TASK: ARCHITECTURAL & CODE ANALYSIS]', questions: 'Architectural evaluation, dependency structure, and code design.' }
      : taskType === 'debug'
        ? {
            header: '[TASK: ROOT CAUSE ANALYSIS]',
            questions: 'Root cause diagnosis, stack trace analysis, and step-by-step fix recommendation.',
          }
        : taskType === 'implementation'
          ? {
              header: '[TASK: CODE IMPLEMENTATION]',
              questions: 'Implementation design, component architecture, and interface specifications.',
            }
          : null;
  const questions = args.specific_questions || focus?.questions;

  const prompt = [
    focus?.header,
    // The answer is read in the caller's context and saved to a file by agy above about 4 KB.
    'Answer what is asked, conclusion first, concisely, without preamble or sections nobody asked for.',
    // A limit of the turn otherwise reads as the caller's wish (#130).
    'If something you need is out of reach, say so: the server sets what this turn can reach.',
    focus || files.length > 0 ? HOST_TOOL_GUIDANCE : LEAVE_WORKSPACE_GUIDANCE,
    focus ? 'PROPOSAL / SPECIFICATION:' : '',
    args.proposal,
    questions ? 'QUESTIONS / FOCUS:' : '',
    questions,
    filesBlock,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    return await runTask('consult', {
      prompt,
      publicInput: args.proposal + (args.specific_questions ? '\n' + args.specific_questions : ''),
      args: { ...args, backend: args.backend },
      cwd: workspaceCwd,
      abortSignal,
      onProgress,
      options: {
        warnings: options.warnings,
        askConsent: options.askConsent,
        onTurnStart: options.onTurnStart,
        beforeExtraTurn: options.beforeExtraTurn,
        budget: call.budget,
        context: call.readContext,
        tracker: call.tracker,
        clock: options.clock,
        onTiming: options.onTiming,
      },
    });
  } finally {
    call.dispose();
  }
}

/**
 * Runs a consult turn synchronously or asynchronously depending on `args.mode` (default `'sync'`).
 * @remarks Callers validate `proposal` once at their boundary: the `consult` schema
 * requires a non-empty string, and `run` and the deprecated aliases check their own
 * request argument (AUD-P2-4).
 */
export async function handleConsult(
  toolName: string,
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: ConsultOptions = {},
) {
  const mode = resolveExecutionMode(args.mode, 'sync');
  const config = loadConfig();
  const limits = resolveExecutionLimits(config);
  const resolvedTimeoutMs =
    args.timeout_ms !== undefined || !options.budget ? resolveTurnTimeout(mode, args.timeout_ms, limits) : undefined;
  if (mode === 'async') {
    const publicInput = args.proposal + (args.specific_questions ? '\n' + args.specific_questions : '');
    const started = await startBackgroundTask({
      role: 'consult',
      publicInput,
      args,
      cwd: workspaceCwd,
      scope: [],
      fingerprintInput: {
        proposal: args.proposal,
        task_type: args.task_type,
        context_files: args.context_files,
        file_paths: args.file_paths,
        specific_questions: args.specific_questions,
      },
      requestId: typeof args.request_id === 'string' && args.request_id ? args.request_id : undefined,
      requestSignal: abortSignal,
      root: { limits: config.rootLimits },
      limits,
      format: formatTaskOutcome,
      options: { requireEnvelope: false, askConsent: options.askConsent, warnings: options.warnings, clock: options.clock },
      run: env =>
        executeConsult(args, workspaceCwd, env.signal, null, {
          warnings: options.warnings,
          askConsent: options.askConsent,
          clock: options.clock,
          onTiming: options.onTiming,
          budget: env.budget,
          context: env.context,
          onTurnStart: env.onTurnStart,
          beforeExtraTurn: env.beforeRound,
        }),
    });
    if ('outcome' in started) return formatExecutionResult(started.outcome);
    return formatTaskStarted(started.task, { role: 'consult', clientName: options.clientName });
  }
  const syncArgs = resolvedTimeoutMs !== undefined ? { ...args, timeout_ms: resolvedTimeoutMs } : args;
  return formatExecutionResult(await executeConsult(syncArgs, workspaceCwd, abortSignal, onProgress, options));
}
