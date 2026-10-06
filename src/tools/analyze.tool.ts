import type { ToolArguments, ToolProgress } from './arguments.js';
import { handleConsult } from './consult.tool.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';

export function getCanonicalAnalyzeToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.ANALYZE,
    description:
      '[Deprecated: Use consult with task_type="architecture" instead] Perform deep architectural, dependency, and structural code analysis in read-only mode using local CLI reasoning agents.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The specific question, architectural aspect, or focus area to analyze.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of files or directories to inspect.',
        },
        backend: {
          type: 'string',
          enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'],
          description: 'CLI agent backend to analyze with (default: "auto").',
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
          description: 'Reasoning depth level (default: "high").',
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
      required: ['task'],
    },
  };
}

export async function handleAnalyze(
  toolName: string,
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null
) {
  if (typeof args.task !== 'string' || !args.task.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Validation Error: task must be a non-empty string.' }],
    };
  }

  const mappedArgs: ToolArguments = {
    ...args,
    proposal: args.task,
    task_type: 'architecture',
    file_paths: args.file_paths,
  };

  const warning = "Tool 'analyze' is deprecated and will be removed in v1.1.0. Use 'consult' with task_type='architecture' instead.";
  return handleConsult(
    CANONICAL_TOOL_NAMES.CONSULT,
    mappedArgs,
    workspaceCwd,
    abortSignal,
    onProgress,
    { warnings: [warning] }
  );
}

