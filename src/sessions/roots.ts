/**
 * Root records of delegated work (#159, #161): one budget and one cancellation for the tasks of a root.
 *
 * @remarks
 * Every reservation runs under the record's file lock, so server processes sharing a data directory
 * cannot pass a limit together. A root of another data directory does not exist here and is refused.
 * The limits come from the user's configuration when the root is created; a calling agent cannot
 * raise them. A call is charged when it is reserved and refunded only when this process knows that
 * no turn started: an entry of a dead process keeps its charge. A worker finishing never finishes
 * the root: only the caller accepts the work, so a root has no succeeded state.
 *
 * @packageDocumentation
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../contracts/index.js';
import { DEFAULT_ROOT_LIMITS, type RootLimits } from '../contracts/execution.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { isRecordedProcessAlive, ownProcessIdentity } from './activity.js';

/** One task of a root. */
export interface RootTask {
  taskHandle: string;
  /** The worker's session; present once the turn is about to start. */
  sessionHandle?: string;
  pid: number;
  pidIdentity?: string;
  parentTask?: string;
  depth: number;
  startedAt: string;
  endedAt?: string;
}

/** The durable record of a root. */
export interface RootRecord {
  schemaVersion: 1;
  rootHandle: string;
  state: 'open' | 'cancelled';
  limits: RootLimits;
  createdAt: string;
  deadlineAt: string;
  calls: number;
  tasks: RootTask[];
}

const ROOT_HANDLE = /^root_[a-f0-9]{32}$/;
/** Entries are bounded by `maxCalls`; this bounds reading a damaged file. */
const MAX_ROOT_BYTES = 1024 * 1024;
/** Roots without a running task older than this are removed when a new root is created. */
const ROOT_RETENTION_MS = 7 * 24 * 3600 * 1000;

function rootsDir(): string {
  return path.join(getDataDir(), 'delegations', 'roots');
}

function rootFile(handle: string): string {
  if (!ROOT_HANDLE.test(handle)) throw new ToolError('INPUT_LIMIT', 'Invalid root handle.');
  return path.join(rootsDir(), `${handle}.json`);
}

function parseRoot(file: string): RootRecord | null {
  let record: Partial<RootRecord> | null;
  try {
    record = JSON.parse(readBoundedFileSync(file, MAX_ROOT_BYTES)) as Partial<RootRecord> | null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ToolError('PROTOCOL_ERROR', `The root record ${path.basename(file)} cannot be read.`);
  }
  if (!record || record.schemaVersion !== 1 || !Array.isArray(record.tasks) || typeof record.calls !== 'number' || !record.limits) {
    throw new ToolError('PROTOCOL_ERROR', `The root record ${path.basename(file)} is not valid.`);
  }
  return record as RootRecord;
}

/**
 * Reads a root.
 * @returns The record, or null when this data directory has none.
 * @throws `INPUT_LIMIT` for a malformed handle, `PROTOCOL_ERROR` for a damaged record.
 */
export function readRoot(handle: string): RootRecord | null {
  return parseRoot(rootFile(handle));
}

/** Whether a task of a root may still be running: not ended, and its server process lives. */
export function isRootTaskActive(task: RootTask): boolean {
  return !task.endedAt && isRecordedProcessAlive(task.pid, task.pidIdentity);
}

/**
 * Creates a root.
 * @param limits - The user's limits; later configuration changes do not touch this root.
 * @returns The new record.
 */
export async function createRoot(limits: Partial<RootLimits> = {}): Promise<RootRecord> {
  const now = Date.now();
  const effective: RootLimits = { ...DEFAULT_ROOT_LIMITS, ...limits };
  const record: RootRecord = {
    schemaVersion: 1,
    rootHandle: `root_${crypto.randomBytes(16).toString('hex')}`,
    state: 'open',
    limits: effective,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + effective.maxMinutes * 60 * 1000).toISOString(),
    calls: 0,
    tasks: [],
  };
  await atomicWrite(rootFile(record.rootHandle), JSON.stringify(record));
  return record;
}

async function updateRoot<T>(handle: string, change: (record: RootRecord) => T): Promise<T> {
  const file = rootFile(handle);
  return withFileLock(file, async () => {
    const record = parseRoot(file);
    if (!record) throw new ToolError('SESSION_INVALID', `No root ${handle} in this data directory.`);
    const result = change(record);
    await atomicWrite(file, JSON.stringify(record));
    return result;
  });
}

/** Milliseconds left, or a refusal when the root is cancelled or out of time. */
function assertUsable(record: RootRecord): number {
  if (record.state === 'cancelled') throw new ToolError('ABORTED', `Root ${record.rootHandle} was cancelled.`);
  const remainingMs = Date.parse(record.deadlineAt) - Date.now();
  if (!(remainingMs > 0)) throw new ToolError('ROOT_LIMIT', `Root ${record.rootHandle} used its ${record.limits.maxMinutes} minutes.`);
  return remainingMs;
}

function charge(record: RootRecord): void {
  if (record.calls >= record.limits.maxCalls) {
    throw new ToolError('ROOT_LIMIT', `Root ${record.rootHandle} used its ${record.limits.maxCalls} calls.`);
  }
  record.calls++;
}

