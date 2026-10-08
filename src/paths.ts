/**
 * File and data directory path resolution.
 * Workspace choice and canonical workspace identity moved to `src/workspace/` (SIMPLIFY-001 S1).
 *
 * @packageDocumentation
 */

import os from 'node:os';
import path from 'node:path';

export function getDataDir(): string {
  return path.resolve(process.env.coagent8_DIR || path.join(os.homedir(), '.coagent8'));
}

// Compatibility re-exports for workspace functions and types
export {
  resolveWorkspacePath,
  type WorkspaceSource,
  type ResolvedWorkspace,
  chooseWorkspace,
} from './workspace/workspace.js';
