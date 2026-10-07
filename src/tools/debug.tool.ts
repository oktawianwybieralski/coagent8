import type { ToolArguments, ToolProgress } from './arguments.js';
import { EXECUTION_PARAMETERS } from './schema.js';
import { handleConsult } from './consult.tool.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import type { TaskOptions } from '../execution/controller.js';

export function getCanonicalDebugToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.DEBUG,
    description:
      '[Deprecated: Use consult with task_type="debug" instead] Diagnose an error or stack trace using local CLI reasoning agents in read-only sandbox mode. Returns root cause analysis and a step-by-step fix recommendation.',
    inputSchema: {
      type: 'object',
      properties: {
        error_message: {
          type: 'string',
          description: 'The complete error message or stack trace to diagnose.',
        },
        context: {
          type: 'string',
          description: 'What you were doing when the error occurred, relevant inputs, or recent changes.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of relevant source files to provide context.',
        },
        ...EXECUTION_PARAMETERS,
      },
      required: ['error_message'],
    },
  };
}

export async function handleDebugError(
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: Pick<TaskOptions, 'askConsent'> = {}
) {
  if (typeof args.error_message !== 'string' || !args.error_message.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Validation Error: error_message must be a non-empty string.' }],
    };
  }

  const mappedArgs: ToolArguments = {
    ...args,
    proposal: args.error_message,
    specific_questions: args.context,
    task_type: 'debug',
    backend: args.backend || 'auto',
    file_paths: args.file_paths,
  };

  const warning = "Tool 'debug' is deprecated and will be removed in v1.1.0. Use 'consult' with task_type='debug' instead.";
  return handleConsult(
    CANONICAL_TOOL_NAMES.CONSULT,
    mappedArgs,
    workspaceCwd,
    abortSignal,
    onProgress,
    { warnings: [warning], askConsent: options.askConsent }
  );
}

