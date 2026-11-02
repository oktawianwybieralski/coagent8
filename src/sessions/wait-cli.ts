/**
 * `coagent8 wait`: blocks until a delegation finishes and prints its result (`DELEGATE-001c`).
 *
 * @remarks
 * A client that wakes its agent when a background command exits runs this command. The waiter
 * only reads: when it times out or is stopped, the worker goes on.
 *
 * @packageDocumentation
 */
import { redactDiagnostic } from '../security/redaction.js';
import { finishedTaskText, isTaskFinished, readTask } from './tasks.js';

const USAGE = 'Usage: coagent8 wait <task_handle> [--data-dir <dir>] [--notes-dir <dir>] [--timeout-ms <ms>]';
const POLL_MS = 500;
/** A client's background task should end by itself: a day is longer than any delegation. */
const DEFAULT_TIMEOUT_MS = 24 * 3600 * 1000;

/**
 * Runs the command.
 * @param args - Arguments after `wait`.
 * @param out - Receives the result.
 * @param err - Receives usage and failures.
 * @param signal - Stops waiting; the worker is not affected.
 * @returns 0 when the worker completed, 1 when it failed, was cancelled or the wait timed out, and
 * 2 for a usage error.
 */
export async function runWaitCli(
  args: string[],
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  signal?: AbortSignal,
): Promise<number> {
  let handle: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--data-dir' || arg === '--notes-dir' || arg === '--timeout-ms') && args[i + 1] === undefined) {
      err.write(`${USAGE}\n`);
      return 2;
    }
    if (arg === '--data-dir') {
      // The waiter reads the server's store, whatever environment the client's shell passes.
      process.env.coagent8_DIR = args[++i];
    } else if (arg === '--notes-dir') {
      process.env.coagent8_END_NOTES_DIR = args[++i];
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(args[++i]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
        err.write(`${USAGE}\n`);
        return 2;
      }
    } else if (!handle && !arg.startsWith('-')) {
      handle = arg;
    } else {
      err.write(`${USAGE}\n`);
      return 2;
    }
  }
  if (!handle) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const task = readTask(handle);
      if (!task) {
        err.write(`No task ${handle} in this data directory.\n`);
        return 1;
      }
      if (isTaskFinished(task.state)) {
        out.write(`task_handle: ${task.taskHandle}\nsession_handle: ${task.sessionHandle}\nstate: ${task.state}\n\n`);
        out.write(`${finishedTaskText(task)}\n`);
        return task.state === 'completed' && !task.result?.isError ? 0 : 1;
      }
      if (signal?.aborted || Date.now() >= deadline) {
        err.write(`Task ${handle} is still running; the worker goes on. Wait again or read it with the session tool.\n`);
        return 1;
      }
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, POLL_MS);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  } catch (error) {
    err.write(`${redactDiagnostic((error as Error).message, 512)}\n`);
    return error instanceof Error && /Invalid task handle/.test(error.message) ? 2 : 1;
  }
}
