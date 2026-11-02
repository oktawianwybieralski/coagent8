/**
 * Session activity and process liveness inspection.
 *
 * @remarks
 * Implements narrow session activity and lease queries by reading disk records
 * and testing process liveness without importing the session service or history store.
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process';
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
  return explicit
    ? explicit.endsWith('.json')
      ? path.join(path.dirname(explicit), 'sessions')
      : explicit
    : path.join(getDataDir(), 'sessions');
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

/** Two reads of one process's start time differ by less than this. */
const START_TOLERANCE_MS = 5000;
/** How long a read start time is used again: a waiter asks about the same process twice a second. */
const START_CACHE_MS = 30 * 1000;
const startCache = new Map<number, { at: number; startedAt: number | null }>();

function readStart(pid: number): number | null {
  const ran =
    process.platform === 'win32'
      ? spawnSync(
          // System copies by full path: PATH must not choose what runs here.
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        )
      : // In UTC: a change of the time zone must not move a stored time.
        spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        });
  const text = ran.status === 0 ? ran.stdout.trim() : '';
  const value = process.platform === 'win32' ? Number(text) : Date.parse(`${text} UTC`);
  return text && Number.isFinite(value) ? value : null;
}

/**
 * Reads when another process started.
 * @param pid - Process ID.
 * @returns Epoch milliseconds, or null when the system does not say.
 */
export function processStartTime(pid: number): number | null {
  const cached = startCache.get(pid);
  // Monotonic: a clock set back must not keep an old answer.
  if (cached && performance.now() - cached.at < START_CACHE_MS) return cached.startedAt;
  const startedAt = readStart(pid);
  startCache.set(pid, { at: performance.now(), startedAt });
  return startedAt;
}

let ownStart: number | null | undefined;

/**
 * This process's start time as the system reports it, the same source later readers compare with.
 * @returns Epoch milliseconds, or undefined when the system does not say: a record then holds the
 * PID alone. Read once per server.
 */
export function ownProcessStartTime(): number | undefined {
  if (ownStart === undefined) ownStart = readStart(process.pid);
  return ownStart ?? undefined;
}

/**
 * Tests whether the process a record names still runs, also when its PID may have been reused.
 *
 * @param pid - The stored process ID.
 * @param startedAt - Its stored start time; a record without one is judged by the PID.
 * @param readStartTime - Reads a process's start time; replaceable by tests.
 * @returns False when the PID is free or now names a later process. When the start time cannot
 * be told, the answer is the PID alone: a record may then look busy, never free by mistake.
 */
export function isRecordedProcessAlive(
  pid: number | null | undefined,
  startedAt: number | null | undefined,
  readStartTime: (pid: number) => number | null = processStartTime,
): boolean {
  if (!isProcessAlive(pid)) return false;
  if (typeof startedAt !== 'number') return true;
  const actual = pid === process.pid ? (ownProcessStartTime() ?? null) : readStartTime(pid!);
  return actual === null || Math.abs(actual - startedAt) < START_TOLERANCE_MS;
}

/**
 * Tests whether a POSIX process group still has members.
 *
 * @param groupId - Process group ID to check.
 * @returns True if a member exists; always false on Windows, which has no such groups.
 */
export function isProcessGroupAlive(groupId: number): boolean {
  if (process.platform === 'win32' || !Number.isSafeInteger(groupId) || groupId <= 0) return false;
  try {
    process.kill(-groupId, 0);
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
    const s = parsed as { activePid?: unknown; activePidStartedAt?: unknown; state?: unknown };
    const pid = typeof s.activePid === 'number' ? s.activePid : null;
    const startedAt = typeof s.activePidStartedAt === 'number' ? s.activePidStartedAt : null;
    return pid !== null && isRecordedProcessAlive(pid, startedAt);
  } catch {
    return false;
  }
}
