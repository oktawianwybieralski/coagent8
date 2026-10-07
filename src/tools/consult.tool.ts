import type { ToolArguments, ToolProgress } from './arguments.js';
import { EXECUTION_PARAMETERS } from './schema.js';
import { executeTask, type TaskOptions } from '../execution/controller.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';

export function getCanonicalConsultToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.CONSULT,
    description: 'Second opinion from another coding agent: advice, design, debugging or implementation.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: { type: 'string', description: 'Question or plan, with context.' },
        task_type: { type: 'string', enum: ['architecture', 'debug', 'implementation'] },
        context_files: { type: 'array', items: { type: 'string' } },
        // Accepted alias of context_files.
        file_paths: { type: 'array', items: { type: 'string' } },
        specific_questions: { type: 'string' },
        ...EXECUTION_PARAMETERS,
      },
      required: ['proposal'],
    },
  };
}

/**
 * Runs a consult turn.
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
  options: Pick<TaskOptions, 'warnings' | 'askConsent'> = {}
) {
  const taskType = args.task_type;
  const rawFiles = Array.isArray(args.context_files)
    ? args.context_files
    : Array.isArray(args.file_paths)
      ? args.file_paths
      : [];
  const files = rawFiles.filter(f => typeof f === 'string' && f.trim().length > 0);
  const filesBlock = files.length > 0 ? `\nTarget files:\n${files.join('\n')}` : '';

  // A task type is the caller's request for a specific kind of analysis. Without one the
  // question is passed on as asked: a default focus such as "trade-offs and technical
  // advice" made backends append engineering sections to plain questions (CONTEXT-001).
  const focus = taskType === 'architecture'
    ? { header: '[TASK: ARCHITECTURAL & CODE ANALYSIS]', questions: 'Architectural evaluation, dependency structure, and code design.' }
    : taskType === 'debug'
      ? { header: '[TASK: ROOT CAUSE ANALYSIS]', questions: 'Root cause diagnosis, stack trace analysis, and step-by-step fix recommendation.' }
      : taskType === 'implementation'
        ? { header: '[TASK: CODE IMPLEMENTATION]', questions: 'Implementation design, component architecture, and interface specifications.' }
        : null;
  const questions = args.specific_questions || focus?.questions;

  const prompt = [
    focus?.header,
    // The answer is read in the caller's context and saved to a file by agy above about 4 KB.
    'Answer what is asked, conclusion first, concisely, without preamble or sections nobody asked for.',
    focus ? 'PROPOSAL / SPECIFICATION:' : '',
    args.proposal,
    questions ? 'QUESTIONS / FOCUS:' : '',
    questions,
    filesBlock,
  ].filter(Boolean).join('\n');

  return executeTask(
    prompt,
    args.proposal + (args.specific_questions ? '\n' + args.specific_questions : ''),
    { ...args, backend: args.backend },
    workspaceCwd,
    abortSignal,
    onProgress,
    { requireEnvelope: false, warnings: options.warnings, askConsent: options.askConsent }
  );
}

