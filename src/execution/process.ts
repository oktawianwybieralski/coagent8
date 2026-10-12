/**
 * Cross-platform subprocess supervisor with layered, identity-safe termination.
 *
 * @remarks
 * ## Termination layers
 * 1. **Protocol interrupt**: a run with a {@link StdinSession} keeps stdin open as the
 *    CLI's protocol channel. Cancellation, deadlines and server shutdown ask the CLI to
 *    end its turn over that protocol; the session closes stdin on the terminal event and
 *    the CLI exits by itself, cleaning up its own children.
 * 2. **Forced stop of the owned root**: when the CLI has not exited within the grace
 *    period, {@link terminateProcessTree} stops it. Windows uses `proc.kill()`, which
 *    calls `TerminateProcess` on the handle Node holds since spawn. POSIX signals the
 *    detached process group with `SIGTERM`, then `SIGKILL`.
 * 3. **No tree guessing**: no process is ever selected by PID or parent PID. There is no
 *    snapshot, polling or name list. On Windows, libuv places every non-detached child in
 *    a `KILL_ON_JOB_CLOSE` job, so a chain of Node processes dies with its root.
 *    Descendants created by native backends are the backend's responsibility.
 *
 * ## Bounds
 * UTF-8 decoding is split-safe (`StringDecoder`), stdout/stderr are capped
 * (`maxBufferBytes`, 512 KiB) and the prompt is capped (`maxInputBytes`, 4 MiB).
 * After the root exits, a descendant that still holds stdout/stderr cannot delay the
 * result beyond {@link PIPE_DRAIN_MS}.
 *
 * @packageDocumentation
 */

import { spawn, ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveCliCommand } from './cli-resolver.js';
import { createLineDecoder, truncateToByteLength } from './runtime/stream.js';
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_TEARDOWN_GRACE_MS,
  type ExecutionError,
  type TerminalStatus,
} from '../contracts/index.js';
import { errorCodeOf } from '../contracts/index.js';
import { redactDiagnostic } from '../security/redaction.js';

/** Default buffer ceiling per output channel (stdout/stderr) in bytes (512 KiB). */
const MAX_BUFFER_BYTES = 512 * 1024;
/** Default execution deadline in milliseconds (15 minutes / 900,000 ms). */
export const DEFAULT_TIMEOUT_MS = DEFAULT_EXECUTION_TIMEOUT_MS;
/** Maximum allowable standard input payload size in bytes (4 MiB). */
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
/** Default time a protocol CLI has to exit after an interrupt before it is stopped (layer 2). */
export const INTERRUPT_GRACE_MS = DEFAULT_TEARDOWN_GRACE_MS;
/** Default POSIX time between `SIGTERM` and `SIGKILL` for an owned process group. */
export const SIGNAL_GRACE_MS = 250;
/** Time stdout/stderr may stay open after the root exits before the runner stops reading. */
export const PIPE_DRAIN_MS = 2000;
/** Upper bound for observing the owned root's exit after a forced stop on Windows. */
const WINDOWS_EXIT_WAIT_MS = 2000;
/** Set of currently live ChildProcess instances managed by the supervisor. */
export const activeProcesses = new Set<ChildProcess>();
const activeRuns = new Map<ChildProcess, { cancel: () => void; done: Promise<RunCommandResult> }>();
const teardowns = new WeakMap<ChildProcess, Promise<void>>();

let shuttingDown = false;
function callbackErrorCode(err: unknown): ExecutionError['code'] {
  return errorCodeOf(err, 'PROTOCOL_ERROR');
}

function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return process.platform !== 'win32'
    ? spawn(command, args, { cwd, env, stdio: 'pipe', shell: false, detached: true })
    : spawn(command, args, { cwd, env, stdio: 'pipe', shell: false, windowsHide: true });
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Signals the owned POSIX process group, whose ID is the detached root's PID.
 * @returns Whether the group may still have members. `ESRCH` means every member has
 * exited, the usual outcome after a normal exit; any other failure is reported.
 * @remarks No fallback to the root alone: a group without members has no root either.
 */
function signalOwnedGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    process.stderr.write(`Warning: could not send ${signal} to owned process group ${groupId}: ${code ?? (err as Error).message}\n`);
    return true;
  }
}

/**
 * Stops a process this supervisor spawned (layer 2) without selecting anything by PID.
 *
 * - On Windows: `proc.kill()` terminates the owned root through its handle, then waits
 *   (bounded) for its exit. Node descendants in the root's libuv job exit with it.
 * - On POSIX: Signals the detached process group (`-proc.pid`) with `SIGTERM`, waits
 *   for the grace period, and escalates to `SIGKILL`. A group that no longer exists
 *   ends the teardown at once, without the grace period.
 *
 * Repeated calls for the same process share one teardown.
 *
 * @param proc - ChildProcess spawned by this process (detached on POSIX).
 * @param graceMs - Grace period in milliseconds between SIGTERM and SIGKILL on POSIX (default: 250ms).
 * @returns Promise that resolves once termination completes.
 */
export function terminateProcessTree(proc: ChildProcess, graceMs = SIGNAL_GRACE_MS): Promise<void> {
  const prior = teardowns.get(proc);
  if (prior) return prior;
  const task = (async () => {
    if (!proc.pid) return;
    if (process.platform === 'win32') {
      if (hasExited(proc)) return;
      const exited = new Promise<void>(resolve => {
        let timer: NodeJS.Timeout | undefined;
        const onExit = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          proc.removeListener('exit', onExit);
          resolve();
        }, WINDOWS_EXIT_WAIT_MS);
        proc.once('exit', onExit);
      });
      proc.kill();
      await exited;
    } else if (signalOwnedGroup(proc.pid, 'SIGTERM')) {
      await new Promise<void>(resolve => setTimeout(resolve, graceMs));
      signalOwnedGroup(proc.pid, 'SIGKILL');
    }
  })();
  teardowns.set(proc, task);
  return task;
}

/**
 * Cancels all running commands (interrupting protocol sessions first) and stops every
 * remaining owned process.
 */
export async function terminateAllProcesses(): Promise<void> {
  const runs = [...activeRuns.values()], processes = [...activeProcesses];
  for (const run of runs) run.cancel();
  await Promise.allSettled(runs.map(run => run.done));
  await Promise.allSettled(processes.map(proc => terminateProcessTree(proc)));
}

/**
 * Server lifecycle shutdown: permanently stops subprocess admission and terminates all active processes.
 */
export async function shutdownProcessRunner(): Promise<void> {
  shuttingDown = true;
  await terminateAllProcesses();
}

/** Write side of a CLI's stdin protocol channel. */
export interface StdinChannel {
  /** Sends one JSON record followed by a newline; ignored once stdin is closed. */
  send(record: unknown): void;
  /** Closes stdin. Protocol CLIs exit after their terminal event once stdin is closed. */
  close(): void;
}

/**
 * Stdin protocol of a CLI that supports a graceful interrupt (termination layer 1).
 *
 * @remarks
 * The session parses the CLI's output itself (through `onStdoutLine`) and must close the
 * channel when the CLI reports its terminal event, including after an interrupt.
 */
export interface StdinSession {
  /** Starts the protocol once the process is spawned; `input` is the size-checked prompt. */
  start(channel: StdinChannel, input: string): void;
  /** Asks the CLI to end its current turn. Called at most once per run. */
  interrupt(channel: StdinChannel): void;
}

/**
 * Options configuring subprocess execution in runCommand.
 */
export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Prompt payload. Written to stdin and closed, or handed to `session.start`. */
  stdinInput?: string | null;
  /** Keeps stdin open as a protocol channel that supports graceful interrupts. */
  session?: StdinSession | null;
  /** Milliseconds a session CLI has to exit after an interrupt (default {@link INTERRUPT_GRACE_MS}). */
  interruptGraceMs?: number;
  /** POSIX milliseconds between `SIGTERM` and `SIGKILL` for the process group (default {@link SIGNAL_GRACE_MS}). */
  signalGraceMs?: number;
  abortSignal?: AbortSignal | null;
  timeoutMs?: number | null;
  maxBufferBytes?: number;
  maxLineBytes?: number;
  maxInputBytes?: number;
  onStdoutLine?: ((line: string) => void) | null;
  onStderrLine?: ((line: string) => void) | null;
  onProgress?: ((info: { message?: string; percent?: number }) => void) | null;
}

