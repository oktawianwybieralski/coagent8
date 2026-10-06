/** Session identity primitives independent of storage and execution lifecycles. @packageDocumentation */
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
  try { resolved = fs.realpathSync.native(resolved); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Validates a public session handle before it becomes a storage filename. */
export function sanitizeHandle(handle?: string | null): string | null {
  return typeof handle === 'string' && /^syn_sess_[A-Za-z0-9_-]{6,80}$/.test(handle) ? handle : null;
}
