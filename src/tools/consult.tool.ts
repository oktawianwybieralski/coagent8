import type { ToolArguments, ToolProgress } from './arguments.js';
import { executeTask } from '../execution/controller.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';

export function getCanonicalConsultToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.CONSULT,
    description:
      'Universal technical consultation: evaluate architecture plans, refactoring strategies, debugging/root-cause analysis, or code implementation proposals.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: {
          type: 'string',
          description: 'The proposed plan, architecture, bug report, or implementation specification to evaluate.',
        },
        task_type: {
          type: 'string',
          enum: ['architecture', 'debug', 'implementation'],
          description: 'Optional task specialization: "architecture" (structural analysis), "debug" (root cause analysis), or "implementation" (code design). Defaults to general technical advice.',
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of relevant files or directories providing context or interfaces.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional alias for context_files: list of files or directories to inspect.',
        },
        specific_questions: {
          type: 'string',
          description: 'Specific concerns, trade-offs, or questions to address.',
        },
        backend: {
          type: 'string',
          enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'],
          description: 'CLI agent backend to consult (default: "auto").',
        },
        workspace_path: {
          type: 'string',
          description: 'Optional absolute path to workspace root.',
        },
        model: {
          type: 'string',
          description: 'Optional model override.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Reasoning depth level (default: "medium").',
        },
        user_confirmed: {
          type: 'boolean',
          description: 'Mandatory true confirmation if using top-tier models ("astra", "claude-3-opus").',
        },
        session_handle: {
          type: 'string',
          description: 'Optional persistent session handle from a previous turn to preserve full multi-turn context.',
        },
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

