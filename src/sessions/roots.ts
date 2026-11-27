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
 * The time limit counts running time (#228): the union of the tasks' intervals, from a reservation
 * to its end, so idle time between calls does not count and tasks running side by side count once.
 * Every write of the record notes the tasks it sees running (`seenAt`), and a running task's server
 * notes it every minute, so a task whose server died counts up to the last time it was seen, never
 * up to the next call. A continued session may run `graceMinutes` beyond the limit to finish its
 * task; a new task or child may not.
 *
 * Times of a root are read on its own timeline: the clock plus `clockOffsetMs`, which a write raises
 * whenever the clock is behind a time the record holds. After a clock is set back the timeline goes on
 * from the latest recorded time, so new work counts at its real length; a clock set forward counts the
 * jump as running time, which fails closed. A task's own server passes its running time, measured on a
 * monotonic clock, with every note and its end, so a clock set back while it runs loses no time.
 *
 * @packageDocumentation
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../contracts/index.js';
import { DEFAULT_ROOT_LIMITS, ROOT_LIMIT_BOUNDS, type RootLimits } from '../contracts/execution.js';
import { getConfigFile } from '../config.js';
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
  /** Continues an earlier task's session, so it is no further child of its parent. */
  continuation?: boolean;
  startedAt: string;
  /** The last time the task was seen running; its end when its server died without recording one. */
  seenAt?: string;
  endedAt?: string;
}

/** The durable record of a root. */
export interface RootRecord {
  schemaVersion: 1;
  rootHandle: string;
  state: 'open' | 'cancelled';
  limits: RootLimits;
  createdAt: string;
  /** Records before #228 only: the wall-clock deadline, no longer read. */
  deadlineAt?: string;
  /** Running time of removed reservations that reached no turn, beyond what other tasks covered. */
  refundedMs?: number;
  /** Added to the clock for the root's timeline after a clock was set back; absent before, meaning 0. */
  clockOffsetMs?: number;
  calls: number;
  tasks: RootTask[];
}

const ROOT_HANDLE = /^root_[a-f0-9]{32}$/;
/** Fits `ROOT_LIMIT_BOUNDS.maxCalls` entries with the longest paths; bounds reading a damaged file. */
const MAX_ROOT_BYTES = 8 * 1024 * 1024;
/** How often a running task's server reads its root, for a cancellation by another server process. */
export const ROOT_WATCH_MS = 1000;
/** Watch ticks between the notes a task's server writes that the task runs. */
export const ROOT_SEEN_TICKS = 60;
/** The longest a running task goes unnoted while its server lives (a minute). */
const ROOT_SEEN_INTERVAL_MS = ROOT_WATCH_MS * ROOT_SEEN_TICKS;
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

/** The tasks using a root's places. */
export function runningTasks(root: RootRecord): RootTask[] {
  return root.tasks.filter(task => isRootTaskActive(task));
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
    calls: 0,
    tasks: [],
  };
  await atomicWrite(rootFile(record.rootHandle), JSON.stringify(record));
  return record;
}

/** A task's running time since its reservation, measured by its own server on a monotonic clock. */
export interface RootTaskElapsed {
  taskHandle: string;
  elapsedMs: number;
}

/**
 * Changes a root under its lock, at one instant of its timeline.
 * @param change - Gets the record and now on the root's timeline, in epoch milliseconds.
 * @param measured - A running task's measured time, which the timeline does not fall behind.
 */
async function updateRoot<T>(handle: string, change: (record: RootRecord, now: number) => T, measured?: RootTaskElapsed): Promise<T> {
  const file = rootFile(handle);
  return withFileLock(file, async () => {
    const record = parseRoot(file);
    if (!record) throw new ToolError('SESSION_INVALID', `No root ${handle} in this data directory.`);
    const now = advanceRootClock(record, measured);
    noteRunningTasks(record, now);
    // A refused change still records what it counted, so a crash right after cannot give that time back.
    const noted = JSON.stringify(record);
    let result: T;
    try {
      result = change(record, now);
    } catch (err) {
      await atomicWrite(file, noted);
      throw err;
    }
    await atomicWrite(file, JSON.stringify(record));
    return result;
  });
}

