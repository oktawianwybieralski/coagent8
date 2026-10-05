import type { ToolArguments, ToolProgress } from './arguments.js';
import { handleConsult } from './consult.tool.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';

export function getCanonicalImplementToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.IMPLEMENT,
    description:
      '[Deprecated: Use consult with task_type="implementation" instead] Implement a well-specified component, complex algorithm, or class in read-only sandbox mode without writing to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        specification: {
          type: 'string',
          description: 'Detailed description of what to implement, including interface requirements.',
        },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of files that provide relevant types, interfaces, or context.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of files or directories for context.',
        },
        context: {
          type: 'string',
          description: 'Optional background context or architectural details.',
        },
        backend: {
          type: 'string',
          enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'],
          description: 'CLI agent backend to implement with (default: "auto").',
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
          description: 'Reasoning effort depth (default: "high").',
        },
        user_confirmed: {
          type: 'boolean',
          description: 'Mandatory true confirmation if using the top-tier "astra" model.',
        },
        session_handle: {
          type: 'string',
          description: 'Optional persistent session handle from a previous turn.',
        },
      },
      required: ['specification'],
    },
  };
}

export async function handleImplement(
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  forceBackend?: string
) {
  if (typeof args.specification !== 'string' || !args.specification.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Validation Error: specification must be a non-empty string.' }],
    };
  }

  const mappedArgs: ToolArguments = {
    ...args,
    proposal: args.specification,
    specific_questions: args.context,
    task_type: 'implementation',
    backend: forceBackend || args.backend || 'auto',
    context_files: args.context_files || args.file_paths,
  };

  const warning = "Tool 'implement' is deprecated and will be removed in v1.1.0. Use 'consult' with task_type='implementation' instead.";
  return handleConsult(
    CANONICAL_TOOL_NAMES.CONSULT,
    mappedArgs,
    workspaceCwd,
    abortSignal,
    onProgress,
    { warnings: [warning] }
  );
}

