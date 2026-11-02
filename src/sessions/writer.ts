/**
 * One writer per Git work tree (`DELEGATE-001w`).
 *
 * @remarks
 * Every client runs its own server process, and clients may use different CoAgent8 data
 * directories, so the writer record lives in the work tree's own Git directory, which every
 * process working there shares; each linked worktree has its own. The storage lock guards
 * only the short acquire and release transactions; a second writer is refused at once rather
 * than queued. A record whose server process is gone is taken over, unless a POSIX process group
 * of its worker still lives: nothing ends that group when the server dies, and it could still
 * write. A random token names the owning call, so a release never removes another call's record.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { ToolError } from '../contracts/index.js';
import { isProcessGroupAlive, isRecordedProcessAlive, ownProcessIdentity } from './activity.js';

/** File name of the writer record inside a Git directory. */
export const WRITER_RECORD_FILE = 'coagent8-writer.json';

interface WriterRecord {
  pid: number;
  /** Identity of `pid`; absent when the system does not tell it. */
  pidIdentity?: string;
  token: string;
  startedAt: string;
  /** POSIX process groups of the processes this call started; absent until the first one. */
  workerGroups?: number[];
  /** A process is being started and its group is not recorded yet. */
  starting?: boolean;
}

/** Ownership of a work tree's writer slot; `release` is idempotent. */
export interface WriterLease {
  readonly token: string;
  /**
   * Call synchronously before a worker starts, so a crash from here on leaves the slot taken.
   * @throws When that cannot be recorded: the worker must then not start.
   */
  workerStarting(): void;
  /** Call synchronously after that start, with the worker's process group if it started. */
  workerStarted(groupId?: number): void;
  release(): Promise<void>;
}

/**
 * Reads a writer record.
 * @returns The record, or null when no record exists.
 * @throws `SESSION_BUSY` when a record exists but cannot be read or validated: it may belong
 * to a running writer, so it is never overwritten.
 */
function readWriter(file: string): WriterRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readBoundedFileSync(file, 4096));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unreadable(file);
  }
  const r = raw as Partial<WriterRecord> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.token !== 'string' ||
    typeof r.startedAt !== 'string' ||
    !Number.isSafeInteger(r.pid) ||
    (r.pid as number) <= 0 ||
    (r.pidIdentity !== undefined && typeof r.pidIdentity !== 'string') ||
    (r.starting !== undefined && typeof r.starting !== 'boolean') ||
    (r.workerGroups !== undefined &&
      !(Array.isArray(r.workerGroups) && r.workerGroups.every(group => Number.isSafeInteger(group) && group > 0)))
  )
    throw unreadable(file);
  return r as WriterRecord;
}

function unreadable(file: string): ToolError {
  return new ToolError(
    'SESSION_BUSY',
    `The delegate writer record ${file} cannot be read. If no delegate call is changing files in this work tree, delete the file.`,
  );
}

/**
 * Takes the writer slot of a Git work tree for this call.
 * @param gitDir - Absolute Git directory of the work tree (`git rev-parse --absolute-git-dir`).
 * @returns The lease, to release when the call has collected its evidence.
 * @param groupAlive - Tests a recorded process group; replaceable by tests.
 * @throws `SESSION_BUSY` when a live server process holds the slot, or a worker of an ended one
 * still lives.
 */
export async function acquireWriterLease(
  gitDir: string,
  groupAlive: (groupId: number) => boolean = isProcessGroupAlive,
): Promise<WriterLease> {
  const file = path.join(gitDir, WRITER_RECORD_FILE);
  const token = crypto.randomUUID();
  await withFileLock(file, async () => {
    const current = readWriter(file);
    if (current && isRecordedProcessAlive(current.pid, current.pidIdentity)) {
      throw new ToolError(
        'SESSION_BUSY',
        `Another delegate call has been changing files in this work tree since ${current.startedAt}; wait for it to finish or cancel it.`,
      );
    }
    const living = current?.workerGroups?.filter(groupAlive) ?? [];
    if (living.length) {
      throw new ToolError(
        'SESSION_BUSY',
        `A worker of an ended CoAgent8 server may still be changing files in this work tree (process group ${living.join(', ')}). Wait for it to finish, or stop it with: kill -- -${living[0]}`,
      );
    }
    if (current?.starting) {
      throw new ToolError(
        'SESSION_BUSY',
        `A CoAgent8 server ended while it started a worker in this work tree, so a worker may still be changing files. If none runs, delete ${file}.`,
      );
    }
    const record: WriterRecord = { pid: process.pid, pidIdentity: ownProcessIdentity(), token, startedAt: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(record));
  });
  let released = false;
  let starting = 0;
  let workerGroups: number[] = [];
  // Written whole from this state, so a later write also carries what a failed one lost.
  // Synchronous and without the lock: only this holder writes a record whose process lives, and a
  // reader under the lock sees the old or the new file.
  const writeState = () => {
    const current = readWriter(file);
    if (current?.token !== token) throw new Error('This call no longer holds the writer record.');
    const record: WriterRecord = {
      pid: current.pid,
      pidIdentity: ownProcessIdentity(),
      token,
      startedAt: current.startedAt,
      workerGroups,
      ...(starting > 0 ? { starting: true } : {}),
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return {
    token,
    workerStarting() {
      if (released) throw new Error('This call released the writer record.');
      starting++;
      try {
        writeState();
      } catch (err) {
        starting--;
        throw err;
      }
    },
    workerStarted(groupId) {
      starting--;
      // Ended groups are dropped, so a call with many short commands keeps a small record.
      workerGroups = [...workerGroups.filter(groupAlive), ...(groupId ? [groupId] : [])];
      if (released) return;
      try {
        writeState();
      } catch (err) {
        // The worker runs, so the run goes on; the mark written before its start stays, and refuses takeover.
        process.stderr.write(`Warning: the writer record was not updated: ${(err as Error).message}\n`);
      }
    },
    async release() {
      if (released) return;
      released = true;
      await withFileLock(file, async () => {
        // An unreadable record is left for the user: it may not be this call's.
        if (readWriter(file)?.token === token) fs.rmSync(file, { force: true });
      });
    },
  };
}
