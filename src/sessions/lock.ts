/**
 * Atomic file lease and storage synchronization service.
 *
 * @remarks
 * ## Architecture & Concurrency Guarantees
 * - **Atomic `.lease` Protocol**: Uses exclusive file creation flags (`O_CREAT | O_EXCL` via `wx`)
 *   to establish cross-process mutual exclusion. Replaces legacy `.claims/` Lamport tickets.
 * - **Ownership Tokens**: Every lease file contains `{ token: UUID, pid: number, createdAt: number }`.
 *   Token checks ensure a process releases or reclaims only the lease it genuinely owns.
 * - **Stale Process Reclamation**: If an existing lease holder's PID is dead (`process.kill(pid, 0)` fails
 *   with ESRCH), stale reclamation is attempted via atomic rename (`.lease.reclaim.<uuid>`).
 *   If the token matches the verified dead owner, the lease is safely cleaned up; if a race
 *   replaces the lease with a live owner in the interim, the lease is immediately restored.
 * - **In-Process Queue Serialization**: Serializes async operations targeting the same canonical
 *   resource path within the Node runtime using promise chaining, preventing unnecessary OS filesystem thrashing.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readBoundedFile } from '../execution/stream.js';

/**
 * Checks whether an OS process with the given PID is currently active.
 *
 * @param pid - Process identifier to probe.
 * @returns True if the process exists (or access is restricted by EPERM), false if ESRCH.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Performs an atomic file write using an isolated temporary file followed by atomic rename.
 * Retries on transient Windows EPERM/EBUSY errors.
 *
 * @param file - Target destination file path.
 * @param text - File content string to persist.
 */
export async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp.${randomUUID()}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
        break;
      }
      catch (err) {
        if (attempt >= 100 || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        await delay(1);
      }
    }
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (err) {
        if (attempt >= 100 || !['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code || '')) throw err;
        const wait = Math.min(50, 5 + Math.floor(attempt * 2) + Math.floor(Math.random() * 5));
        await delay(wait);
      }
    }
  }
  finally { await fs.rm(temp, { force: true }); }
}

export const inProcessLocks = new Map<string, Promise<void>>();

/**
 * Executes an asynchronous function within an exclusive file lease lock.
 *
 * Combines in-process FIFO promise queuing with OS-level `.lease` file acquisition.
 * Handles stale process detection, atomic reclamation, and token-verified cleanup.
 *
 * @typeParam T - Result of the asynchronous critical section.
 * @param resource - Canonical path of the resource or directory to lock.
 * @param fn - Asynchronous critical section callback.
 * @param timeoutMs - Maximum duration to wait before aborting with lock timeout (default: 5000ms).
 * @returns Resolves with the result of `fn`.
 * @throws Error if the lock cannot be acquired within `timeoutMs`.
 */
export async function withFileLock<T>(resource: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const canonical = path.resolve(resource);
  const started = Date.now();

  // In-process serialization to prevent internal async contention within the same Node process
  let prev = inProcessLocks.get(canonical) || Promise.resolve();
  let releaseInProcess!: () => void;
  const currentGate = new Promise<void>(resolve => { releaseInProcess = resolve; });
  const chainedLock = prev.then(() => currentGate, () => currentGate);
  inProcessLocks.set(canonical, chainedLock);

  // Clean up queue tail when this turn and all preceding turns finish
  chainedLock.finally(() => {
    if (inProcessLocks.get(canonical) === chainedLock) {
      inProcessLocks.delete(canonical);
    }
  });

  const leaseFile = `${resource}.lease`;
  const myToken = randomUUID();
  const leasePayload = JSON.stringify({ token: myToken, pid: process.pid, createdAt: Date.now() });

  let acquiredInProcess = false;
  let fileHandle: fs.FileHandle | null = null;
  try {
    const queueTimeout = Math.max(1, timeoutMs - (Date.now() - started));
    let timerHandle: NodeJS.Timeout | null = null;
    const timer = new Promise<never>((_, reject) => {
      timerHandle = setTimeout(() => reject(new Error('Timed out waiting for local storage lock.')), queueTimeout);
    });
    try {
      await Promise.race([prev, timer]);
      acquiredInProcess = true;
    } finally {
      if (timerHandle) clearTimeout(timerHandle);
    }

    let collisionAttempt = 0;
    for (;;) {
      try {
        await fs.mkdir(path.dirname(leaseFile), { recursive: true, mode: 0o700 });
        fileHandle = await fs.open(leaseFile, 'wx', 0o600);
        await fileHandle.writeFile(leasePayload, 'utf8');
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') throw err;
      }

      // Check existing lease owner
      let owner: { token?: string; pid?: number; createdAt?: number } | null = null;
      try {
        const raw = await readBoundedFile(leaseFile, 1024);
        owner = JSON.parse(raw);
      } catch {}

      if (owner?.pid && !alive(owner.pid)) {
        // Stale owner process died; atomically reclaim via rename with token verification
        const reclaimFile = `${leaseFile}.reclaim.${randomUUID()}`;
        try {
          await fs.rename(leaseFile, reclaimFile);
          let movedOwner: { token?: string; pid?: number } | null = null;
          try {
            const raw = await readBoundedFile(reclaimFile, 1024);
            movedOwner = JSON.parse(raw);
          } catch {}

          if (movedOwner?.token === owner.token && movedOwner?.pid === owner.pid) {
            await fs.rm(reclaimFile, { force: true });
            continue;
          } else {
            // A live owner's lease was caught in a race; restore it immediately
            try {
              await fs.rename(reclaimFile, leaseFile);
            } catch {
              await fs.rm(reclaimFile, { force: true }).catch(() => {});
            }
          }
        } catch {}
      }

      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        throw new Error('Timed out waiting for local storage lock.');
      }

      // Jittered exponential backoff: 5ms -> 10ms -> 25ms -> 50ms, mitigating NTFS lock contention
      const baseDelay = 5;
      const maxDelay = 50;
      const exponential = Math.min(maxDelay, Math.floor(baseDelay * Math.pow(1.5, Math.min(collisionAttempt, 8))));
      const jitter = Math.floor(Math.random() * (baseDelay + 1));
      const waitTime = Math.min(exponential + jitter, Math.max(1, timeoutMs - elapsed));
      collisionAttempt++;
      await delay(waitTime);
    }

    return await fn();
  } finally {
    if (fileHandle) {
      try { await fileHandle.close(); } catch {}
      try {
        let current: { token?: string } | null = null;
        try {
          const raw = await readBoundedFile(leaseFile, 1024);
          current = JSON.parse(raw);
        } catch {}
        if (current?.token === myToken) {
          await fs.rm(leaseFile, { force: true });
        }
      } catch {}
    }
    releaseInProcess();
    if (acquiredInProcess && inProcessLocks.get(canonical) === chainedLock) {
      inProcessLocks.delete(canonical);
    }
  }
}

