/**
 * One writer per Git work tree (`DELEGATE-001w`).
 *
 * @remarks
 * Every client runs its own server process, and clients may use different CoAgent8 data
 * directories, so the writer record lives in the work tree's own Git directory, which every
 * process working there shares; each linked worktree has its own. The storage lock guards
 * only the short acquire and release transactions; a second writer is refused at once rather
 * than queued. A record whose server process is gone is taken over. A random token names the
 * owning call, so a release never removes another call's record.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { ToolError } from '../contracts/index.js';
import { isProcessAlive } from './activity.js';

/** File name of the writer record inside a Git directory. */
export const WRITER_RECORD_FILE = 'coagent8-writer.json';

interface WriterRecord {
  pid: number;
  token: string;
  startedAt: string;
}

/** Ownership of a work tree's writer slot; `release` is idempotent. */
export interface WriterLease {
  readonly token: string;
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
  if (!r || typeof r !== 'object' || typeof r.token !== 'string' || typeof r.startedAt !== 'string'
    || !Number.isSafeInteger(r.pid) || (r.pid as number) <= 0) throw unreadable(file);
  return r as WriterRecord;
}

function unreadable(file: string): ToolError {
  return new ToolError('SESSION_BUSY', `The delegate writer record ${file} cannot be read. If no delegate call is changing files in this work tree, delete the file.`);
}

/**
 * Takes the writer slot of a Git work tree for this call.
 * @param gitDir - Absolute Git directory of the work tree (`git rev-parse --absolute-git-dir`).
 * @returns The lease, to release when the call has collected its evidence.
 * @throws `SESSION_BUSY` when a live server process holds the slot.
 */
export async function acquireWriterLease(gitDir: string): Promise<WriterLease> {
  const file = path.join(gitDir, WRITER_RECORD_FILE);
  const token = crypto.randomUUID();
  await withFileLock(file, async () => {
    const current = readWriter(file);
    // A reused PID can only make the slot look busy, never let two writers in.
    if (current && isProcessAlive(current.pid)) {
      throw new ToolError('SESSION_BUSY', `Another delegate call has been changing files in this work tree since ${current.startedAt}; wait for it to finish or cancel it.`);
    }
    const record: WriterRecord = { pid: process.pid, token, startedAt: new Date().toISOString() };
    await atomicWrite(file, JSON.stringify(record));
  });
  let released = false;
  return {
    token,
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