/**
 * Reserves one task of a root, atomically with every limit it is subject to.
 * @param request - The task, its parent, and the worker session it continues, whose place in the tree it keeps.
 * @returns The task's depth and the milliseconds left in the root.
 * @throws `ROOT_LIMIT` at a limit, `ABORTED` for a cancelled root, `SESSION_BUSY` while the same task
 * is reserved, `INPUT_LIMIT` for a parent outside the root, `SESSION_INVALID` without such a root.
 */
export function reserveRootTask(
  handle: string,
  request: { taskHandle: string; parentTask?: string; continues?: string },
): Promise<{ depth: number; remainingMs: number }> {
  return updateRoot(handle, record => {
    const remainingMs = assertUsable(record);
    if (record.tasks.some(task => task.taskHandle === request.taskHandle && isRootTaskActive(task))) {
      throw new ToolError('SESSION_BUSY', `Task ${request.taskHandle} is already starting in this root.`);
    }
    const parent = request.parentTask ? record.tasks.find(task => task.taskHandle === request.parentTask) : undefined;
    if (request.parentTask && !parent) throw new ToolError('INPUT_LIMIT', `Task ${request.parentTask.slice(0, 80)} is not in this root.`);
    const earlier = request.continues ? record.tasks.findLast(task => task.sessionHandle === request.continues) : undefined;
    const depth = parent ? parent.depth + 1 : (earlier?.depth ?? 1);
    if (depth > record.limits.maxDepth) throw new ToolError('ROOT_LIMIT', `Root ${handle} allows a depth of ${record.limits.maxDepth}.`);
    const running = record.tasks.filter(isRootTaskActive).length;
    if (running >= record.limits.maxConcurrent) {
      throw new ToolError('ROOT_LIMIT', `Root ${handle} already runs ${running} tasks, its limit; wait for one to finish.`);
    }
    charge(record);
    const parentTask = request.parentTask ?? earlier?.parentTask;
    record.tasks.push({
      taskHandle: request.taskHandle,
      pid: process.pid,
      pidIdentity: ownProcessIdentity(),
      ...(parentTask ? { parentTask } : {}),
      depth,
      startedAt: new Date().toISOString(),
    });
    return { depth, remainingMs };
  });
}

/**
 * Binds a reserved task to its worker session just before the turn starts, the last point where a
 * cancellation can still prevent it.
 * @throws `ABORTED` for a cancelled root, `ROOT_LIMIT` for one out of time.
 */
export function bindRootTask(handle: string, taskHandle: string, sessionHandle: string): Promise<void> {
  return updateRoot(handle, record => {
    assertUsable(record);
    const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle);
    if (!task) throw new ToolError('PROTOCOL_ERROR', `Task ${taskHandle} has no reservation in root ${handle}.`);
    task.sessionHandle = sessionHandle;
  });
}

/**
 * Charges one more backend turn of a running task, such as a fix round or a review attempt.
 * @throws `ROOT_LIMIT` at a limit, `ABORTED` for a cancelled root.
 */
export function reserveRootCall(handle: string): Promise<void> {
  return updateRoot(handle, record => {
    assertUsable(record);
    charge(record);
  });
}

/** Marks a task ended; its charge stays. */
export function endRootTask(handle: string, taskHandle: string): Promise<void> {
  return updateRoot(handle, record => {
    const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle && !entry.endedAt);
    if (task) task.endedAt = new Date().toISOString();
  });
}

/** Removes a reservation whose turn this process knows did not start, and returns its charge. */
export function refundRootTask(handle: string, taskHandle: string): Promise<void> {
  return updateRoot(handle, record => {
    const index = record.tasks.findLastIndex(entry => entry.taskHandle === taskHandle && !entry.endedAt);
    if (index < 0) return;
    record.tasks.splice(index, 1);
    record.calls = Math.max(0, record.calls - 1);
  });
}

/**
 * Marks a root cancelled: no reservation succeeds from here on. Stopping its workers is the caller's.
 * @returns The record.
 * @throws `SESSION_INVALID` without such a root.
 */
export function cancelRoot(handle: string): Promise<RootRecord> {
  return updateRoot(handle, record => {
    record.state = 'cancelled';
    return record;
  });
}

/** Removes a root that no task ever used. */
export function removeUnusedRoot(handle: string): Promise<void> {
  const file = rootFile(handle);
  return withFileLock(file, async () => {
    if (parseRoot(file)?.tasks.length === 0) fs.rmSync(file, { force: true });
  });
}

function eachRoot(): RootRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(rootsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter(name => name.endsWith('.json') && ROOT_HANDLE.test(name.slice(0, -'.json'.length)))
    .flatMap(name => {
      const record = parseRoot(path.join(rootsDir(), name));
      return record ? [record] : [];
    });
}

/** The root that holds a worker session, so a continuation stays under its budget. */
export function findRootOfSession(sessionHandle: string): RootRecord | null {
  return eachRoot().find(root => root.tasks.some(task => task.sessionHandle === sessionHandle)) ?? null;
}

/** The root that holds a task. */
export function findRootOfTask(taskHandle: string): RootRecord | null {
  return eachRoot().find(root => root.tasks.some(task => task.taskHandle === taskHandle)) ?? null;
}

/**
 * Removes roots past their retention that no running task uses.
 * @param now - Reference time in epoch milliseconds.
 */
export function pruneRoots(now = Date.now()): void {
  for (const root of eachRoot()) {
    if (now - Date.parse(root.createdAt) >= ROOT_RETENTION_MS && !root.tasks.some(isRootTaskActive)) {
      fs.rmSync(rootFile(root.rootHandle), { force: true });
    }
  }
}
