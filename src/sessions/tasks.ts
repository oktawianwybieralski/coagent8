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
import path from 'node:path';
import { ToolError } from '../contracts/index.js';
import { getDataDir } from '../paths.js';
import { atomicWrite } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { isProcessAlive } from './activity.js';

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
  startedAt: string;
  finishedAt?: string;
  /** The calling agent's own session, when its client exposes one; a label, never an authority. */
  callerSession?: string;
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
  fs.mkdirSync(tasksDir(), { recursive: true, mode: 0o700 });
  await atomicWrite(taskFile(task.taskHandle), JSON.stringify(task));
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ToolError('PROTOCOL_ERROR', `The task record ${handle} cannot be read.`);
  }
  return task.state === 'running' && !isProcessAlive(task.serverPid) ? { ...task, state: 'interrupted' } : task;
}

/**
 * Removes finished task records past their retention.
 * @param now - Reference time in epoch milliseconds.
 */
export function pruneTasks(now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(tasksDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(tasksDir(), name);
    const modified = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (modified === undefined || now - modified < TASK_RETENTION_MS) continue;
    const task = readTask(name.slice(0, -'.json'.length));
    if (task && isTaskFinished(task.state)) fs.rmSync(file, { force: true });
  }
}
