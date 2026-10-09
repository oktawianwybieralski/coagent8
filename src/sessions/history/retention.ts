/**
 * Session history capacity accounting, directory retention, and eviction.
 *
 * @remarks
 * Enforces the 100 MiB global storage bound across sessions (`TOTAL_LIMIT`),
 * reserves capacity before writes under directory lock, cleans up sessions older
 * than 7 days, and evicts inactive sessions LRU while protecting active turns.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock, atomicWrite, LockTimeoutError, type FileLockOptions } from '../../storage/lock.js';
import { readBoundedFile } from '../../storage/read.js';
import { sanitizeHandle } from '../identity.js';
import { TOTAL_LIMIT, getHistoryDir, statIfExists, sizeIfExists } from './types.js';
import { isSessionActive } from '../activity.js';
import type { SessionActivityChecker } from '../activity.js';
import type { BackendReadContext } from '../../contracts/index.js';

let activityChecker: SessionActivityChecker = isSessionActive;

/**
 * Installs a custom activity checker for determining whether a session is busy.
 *
 * @param checker - Predicate returning true when a session has an active running turn.
 */
export function setSessionActivityChecker(checker: SessionActivityChecker): void {
  activityChecker = checker;
}

/** Whether a live session record names a running turn for this handle. */
export function sessionMayBeActive(handle: string): boolean {
  return activityChecker(handle);
}

let onSessionEvicted: ((handle: string) => void) | null = null;

/**
 * Registers an invalidation callback invoked when an inactive session is evicted.
 *
 * @param fn - Callback receiving the evicted session handle.
 */
export function setHistoryEvictionCallback(fn: (handle: string) => void): void {
  onSessionEvicted = fn;
}

/**
 * Reads the cached directory total from `.capacity.meta`.
 * @returns The total, or null when the cache is missing, oversized or not a valid record
 * and must be recomputed from the directory; other I/O errors propagate.
 */
export async function readCapacityMeta(metaFile: string): Promise<number | null> {
  let raw: string;
  try { raw = await readBoundedFile(metaFile, 1024); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'BUFFER_LIMIT') return null;
    throw err;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return null; /* A torn cache record is recomputed. */ }
  const total = (parsed as { totalBytes?: unknown } | null)?.totalBytes;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
}

/** Records the directory total; when that fails, the cache is removed so the next reader recomputes it. */
export async function writeCapacityMeta(metaFile: string, total: number): Promise<void> {
  try { await atomicWrite(metaFile, JSON.stringify({ totalBytes: total })); }
  catch { await fs.rm(metaFile, { force: true }); }
}

/** Adjusts the cached directory total; a missing cache stays missing and is recomputed on demand. */
export async function adjustCapacityMeta(metaFile: string, deltaBytes: number): Promise<void> {
  const total = await readCapacityMeta(metaFile);
  if (total !== null) await writeCapacityMeta(metaFile, Math.max(0, total + deltaBytes));
}

/** Computes the total storage bytes currently occupied by all session history files in dir. */
export async function calculateDirectoryBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if ((!name.endsWith('.json') && !name.endsWith('.jsonl')) || !sanitizeHandle(name.replace(/\.jsonl?$/, ''))) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        total += stat.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return total;
}

/**
 * Evicts oldest inactive session files to free at least neededBytes, protecting active sessions.
 *
 * @param dir - History directory path.
 * @param neededBytes - Minimum bytes to free.
 * @param activeHandle - Active session handle to protect from eviction.
 * @returns Total bytes freed.
 */