/** The latest time a root records, in epoch milliseconds; -Infinity without one. */
function latestRecordedMs(record: RootRecord): number {
  let latest = -Infinity;
  for (const task of record.tasks) {
    for (const time of [task.startedAt, task.seenAt, task.endedAt]) {
      const parsed = time ? Date.parse(time) : NaN;
      if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
    }
  }
  return latest;
}

function clockOffsetMs(record: RootRecord): number {
  const offset = record.clockOffsetMs;
  return typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? offset : 0;
}

/**
 * Now on a root's timeline, in epoch milliseconds: the clock plus the root's offset, and never before
 * a time the record holds, also when it is read without the lock.
 */
export function rootNow(record: RootRecord): number {
  return Math.max(Date.now() + clockOffsetMs(record), latestRecordedMs(record));
}

/**
 * Notes a running task as seen at least its measured time after its start, so time it ran before a
 * clock was set back counts though no note recorded it; the clock offset then rises from there.
 */
function noteMeasured(record: RootRecord, measured: RootTaskElapsed): void {
  const task = record.tasks.findLast(entry => entry.taskHandle === measured.taskHandle && !entry.endedAt);
  const start = task ? Date.parse(task.startedAt) : NaN;
  if (!task || !Number.isFinite(start) || !Number.isFinite(measured.elapsedMs) || measured.elapsedMs <= 0) return;
  const floor = start + measured.elapsedMs;
  const seen = task.seenAt ? Date.parse(task.seenAt) : NaN;
  if (!(seen >= floor)) task.seenAt = new Date(floor).toISOString();
}

/**
 * Raises the root's clock offset when the clock is behind a recorded time, so after a clock is set
 * back the timeline goes on from where it was instead of placing new work inside earlier intervals,
 * where the union would not count it. Runs under the record's lock, so servers agree on the offset.
 *
 * Every time written is the root's now, so a clock behind one was set back. Tasks running then ran an
 * unknown time since their last note, at most a note interval, so the timeline goes on a full note
 * interval after the latest written time and they are noted up to there: at most one interval too many
 * per change, which fails closed. Their measured time, given later, only raises their times further.
 * @param measured - A running task's measured time; applied after the check, so the drift of a
 * monotonic clock against the wall clock never reads as a clock set back.
 * @returns Now on the root's timeline.
 */
function advanceRootClock(record: RootRecord, measured?: RootTaskElapsed): number {
  const clock = Date.now() + clockOffsetMs(record);
  const written = latestRecordedMs(record);
  const setBack = clock < written;
  // Applied whether or not the check saw a change: a clock set back by less than the time since the
  // last write passes the check, and only the measured time keeps what the task ran. A measured time
  // ahead of the clock, by drift or a set-back clock, raises the offset below by as much, so the next
  // write does not find the clock behind it and charges no note interval.
  if (measured) noteMeasured(record, measured);
  let now = Math.max(clock, latestRecordedMs(record));
  if (setBack && record.tasks.some(task => !task.endedAt && isRootTaskActive(task))) {
    now = Math.max(now, written + ROOT_SEEN_INTERVAL_MS);
  }
  if (now > clock) record.clockOffsetMs = clockOffsetMs(record) + (now - clock);
  return now;
}

/**
 * Notes every task seen running, so its time keeps counting if its server dies unseen. Every write
 * of the record does this, so what a check counted stays counted: a running task counts up to now,
 * and after its server dies up to this note.
 * @param now - Now on the root's timeline, never before a recorded time.
 */
function noteRunningTasks(record: RootRecord, now: number): void {
  for (const task of record.tasks) if (!task.endedAt && isRootTaskActive(task)) task.seenAt = new Date(now).toISOString();
}

/** Minutes a continued session may run beyond `maxMinutes`; records before #228 have the default. */
export function rootGraceMinutes(root: RootRecord): number {
  return root.limits.graceMinutes ?? DEFAULT_ROOT_LIMITS.graceMinutes;
}

/**
 * The running time of a root: the union of its tasks' intervals, so idle time between calls does not
 * count and tasks running side by side count once.
 * @param now - Reference time on the root's timeline, in epoch milliseconds; by default its now.
 * @returns Milliseconds.
 */
