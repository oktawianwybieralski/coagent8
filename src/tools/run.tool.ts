import type { ToolArguments, ToolProgress } from './arguments.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';
import { handleConsult } from './consult.tool.js';
import { handleReview } from './review.tool.js';
import { handleIssue } from './issue.tool.js';

export const runToolDefinition = {
  name: CANONICAL_TOOL_NAMES.RUN,
  description:
    'Compact subcommand gateway: execute canonical actions (consult, review, issue) or deprecated legacy actions (analyze, debug, implement) with strict validation and argument mapping.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['consult', 'review', 'issue', 'analyze', 'debug', 'implement'],
        description: 'Action to execute: canonical ("consult", "review", "issue") or deprecated legacy ("analyze", "debug", "implement").',
      },
      proposal: {
        type: 'string',
        description: 'The proposed plan, architecture, or refactoring strategy (required for "consult").',
      },
      task_type: {
        type: 'string',
        enum: ['architecture', 'debug', 'implementation'],
        description: 'Optional task specialization for "consult": "architecture", "debug", or "implementation".',
      },
      specific_questions: {
        type: 'string',
        description: 'Specific concerns or questions for "consult".',
      },
      instructions: {
        type: 'string',
        description: 'Review focus guidelines, constraints, conventions, or checks for "review".',
      },
      scope: {
        type: 'string',
        description: 'Target changes to review for "review" (default: "uncommitted").',
      },
      target: {
        type: 'string',
        description: 'Optional explicit target commit SHA, branch, or revision for "review".',
      },
      task: {
        type: 'string',
        description: 'The specific question or focus area to analyze (required for legacy action "analyze").',
      },
      error_message: {
        type: 'string',
        description: 'The complete error message or stack trace (required for legacy action "debug").',
      },
      context: {
        type: 'string',
        description: 'Context or background information for "debug" or "implement".',
      },
      specification: {
        type: 'string',
        description: 'Detailed description of what to implement (required for legacy action "implement").',
      },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of files or directories for "consult", "analyze", "debug", or "implement".',
      },
      include_doctor: {
        type: 'boolean',
        description: 'Whether to attach non-sensitive environment diagnostics for action "issue" (default: true).',
      },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of context files for "consult" or "implement".',
      },
      backend: {
        type: 'string',
        enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'],
        description: 'CLI agent backend to execute with (default: "auto").',
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
        description: 'Reasoning depth level (e.g. "low", "medium", "high", "xhigh", "max").',
      },
      user_confirmed: {
        type: 'boolean',
        description: 'Mandatory true confirmation if using top-tier models ("astra", "claude-3-opus").',
      },
      session_handle: {
        type: 'string',
        description: 'Optional persistent session handle from a previous turn to preserve multi-turn context.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 100,
        maximum: 1800000,
        description: 'Operation deadline in milliseconds.',
      },
    },
    required: ['action'],
  },
};

export async function handleRun(
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null
) {
  const action = args?.action;
  switch (action) {
    case 'consult': {
      if (typeof args.proposal !== 'string' || !args.proposal.trim()) {
        throw new Error('Validation Error: proposal must be a non-empty string for action "consult".');
      }
      return await handleConsult(CANONICAL_TOOL_NAMES.CONSULT, args, workspaceCwd, abortSignal, onProgress);
    }
    case 'review': {
      return await handleReview(CANONICAL_TOOL_NAMES.REVIEW, { ...args, scope: args.scope || args.target }, workspaceCwd, abortSignal, onProgress);
    }
    case 'issue': {
      return await handleIssue(args);
    }
    case 'analyze': {
      if (typeof args.task !== 'string' || !args.task.trim()) {
        throw new Error('Validation Error: task must be a non-empty string for action "analyze".');
      }
      const mappedArgs: ToolArguments = {
        ...args,
        proposal: args.task,
        task_type: 'architecture',
        file_paths: args.file_paths,
        context_files: args.context_files,
      };
      const warning = "Subcommand 'analyze' in run gateway is deprecated. Use action 'consult' with task_type='architecture' instead.";
      return await handleConsult(CANONICAL_TOOL_NAMES.CONSULT, mappedArgs, workspaceCwd, abortSignal, onProgress, { warnings: [warning] });
    }
    case 'debug': {
      if (typeof args.error_message !== 'string' || !args.error_message.trim()) {
        throw new Error('Validation Error: error_message must be a non-empty string for action "debug".');
      }
      const mappedArgs: ToolArguments = {
        ...args,
        proposal: args.error_message,
        specific_questions: args.context,
        task_type: 'debug',
        file_paths: args.file_paths,
        context_files: args.context_files,
      };
      const warning = "Subcommand 'debug' in run gateway is deprecated. Use action 'consult' with task_type='debug' instead.";
      return await handleConsult(CANONICAL_TOOL_NAMES.CONSULT, mappedArgs, workspaceCwd, abortSignal, onProgress, { warnings: [warning] });
    }
    case 'implement': {
      if (typeof args.specification !== 'string' || !args.specification.trim()) {
        throw new Error('Validation Error: specification must be a non-empty string for action "implement".');
      }
      const mappedArgs: ToolArguments = {
        ...args,
        proposal: args.specification,
        specific_questions: args.context,
        task_type: 'implementation',
        context_files: args.context_files || args.file_paths,
        file_paths: args.file_paths,
      };
      const warning = "Subcommand 'implement' in run gateway is deprecated. Use action 'consult' with task_type='implementation' instead.";
      return await handleConsult(CANONICAL_TOOL_NAMES.CONSULT, mappedArgs, workspaceCwd, abortSignal, onProgress, { warnings: [warning] });
    }
    default:
      throw new Error(`Validation Error: Unknown action "${action}". Allowed: "consult", "review", "issue", "analyze", "debug", "implement".`);
  }
}

