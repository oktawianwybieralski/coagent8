import type { ExecutionRequest } from '../execution/controller.js';

/** Fields narrowed by the canonical MCP schemas before entering tool handlers. */
export interface ToolArguments extends ExecutionRequest {
  action?: string;
  workspace_path?: string;
  proposal?: string;
  task_type?: string;
  specific_questions?: string;
  task?: string;
  scope?: string;
  target?: string;
  instructions?: string;
  error_message?: string;
  specification?: string;
  context?: string;
  file_paths?: string[];
  context_files?: string[];
  include_doctor?: boolean;
  delete_history?: boolean;
  cursor?: string;
  limit?: number;
}
/** Public progress only; private provider output never belongs in this callback. */
export type ToolProgress = ((info: { message?: string; percent?: number }) => void) | null;
