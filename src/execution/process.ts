/**
 * Robust cross-platform subprocess supervisor and process-tree lifecycle management.
 *
 * @remarks
 * ## Architecture & Safety Invariants
 * - **Windows Supervisor & Descendant Tracking**: On Windows, child processes may spawn grandchild
 *   processes (e.g. CLI invoking Git or compilers) that survive parent exit. We employ a hybrid
 *   strategy: real-time CIM/WMI parent-child descendant polling (`startDescendantTracking`),
 *   primary termination via Windows `taskkill.exe /PID <pid> /T /F`, and a recursive PowerShell
 *   CIM fallback to sweep orphaned descendant trees.
 * - **POSIX Detached Process Groups**: On Linux/macOS, child processes are spawned detached (`detached: true`).
 *   Process tree teardown targets the negative process group ID (`process.kill(-proc.pid, 'SIGTERM')`)
 *   followed by `SIGKILL` after a 250ms grace period.
 * - **Capacity & Buffer Budgeting**: Enforces strict UTF-8 string decoders (`StringDecoder`),
 *   streaming line decoding (`createLineDecoder`), stdout/stderr capacity budgeting (`maxBufferBytes: 512KB`),
 *   and maximum prompt size (`maxInputBytes: 4MB`) to prevent Node heap exhaustion.
 * - **Pipe Liveness & Leak Prevention**: Explicitly terminates process trees on the `exit` event
 *   rather than waiting indefinitely for `close`, preventing un-terminated background descendants
 *   from holding stdio pipes open until execution timeouts.
 *
 * @packageDocumentation
 */

import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveCliCommand } from '../backends/cli-resolver.js';
import { createLineDecoder, truncateToByteLength } from './stream.js';
import type { ExecutionError, TerminalStatus } from '../types/conversation.types.js';
import { ERROR_CODES } from '../types/conversation.types.js';
import { redactDiagnostic } from '../redaction.js';

/** Default buffer ceiling per output channel (stdout/stderr) in bytes (512 KiB). */
export const MAX_BUFFER_BYTES = 512 * 1024;
/** Default execution deadline in milliseconds (15 minutes / 900,000 ms). */
export const DEFAULT_TIMEOUT_MS = 900_000;
/** Maximum allowable standard input payload size in bytes (4 MiB). */
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
/** Set of currently live ChildProcess instances managed by the supervisor. */
export const activeProcesses = new Set<ChildProcess>();
const activeRuns = new Map<ChildProcess, { cancel: () => void; done: Promise<RunCommandResult> }>();
const teardowns = new WeakMap<ChildProcess, Promise<void>>();
/** Map tracking observed OS descendant PIDs for each active ChildProcess on Windows. */
export const trackedDescendants = new Map<ChildProcess, Set<number>>();

/**
 * Records an OS descendant PID associated with a parent process for targeted teardown.
 *
 * @param proc - Parent ChildProcess instance.
 * @param pid - Descendant OS process identifier.
 */
export function recordDescendant(proc: ChildProcess, pid: number): void {
  let set = trackedDescendants.get(proc);
  if (!set) {
    set = new Set<number>();
    trackedDescendants.set(proc, set);
  }
  set.add(pid);
}

const activeQueries = new WeakMap<ChildProcess, Promise<void>>();
const cancelQueuedPolls = new WeakMap<ChildProcess, () => void>();

/**
 * Strict FIFO Mutex serializing PowerShell CIM queries across the supervisor.
 * Ensures at most one query runs OS-wide, while permitting waiting targets to cancel
 * immediately without delaying teardown or allowing subsequent queued entries to bypass the active lock.
 */
export class CimMutex {
  private activeHolder: Promise<void> | null = null;
  private queue: Array<{
    proc: ChildProcess;
    resolve: (release: (() => void) | null) => void;
    isCancelled: () => boolean;
  }> = [];

  async acquire(proc: ChildProcess, isCancelled: () => boolean): Promise<(() => void) | null> {
    if (isCancelled()) return null;

    if (!this.activeHolder) {
      let releaseLock!: () => void;
      this.activeHolder = new Promise<void>(resolve => {
        releaseLock = resolve;
      });
      return () => {
        this.activeHolder = null;
        this.dequeueNext();
        releaseLock();
      };
    }

    return new Promise<(() => void) | null>(resolve => {
      this.queue.push({
        proc,
        resolve,
        isCancelled,
      });
    });
  }

