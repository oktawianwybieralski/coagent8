/**
 * Durable records of asynchronous delegations (`DELEGATE-001c`, `e`).
 *
 * @remarks
 * A record is written before a waiter can see the worker finish, so a wake-up always finds the
 * complete result. It outlives the MCP request, not the server: a running record whose server
 * process is gone reads as `interrupted`.
 *
 * @packageDocumentation
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../contracts/index.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { isRecordedProcessAlive, ownProcessIdentity } from './activity.js';

export type TaskState = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export interface DelegationTask {
  schemaVersion: 1;
  taskHandle: string;
  state: TaskState;
  workspace: string;
  sessionHandle: string;
  backend: string;
  model: string | null;
  /** The server process that owns the worker. */
  serverPid: number;
  /** Identity of `serverPid`, so a reused PID is not taken for the running server. */
  serverIdentity?: string;
  startedAt: string;
  finishedAt?: string;
  /** The calling agent's own session, when its client exposes one; a label, never an authority. */
  callerSession?: string;
  /** Hash of the request behind a caller's request id. */
  requestFingerprint?: string;
  /** The root whose budget and cancellation this task shares; absent on a synchronous-era record. */
  rootHandle?: string;
  /** The task the caller named as this one's parent. */
  parentTask?: string;
  /** Place in the root's tree, the first level being 1. */
  depth?: number;
  /** Workspace-relative paths the worker may change; empty or absent means the whole workspace. */
  scope?: readonly string[];
  /** The complete result as the delegate tool formats it, written before the state turns terminal. */
  result?: { text: string; isError: boolean };
}

const TASK_HANDLE = /^task_[a-f0-9]{32}$/;
/** A result is bounded by the tool's own output limits; this bounds reading a damaged file. */
const MAX_TASK_BYTES = 8 * 1024 * 1024;
/** Finished records older than this are removed when a new task starts. */
const TASK_RETENTION_MS = 7 * 24 * 3600 * 1000;

function tasksDir(): string {
  return path.join(getDataDir(), 'delegations');
}

function taskFile(handle: string): string {
  if (!TASK_HANDLE.test(handle)) throw new ToolError('INPUT_LIMIT', 'Invalid task handle.');
  return path.join(tasksDir(), `${handle}.json`);
}

/**
 * A task handle.
 * @param idempotencyKey - The caller's request id with its workspace: the same key gives the same
 * handle, so a repeated start after a lost response finds the existing task.
 * @returns A new handle.
 */
export function createTaskHandle(idempotencyKey?: string): string {
  const id = idempotencyKey
    ? crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
    : crypto.randomBytes(16).toString('hex');
  return `task_${id}`;
}

/** Whether a state is final. */
export function isTaskFinished(state: TaskState): boolean {
  return state !== 'running';
}

/**
 * Writes a task record atomically.
 * @param task - The record.
 */
export async function writeTask(task: DelegationTask): Promise<void> {
  // A new task of a reused handle: a note of the earlier one must not answer for it.
  if (task.state === 'running') removeEndNote(task.taskHandle);
  fs.mkdirSync(tasksDir(), { recursive: true, mode: 0o700 });
  await atomicWrite(taskFile(task.taskHandle), JSON.stringify(task));
}

/**
 * Claims a request id while its task has no record yet, so two identical starts cannot both run.
 * A task's record is written before its turn starts, so a dead owner without one started no turn.
 * Every step runs under the claim's lock: a reader never sees half a claim, and a release or a
 * takeover removes only the claim it read.
 * @returns Gives the claim up; idempotent, and it never rejects: the claim then ages out.
 * @throws `SESSION_BUSY` while a live server process holds the claim.
 */
