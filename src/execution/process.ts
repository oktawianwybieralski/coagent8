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
import {
  parseProcessSnapshot,
  selectOwnedTree,
  type KnownIdentity,
  type ProcessRow,
} from './process-tree.js';
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
/** Map tracking verified OS process identities (PID + creationTime) for each active ChildProcess on Windows. */
export const trackedIdentities = new Map<ChildProcess, Map<string, KnownIdentity>>();

/**
 * Records an OS descendant PID and optional creation time associated with a parent process for targeted teardown.
 *
 * @param proc - Parent ChildProcess instance.
 * @param pid - Descendant OS process identifier.
 * @param created - Optional creation time in microseconds since Unix epoch.
 */
export function recordDescendant(proc: ChildProcess, pid: number, created?: number): void {
  let set = trackedDescendants.get(proc);
  if (!set) {
    set = new Set<number>();
    trackedDescendants.set(proc, set);
  }
  set.add(pid);

  if (created !== undefined) {
    let map = trackedIdentities.get(proc);
    if (!map) {
      map = new Map<string, KnownIdentity>();
      trackedIdentities.set(proc, map);
    }
    const key = `${pid}:${created}`;
    if (!map.has(key)) {
      map.set(key, { pid, created });
    }
  }
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

  let idMap = trackedIdentities.get(proc);
  if (!idMap) {
    idMap = new Map<string, KnownIdentity>();
    trackedIdentities.set(proc, idMap);
  }
  if (proc.pid && proc.pid > 4) {
    idMap.set(`${proc.pid}:0`, { pid: proc.pid, created: 0 });
  }

  cancelQueuedPolls.set(proc, () => {
    isTerminating = true;
    cimMutex.cancelWait(proc);
  });

  const poll = (): Promise<void> => {
    if (stopped || isTerminating || inFlight) return Promise.resolve();
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
              '$now = [DateTime]::UtcNow.ToFileTimeUtc();',
              'Write-Output "# SNAPSHOT_AT $now";',
              'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
              '  if ($_.ProcessId -gt 4 -and $_.CreationDate) {',
              '    "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())"',
              '  }',
              '}'
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
                const { snapshotAt, rows } = parseProcessSnapshot(out);
                let idMap = trackedIdentities.get(proc);
                if (!idMap) {
                  idMap = new Map<string, KnownIdentity>();
                  trackedIdentities.set(proc, idMap);
                }
                if (proc.pid && proc.pid > 4) {
                  const rootRow = rows.find(r => r.pid === proc.pid);
                  if (rootRow) {
                    idMap.delete(`${proc.pid}:0`);
                    const rootKey = `${rootRow.pid}:${rootRow.created}`;
                    if (!idMap.has(rootKey)) {
                      idMap.set(rootKey, { pid: rootRow.pid, created: rootRow.created });
                      recordDescendant(proc, rootRow.pid, rootRow.created);
                    }
                  }
                }
                const liveKey = new Set(rows.map(r => `${r.pid}:${r.created}`));
                for (const [k, ident] of idMap.entries()) {
                  if (ident.created > 0 && !liveKey.has(k) && ident.goneBy === undefined) {
                    ident.goneBy = snapshotAt;
                  }
                }
                const ownedRows = selectOwnedTree(rows, Array.from(idMap.values()), snapshotAt);
                for (const row of ownedRows) {
                  const rowKey = `${row.pid}:${row.created}`;
                  if (!idMap.has(rowKey)) {
                    idMap.set(rowKey, { pid: row.pid, created: row.created });
                  }
                  recordDescendant(proc, row.pid, row.created);
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
    if (stopped) return;
    void poll();
    timer2 = setTimeout(() => {
      timer2 = null;
      if (stopped) return;
      void poll();
      intervalTimer = setInterval(() => {
        if (stopped) return;
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

async function teardownWindowsDescendants(
  proc: ChildProcess,
  knownList: KnownIdentity[]
): Promise<void> {
  const rootPid = proc.pid;
  for (let round = 0; round < 3; round++) {
    const snapshotOut = await new Promise<string>(resolve => {
      try {
        const psScript = [
          '$now = [DateTime]::UtcNow.ToFileTimeUtc();',
          'Write-Output "# SNAPSHOT_AT $now";',
          'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
          '  if ($_.ProcessId -gt 4 -and $_.CreationDate) {',
          '    "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())"',
          '  }',
          '}'
        ].join(' ');

        const ps = spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript
        ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

        let out = '';
        const timer = setTimeout(() => {
          try { ps.kill(); } catch {}
          resolve(out);
        }, 1500);

        ps.stdout?.on('data', d => { out += d.toString('utf8'); });
        ps.on('close', () => { clearTimeout(timer); resolve(out); });
        ps.on('error', () => { clearTimeout(timer); resolve(out); });
      } catch {
        resolve('');
      }
    });

    const { snapshotAt, rows } = parseProcessSnapshot(snapshotOut);
    if (rows.length === 0) break;

    for (const k of knownList) {
      if (k.created === 0) {
        const found = rows.find(r => r.pid === k.pid);
        if (found) {
          k.created = found.created;
        }
      }
    }

    const ownedRows = selectOwnedTree(rows, knownList, snapshotAt);
    const liveExtra = knownList
      .filter(k => k.created === 0 && rows.some(r => r.pid === k.pid))
      .map(k => ({ pid: k.pid, ppid: 0, created: 0 }));

    const targets = [...ownedRows.filter(r => r.pid !== rootPid), ...liveExtra];
    if (targets.length === 0) {
      break;
    }

    // Sort parents before children (created ascending)
    targets.sort((a, b) => a.created - b.created);

    await new Promise<void>(resolve => {
      try {
        const targetDefs = targets.map(t => `@{id=${t.pid};expected=${t.created}}`).join(',');
        const killScript = [
          `$targets = @(${targetDefs});`,
          'foreach ($t in $targets) {',
          '  try {',
          '    $p = [Diagnostics.Process]::GetProcessById($t.id);',
          '    $null = $p.Handle;',
          '    $ft = $p.StartTime.ToFileTimeUtc();',
          '    $us = [long](($ft - 116444736000000000) / 10);',
          '    if ($t.expected -eq 0 -or [Math]::Abs($us - $t.expected) -le 2) {',
          '      $p.Kill();',
          '      $null = $p.WaitForExit(500);',
          '    }',
          '  } catch {}',
          '}'
        ].join(' ');

        const killer = spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', killScript
        ], { stdio: 'ignore', windowsHide: true });

        const timer = setTimeout(() => {
          try { killer.kill(); } catch {}
          resolve();
        }, 1500);

        killer.on('close', () => { clearTimeout(timer); resolve(); });
        killer.on('error', () => { clearTimeout(timer); resolve(); });
      } catch {
        resolve();
      }
    });
  }
}

/**
 * Terminate a process and all of its spawned descendants cleanly across platforms.
 *
 * - On Windows: Terminates the root process immediately while libuv holds its handle,
 *   selects verified descendants via pure `(PID, creationTime)` tree analysis, and terminates
 *   verified identities individually while re-verifying creation time. Never sweeps after a clean
 *   exit when no descendants were observed.
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
      try { proc.kill(); } catch {}

      const cancelQueue = cancelQueuedPolls.get(proc);
      if (cancelQueue) cancelQueue();

      const pendingQuery = activeQueries.get(proc);
      if (pendingQuery) {
        try { await pendingQuery; } catch {}
      }

      const idMap = trackedIdentities.get(proc);
      const knownList: KnownIdentity[] = idMap ? Array.from(idMap.values()) : [];
      const tracked = trackedDescendants.get(proc);
      if (tracked) {
        for (const p of tracked) {
          if (p > 4 && !knownList.some(k => k.pid === p)) {
            knownList.push({ pid: p, created: 0 });
          }
        }
      }
      if (extraPids) {
        for (const p of extraPids) {
          if (Number.isSafeInteger(p) && p > 4 && !knownList.some(k => k.pid === p)) {
            knownList.push({ pid: p, created: 0 });
          }
        }
      }
      if (proc.pid && proc.pid > 4 && !knownList.some(k => k.pid === proc.pid)) {
        knownList.push({ pid: proc.pid, created: 0 });
      }

      const hasDescendantsToSweep = knownList.some(k => k.pid !== proc.pid) || Boolean(extraPids);
      const isCleanExit = proc.exitCode === 0;

      // Never start a sweep after a clean exit when no descendant was observed
      if (isCleanExit && !hasDescendantsToSweep) {
        return;
      }

      if (knownList.length > 0) {
        await teardownWindowsDescendants(proc, knownList);
      }
    } else {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
      await new Promise<void>(resolve => setTimeout(resolve, graceMs));
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
    }
  })().finally(() => {
    trackedIdentities.delete(proc);
    trackedDescendants.delete(proc);
  });
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
