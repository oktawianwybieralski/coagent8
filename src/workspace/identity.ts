/**
 * Canonical workspace identity primitives independent of sessions and storage.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonicalizes workspace ownership identifiers, including Windows case folding.
 * @param value - Workspace path; absent values map to the empty identifier.
 * @returns A resolved real path when available, otherwise a normalized absolute path.
 * @remarks Nonexistent paths retain their normalized identity; this does not authorize access.
 */
export function canonicalPath(value?: string | null): string {
  if (!value) return '';
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

