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
 * Resolves the agy profile directory CoAgent8 owns: on Windows agy turns, their recovery and
 * resume, and the profile check before them get it as `USERPROFILE`, so agy loads none of the
 * user's own MCP servers and plugins (#224).
 *
 * @returns Absolute path to `<data directory>/agy-profile`; the directory may not exist yet.
 */
export function getAgyProfileDir(): string {
  return path.join(getDataDir(), 'agy-profile');
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
export { resolveWorkspacePath, type WorkspaceSource, type ResolvedWorkspace, chooseWorkspace } from './workspace/workspace.js';
