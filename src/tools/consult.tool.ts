import type { ToolArguments, ToolProgress } from './arguments.js';
import { EXECUTION_PARAMETERS } from './schema.js';
import { executeTask } from '../execution/controller.js';
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

export async function handleConsult(
  toolName: string,
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: { warnings?: string[] } = {}
) {
  if (typeof args.proposal !== 'string' || !args.proposal.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Validation Error: proposal must be a non-empty string.' }],
    };
  }

  const taskType = args.task_type;
  const rawFiles = Array.isArray(args.context_files)
    ? args.context_files
    : Array.isArray(args.file_paths)
      ? args.file_paths
      : [];
  const files = rawFiles.filter(f => typeof f === 'string' && f.trim().length > 0);
  const filesBlock = files.length > 0 ? `\nTarget files:\n${files.join('\n')}` : '';

  let header: string;
  let defaultQuestions: string;
  if (taskType === 'architecture') {
    header = '[TASK: ARCHITECTURAL & CODE ANALYSIS]';
    defaultQuestions = 'Architectural evaluation, dependency structure, and code design.';
  } else if (taskType === 'debug') {
    header = '[TASK: ROOT CAUSE ANALYSIS]';
    defaultQuestions = 'Root cause diagnosis, stack trace analysis, and step-by-step fix recommendation.';
  } else if (taskType === 'implementation') {
    header = '[TASK: CODE IMPLEMENTATION]';
    defaultQuestions = 'Implementation design, component architecture, and interface specifications.';
  } else {
    header = '[TASK: TECHNICAL ADVICE & CONSULTATION]';
    defaultQuestions = 'General evaluation, trade-offs, and technical advice.';
  }

  const prompt = [
    header,
    'PROPOSAL / SPECIFICATION:',
    args.proposal,
    'QUESTIONS / FOCUS:',
    args.specific_questions || defaultQuestions,
    filesBlock,
  ].filter(Boolean).join('\n');

  return executeTask(
    prompt,
    args.proposal + (args.specific_questions ? '\n' + args.specific_questions : ''),
    { ...args, backend: args.backend },
    workspaceCwd,
    abortSignal,
    onProgress,
    { requireEnvelope: false, warnings: options.warnings }
  );
}