export function rootRunningMs(root: RootRecord, now = rootNow(root)): number {
  const intervals = root.tasks
    .map(task => {
      const start = Date.parse(task.startedAt);
      const seen = Date.parse(task.seenAt ?? task.startedAt);
      const end = task.endedAt ? Date.parse(task.endedAt) : isRootTaskActive(task) ? Math.max(now, seen) : seen;
      return [start, Math.max(start, end)] as const;
    })
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = root.refundedMs ?? 0;
  let coveredTo = -Infinity;
  for (const [start, end] of intervals) {
    if (end <= coveredTo) continue;
    total += end - Math.max(start, coveredTo);
    coveredTo = end;
  }
  return total;
}

/**
 * Refuses a root that is cancelled or out of running time.
 * @param now - Now on the root's timeline.
 * @param continuation - The task continues a session of this root, which may use the grace minutes.
 * @returns The milliseconds of running time left to it.
 */
function assertUsable(record: RootRecord, now: number, continuation = false): number {
  if (record.state === 'cancelled') throw new ToolError('ABORTED', `Root ${record.rootHandle} was cancelled.`);
  const grace = rootGraceMinutes(record);
  const usedMs = rootRunningMs(record, now);
  const remainingMs = (record.limits.maxMinutes + (continuation ? grace : 0)) * 60_000 - usedMs;
  if (remainingMs > 0) return remainingMs;
  const counted = 'counted while its tasks run, not between calls';
  const raise = `For more, raise rootLimits.maxMinutes (up to ${ROOT_LIMIT_BOUNDS.maxMinutes}) or rootLimits.graceMinutes in ${getConfigFile()}; it applies to new roots.`;
  // Past the grace too, a continuation would be refused as well, so the advice to continue is left out.
  if (continuation || grace === 0 || usedMs >= (record.limits.maxMinutes + grace) * 60_000) {
    throw new ToolError(
      'ROOT_LIMIT',
      `Root ${record.rootHandle} used its ${record.limits.maxMinutes} minutes of running time${grace ? ` and the ${grace} more minutes a continued session gets` : ''} (${counted})${grace ? '' : '; rootLimits.graceMinutes is 0, so a continued session gets no more minutes'}. ${raise} Or start a new task without root_handle and session_handle, restating the work.`,
    );
  }
  throw new ToolError(
    'ROOT_LIMIT',
    `Root ${record.rootHandle} used its ${record.limits.maxMinutes} minutes of running time (${counted}). To finish a task, continue its session with session_handle: a continued session gets ${grace} more minutes. ${raise} Or start a new root without root_handle.`,
  );
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
 * @returns The task's depth, its parent, named or inherited, and its deadline in epoch milliseconds:
 * now plus the root's running time left to it, which bounds it since its own time counts as running.
 * @throws `ROOT_LIMIT` at a limit, `ABORTED` for a cancelled root, `SESSION_BUSY` while the same task
 * is reserved, `INPUT_LIMIT` for a parent outside the root or another than a continued session has,
 * `SESSION_INVALID` without such a root.
 */
export function reserveRootTask(
  handle: string,
  request: { taskHandle: string; parentTask?: string; continues?: string },
): Promise<{ depth: number; parentTask?: string; deadlineMs: number }> {
  return updateRoot(handle, (record, now) => {
    // A continuation is classified once, here, and its entry keeps the class for its later rounds.
    const earlier = request.continues ? record.tasks.findLast(task => task.sessionHandle === request.continues) : undefined;
    const remainingMs = assertUsable(record, now, Boolean(earlier));
    if (record.tasks.some(task => task.taskHandle === request.taskHandle && isRootTaskActive(task))) {
      throw new ToolError('SESSION_BUSY', `Task ${request.taskHandle} is already starting in this root.`);
    }
    // A parent must exist before its child, so the tree has no cycle; a repeated handle could otherwise name itself.
    if (request.parentTask === request.taskHandle) throw new ToolError('INPUT_LIMIT', 'A task cannot be its own parent.');
    const parent = request.parentTask ? record.tasks.find(task => task.taskHandle === request.parentTask) : undefined;
    if (request.parentTask && !parent) throw new ToolError('INPUT_LIMIT', `Task ${request.parentTask.slice(0, 80)} is not in this root.`);
    // A continuation keeps its place, so naming a shallower parent cannot buy depth.
    if (earlier && request.parentTask && request.parentTask !== earlier.parentTask) {
      throw new ToolError('INPUT_LIMIT', 'A continued session keeps its parent; omit parent_task.');
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
      ...(earlier ? { continuation: true } : {}),
      startedAt: new Date(now).toISOString(),
    });
    // What is left is a length, so the deadline is on this process's clock, which its caller compares with.
    return { depth, ...(parentTask ? { parentTask } : {}), deadlineMs: Date.now() + remainingMs };
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
  return updateRoot(handle, (record, now) => {
    const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle);
    if (!task) throw new ToolError('PROTOCOL_ERROR', `Task ${taskHandle} has no reservation in root ${handle}.`);
    assertUsable(record, now, Boolean(task.continuation));
    task.sessionHandle = sessionHandle;
    if (writer) task.writer = writer;
  });
}

/**
 * Charges one more backend turn of a running task, such as a fix round or a review attempt; a
 * continued session's turn may use the grace minutes.
 * @throws `ROOT_LIMIT` at a limit, `ABORTED` for a cancelled root.
 */
export function reserveRootCall(handle: string, taskHandle?: string): Promise<void> {
  return updateRoot(handle, (record, now) => {
    const task = taskHandle ? record.tasks.findLast(entry => entry.taskHandle === taskHandle) : undefined;
    assertUsable(record, now, Boolean(task?.continuation));
    charge(record);
  });
}

/**
 * Notes a running task as seen, so its time counts if its server dies; every write of the root does the same.
 * @param measured - The task's running time measured by its server, which a clock set back cannot shorten.
 */
export function touchRootTask(handle: string, measured?: RootTaskElapsed): Promise<void> {
  return updateRoot(handle, () => undefined, measured);
}

/**
 * Marks a task ended; its charge stays.
 * @param elapsedMs - The task's running time since its reservation on its server's monotonic clock;
 * its end is at least that long after its start.
 */
export function endRootTask(handle: string, taskHandle: string, elapsedMs?: number): Promise<void> {
  return updateRoot(
    handle,
    (record, now) => {
      const task = record.tasks.findLast(entry => entry.taskHandle === taskHandle && !entry.endedAt);
      if (task) task.endedAt = new Date(now).toISOString();
    },
    elapsedMs === undefined ? undefined : { taskHandle, elapsedMs },
  );
}

/**
 * Removes a reservation whose turn this process knows did not start and returns its charge; the time
 * it took, such as a form left open, stays counted in `refundedMs`, so the record does not grow.
 * @param elapsedMs - As for {@link endRootTask}.
 */
export function refundRootTask(handle: string, taskHandle: string, elapsedMs?: number): Promise<void> {
  return updateRoot(
    handle,
    (record, now) => {
      const index = record.tasks.findLastIndex(entry => entry.taskHandle === taskHandle && !entry.endedAt);
      if (index < 0) return;
      record.tasks[index]!.endedAt = new Date(now).toISOString();
      const before = rootRunningMs(record, now);
      record.tasks.splice(index, 1);
      // Later tasks start after it on the root's timeline, so its share cannot be counted twice.
      record.refundedMs = (record.refundedMs ?? 0) + Math.max(0, before - rootRunningMs(record, now));
      record.calls = Math.max(0, record.calls - 1);
    },
    elapsedMs === undefined ? undefined : { taskHandle, elapsedMs },
  );
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

/** Removes a root that no task used; the time of refunded reservations goes with it. */
export function removeUnusedRoot(handle: string): Promise<void> {
  const file = rootFile(handle);
  return withFileLock(file, async () => {
    if (parseRoot(file)?.tasks.length === 0) fs.rmSync(file, { force: true });
  });
}

function eachRoot(options: { skipDamaged?: boolean } = {}): RootRecord[] {
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
      try {
        const record = parseRoot(path.join(rootsDir(), name));
        return record ? [record] : [];
      } catch (err) {
        if (!options.skipDamaged) throw err;
        return [];
      }
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
