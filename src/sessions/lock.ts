/**
 * Atomic file lease and storage synchronization service.
 *
 * @remarks
 * ## Architecture & Concurrency Guarantees
 * - **Atomic `.lease` Protocol**: A lease is written to a temporary file and published with
 *   `link`, which fails when the lease exists. A lease is therefore never observable empty.
 * - **Ownership Tokens**: Every lease file contains `{ token: UUID, pid: number, createdAt: number }`.
 *   Token checks ensure a process releases or reclaims only the lease it genuinely owns.
 * - **Renewal**: The holder renews the lease's modification time every `LEASE_RENEW_MS`.
 * - **Stale Reclamation**: A lease is stale when its owner PID is dead, when it was not renewed
 *   for `LEASE_MAX_AGE_MS` (a reused PID cannot keep a dead owner's lease alive), or when it is
 *   unreadable and older than `UNREADABLE_LEASE_GRACE_MS`. Reclamation renames the lease aside,
 *   confirms it is the one judged stale and otherwise restores it.
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

/** Interval at which a holder renews its lease's modification time. */
const LEASE_RENEW_MS = 2000;
/** A lease not renewed for this long is stale whatever its PID reports. */
const LEASE_MAX_AGE_MS = 30000;
/** An unreadable lease (from a crash in an older release) is stale after this age. */
const UNREADABLE_LEASE_GRACE_MS = 2000;

interface LeaseOwner { token?: string; pid?: number; createdAt?: number }

/** Reads a lease's owner and modification time; `owner` is null when the content is not a lease. */
async function inspectLease(file: string): Promise<{ owner: LeaseOwner | null; mtimeMs: number } | null> {
  let mtimeMs: number;
  try { mtimeMs = (await fs.stat(file)).mtimeMs; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  let owner: LeaseOwner | null = null;
  try {
    const parsed: unknown = JSON.parse(await readBoundedFile(file, 1024));
    if (parsed && typeof parsed === 'object' && typeof (parsed as LeaseOwner).token === 'string') owner = parsed as LeaseOwner;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    // Unparsable or oversized content is judged by age below; other I/O errors propagate.
    if (!(err instanceof SyntaxError) && code !== 'BUFFER_LIMIT') throw err;
  }
  return { owner, mtimeMs };
}

function isStale(lease: { owner: LeaseOwner | null; mtimeMs: number }, now = Date.now()): boolean {
  const age = now - lease.mtimeMs;
  if (!lease.owner) return age > UNREADABLE_LEASE_GRACE_MS;
  if (age > LEASE_MAX_AGE_MS) return true;
  return typeof lease.owner.pid === 'number' && !alive(lease.owner.pid);
}

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
 * Publishes a complete lease file, or reports that a lease already exists.
 * @returns True when this call created the lease.
 */
async function publishLease(leaseFile: string, payload: string): Promise<boolean> {
  const temp = `${leaseFile}.tmp.${randomUUID()}`;
  await fs.writeFile(temp, payload, { flag: 'wx', mode: 0o600 });
  try {
    await fs.link(temp, leaseFile);
    return true;
  } catch (err) {
    // EEXIST: another owner holds the lease. Windows reports EPERM/EBUSY for a lease being deleted.
    if (['EEXIST', 'EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code || '')) return false;
    throw err;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/**
 * Removes a lease judged stale, unless it was replaced after the judgement.
 * @returns True when the stale lease was removed.
 * @remarks The lease is renamed aside first; a different lease found there is linked back.
 */
async function reclaimStaleLease(leaseFile: string, judged: { owner: LeaseOwner | null; mtimeMs: number }): Promise<boolean> {
  const reclaimFile = `${leaseFile}.reclaim.${randomUUID()}`;
  try { await fs.rename(leaseFile, reclaimFile); }
  catch (err) {
    // Another process reclaimed or released it first, or Windows is still deleting it.
    if (['ENOENT', 'EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code || '')) return false;
    throw err;
  }
  try {
    const moved = await inspectLease(reclaimFile);
    const same = moved !== null && moved.mtimeMs === judged.mtimeMs && moved.owner?.token === judged.owner?.token;
    if (moved && !same) {
      // A live owner's lease was caught in a race; put it back unless a newer lease exists.
      await fs.link(reclaimFile, leaseFile).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'EEXIST') throw err; });
      return false;
    }
    return true;
  } finally {
    await fs.rm(reclaimFile, { force: true });
  }
}

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
  let owned = false;
  let renewal: NodeJS.Timeout | null = null;
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
    await fs.mkdir(path.dirname(leaseFile), { recursive: true, mode: 0o700 });
    for (;;) {
      if (await publishLease(leaseFile, leasePayload)) break;
      const lease = await inspectLease(leaseFile);
      if (lease && isStale(lease) && await reclaimStaleLease(leaseFile, lease)) continue;

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
    owned = true;
    renewal = setInterval(() => {
      const now = new Date();
      fs.utimes(leaseFile, now, now).catch(() => { /* A lease removed or replaced meanwhile is not renewed. */ });
    }, LEASE_RENEW_MS);
    renewal.unref();

    return await fn();
  } finally {
    if (renewal) clearInterval(renewal);
    if (owned) {
      try {
        const current = await inspectLease(leaseFile);
        if (current?.owner?.token === myToken) await fs.rm(leaseFile, { force: true });
      } catch (err) {
        // The critical section's result stands; an unreleased lease expires after LEASE_MAX_AGE_MS.
        process.stderr.write(`Warning: could not release storage lease ${path.basename(leaseFile)}: ${(err as Error).message}
`);
      }
    }
    releaseInProcess();
    if (acquiredInProcess && inProcessLocks.get(canonical) === chainedLock) {
      inProcessLocks.delete(canonical);
    }
  }
}

