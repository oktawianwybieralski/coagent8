const { spawn } = require('node:child_process');
const { createLineDecoder } = require('../../src/execution/stream.ts');
const { startDescendantTracking, terminateProcessTree } = require('../../src/execution/process.ts');
const { redactDiagnostic } = require('../../src/redaction.ts');

function connect(command, args, options = {}) {
  const proc = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
  const stop = startDescendantTracking(proc);
  const pending = new Map();
  const notifications = [];
  let next = 1, stderr = '', totalBytes = 0, failure, cleanupTask;
  let exitResolve;
  const exited = new Promise(resolve => { exitResolve = resolve; });
  function rejectPending(error) {
    failure ||= error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    pending.clear();
  }
  async function cleanup() {
    if (!cleanupTask) cleanupTask = (async () => {
      rejectPending(new Error('MCP connection closed.'));
      stop();
      await terminateProcessTree(proc);
      proc.stdin.destroy(); proc.stdout.destroy(); proc.stderr.destroy();
      await exited;
    })();
    return cleanupTask;
  }
  function fail(message) {
    rejectPending(new Error(message));
    void cleanup().catch(error => { failure = error; });
  }
  const decoder = createLineDecoder(line => {
    const message = JSON.parse(line);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid MCP response.');
    if (message.id != null) {
      const item = pending.get(message.id);
      if (!item) throw new Error('Unexpected MCP response ID.');
      pending.delete(message.id); clearTimeout(item.timer); item.resolve(message);
    } else {
      if (notifications.length >= 1000) throw new Error('MCP notification limit.');
      notifications.push(message);
    }
  });
  proc.stdout.on('data', chunk => {
    totalBytes += chunk.length;
    try {
      if (totalBytes > 512 * 1024) throw new Error('MCP output limit.');
      decoder.push(chunk);
    } catch { fail('Malformed or oversized MCP output.'); }
  });
  proc.stdout.on('end', () => { try { decoder.finish(); } catch { fail('Malformed MCP final record.'); } });
  proc.stderr.on('data', chunk => {
    totalBytes += chunk.length;
    if (totalBytes > 512 * 1024) fail('MCP output limit.');
    else stderr += chunk.toString('utf8');
  });
  proc.on('error', () => { exitResolve(); fail('MCP process failed to start.'); });
  proc.stdin.on('error', () => fail('MCP process input failed.'));
  proc.once('close', () => { exitResolve(); rejectPending(new Error('MCP process terminated unexpectedly.')); });
  const request = (method, params) => {
    if (failure) return Promise.reject(failure);
    if (pending.size >= 32) return Promise.reject(new Error('MCP pending request limit.'));
    return new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => fail('MCP request timed out.'), options.timeoutMs ?? 15_000);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  async function waitForExit(timeoutMs) {
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP failed to exit.')), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  return { proc, request, notifications, cleanup, waitForExit, getStderr: () => redactDiagnostic(stderr, 512 * 1024), pending };
}
module.exports = { connect };