/**
 * Terminal execution result returned by runCommand.
 */
export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  status: TerminalStatus;
  error?: ExecutionError;
  isTruncated: boolean;
}

function failure(code: ExecutionError['code'], message: string): RunCommandResult {
  return { stdout: '', stderr: '', exitCode: null, signal: null, status: code === 'ABORTED' ? 'cancelled' : code === 'TIMEOUT' ? 'timed_out' : 'failed',
    error: { code, message: redactDiagnostic(message), retryable: code === 'TIMEOUT' }, isTruncated: false };
}

/**
 * Code and message of a stop requested through the abort signal: an execution budget aborts
 * with its `TIMEOUT` error as the reason, which stays a timeout; any other reason is a
 * cancellation.
 */
function abortOutcome(signal: AbortSignal | null | undefined, cancelled: string): [ExecutionError['code'], string] {
  const reason: unknown = signal?.aborted ? signal.reason : undefined;
  return errorCodeOf(reason, 'ABORTED') === 'TIMEOUT' ? ['TIMEOUT', (reason as Error).message] : ['ABORTED', cancelled];
}

/**
 * Executes a CLI executable or shim with robust streaming line decoders, buffer bounding,
 * deadline enforcement, and layered termination.
 *
 * @param command - Command binary or shim name to resolve and execute.
 * @param args - CLI arguments array.
 * @param options - Execution constraints, standard input or protocol session, signal, and line callbacks.
 * @returns Resolves with terminal stdout, stderr, exit code, and error envelopes.
 * @remarks
 * Without a session, stdin receives `stdinInput` and is closed, and a stop forces
 * termination immediately. With a session, a stop first calls `session.interrupt` and
 * keeps delivering output so the session can observe the terminal event; the root is
 * stopped only when it has not exited within `interruptGraceMs`.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
  if (shuttingDown) return Promise.resolve(failure('ABORTED', 'Server shutdown has stopped subprocess admission.'));
  if (options.abortSignal?.aborted) return Promise.resolve(failure(...abortOutcome(options.abortSignal, 'Operation cancelled before launch.')));
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS, limit = options.maxBufferBytes ?? MAX_BUFFER_BYTES;
  const grace = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  const signalGrace = options.signalGraceMs ?? SIGNAL_GRACE_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit < 1) return Promise.resolve(failure('INPUT_LIMIT', 'Invalid deadline or buffer budget.'));
  if (!Number.isSafeInteger(grace) || grace < 0 || !Number.isSafeInteger(signalGrace) || signalGrace < 0) return Promise.resolve(failure('INPUT_LIMIT', 'Invalid grace period.'));
  if (Buffer.byteLength(options.stdinInput || '') > (options.maxInputBytes ?? MAX_PROMPT_BYTES)) return Promise.resolve(failure('INPUT_LIMIT', 'Prompt exceeds the UTF-8 byte limit.'));
  let child: ChildProcess;
  try {
    const resolved = resolveCliCommand(command, { env: options.env, cwd: options.cwd });
    child = launch(resolved.command, [...resolved.argsPrefix, ...args], options.cwd || process.cwd(), options.env || process.env);
  } catch (err) {
    const error = err as Error & { code?: string };
    return Promise.resolve(failure(error.code === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : error.code === 'CLI_UNSUPPORTED' ? 'CLI_UNSUPPORTED' : 'PROCESS_ERROR', error.message));
  }
  activeProcesses.add(child);
  const session = options.session ?? null;
  let cancel = () => {};
  const done = new Promise<RunCommandResult>(resolve => {
    let stopped: RunCommandResult | undefined;
    let forced = false, started = false, stdinClosed = false;
    let stdout = '', stderr = '', truncated = false;
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const outLines = options.onStdoutLine ? createLineDecoder(options.onStdoutLine, options.maxLineBytes) : null;
    const errLines = options.onStderrLine ? createLineDecoder(options.onStderrLine, options.maxLineBytes) : null;
    let timer: NodeJS.Timeout;
    let graceTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
    const channel: StdinChannel = {
      send(record) {
        if (stdinClosed || !child.stdin?.writable) return;
        child.stdin.write(JSON.stringify(record) + '\n', 'utf8');
      },
      close() {
        if (stdinClosed) return;
        stdinClosed = true;
        child.stdin?.end();
      },
    };
    const forceStop = () => {
      if (forced) return;
      forced = true;
      if (graceTimer) clearTimeout(graceTimer);
      void terminateProcessTree(child, signalGrace).finally(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
    };
    const stop = (code: ExecutionError['code'], message: string) => {
      if (stopped) return;
      stopped = failure(code, message);
      if (!session || !started || hasExited(child)) { forceStop(); return; }
      graceTimer = setTimeout(forceStop, grace);
      // A session that already closed stdin is ending its CLI; it only needs the grace period.
      if (stdinClosed) return;
      try { session.interrupt(channel); }
      catch { forceStop(); }
    };
    cancel = () => stop(...abortOutcome(options.abortSignal, 'Operation cancelled.'));
    child.on('error', (err: NodeJS.ErrnoException) => stop(err.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'PROCESS_ERROR', err.message));
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') stop('PROCESS_ERROR', 'CLI stdin failed.'); });
    function collect(chunk: Buffer, channelName: 'stdout' | 'stderr') {
      // A session keeps reading after a stop so it can observe the interrupted turn end.
      if (forced || (stopped && !session)) return;
      const decoder = channelName === 'stdout' ? outDecoder : errDecoder;
      const current = channelName === 'stdout' ? stdout : stderr;
      const text = decoder.write(chunk), next = truncateToByteLength(current + text, limit);
      if (Buffer.byteLength(current) + Buffer.byteLength(text) > limit) truncated = true;
      if (channelName === 'stdout') stdout = next; else stderr = next;
      try { (channelName === 'stdout' ? outLines : errLines)?.push(chunk); }
      catch (err) { stop(callbackErrorCode(err), (err as Error).message); }
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    // A descendant may keep inherited pipes open after the root exits. Signal the owned
    // POSIX group and stop waiting for the pipes after a bounded drain period.
    child.once('exit', () => {
      if (graceTimer) clearTimeout(graceTimer);
      void terminateProcessTree(child, signalGrace);
      drainTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, PIPE_DRAIN_MS);
    });
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      options.abortSignal?.removeEventListener('abort', cancel);
      try { if (!stopped) { outLines?.finish(); errLines?.finish(); } }
      catch (err) { stopped = failure(callbackErrorCode(err), (err as Error).message); }
      stdout = truncateToByteLength(stdout + outDecoder.end(), limit);
      stderr = truncateToByteLength(stderr + errDecoder.end(), limit);
      try {
        await terminateProcessTree(child, signalGrace);
      } catch {
        // teardown safety
      }
      activeProcesses.delete(child); activeRuns.delete(child);
      resolve({ ...(stopped || { status: exitCode === 0 && !signal ? 'completed' : 'failed' }), stdout, stderr, exitCode, signal, isTruncated: truncated });
    });
    timer = setTimeout(() => stop('TIMEOUT', `CLI deadline exceeded (${timeout} ms).`), timeout);
    options.abortSignal?.addEventListener('abort', cancel, { once: true });
    if (options.abortSignal?.aborted) cancel();
    if (stopped) return;
    if (!session) {
      try {
        child.stdin?.end(options.stdinInput || '', 'utf8');
      } catch (err) {
        stop(callbackErrorCode(err), (err as Error).message);
      }
      return;
    }
    try {
      session.start(channel, options.stdinInput || '');
      started = true;
    } catch (err) { stop(callbackErrorCode(err), (err as Error).message); }
  });
  activeRuns.set(child, { cancel, done });
  return done;
}