export async function claimTaskRequest(handle: string): Promise<() => Promise<void>> {
  const file = `${taskFile(handle)}.starting`;
  const token = crypto.randomUUID();
  const readHolder = (): { pid?: unknown; identity?: unknown; token?: unknown } | null => {
    try {
      return JSON.parse(readBoundedFileSync(file, 1024)) as { pid?: unknown; identity?: unknown; token?: unknown };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Written atomically under this lock, so unreadable means damaged, and nobody can own it.
      return {};
    }
  };
  await withFileLock(file, async () => {
    const holder = readHolder();
    if (holder && typeof holder.pid === 'number') {
      if (isRecordedProcessAlive(holder.pid, typeof holder.identity === 'string' ? holder.identity : undefined)) {
        throw new ToolError('SESSION_BUSY', 'The same request_id is still starting; read its task shortly.');
      }
    }
    await atomicWrite(file, JSON.stringify({ pid: process.pid, identity: ownProcessIdentity(), token }));
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await withFileLock(file, async () => {
        if (readHolder()?.token === token) fs.rmSync(file, { force: true });
      });
    } catch (err) {
      process.stderr.write(`CoAgent8: the claim on ${handle} was not removed: ${(err as Error).message}\n`);
    }
  };
}

/** Attempts to store a final record before the result is given up; a full disk may clear. */
const FINAL_WRITE_ATTEMPTS = 3;
const FINAL_WRITE_RETRY_MS = 200;

/**
 * Stores a final record, so that a waiter learns the end of the worker. After failed attempts the
 * result is replaced by a short note, which fits where the result did not.
 * @param task - The final record.
 * @param write - Writes a record.
 * @returns Whether a final record was stored.
 */
export async function writeFinalTask(task: DelegationTask, write: (task: DelegationTask) => Promise<void> = writeTask): Promise<boolean> {
  for (let attempt = 1; attempt <= FINAL_WRITE_ATTEMPTS; attempt++) {
    try {
      await write(task);
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, FINAL_WRITE_RETRY_MS));
    }
  }
  const note: DelegationTask = {
    ...task,
    state: 'failed',
    result: {
      text: 'The worker ended, but its result could not be stored. Inspect the work tree with git status and git diff.',
      isError: true,
    },
  };
  try {
    await write(note);
    return true;
  } catch {
    return writeEndNote(note);
  }
}

const END_NOTE_FILE = /^task_[a-f0-9]{32}-[a-f0-9]{16}\.json(\.\d+\.tmp)?$/;

/** One data directory's note: another's task can have the same handle. */
function endNoteName(handle: string): string {
  const store = crypto.createHash('sha256').update(getDataDir()).digest('hex').slice(0, 16);
  return `${handle}-${store}.json`;
}

/**
 * Where end notes go. A waiter is told the server's, as its temporary directory can differ.
 * @param waiterDirectory - The directory a waiter was given; it is checked like any other.
 */
export function endNotesPath(waiterDirectory = process.env.coagent8_END_NOTES_DIR): string {
  return waiterDirectory || path.join(os.tmpdir(), `coagent8-notes-${process.getuid?.() ?? 'user'}`);
}

/**
 * The directory of end notes: outside the data directory, this user's alone.
 * @returns Its path, or null when it cannot be trusted, such as a link or another user's directory.
 */
function endNotesDir(create: boolean): string | null {
  const dir = endNotesPath();
  try {
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return null;
    // On Windows the temporary directory is private to the user's profile.
    if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) return null;
    return dir;
  } catch {
    return null;
  }
}

/**
 * Stores the end of a task outside the data directory, which has just refused it (#121).
 * @returns Whether a reader can now learn the end.
 */
function writeEndNote(note: DelegationTask): boolean {
  const dir = endNotesDir(true);
  if (!dir) return false;
  const file = path.join(dir, endNoteName(note.taskHandle));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(note), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Removed with the directory's old notes.
    }
    return false;
  }
}

/**
 * The end note of a task.
 * @param handle - The task handle.
 * @param startedAt - The start of the task the reader has a record of: a note of an earlier task
 * with the same handle does not count.
 */
