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
 * @returns A resolved real path when available; for a path that no longer exists, the real
 * path of its nearest existing ancestor followed by the missing segments.
 * @remarks A deleted workspace thus keeps the identity it had while it existed, also below a
 * symlink (`/var` on macOS) or a Windows 8.3 short name. This does not authorize access.
 */
export function canonicalPath(value?: string | null): string {
  if (!value) return '';
  const absolute = path.resolve(value);
  let resolved = absolute;
  const missing: string[] = [];
  for (let current = absolute; ;) {
    try {
      resolved = path.join(fs.realpathSync.native(current), ...missing);
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
