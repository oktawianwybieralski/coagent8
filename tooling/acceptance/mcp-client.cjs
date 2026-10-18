/**
 * Minimal MCP client over stdio for native acceptance scenarios (ACCEPT-001a2).
 *
 * @remarks
 * The installed runtime runs as `node <entry> mcp` through the runtime supervisor
 * (`runCommand`) with a stdin protocol session, so the output bounds, deadline and owned
 * teardown of every other acceptance child also apply to the server. The client declares
 * no elicitation capability: a model that needs the user's approval is refused by the
 * server, never approved by the runner. Server-to-client requests are answered with a
 * JSON-RPC error.
 */
require('tsx/cjs');
const { runCommand } = require('../../src/execution/process.ts');

const PROTOCOL_VERSION = '2025-06-18';
/** Largest JSON-RPC record the runner sends or accepts. */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** Default per-request deadline. */
const DEFAULT_REQUEST_MS = 60_000;
/** Time a server has to exit after its stdin closes before the supervisor stops it. */
const CLOSE_GRACE_MS = 10_000;

/**
 * Starts an MCP server and completes the initialization handshake.
 *
 * @param options - `command` and `args` start the server; `cwd`, `env`, `timeoutMs` (whole
 * server lifetime), `initTimeoutMs` (handshake), `closeGraceMs` and `abortSignal` bound it.
 * @returns A connected client.
 * @throws When the server does not answer `initialize`.
 */
async function connectMcp(options) {
  const pending = new Map();
  let nextId = 1, channel = null, failure = null, closed = false;
  // The caller's signal, or our own stop when the server does not exit after stdin closes.
  const stop = new AbortController();
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, stop.signal]) : stop.signal;
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });

  function rejectAll(error) {
    failure = failure || error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    pending.clear();
  }

  function send(record) {
    const line = JSON.stringify(record);
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new Error('MCP request exceeds the record limit.');
    channel.send(record);
  }

  function onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { rejectAll(new Error('Malformed MCP output.')); channel?.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { rejectAll(new Error('Invalid MCP record.')); channel?.close(); return; }
    if (message.method && message.id != null) {
      // A server request (such as elicitation, which this client never declares).
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported by the acceptance client.' } });
      return;
    }
    if (message.method) {
      if (message.method === 'notifications/progress') {
        const token = message.params?.progressToken;
        for (const item of pending.values()) if (item.progressToken === token) item.onProgress?.(message.params);
      }
      return;
    }
    const item = pending.get(message.id);
    if (!item) { rejectAll(new Error(`Unexpected MCP response id ${message.id}.`)); channel?.close(); return; }
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(Object.assign(new Error(message.error.message || 'MCP error'), { rpc: message.error }));
    else item.resolve(message.result);
  }

  const exited = runCommand(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs || 30 * 60_000,
    abortSignal,
    maxLineBytes: MAX_RECORD_BYTES,
    onStdoutLine: onLine,
    session: {
      start(ch) { channel = ch; opened(); },
      interrupt(ch) { ch.close(); },
    },
  }).then(result => {
    closed = true;
    rejectAll(new Error(`MCP server ended (${result.error ? result.error.code : `exit code ${result.exitCode}`}).`));
    return result;
  });

  /** Closes stdin, stops the server if it outlives the grace period, and waits for its exit. */
  async function shutdown() {
    if (!closed) channel.close();
    const timer = setTimeout(() => stop.abort(new Error('MCP server did not exit after stdin closed.')), options.closeGraceMs ?? CLOSE_GRACE_MS);
    try { return await exited; } finally { clearTimeout(timer); }
  }

  await Promise.race([ready, exited]);
  if (!channel) throw failure || new Error('MCP server did not start.');

  /**
   * Sends one request and waits for its response.
   * @param params - Request parameters; `options.onProgress` receives progress notifications.
   */
  function request(method, params, requestOptions = {}) {
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.reject(new Error('MCP server has ended.'));
    const id = nextId++;
    const progressToken = requestOptions.onProgress ? `p${id}` : undefined;
    const body = progressToken ? { ...params, _meta: { ...(params?._meta || {}), progressToken } } : params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${requestOptions.timeoutMs || DEFAULT_REQUEST_MS} ms.`));
      }, requestOptions.timeoutMs || DEFAULT_REQUEST_MS);
      pending.set(id, { resolve, reject, timer, progressToken, onProgress: requestOptions.onProgress });
      try { send({ jsonrpc: '2.0', id, method, params: body }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  let init;
  try {
    init = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'coagent8-acceptance', version: '1.0.0' },
    }, { timeoutMs: options.initTimeoutMs || DEFAULT_REQUEST_MS });
    if (!init || typeof init !== 'object' || !init.serverInfo || typeof init.protocolVersion !== 'string') {
      throw new Error('MCP server returned an invalid initialize result.');
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch (error) {
    // Nobody else can close a server whose handshake failed: end it before reporting.
    await shutdown();
    throw error;
  }

  return {
    serverInfo: init.serverInfo,
    request,
    /** Calls a tool; the result keeps `isError`, `content` and `structuredContent`. */
    callTool(name, args, callOptions) {
      return request('tools/call', { name, arguments: args }, callOptions);
    },
    /** Closes stdin and waits until the supervised server has exited (stopped after a grace period). */
    close: shutdown,
  };
}

/** The text of a tool result's content blocks. */
function resultText(result) {
  return (result?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

module.exports = { connectMcp, resultText };
