/**
 * Writers of a Git work tree (`DELEGATE-001w`, #160): the whole tree, or disjoint paths of it.
 *
 * @remarks
 * Every client runs its own server process, and clients may use different CoAgent8 data
 * directories, so the writer record lives in the work tree's own Git directory, which every
 * process working there shares; each linked worktree has its own. A writer of the whole tree has
 * `coagent8-writer.json`; each writer of a path claim has its own file in `coagent8-writers/`, so its
 * synchronous updates need no lock. The storage lock guards only the short acquire and release
 * transactions; an overlapping writer is refused at once rather than queued. A claim is a
 * scheduling agreement and not a sandbox: a worker can still reach another worker's paths.
 * An ended writer of a claim stays as a tombstone until no writer of a claim is left, so that one
 * still running can name the paths others held during its run. A record whose server process is gone is taken over, unless a POSIX process group
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
import { claimsOverlap } from '../workspace/changes.js';
import { isProcessGroupAlive, isRecordedProcessAlive, ownProcessIdentity } from './activity.js';

/** File name of the writer record inside a Git directory. */
export const WRITER_RECORD_FILE = 'coagent8-writer.json';
/** Directory of the writers of path claims, inside a Git directory. */
export const WRITERS_DIRECTORY = 'coagent8-writers';

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
  /** Repository-relative paths this writer holds; absent for the whole work tree. */
  claim?: string[];
  /** Set by the release of a writer of a claim. */
  endedAt?: string;
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
  /**
   * Paths other writers of this tree held during this lease's run. Call before the release.
   * @returns Repository-relative claims, for an annotation: a claim says who could have changed a path, not who did.
   * @throws `SESSION_BUSY` when a record cannot be read.
   */
  peerClaims(): string[];
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
    (r.endedAt !== undefined && typeof r.endedAt !== 'string') ||
    (r.claim !== undefined && !(Array.isArray(r.claim) && r.claim.every(entry => typeof entry === 'string'))) ||
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

/** The records of the writers of claims. */
function readClaimWriters(dir: string): { file: string; record: WriterRecord }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter(name => name.endsWith('.json'))
    .flatMap(name => {
      const file = path.join(dir, name);
      const record = readWriter(file);
      return record ? [{ file, record }] : [];
    });
}

/** Whether a record's writer can no longer change anything, as far as this machine can tell. */
function writerGone(record: WriterRecord, groupAlive: (groupId: number) => boolean): boolean {
  if (record.endedAt) return true;
  return !isRecordedProcessAlive(record.pid, record.pidIdentity) && !record.workerGroups?.some(groupAlive) && !record.starting;
}

/** @throws `SESSION_BUSY` when a record's writer may still be changing files. */
function refuseBusy(record: WriterRecord, file: string, groupAlive: (groupId: number) => boolean): void {
  if (isRecordedProcessAlive(record.pid, record.pidIdentity)) {
    const where = record.claim ? `${record.claim.join(', ')} in this work tree` : 'files in this work tree';
    throw new ToolError(
      'SESSION_BUSY',
      `Another delegate call has been changing ${where} since ${record.startedAt}; wait for it to finish, cancel it, or use a scope that does not overlap.`,
    );
  }
  const living = record.workerGroups?.filter(groupAlive) ?? [];
  if (living.length) {
    throw new ToolError(
      'SESSION_BUSY',
      `A worker of an ended CoAgent8 server may still be changing files in this work tree (process group ${living.join(', ')}). Wait for it to finish, or stop it with: kill -- -${living[0]}`,
    );
  }
  if (record.starting) {
    throw new ToolError(
      'SESSION_BUSY',
      `A CoAgent8 server ended while it started a worker in this work tree, so a worker may still be changing files. If none runs, delete ${file}.`,
    );
  }
}

/** Removes the tombstones once no writer of a claim is left; a live one still needs them. */
function collectIfAllGone(writers: { file: string; record: WriterRecord }[], groupAlive: (groupId: number) => boolean): void {
  if (!writers.every(writer => writerGone(writer.record, groupAlive))) return;
  for (const writer of writers) fs.rmSync(writer.file, { force: true });
}

/**
 * Takes the whole work tree, or a path claim in it, for this call.
 * @param gitDir - Absolute Git directory of the work tree (`git rev-parse --absolute-git-dir`).
 * @param groupAlive - Tests a recorded process group; replaceable by tests.
 * @param claim - Repository-relative paths; empty takes the whole work tree.
 * @returns The lease, to release when the call has collected its evidence.
 * @throws `SESSION_BUSY` when a live server process holds an overlapping claim, or a worker of an
 * ended one still lives.
 */
export async function acquireWriterLease(
  gitDir: string,
  groupAlive: (groupId: number) => boolean = isProcessGroupAlive,
  claim: readonly string[] = [],
): Promise<WriterLease> {
  const wholeTreeFile = path.join(gitDir, WRITER_RECORD_FILE);
  const dir = path.join(gitDir, WRITERS_DIRECTORY);
  const token = crypto.randomUUID();
  const file = claim.length ? path.join(dir, `${token}.json`) : wholeTreeFile;
  /** Writers that had ended before this one started: they were never its peers. */
  const earlier = new Set<string>();
  await withFileLock(wholeTreeFile, async () => {
    const whole = readWriter(wholeTreeFile);
    if (whole) refuseBusy(whole, wholeTreeFile, groupAlive);
    const writers = readClaimWriters(dir);
    for (const writer of writers) {
      if (writerGone(writer.record, groupAlive)) earlier.add(writer.record.token);
      else if (!claim.length || claimsOverlap(claim, writer.record.claim ?? [])) refuseBusy(writer.record, writer.file, groupAlive);
    }
    collectIfAllGone(writers, groupAlive);
    // A writer of a claim takes over a dead whole-tree record by removing it; one of the tree overwrites it.
    if (whole && claim.length) fs.rmSync(wholeTreeFile, { force: true });
    const record: WriterRecord = {
      pid: process.pid,
      pidIdentity: ownProcessIdentity(),
      token,
      startedAt: new Date().toISOString(),
      ...(claim.length ? { claim: [...claim] } : {}),
    };
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
      ...(claim.length ? { claim: [...claim] } : {}),
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
    peerClaims() {
      if (!claim.length) return [];
      return readClaimWriters(dir)
        .filter(({ record }) => record.token !== token && !earlier.has(record.token))
        .flatMap(({ record }) => record.claim ?? []);
    },
    async release() {
      if (released) return;
      released = true;
      await withFileLock(wholeTreeFile, async () => {
        // An unreadable record is left for the user: it may not be this call's.
        const own = readWriter(file);
        if (!claim.length) {
          if (own?.token === token) fs.rmSync(file, { force: true });
          return;
        }
        if (own?.token === token) {
          const { starting: _starting, ...record } = own;
          await atomicWrite(file, JSON.stringify({ ...record, endedAt: new Date().toISOString() }));
        }
        collectIfAllGone(readClaimWriters(dir), groupAlive);
      });
    },
  };
}
