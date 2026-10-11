/**
 * Workspace path resolution and selection mechanisms.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../contracts/error.js';

/**
 * Resolves workspace path strictly; errors out if explicit path does not exist.
 */
export function resolveWorkspacePath(rawPath?: string | null): string {
  if (typeof rawPath === 'string' && rawPath.trim()) {
    const cleanPath = rawPath.trim();
    if (!fs.existsSync(cleanPath)) {
      throw new ToolError('INPUT_LIMIT', `Validation Error: The specified workspace path does not exist: '${cleanPath}'`);
    }
    const stat = fs.statSync(cleanPath);
    if (!stat.isDirectory()) {
      throw new ToolError('INPUT_LIMIT', `Validation Error: The specified workspace path is not a directory: '${cleanPath}'`);
    }
    return path.resolve(cleanPath);
  }
  return process.cwd();
}

/** Workspace origin used internally; only server-directory fallback is reported in the Markdown footer. */
export type WorkspaceSource = 'argument' | 'client_root' | 'server_directory';

export interface ResolvedWorkspace {
  path: string;
  source: WorkspaceSource;
}

function sameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Home, filesystem root and OS directories are never a project, so they are not used implicitly. */
function isUnsuitableImplicitWorkspace(directory: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // Windows paths compare case-insensitively.
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const candidate = normalize(directory);
  if (candidate === normalize(path.parse(candidate).root) || candidate === normalize(os.homedir())) return true;
  const systemRoot = env.SystemRoot || env.windir;
  return !!systemRoot && sameOrInside(candidate, normalize(systemRoot));
}

/**
 * Chooses the workspace of one call.
 * @param rawPath - The caller's `workspace_path`, which always wins.
 * @param roots - Directories from the client's MCP roots, or `null` when the client does not provide roots.
 * @param serverDirectory - The server's working directory, used only when it is a plausible project.
 * @throws `ToolError` with INPUT_LIMIT when roots are ambiguous or no plausible workspace remains.
 * @remarks Several roots, as Claude Code reports after `--add-dir`, resolve to the one that
 * contains the server's working directory (its launch directory).
 */
export function chooseWorkspace(
  rawPath: string | null | undefined,
  roots: readonly string[] | null,
  serverDirectory = process.cwd()
): ResolvedWorkspace {
  if (typeof rawPath === 'string' && rawPath.trim()) return { path: resolveWorkspacePath(rawPath), source: 'argument' };
  const directories = (roots || []).map(root => path.resolve(root)).filter(root => fs.existsSync(root) && fs.statSync(root).isDirectory());
  if (directories.length === 1) return { path: directories[0], source: 'client_root' };
  if (directories.length > 1) {
    const containing = directories.filter(root => sameOrInside(path.resolve(serverDirectory), root));
    if (containing.length) return { path: containing.sort((a, b) => b.length - a.length)[0], source: 'client_root' };
    throw new ToolError('INPUT_LIMIT', `Validation Error: The client reports ${directories.length} workspace roots; pass workspace_path.`);
  }
  if (isUnsuitableImplicitWorkspace(serverDirectory)) {
    throw new ToolError('INPUT_LIMIT', 'Validation Error: No client workspace root and the server directory is the home or a system directory; pass workspace_path.');
  }
  return { path: path.resolve(serverDirectory), source: 'server_directory' };
}

