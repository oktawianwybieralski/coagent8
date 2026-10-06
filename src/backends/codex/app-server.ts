/**
 * One read-only turn over the `codex app-server` JSON-RPC protocol (Codex CLI 0.160).
 *
 * @remarks
 * Messages are newline-delimited JSON-RPC 2.0 without the `jsonrpc` field. The session
 * performs the `initialize`/`initialized` handshake, starts or resumes the thread, fails
 * closed unless the server reports a read-only sandbox with `approvalPolicy: "never"`,
 * starts one turn and closes stdin when the turn completes, which ends the server. An
 * interrupt sends `turn/interrupt`; the server then completes the turn with
 * `status: "interrupted"`. Server-initiated requests (approvals, user input, tool calls)
 * are answered with a JSON-RPC error: this client never grants anything.
 *
 * @packageDocumentation
 */
import { BRAND } from '../../constants.js';
import { validEventIdentifier } from '../../types/conversation.types.js';
import type { AdapterEvent, ExecutionError } from '../../types/adapter.types.js';
import type { StdinChannel, StdinSession } from '../../execution/process.js';
import { classifyCodexTurnError } from './errors.js';
import type { createCodexStreamCollector } from './collector.js';

export interface CodexAppSessionOptions {
  collector: ReturnType<typeof createCodexStreamCollector>;
  /** Thread to resume; a new thread is started when absent. */
  threadId?: string | null;
  model: string;
  effort: string;
  cwd: string;
  onEvent?: (event: AdapterEvent) => void;
}

const REQUEST = { initialize: 1, thread: 2, turn: 3, interrupt: 4 } as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function typed(code: ExecutionError['code'], message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Creates the stdin session and stdout line handler for one Codex app-server turn.
 * @param options - Collector, thread, model, effort and working directory of the turn.
 * @returns `session` for `runCommand` and `line` for its `onStdoutLine`.
 * @throws From `line`: `SANDBOX_UNAVAILABLE` when the server does not confirm read-only
 * mode, `SESSION_INVALID` for an unknown thread, `PROTOCOL_ERROR` on malformed messages,
 * and typed provider errors for failed requests.
 */
export function createCodexAppSession(options: CodexAppSessionOptions) {
  const { collector } = options;
  let channel: StdinChannel | undefined;
  let prompt = '';
  let interruptRequested = false, interruptSent = false;
  let warnedRequest = false;

  const send = (message: Record<string, unknown>) => channel?.send(message);
  // Every failure ends the server: no turn is left running after the run stops.
  const fail = (error: Error): never => { channel?.close(); throw error; };
  function sendInterrupt() {
    const { threadId, turnId } = collector.snapshot();
    if (interruptSent || !threadId || !turnId) return;
    interruptSent = true;
    send({ id: REQUEST.interrupt, method: 'turn/interrupt', params: { threadId, turnId } });
  }

  function onInitialized() {
    send({ method: 'initialized' });
    const thread = { model: options.model, cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only' };
    send(options.threadId
      // `excludeTurns` keeps the response from carrying the whole thread history.
      ? { id: REQUEST.thread, method: 'thread/resume', params: { ...thread, threadId: options.threadId, excludeTurns: true } }
      : { id: REQUEST.thread, method: 'thread/start', params: thread });
  }
  function onThread(result: Record<string, unknown>) {
    const sandbox = record(result.sandbox);
    if (sandbox?.type !== 'readOnly' || result.approvalPolicy !== 'never') {
      fail(typed('SANDBOX_UNAVAILABLE', 'Codex did not confirm a read-only sandbox with approvals disabled.'));
    }
    const id = record(result.thread)?.id;
    if (typeof id !== 'string') fail(typed('PROTOCOL_ERROR', 'Codex returned a thread without an ID.'));
    collector.initialize(id as string);
    send({ id: REQUEST.turn, method: 'turn/start', params: {
      threadId: id, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: options.effort } });
  }
  function onTurn(result: Record<string, unknown>) {
    const id = record(result.turn)?.id;
    if (typeof id !== 'string') fail(typed('PROTOCOL_ERROR', 'Codex returned a turn without an ID.'));
    collector.beginTurn(id as string);
    if (interruptRequested) sendInterrupt();
  }
  function onResponse(id: unknown, message: Record<string, unknown>) {
    const error = record(message.error);
    if (id === REQUEST.interrupt) {
      // A turn that already ended rejects the interrupt; its completion is authoritative.
      return;
    }
    if (error) {
      const text = typeof error.message === 'string' ? error.message : 'Codex rejected a request.';
      if (id === REQUEST.thread && options.threadId && /no rollout found|not found/i.test(text)) fail(typed('SESSION_INVALID', 'Codex thread not found.'));
      const classified = classifyCodexTurnError({ message: text }, 'Codex rejected a request.');
      fail(typed(classified.code, classified.message));
    }
    const result = record(message.result);
    if (!result) fail(typed('PROTOCOL_ERROR', 'Codex returned a response without a result.'));
    if (id === REQUEST.initialize) onInitialized();
    else if (id === REQUEST.thread) onThread(result as Record<string, unknown>);
    else if (id === REQUEST.turn) onTurn(result as Record<string, unknown>);
    else fail(typed('PROTOCOL_ERROR', 'Codex answered an unknown request.'));
  }

  const session: StdinSession = {
    start(opened, input) {
      channel = opened;
      prompt = input;
      send({ id: REQUEST.initialize, method: 'initialize', params: {
        clientInfo: { name: BRAND.PACKAGE_NAME, title: BRAND.NAME, version: BRAND.SERVER_VERSION },
        // `excludeTurns` on `thread/resume` is an experimental field.
        capabilities: { experimentalApi: true, requestAttestation: false } } });
    },
    interrupt(opened) {
      interruptRequested = true;
      // Before the turn exists there is nothing to interrupt; EOF ends the server.
      if (!collector.snapshot().turnId) { opened.close(); return; }
      sendInterrupt();
    },
  };

  function line(raw: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail(typed('PROTOCOL_ERROR', 'Invalid Codex JSON-RPC record.')); }
    const message = record(parsed);
    if (!message) fail(typed('PROTOCOL_ERROR', 'Invalid Codex JSON-RPC message.'));
    const msg = message as Record<string, unknown>;
    const hasId = typeof msg.id === 'number' || (typeof msg.id === 'string' && validEventIdentifier(msg.id));
    if (hasId && typeof msg.method === 'string') {
      if (!warnedRequest) {
        warnedRequest = true;
        options.onEvent?.({ type: 'warning', message: `Declined a Codex '${msg.method.slice(0, 64)}' request in read-only mode.` });
      }
      send({ id: msg.id, error: { code: -32601, message: `${BRAND.NAME} runs Codex read-only and does not answer server requests.` } });
      return;
    }
    if (hasId) onResponse(msg.id, msg);
    else if (typeof msg.method === 'string') {
      try { collector.notify(msg.method, msg.params); }
      finally { if (collector.isTerminal()) channel?.close(); }
    } else fail(typed('PROTOCOL_ERROR', 'Invalid Codex JSON-RPC message.'));
  }

  return { session, line };
}