export async function evictOldestSessions(dir: string, neededBytes: number, activeHandle: string): Promise<number> {
  let freed = 0;
  const handles = new Set<string>();
  try {
    for (const name of await fs.readdir(dir)) {
      if ((!name.endsWith('.json') && !name.endsWith('.jsonl')) || name.startsWith('.')) continue;
      const h = name.replace(/\.jsonl?$/, '');
      if (h && sanitizeHandle(h) && h !== activeHandle) {
        handles.add(h);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }

  const candidates: Array<{ handle: string; mtimeMs: number; totalBytes: number }> = [];
  for (const h of handles) {
    if (sessionMayBeActive(h)) continue;

    const jsonFile = path.join(dir, `${h}.json`);
    const logFile = path.join(dir, `${h}.jsonl`);
    let mtimeMs = 0;
    let bytes = 0;
    for (const file of [jsonFile, logFile]) {
      const stat = await statIfExists(file);
      if (stat) { bytes += stat.size; mtimeMs = Math.max(mtimeMs, stat.mtimeMs); }
    }

    if (bytes > 0) {
      candidates.push({ handle: h, mtimeMs, totalBytes: bytes });
    }
  }

  // Sort LRU (oldest mtimeMs first)
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const candidate of candidates) {
    if (freed >= neededBytes) break;
    try {
      await withFileLock(path.join(dir, `${candidate.handle}.lock`), async () => {
        if (sessionMayBeActive(candidate.handle)) return;
        let b = 0;
        for (const file of [path.join(dir, `${candidate.handle}.json`), path.join(dir, `${candidate.handle}.jsonl`)]) {
          const size = await sizeIfExists(file);
          await fs.rm(file, { force: true });
          b += size;
        }
        if (onSessionEvicted) {
          onSessionEvicted(candidate.handle);
        }
        freed += b;
      }, 1);
    } catch (err) {
      // A session whose lock is held right now is being written; the next candidate is evicted instead.
      if (!(err instanceof LockTimeoutError)) throw err;
    }
  }

  return freed;
}

/** Internal directory pruning implementation executed under directory lock. */
export async function pruneHistoryDirectoryInternal(dir: string, extraBytes = 0, activeHandle = ''): Promise<number> {
  const metaFile = path.join(dir, '.capacity.meta');
  await fs.rm(metaFile, { force: true });
  let total = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if ((!name.endsWith('.json') && !name.endsWith('.jsonl')) || !sanitizeHandle(name.replace(/\.jsonl?$/, ''))) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs > 7 * 24 * 3600 * 1000) {
          const sessionHandle = name.replace(/\.jsonl?$/, '');
          if (sessionHandle === activeHandle) {
            total += stat.size;
            continue;
          }
          if (sessionMayBeActive(sessionHandle)) {
            total += stat.size;
            continue;
          }
          try {
            await withFileLock(path.join(dir, `${sessionHandle}.lock`), async () => {
              await fs.rm(file, { force: true });
            }, 1);
          } catch (err) {
            // A session written right now keeps its file until the next sweep.
            if (!(err instanceof LockTimeoutError)) throw err;
            total += stat.size;
          }
        } else {
          total += stat.size;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (total + extraBytes > TOTAL_LIMIT) {
    const needed = total + extraBytes - TOTAL_LIMIT;
    const freed = await evictOldestSessions(dir, needed, activeHandle);
    total = Math.max(0, total - freed);
  }

  await writeCapacityMeta(metaFile, total);
  if (total + extraBytes > TOTAL_LIMIT) {
    throw new Error('History total limit reached.');
  }
  return total;
}

/**
 * Sweeps the history directory, removing sessions older than 7 days and checking
 * the total byte limit under an exclusive directory file lock.
 *
 * @param extraBytes - Expected additional bytes to allocate in the current write.
 * @returns Total storage bytes currently occupied after pruning.
 */
export async function pruneHistoryDirectory(
  extraBytes = 0,
  options?: number | AbortSignal | FileLockOptions | BackendReadContext
): Promise<number> {
  if (process.env.coagent8_HISTORY === 'off') return 0;
  const dir = getHistoryDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(path.join(dir, '.capacity.lock'), () => pruneHistoryDirectoryInternal(dir, extraBytes), options);
}

/**
 * Adds bytes to the directory total before they are written, evicting the oldest other
 * sessions when needed, so the total budget holds at every moment (CUR-012).
 *
 * @throws When eviction cannot free enough space.
 */
export async function reserveCapacity(
  dir: string,
  bytes: number,
  keepHandle: string,
  options?: number | AbortSignal | FileLockOptions | BackendReadContext
): Promise<void> {
  await withFileLock(path.join(dir, '.capacity.lock'), async () => {
    const metaFile = path.join(dir, '.capacity.meta');
    let currentTotal = await readCapacityMeta(metaFile);
    if (currentTotal == null) currentTotal = await calculateDirectoryBytes(dir);
    if (currentTotal + bytes > TOTAL_LIMIT) {
      const freed = await evictOldestSessions(dir, currentTotal + bytes - TOTAL_LIMIT, keepHandle);
      currentTotal = Math.max(0, currentTotal - freed);
      if (currentTotal + bytes > TOTAL_LIMIT) throw new Error('History total limit reached.');
    }
    await writeCapacityMeta(metaFile, currentTotal + bytes);
  }, options);
}

/** Returns bytes reserved for a write that failed. */
export async function releaseCapacity(dir: string, bytes: number): Promise<void> {
  try {
    await withFileLock(path.join(dir, '.capacity.lock'), () => adjustCapacityMeta(path.join(dir, '.capacity.meta'), -bytes));
  } catch {
    // The write error is reported; a cache left high only makes the next eviction earlier,
    // and the next directory scan recomputes it.
  }
}

