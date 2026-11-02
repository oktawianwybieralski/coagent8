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
import fs from 'node:fs';
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

/** How long a read identity is used again: a waiter asks about the same process twice a second. */
const IDENTITY_CACHE_MS = 30 * 1000;
const identityCache = new Map<number, { at: number; identity: string | null }>();

function readLinuxIdentity(pid: number): string | null {
  // Ticks since boot with the boot's id: unlike a wall-clock time, no clock change moves them.
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return ticks && boot ? `${boot}:${ticks}` : null;
}

function readIdentity(pid: number): string | null {
  try {
    if (process.platform === 'linux') return readLinuxIdentity(pid);
    const ran =
      process.platform === 'win32'
        ? spawnSync(
            // System copies by full path: PATH must not choose what runs here.
            path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
            { encoding: 'utf8', windowsHide: true, timeout: 5000 },
          )
        : spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          });
    return (ran.status === 0 && ran.stdout.trim()) || null;
  } catch {
    return null;
  }
}

/**
 * What tells one process from a later one with the same PID.
 * @param pid - Process ID.
 * @param fresh - Skips the short cache.
 * @returns An opaque text, or null when the system does not say.
 */
export function processIdentity(pid: number, fresh = false): string | null {
  const cached = identityCache.get(pid);
  // Monotonic: a clock set back must not keep an old answer.
  if (!fresh && cached && performance.now() - cached.at < IDENTITY_CACHE_MS) return cached.identity;
  const identity = readIdentity(pid);
  identityCache.set(pid, { at: performance.now(), identity });
  return identity;
}

let ownIdentity: string | null | undefined;

/**
 * This process's identity, stored beside its PID.
 * @returns The identity, or undefined when the system does not say: the record then holds the PID
 * alone. Read once per server.
 */
export function ownProcessIdentity(): string | undefined {
  if (ownIdentity === undefined) ownIdentity = readIdentity(process.pid);
  return ownIdentity ?? undefined;
}

/**
 * Tests whether the process a record names still runs, also when its PID may have been reused.
 *
 * @param pid - The stored process ID.
 * @param identity - Its stored identity; a record without one is judged by the PID.
 * @param read - Reads a process's identity; replaceable by tests.
 * @returns False when the PID is free or now names another process. When the identity cannot be
 * told, the answer is the PID alone: a record may then look busy, never free by mistake.
 */
export function isRecordedProcessAlive(
  pid: number | null | undefined,
  identity: string | null | undefined,
  read: (pid: number, fresh?: boolean) => string | null = processIdentity,
): boolean {
  if (!isProcessAlive(pid)) return false;
  if (typeof identity !== 'string') return true;
  if (pid === process.pid) return (ownProcessIdentity() ?? identity) === identity;
  if (read(pid!) === identity) return true;
  // A cached answer may be of the PID's previous process: dead is decided on a fresh read only.
  const current = read(pid!, true);
  return current === null || current === identity;
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
    const s = parsed as { activePid?: unknown; activePidIdentity?: unknown; state?: unknown };
    const pid = typeof s.activePid === 'number' ? s.activePid : null;
    const identity = typeof s.activePidIdentity === 'string' ? s.activePidIdentity : null;
    return pid !== null && isRecordedProcessAlive(pid, identity);
  } catch {
    return false;
  }
}
