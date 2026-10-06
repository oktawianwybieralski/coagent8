/**
 * Bounded stdio probes for installation; owns and awaits the complete process tree.
 * @packageDocumentation
 */
import { spawn } from 'node:child_process';
import { resolveCliCommand } from '../backends/cli-resolver.js';
import { startDescendantTracking, terminateProcessTree } from '../execution/process.js';
import { createLineDecoder } from '../execution/stream.js';

/** Narrows an untrusted protocol/configuration value to an object. */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}

/**
 * Starts a probe with bounded output and requests, and awaits teardown on every exit.
 * @param command - Executable or supported shim; no shell is invoked.
 * @param args - Host/server arguments, without credentials in diagnostics.
 * @param operation - Requests to issue after process startup.
 * @param options - Effective local environment, working directory, and request deadline.
 * @returns The operation result after owned process cleanup.
 * @throws On malformed output, request deadline, process failure, or protocol errors.
 */
export async function withStdioRpc<T>(command: string, args: string[], operation: (rpc: {
  request: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string, params?: unknown) => void;
}) => Promise<T>, options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}): Promise<T> {
  const resolved = resolveCliCommand(command, options);
  const proc = spawn(resolved.command, [...resolved.argsPrefix, ...args], {
    cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32',
  });
  const stopTracking = startDescendantTracking(proc);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let next = 1;
  let failure: Error | undefined;
  let closing = false;
  let bytes = 0;
  function fail(message: string) {
    failure ||= new Error(message);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(failure);
    }
    pending.clear();
    proc.stdin.destroy();
  }
  const decoder = createLineDecoder(line => {
    const message = object(JSON.parse(line));
    if (message.id == null) return;
    if (typeof message.id !== 'number' || !pending.has(message.id)) throw new Error('Unexpected response.');
    const item = pending.get(message.id)!;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error != null || !Object.hasOwn(message, 'result')) item.reject(new Error('Host rejected the probe request.'));
    else item.resolve(message.result);
  });
  proc.stdout.on('data', (chunk: Buffer) => {
    try {
      bytes += chunk.length;
      if (bytes > 512 * 1024) throw new Error('Probe output exceeds the byte limit.');
      decoder.push(chunk);
    } catch { fail('Malformed or oversized probe output.'); }
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 512 * 1024) fail('Probe output exceeds the byte limit.');
  });
  proc.stdout.on('end', () => {
    try { decoder.finish(); } catch { fail('Malformed probe output.'); }
  });
  proc.on('error', () => fail('Probe process could not start.'));
  proc.stdin.on('error', () => fail('Probe input closed unexpectedly.'));
  proc.on('exit', () => { if (!closing) fail('Probe process exited before completion.'); });
  const deadline = setTimeout(() => fail('Probe deadline exceeded.'), options.timeoutMs ?? 30_000);
  const send = (value: unknown) => {
    if (failure) throw failure;
    proc.stdin.write(JSON.stringify(value) + '\n');
  };
  let result: T;
  try {
    result = await operation({
      request(method, params) {
        if (failure) return Promise.reject(failure);
        if (pending.size >= 8) return Promise.reject(new Error('Too many pending probe requests.'));
        return new Promise((resolve, reject) => {
          const id = next++;
          const timer = setTimeout(() => fail('Probe request timed out.'), options.timeoutMs ?? 30_000);
          pending.set(id, { resolve, reject, timer });
          try { send({ jsonrpc: '2.0', id, method, params }); } catch { fail('Probe request could not be sent.'); }
        });
      },
      notify(method, params) { send({ jsonrpc: '2.0', method, params }); },
    });
  } finally {
    clearTimeout(deadline);
    closing = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Probe closed.'));
    }
    pending.clear();
    stopTracking();
    await terminateProcessTree(proc);
    try { decoder.finish(); } catch { fail('Malformed probe output.'); }
  }
  if (failure) throw failure;
  return result;
}