function readEndNote(handle: string, startedAt?: string): DelegationTask | null {
  const dir = endNotesDir(false);
  if (!dir || !TASK_HANDLE.test(handle)) return null;
  try {
    const file = path.join(dir, endNoteName(handle));
    if (Date.now() - fs.statSync(file).mtimeMs >= TASK_RETENTION_MS) return null;
    const note = JSON.parse(readBoundedFileSync(file, MAX_TASK_BYTES)) as DelegationTask;
    return startedAt === undefined || note.startedAt === startedAt ? note : null;
  } catch {
    return null;
  }
}

/** @throws When the note stays: the new task must not start with it in place. */
function removeEndNote(handle: string): void {
  const dir = endNotesDir(false);
  if (dir) fs.rmSync(path.join(dir, endNoteName(handle)), { force: true });
}

/** Removes end notes past the retention of task records. */
function pruneEndNotes(now: number): void {
  const dir = endNotesDir(false);
  if (!dir) return;
  for (const name of fs.readdirSync(dir)) {
    // A waiter can name any directory: only what this code wrote there is ever removed.
    if (!END_NOTE_FILE.test(name)) continue;
    const file = path.join(dir, name);
    const modified = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (modified !== undefined && now - modified >= TASK_RETENTION_MS) fs.rmSync(file, { force: true });
  }
}

/**
 * Reads a task record.
 * @param handle - The task handle.
 * @returns The record, or null when there is none. A running record of a dead server reads as
 * `interrupted`: the worker ended with its server, and partial changes stay for inspection.
 */
export function readTask(handle: string): DelegationTask | null {
  const file = taskFile(handle);
  let task: DelegationTask;
  try {
    task = JSON.parse(readBoundedFileSync(file, MAX_TASK_BYTES)) as DelegationTask;
  } catch (err) {
    // The data directory itself may be what failed, so a note can answer for its record.
    const code = (err as NodeJS.ErrnoException).code;
    const note = readEndNote(handle);
    if (note) return note;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ToolError('PROTOCOL_ERROR', `The task record ${handle} cannot be read.`);
  }
  if (task.state !== 'running') return task;
  const ended = readEndNote(handle, task.startedAt);
  if (ended) return ended;
  return isRecordedProcessAlive(task.serverPid, task.serverIdentity) ? task : { ...task, state: 'interrupted' };
}

/**
 * What a reader is told about a finished task.
 * @param task - The record.
 * @returns The result. An interrupted task gets a warning instead of a final answer: its stored
 * result is not final, and on POSIX its processes can outlive a server that died (`CUR-011`).
 */
export function finishedTaskText(task: DelegationTask): string {
  if (task.state !== 'interrupted') return task.result?.text ?? 'The worker ended without a result.';
  const warning =
    'The server ended before this delegation finished. Its processes may still be running on Linux and macOS: check them, then inspect the work tree with git status before you edit or retry.';
  return task.result ? `${warning}\n\nStored before the server ended, not final:\n\n${task.result.text}` : warning;
}

/**
 * Removes finished task records past their retention.
 * @param now - Reference time in epoch milliseconds.
 */
export function pruneTasks(now = Date.now()): void {
  pruneEndNotes(now);
  let names: string[];
  try {
    names = fs.readdirSync(tasksDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    // A claim left by a dead process is taken over by its request; one that never returns ages out.
    if (name.endsWith('.json.starting')) {
      const claimed = path.join(tasksDir(), name);
      const at = fs.statSync(claimed, { throwIfNoEntry: false })?.mtimeMs;
      if (at !== undefined && now - at >= TASK_RETENTION_MS) fs.rmSync(claimed, { force: true });
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const file = path.join(tasksDir(), name);
    const modified = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (modified === undefined || now - modified < TASK_RETENTION_MS) continue;
    const task = readTask(name.slice(0, -'.json'.length));
    if (task && isTaskFinished(task.state)) fs.rmSync(file, { force: true });
  }
}
