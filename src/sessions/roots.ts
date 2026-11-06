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
import { writerMayStillRun } from './writer.js';

/** One task of a root. */
export interface RootTask {
  taskHandle: string;
  /** The worker's session; present once the turn is about to start. */
  sessionHandle?: string;
  /** The task's writer record, where a worker that outlives the server shows. */
  writer?: { file: string; token: string };
  pid: number;
  pidIdentity?: string;
  parentTask?: string;
  depth: number;
  /** A coordinator: it holds a place among the running tasks only during its turns. */
  coordinator?: boolean;
  /** A coordinator's turn is running or about to. */
  turning?: boolean;
  /** Continues an earlier task's session, so it is no further child of its parent. */
  continuation?: boolean;
  /** Someone asked this coordinator to stop; its server reads this at its next look at the root. */
  cancelRequested?: boolean;
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
/** Fits `ROOT_LIMIT_BOUNDS.maxCalls` entries with the longest paths; bounds reading a damaged file. */
const MAX_ROOT_BYTES = 8 * 1024 * 1024;
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

/** Whether the server process of a task lives; only that process can stop or end the task. */
export function isRootTaskServerAlive(task: RootTask): boolean {
  return isRecordedProcessAlive(task.pid, task.pidIdentity);
}

/**
 * Whether a task may still be using its root: not ended, and its server lives or, on POSIX, a worker
 * of its dead server does (`CUR-011`).
 */
export function isRootTaskActive(task: RootTask): boolean {
  if (task.endedAt) return false;
  return isRootTaskServerAlive(task) || (task.writer ? writerMayStillRun(task.writer.file, task.writer.token) : false);
}

/** The tasks using a root's places: workers, and coordinators during their turns. */
export function runningTasks(root: RootRecord): RootTask[] {
  return root.tasks.filter(task => (!task.coordinator || task.turning) && isRootTaskActive(task));
}

/** Whether a task could start now as far as the root's concurrency goes. */
export function rootHasFreeSlot(root: RootRecord): boolean {
  return runningTasks(root).length < root.limits.maxConcurrent;
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

/** Refuses a root that is cancelled or out of time. */
function assertUsable(record: RootRecord): void {
  if (record.state === 'cancelled') throw new ToolError('ABORTED', `Root ${record.rootHandle} was cancelled.`);
  const remainingMs = Date.parse(record.deadlineAt) - Date.now();
  if (!(remainingMs > 0)) throw new ToolError('ROOT_LIMIT', `Root ${record.rootHandle} used its ${record.limits.maxMinutes} minutes.`);
}

function assertFreeSlot(record: RootRecord): void {
  const running = runningTasks(record).length;
  if (running >= record.limits.maxConcurrent) {
    throw new ToolError('ROOT_LIMIT', `Root ${record.rootHandle} already runs ${running} tasks, its limit; wait for one to finish.`);
  }
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
 * @returns The task's depth, its parent, named or inherited, and the root's deadline in epoch milliseconds.
 * @throws `ROOT_LIMIT` at a limit, `ABORTED` for a cancelled root, `SESSION_BUSY` while the same task
 * is reserved, `INPUT_LIMIT` for a parent outside the root or another than a continued session has,
 * `SESSION_INVALID` without such a root.
 */
export function reserveRootTask(
  handle: string,
  request: { taskHandle: string; parentTask?: string; continues?: string; coordinator?: boolean },
): Promise<{ depth: number; parentTask?: string; deadlineMs: number }> {
  return updateRoot(handle, record => {
    assertUsable(record);
    if (record.tasks.some(task => task.taskHandle === request.taskHandle && isRootTaskActive(task))) {
      throw new ToolError('SESSION_BUSY', `Task ${request.taskHandle} is already starting in this root.`);
    }
    // A parent must exist before its child, so the tree has no cycle; a repeated handle could otherwise name itself.
    if (request.parentTask === request.taskHandle) throw new ToolError('INPUT_LIMIT', 'A task cannot be its own parent.');
    const parent = request.parentTask ? record.tasks.find(task => task.taskHandle === request.parentTask) : undefined;
    if (request.parentTask && !parent) throw new ToolError('INPUT_LIMIT', `Task ${request.parentTask.slice(0, 80)} is not in this root.`);
    const earlier = request.continues ? record.tasks.findLast(task => task.sessionHandle === request.continues) : undefined;
    // A continuation keeps its place, so naming a shallower parent cannot buy depth.
    if (earlier && request.parentTask && request.parentTask !== earlier.parentTask) {
      throw new ToolError('INPUT_LIMIT', 'A continued session keeps its parent; omit parent_task.');
    }
    // A coordinator waits between turns with no turn lease held, which alone could not refuse a second one.
    if (earlier?.coordinator && request.coordinator && isRootTaskActive(earlier)) {
      throw new ToolError('SESSION_BUSY', 'This coordinator is still running; cancel it or wait for it.');
    }
    const depth = earlier?.depth ?? (parent ? parent.depth + 1 : 1);
    if (depth > record.limits.maxDepth) throw new ToolError('ROOT_LIMIT', `Root ${handle} allows a depth of ${record.limits.maxDepth}.`);
    if (request.parentTask && !earlier) {
      const maxChildren = record.limits.maxChildren ?? DEFAULT_ROOT_LIMITS.maxChildren;
      const children = new Set(
        record.tasks.filter(task => task.parentTask === request.parentTask && !task.continuation).map(task => task.taskHandle),
      );
      if (children.size >= maxChildren) {
        throw new ToolError('ROOT_LIMIT', `Task ${request.parentTask} already has ${children.size} children, the limit of root ${handle}.`);
      }
    }
    assertFreeSlot(record);
    charge(record);
    const parentTask = request.parentTask ?? earlier?.parentTask;
    record.tasks.push({
      taskHandle: request.taskHandle,
      pid: process.pid,
      pidIdentity: ownProcessIdentity(),
      ...(parentTask ? { parentTask } : {}),
      depth,
      ...(request.coordinator ? { coordinator: true, turning: true } : {}),
      ...(earlier ? { continuation: true } : {}),
      // Held from here on: a continuation reads its workers before its turn binds the session.
      ...(request.coordinator && request.continues ? { sessionHandle: request.continues } : {}),
      startedAt: new Date().toISOString(),
    });
    return { depth, ...(parentTask ? { parentTask } : {}), deadlineMs: Date.parse(record.deadlineAt) };
  });
}

/**
 * Binds a reserved task to its worker session just before the turn starts, the last point where a
 * cancellation can still prevent it.
 * @throws `ABORTED` for a cancelled root, `ROOT_LIMIT` for one out of time.
 */
export function bindRootTask(
  handle: string,
  taskHandle: string,
  sessionHandle: string,
  writer?: { file: string; token: string },
): Promise<void> {
  return updateRoot(handle, record => {
    assertUsable(record);
    const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle);
    if (!task) throw new ToolError('PROTOCOL_ERROR', `Task ${taskHandle} has no reservation in root ${handle}.`);
    task.sessionHandle = sessionHandle;
    if (writer) task.writer = writer;
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

/**
 * Takes a place for a coordinator's next turn, which is charged when it starts.
 * @throws `ROOT_LIMIT` at a limit, `ABORTED` for a cancelled root.
 */
export function beginCoordinatorTurn(handle: string, taskHandle: string): Promise<void> {
  return updateRoot(handle, record => {
    assertUsable(record);
    assertFreeSlot(record);
    const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle);
    if (!task) throw new ToolError('PROTOCOL_ERROR', `Task ${taskHandle} has no reservation in root ${handle}.`);
    task.turning = true;
  });
}

/** Gives a coordinator's place back while it waits for its workers. */
export function endCoordinatorTurn(handle: string, taskHandle: string): Promise<void> {
  return updateRoot(handle, record => {
    const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle);
    if (task) task.turning = false;
  });
}

/**
 * Asks the running coordinator of a session to stop, whichever server process runs it.
 * @returns Whether such a coordinator exists.
 */
export async function requestCoordinatorCancel(sessionHandle: string): Promise<boolean> {
  const root = findRootOfSession(sessionHandle);
  if (!root) return false;
  return updateRoot(root.rootHandle, record => {
    const task = record.tasks.findLast(entry => entry.sessionHandle === sessionHandle);
    if (!task?.coordinator || task.endedAt || !isRootTaskActive(task)) return false;
    task.cancelRequested = true;
    return true;
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
