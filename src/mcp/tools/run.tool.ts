import type { ToolArguments, ToolProgress } from '../arguments.js';
import { EXECUTION_PARAMETERS } from '../schema.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import type { TaskOptions } from '../../execution/controller.js';
import { handleConsult } from './consult.tool.js';
import { handleReview } from './review.tool.js';
import { handleIssue } from './issue.tool.js';
import { handleLegacyAlias } from './legacy.js';
import { ToolError } from '../../contracts/index.js';

import type { BackendReadContext, ExecutionBudget, MonotonicClock, TimingObserver } from '../../contracts/execution.js';
import type { PhaseTracker } from '../../execution/runtime/timing.js';

export const runToolDefinition = {
  name: CANONICAL_TOOL_NAMES.RUN,
  description:
    'Legacy subcommand gateway, callable but not advertised: runs consult, review, issue or the deprecated analyze, debug and implement actions.',
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
      ...EXECUTION_PARAMETERS,
    },
    required: ['action'],
  },
};

export async function handleRun(
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: Pick<TaskOptions, 'askConsent'> & {
    onTiming?: TimingObserver;
    tracker?: PhaseTracker;
    clock?: MonotonicClock;
    budget?: ExecutionBudget;
    context?: BackendReadContext;
  } = {}
) {
  const action = args?.action;
  switch (action) {
    case 'consult': {
      if (typeof args.proposal !== 'string' || !args.proposal.trim()) {
        throw new ToolError('INPUT_LIMIT', 'Validation Error: proposal must be a non-empty string for action "consult".');
      }
      return await handleConsult(CANONICAL_TOOL_NAMES.CONSULT, args, workspaceCwd, abortSignal, onProgress, options);
    }
    case 'review': {
      return await handleReview(CANONICAL_TOOL_NAMES.REVIEW, { ...args, scope: args.scope || args.target }, workspaceCwd, abortSignal, onProgress, options);
    }
    case 'issue': {
      return await handleIssue(args);
    }
    case 'analyze':
    case 'debug':
    case 'implement':
      return await handleLegacyAlias(action, args, workspaceCwd, abortSignal, onProgress, options, 'run');
    default:
      throw new ToolError('INPUT_LIMIT', `Validation Error: Unknown action "${action}". Allowed: "consult", "review", "issue", "analyze", "debug", "implement".`);
  }
}

