/**
 * Session activity and process liveness inspection.
 *
 * @remarks
 * Implements narrow session activity and lease queries by reading disk records
 * and testing process liveness without importing the session service or history store.
 *
 * @packageDocumentation
 */

import path from 'node:path';
import { getDataDir } from '../paths.js';
import { sanitizeHandle } from './identity.js';
import { readBoundedFileSync } from '../storage/read.js';
import type { SessionActivityChecker } from '../contracts/session.js';

export type { SessionActivityChecker };

/**
 * Returns the resolved directory path where session metadata files are stored.
 */
export function getSessionsDir(): string {
  const explicit = process.env.coagent8_SESSIONS_DIR || process.env.coagent8_SESSIONS;
  return explicit ? (explicit.endsWith('.json') ? path.join(path.dirname(explicit), 'sessions') : explicit) : path.join(getDataDir(), 'sessions');
}

/**
 * Tests whether a system process ID is alive and accessible.
 *
 * @param pid - Process ID to check.
 * @returns True if the process exists and responds to signal 0.
 */
export function isProcessAlive(pid?: number | null): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Computes the file path of a session's disk record if the handle is valid.
 *
 * @param handle - Session handle to inspect.
 * @returns Full file path or null if invalid.
 */
export function getSessionFilePath(handle: string): string | null {
  return sanitizeHandle(handle) ? path.join(getSessionsDir(), `${handle}.json`) : null;
}

/**
 * Default activity checker: verifies whether the on-disk session record for a handle
 * exists and is actively executing a turn with an alive process.
 *
 * @param handle - Session handle to test.
 * @returns True if the session has an active execution turn.
 */
export function isSessionActive(handle: string): boolean {
  const file = getSessionFilePath(handle);
  if (!file) return false;
  try {
    const raw = readBoundedFileSync(file);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const s = parsed as { activePid?: unknown; state?: unknown };
    const pid = typeof s.activePid === 'number' ? s.activePid : null;
    return pid !== null && isProcessAlive(pid);
  } catch {
    return false;
  }
}