  cancelWait(proc: ChildProcess): void {
    const index = this.queue.findIndex(item => item.proc === proc);
    if (index !== -1) {
      const [item] = this.queue.splice(index, 1);
      item.resolve(null);
    }
  }

  private dequeueNext(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.isCancelled()) {
        next.resolve(null);
        continue;
      }

      let releaseLock!: () => void;
      this.activeHolder = new Promise<void>(resolve => {
        releaseLock = resolve;
      });

      next.resolve(() => {
        this.activeHolder = null;
        this.dequeueNext();
        releaseLock();
      });
      return;
    }
    this.activeHolder = null;
  }
}

const cimMutex = new CimMutex();

/**
 * Starts periodic background polling of descendant processes on Windows using WMI/CIM.
 * Returns an un-subscribe function to stop polling.
 *
 * @param proc - ChildProcess to monitor.
 * @returns Teardown function that cancels active polling timers and helper processes.
 */
export function startDescendantTracking(proc: ChildProcess): () => void {
  if (process.platform !== 'win32' || !proc.pid || proc.pid <= 4) return () => {};
  let stopped = false;
  let isTerminating = false;
  let inFlight = false;
  let activeHelper: ChildProcess | null = null;
  let helperTimeout: NodeJS.Timeout | null = null;

  const isCancelled = () => stopped || isTerminating;

  cancelQueuedPolls.set(proc, () => {
    isTerminating = true;
    cimMutex.cancelWait(proc);
  });

  const poll = (): Promise<void> => {
    if (stopped || isTerminating || inFlight || proc.killed || (proc.exitCode !== null && proc.exitCode !== undefined)) return Promise.resolve();
    inFlight = true;

    const executePoll = async (): Promise<void> => {
      const release = await cimMutex.acquire(proc, isCancelled);
      if (!release) {
        inFlight = false;
        return;
      }

      try {
        if (isCancelled()) {
          inFlight = false;
          return;
        }

        await new Promise<void>(resolve => {
          try {
            const psScript = [
              "$protected = '^(explorer|dwm|taskhostw|services|lsass|csrss|smss|wininit|winlogon|runtimebroker|shellexperiencehost|searchhost|startmenuexperiencehost|sihost|fontdrvhost|svchost)$';",
              '$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue;',
              '$q = [System.Collections.Generic.Queue[int]]::new();',
              `$q.Enqueue(${proc.pid});`,
              '$res = [System.Collections.Generic.List[int]]::new();',
              'while ($q.Count -gt 0) {',
              '  $curr = $q.Dequeue();',
              '  foreach ($p in $all) {',
              '    if ($p.ProcessId -gt 4 -and ($p.Name -replace \'\\.exe$\',\'\') -notmatch $protected -and $p.ParentProcessId -eq $curr -and !$res.Contains([int]$p.ProcessId)) {',
              '      $res.Add([int]$p.ProcessId);',
              '      $q.Enqueue([int]$p.ProcessId);',
              '    }',
              '  }',
              '}',
              '$res'
            ].join(' ');

            const ps = spawn('powershell.exe', [
              '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript
            ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

            activeHelper = ps;
            helperTimeout = setTimeout(() => {
              try { ps.kill(); } catch {}
            }, 1500);

            let out = '';
            ps.stdout?.on('data', d => {
              if (!stopped && !isTerminating) out += d.toString('utf8');
            });

            const cleanup = () => {
              if (helperTimeout) { clearTimeout(helperTimeout); helperTimeout = null; }
              if (activeHelper === ps) activeHelper = null;
              inFlight = false;
              resolve();
            };

            ps.on('close', () => {
              if (!stopped && !isTerminating) {
                for (const line of out.split(/\r?\n/)) {
                  const pid = parseInt(line.trim(), 10);
                  if (!isNaN(pid) && pid > 0) recordDescendant(proc, pid);
                }
              }
              cleanup();
            });

            ps.on('error', () => {
              cleanup();
            });
          } catch {
            inFlight = false;
            resolve();
          }
        });
      } finally {
        release();
      }
    };

    const queryPromise = executePoll();
    activeQueries.set(proc, queryPromise);
    return queryPromise;
  };

  let timer1: NodeJS.Timeout | null = null;
  let timer2: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  timer1 = setTimeout(() => {
    timer1 = null;
    if (stopped || proc.killed || (proc.exitCode !== null && proc.exitCode !== undefined)) return;
    void poll();
    timer2 = setTimeout(() => {
      timer2 = null;
      if (stopped || proc.killed || (proc.exitCode !== null && proc.exitCode !== undefined)) return;
      void poll();
      intervalTimer = setInterval(() => {
        if (stopped || proc.killed || (proc.exitCode !== null && proc.exitCode !== undefined)) return;
        void poll();
      }, 500);
    }, 125);
  }, 25);

  return () => {
    stopped = true;
    cimMutex.cancelWait(proc);
    cancelQueuedPolls.delete(proc);
    if (timer1) { clearTimeout(timer1); timer1 = null; }
    if (timer2) { clearTimeout(timer2); timer2 = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (helperTimeout) { clearTimeout(helperTimeout); helperTimeout = null; }
    if (activeHelper) {
      try { activeHelper.kill(); } catch {}
      activeHelper = null;
    }
  };
}
let shuttingDown = false;
function callbackErrorCode(err: unknown): ExecutionError['code'] {
  const code = (err as { code?: ExecutionError['code'] })?.code;
  return code && ERROR_CODES.includes(code) ? code : 'PROTOCOL_ERROR';
}

function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return process.platform !== 'win32'
    ? spawn(command, args, { cwd, env, stdio: 'pipe', shell: false, detached: true })
    : spawn(command, args, { cwd, env, stdio: 'pipe', shell: false, windowsHide: true });
}

/**
 * Terminate a process and all of its spawned descendants cleanly across platforms.
 *
 * - On Windows: Invokes `taskkill.exe /PID <pid> /T /F`. If the parent exited prematurely,
 *   falls back to sweeping known and active descendant PIDs via CIM `Stop-Process`.
 * - On POSIX: Signals the detached process group (`-proc.pid`) with `SIGTERM`, waits
 *   for the grace period, and escalates to `SIGKILL`.
 *
 * @param proc - Target ChildProcess instance.
 * @param graceMs - Grace period in milliseconds between SIGTERM and SIGKILL on POSIX (default: 250ms).
 * @param extraPids - Optional iterable of specific descendant PIDs to include in termination.
 * @returns Promise that resolves once process tree termination completes.
 */
export function terminateProcessTree(proc: ChildProcess, graceMs = 250, extraPids?: Iterable<number>): Promise<void> {
  const prior = teardowns.get(proc);
  if (prior) return prior;
  const task = (async () => {
    if (!proc.pid) return;
    if (process.platform === 'win32') {
      const cancelQueue = cancelQueuedPolls.get(proc);
      if (cancelQueue) cancelQueue();

      const pendingQuery = activeQueries.get(proc);
      if (pendingQuery) {
        try { await pendingQuery; } catch {}
      }

      const knownSet = new Set<number>();
      if (proc.pid && proc.pid > 4) knownSet.add(proc.pid);
      const tracked = trackedDescendants.get(proc);
      if (tracked) {
        for (const p of tracked) {
          if (p > 4) knownSet.add(p);
        }
      }
      if (extraPids) {
        for (const p of extraPids) {
          if (Number.isSafeInteger(p) && p > 4) knownSet.add(p);
        }
      }

      await new Promise<void>(resolve => {
        let settled = false;
        let killerTimer: NodeJS.Timeout | null = null;
        let fallbackExecuted = false;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (killerTimer) { clearTimeout(killerTimer); killerTimer = null; }
          resolve();
        };

        const executeFallback = () => {
          if (fallbackExecuted || settled) return;
          fallbackExecuted = true;
          if (killerTimer) { clearTimeout(killerTimer); killerTimer = null; }
          try {
            const knownArray = Array.from(knownSet).filter(pid => Number.isSafeInteger(pid) && pid > 4);
            if (knownArray.length === 0) {
              finish();
              return;
            }
            const targetPid = Number.isSafeInteger(proc.pid) && (proc.pid as number) > 4 ? proc.pid : -1;
            const psScript = [
              "$protected = '^(explorer|dwm|taskhostw|services|lsass|csrss|smss|wininit|winlogon|runtimebroker|shellexperiencehost|searchhost|startmenuexperiencehost|sihost|fontdrvhost|svchost)$';",
              '$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue;',
              '$q = [System.Collections.Generic.Queue[int]]::new();',
              `$known = @(${knownArray.join(',')});`,
              'foreach ($k in $known) { if ($k -gt 4) { $q.Enqueue([int]$k); } }',
              '$pids = [System.Collections.Generic.List[int]]::new();',
              'while ($q.Count -gt 0) {',
              '  $curr = $q.Dequeue();',
              '  foreach ($p in $all) {',
              '    if ($p.ProcessId -gt 4 -and ($p.Name -replace \'\\.exe$\',\'\') -notmatch $protected -and $p.ParentProcessId -eq $curr -and !$pids.Contains([int]$p.ProcessId)) {',
              '      $pids.Add([int]$p.ProcessId);',
              '      $q.Enqueue([int]$p.ProcessId);',
              '    }',
              '  }',
              '}',
              'foreach ($p in $all) {',
              '  if ($p.ProcessId -gt 4 -and ($p.Name -replace \'\\.exe$\',\'\') -notmatch $protected) {',
              '    if ($known.Contains([int]$p.ProcessId) -and !$pids.Contains([int]$p.ProcessId)) {',
              `      if (($p.ProcessId -eq ${targetPid} -and ${targetPid} -gt 4) -or ($p.ParentProcessId -gt 4 -and $known.Contains([int]$p.ParentProcessId))) {`,
              '        $pids.Add([int]$p.ProcessId);',
              '      }',
              '    }',
              '  }',
              '}',
              'for ($i = $pids.Count - 1; $i -ge 0; $i--) {',
              '  Stop-Process -Id $pids[$i] -Force -ErrorAction SilentlyContinue;',
              '}'
            ].join(' ');

            const findChildren = spawn(
              'powershell.exe',
              ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
              { stdio: 'ignore', windowsHide: true }
            );
            const timer = setTimeout(() => {
              try { findChildren.kill(); } catch {}
              finish();
            }, 3000);
            findChildren.on('close', () => { clearTimeout(timer); finish(); });
            findChildren.on('error', () => { clearTimeout(timer); finish(); });
          } catch {
            finish();
          }
        };

        if (proc.pid && proc.pid > 4) {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killerTimer = setTimeout(() => {
            killerTimer = null;
            try { killer.kill(); } catch {}
            try { proc.kill(); } catch {}
            executeFallback();
          }, 3000);

          killer.on('error', () => {
            if (killerTimer) { clearTimeout(killerTimer); killerTimer = null; }
            try { proc.kill(); } catch {}
            executeFallback();
          });

          killer.on('close', (code) => {
            if (killerTimer) { clearTimeout(killerTimer); killerTimer = null; }
            try { proc.kill(); } catch {}
            if (fallbackExecuted || settled) return;
            if (code !== 0) {
              executeFallback();
            } else {
              finish();
            }
          });
        } else {
          executeFallback();
        }
      });
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
      await new Promise<void>(resolve => setTimeout(resolve, graceMs));
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
    }
  })().finally(() => { trackedDescendants.delete(proc); });
  teardowns.set(proc, task);
  return task;
}

/** Compatibility for the adapter being migrated by the other author. */
export function killProcessSafely(proc: ChildProcess | null | undefined): void {
  if (proc) void terminateProcessTree(proc).finally(() => { proc.stdin?.destroy(); proc.stdout?.destroy(); proc.stderr?.destroy(); });
}

/**
 * Terminates all currently active processes and cancels running commands.
 */
export async function terminateAllProcesses(): Promise<void> {
  const runs = [...activeRuns.values()], processes = [...activeProcesses];
  for (const run of runs) run.cancel();
  await Promise.all(runs.map(run => run.done));
  await Promise.all(processes.map(proc => terminateProcessTree(proc)));
}

/**
 * Server lifecycle shutdown: permanently stops subprocess admission and terminates all active processes.
 */
export async function shutdownProcessRunner(): Promise<void> {
  shuttingDown = true;
  await terminateAllProcesses();
}

/**
 * Options configuring subprocess execution in runCommand.
 */
export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinInput?: string | null;
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
 * Executes a CLI executable or shim with robust streaming line decoders, buffer bounding,
 * deadline enforcement, and leak-free process tree teardown.
 *
 * @param command - Command binary or shim name to resolve and execute.
 * @param args - CLI arguments array.
 * @param options - Execution constraints, standard input, signal, and line callbacks.
 * @returns Resolves with terminal stdout, stderr, exit code, and error envelopes.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
  if (shuttingDown) return Promise.resolve(failure('ABORTED', 'Server shutdown has stopped subprocess admission.'));
  if (options.abortSignal?.aborted) return Promise.resolve(failure('ABORTED', 'Operation cancelled before launch.'));
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS, limit = options.maxBufferBytes ?? MAX_BUFFER_BYTES;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit < 1) return Promise.resolve(failure('INPUT_LIMIT', 'Invalid deadline or buffer budget.'));
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
  if (child.pid) recordDescendant(child, child.pid);
  const stopTracking = startDescendantTracking(child);
  let cancel = () => {};
  const done = new Promise<RunCommandResult>(resolve => {
    let stopped: RunCommandResult | undefined;
    let stdout = '', stderr = '', truncated = false;
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const outLines = options.onStdoutLine ? createLineDecoder(options.onStdoutLine, options.maxLineBytes) : null;
    const errLines = options.onStderrLine ? createLineDecoder(options.onStderrLine, options.maxLineBytes) : null;
    let timer: NodeJS.Timeout;
    const stop = (code: ExecutionError['code'], message: string) => {
      if (stopped) return;
      stopped = failure(code, message);
      stopTracking();
      void terminateProcessTree(child).finally(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
    };
    cancel = () => stop('ABORTED', 'Operation cancelled.');
    child.on('error', (err: NodeJS.ErrnoException) => stop(err.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'PROCESS_ERROR', err.message));
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') stop('PROCESS_ERROR', 'CLI stdin failed.'); });
    function collect(chunk: Buffer, channel: 'stdout' | 'stderr') {
      if (stopped) return;
      const decoder = channel === 'stdout' ? outDecoder : errDecoder;
      const current = channel === 'stdout' ? stdout : stderr;
      const text = decoder.write(chunk), next = truncateToByteLength(current + text, limit);
      if (Buffer.byteLength(current) + Buffer.byteLength(text) > limit) truncated = true;
      if (channel === 'stdout') stdout = next; else stderr = next;
      try { (channel === 'stdout' ? outLines : errLines)?.push(chunk); }
      catch (err) { stop(callbackErrorCode(err), (err as Error).message); }
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    // Descendants may keep inherited pipes open after their leader exits.
    // Waiting for close before teardown would wait for the full deadline.
    child.once('exit', () => { void terminateProcessTree(child); });
    child.on('close', async (exitCode, signal) => {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', cancel);
      try { if (!stopped) { outLines?.finish(); errLines?.finish(); } }
      catch (err) { stopped = failure(callbackErrorCode(err), (err as Error).message); }
      stdout = truncateToByteLength(stdout + outDecoder.end(), limit);
      stderr = truncateToByteLength(stderr + errDecoder.end(), limit);
      stopTracking();
      await terminateProcessTree(child);
      trackedDescendants.delete(child);
      activeProcesses.delete(child); activeRuns.delete(child);
      resolve({ ...(stopped || { status: exitCode === 0 && !signal ? 'completed' : 'failed' }), stdout, stderr, exitCode, signal, isTruncated: truncated });
    });
    timer = setTimeout(() => stop('TIMEOUT', `CLI deadline exceeded (${timeout} ms).`), timeout);
    options.abortSignal?.addEventListener('abort', cancel, { once: true });
    if (options.abortSignal?.aborted) cancel();
    if (!stopped) child.stdin?.end(options.stdinInput || '', 'utf8');
  });
  activeRuns.set(child, { cancel, done });
  return done;
}
