import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function getDataDir(): string {
  return path.resolve(process.env.coagent8_DIR || path.join(os.homedir(), '.coagent8'));
}

/**
 * Resolves workspace path strictly; errors out if explicit path does not exist.
 */
export function resolveWorkspacePath(rawPath?: string | null): string {
  if (typeof rawPath === 'string' && rawPath.trim()) {
    const cleanPath = rawPath.trim();
    if (!fs.existsSync(cleanPath)) {
      throw new Error(`Validation Error: The specified workspace path does not exist: '${cleanPath}'`);
    }
    const stat = fs.statSync(cleanPath);
    if (!stat.isDirectory()) {
      throw new Error(`Validation Error: The specified workspace path is not a directory: '${cleanPath}'`);
    }
    return path.resolve(cleanPath);
  }
  return process.cwd();
}
