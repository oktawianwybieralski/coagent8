/**
 * Ledgers of delegated coordination (#164): which workers a coordinator asked for.
 *
 * @remarks
 * A coordinator's request is stored before any of its workers starts, so a crash between a request
 * and a launch can be read back. Workers get handles derived from the ledger's session and their id,
 * so a repeated start finds the existing task instead of running a second writer. Nothing here starts
 * or stops anything.
 *
 * @packageDocumentation
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../contracts/index.js';
import { getDataDir } from '../paths.js';
import { atomicWrite } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';

/** One worker a coordinator asked for. */
export interface CoordinationChild {
  /** The coordinator's own name for it, unique in the ledger. */
  id: string;
  taskHandle: string;
  /** Why it did not start, when the server knows. */
  startError?: string;
  /** Whether a coordinator turn that was told how it ended has finished. */
  reported: boolean;
}

/** The ledger of one coordinator session. */
export interface CoordinationRecord {
  schemaVersion: 1;
  sessionHandle: string;
  rootHandle: string;
  /** The first task of this session: the parent of all its workers, also after a continuation. */
  parentTask: string;
  /** What the first start allowed its workers; a continuation can only narrow it. */
  scope: readonly string[];
  children: CoordinationChild[];
}

/** Bounds reading a damaged file; fits {@link MAX_COORDINATION_CHILDREN} entries with their refusals. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
/** Workers one ledger may name, refused ones included. */
export const MAX_COORDINATION_CHILDREN = 2000;
/** Kept as long as the task records it names. */
const RETENTION_MS = 7 * 24 * 3600 * 1000;

function coordinationsDir(): string {
  return path.join(getDataDir(), 'delegations', 'coordinations');
}

function recordFile(sessionHandle: string): string {
  return path.join(coordinationsDir(), `${crypto.createHash('sha256').update(sessionHandle).digest('hex').slice(0, 32)}.json`);
}

/**
 * Reads the ledger of a session.
 * @returns The ledger, or null when this session never asked for a worker.
 * @throws `PROTOCOL_ERROR` for a damaged record or one of another session.
 */
export function readCoordination(sessionHandle: string): CoordinationRecord | null {
  let record: Partial<CoordinationRecord> | null;
  try {
    record = JSON.parse(readBoundedFileSync(recordFile(sessionHandle), MAX_RECORD_BYTES)) as Partial<CoordinationRecord> | null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ToolError('PROTOCOL_ERROR', 'The coordination record cannot be read.');
  }
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.sessionHandle !== sessionHandle ||
    !Array.isArray(record.children) ||
    !Array.isArray(record.scope)
  ) {
    throw new ToolError('PROTOCOL_ERROR', 'The coordination record is not valid.');
  }
  return record as CoordinationRecord;
}

/** Writes a ledger atomically. */
export async function writeCoordination(record: CoordinationRecord): Promise<void> {
  fs.mkdirSync(coordinationsDir(), { recursive: true, mode: 0o700 });
  await atomicWrite(recordFile(record.sessionHandle), JSON.stringify(record));
}

/**
 * Removes ledgers past the retention of task records.
 * @param now - Reference time in epoch milliseconds.
 */
export function pruneCoordinations(now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(coordinationsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(coordinationsDir(), name);
    const modified = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (modified !== undefined && now - modified >= RETENTION_MS) fs.rmSync(file, { force: true });
  }
}
