/**
 * File and data directory path resolution (`EXEC-001-T03a`).
 *
 * @remarks
 * ## Precedence and Freshness
 * - Data directory resolution honors `coagent8_DIR` environment variable over
 *   default home directory path (`~/.coagent8`).
 * - Custom overrides are captured in configuration snapshots to explain
 *   custom environments and legacy tool registration paths.
 * - Workspace choice and canonical workspace identity moved to `src/workspace/` (SIMPLIFY-001 S1).
 *
 * @packageDocumentation
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the root data directory for CoAgent8 state, caches, and default configuration.
 *
 * @returns Absolute canonical path to the active CoAgent8 data directory.
 */
export function getDataDir(): string {
  return path.resolve(process.env.coagent8_DIR || path.join(os.homedir(), '.coagent8'));
}

/**
 * Resolves the active runtime script or bundle path executing CoAgent8.
 *
 * @returns Absolute normalized path to the running entrypoint file.
 */
export function getRuntimePath(): string {
  if (require.main?.filename) {
    return path.resolve(require.main.filename);
  }
  if (process.argv[1]) {
    return path.resolve(process.argv[1]);
  }
  return path.resolve(__filename);
}

// Compatibility re-exports for workspace functions and types
export {
  resolveWorkspacePath,
  type WorkspaceSource,
  type ResolvedWorkspace,
  chooseWorkspace,
} from './workspace/workspace.js';
