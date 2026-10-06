/** Public Codex app-server notification collector shared by production execution and parser regressions. @packageDocumentation */
import { BufferLimitError, StreamReducer, truncateToByteLength } from '../execution/stream.js';
import { redactDiagnostic, redactSecrets } from '../redaction.js';
import { validEventIdentifier } from '../types/conversation.types.js';
import type { AdapterEvent, ExecutionError, TerminalExecutionResult } from '../types/adapter.types.js';
import { classifyCodexTurnError } from './codex-errors.js';

export interface CodexStreamCollectorOptions {
  onEvent?: (event: AdapterEvent) => void;
  onProgress?: ((message: string) => void) | null;
  nativeSessionId?: string | null;
  maxLineBuffer?: number;
  maxTotalMessageBytes?: number;
  maxMessages?: number;
  maxTextPerMessage?: number;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function protocolError(message: string): never {
  throw Object.assign(new Error(message), { code: 'PROTOCOL_ERROR' });
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
/** Thread item types reported as tool activity; their operands and output stay private. */
const TOOL_ITEMS: Record<string, string> = {
  commandExecution: 'sandbox command', mcpToolCall: 'MCP tool', webSearch: 'web search',
  fileChange: 'file change', dynamicToolCall: 'tool',
};

/**
 * Collects validated answers, tool activity, usage and terminal state from `codex app-server`
 * notifications (protocol of Codex CLI 0.160).
 * @param options - Owned callback and bounded public-output budgets, in bytes/counts.
 * @returns A collector fed with notifications by the app-server session, whose snapshot is
 * used directly by the production adapter.
 * @throws On malformed notifications for the run's thread or a second terminal event.
 * @remarks
 * Notifications for other threads (for example sub-agents) are ignored. Private reasoning,
 * raw commands and tool output are discarded. Latest public snapshots replace drafts,
 * including under budget pressure. Truncation is explicit; the adapter returns
 * BUFFER_LIMIT rather than claiming a complete answer. Turn usage is the sum of
 * `tokenUsage.last` over the turn's `thread/tokenUsage/updated` notifications, which the
 * server emits once per model request.
 */
export function createCodexStreamCollector(options: CodexStreamCollectorOptions = {}) {
  const reducer = new StreamReducer({ maxLineBuffer: options.maxLineBuffer ?? 512 * 1024,
    maxTotalBytes: options.maxTotalMessageBytes ?? 512 * 1024, maxMessages: options.maxMessages ?? 50,
    maxMessageBytes: options.maxTextPerMessage ?? 512 * 1024 });
  let threadId = options.nativeSessionId ?? null;
  let turnId: string | null = null;
  let initialized = false;
  let terminal = false;
  let interrupted = false;
  let providerError: ExecutionError | undefined;
  let inputTokens = 0, outputTokens = 0, usageSeen = false;
  let streamedBytes = 0;
  const emit = (event: AdapterEvent) => {
    options.onEvent?.(event);
    if (event.type === 'status') options.onProgress?.(event.message);
  };
  function acceptMessage(item: Record<string, unknown>) {
    if (!validEventIdentifier(item.id) || typeof item.text !== 'string') protocolError('Invalid public Codex message.');
    const id = item.id as string;
    if (!reducer.getMessageMap().has(id) && reducer.getMessageMap().size >= reducer.maxMessages) throw new BufferLimitError('Too many Codex public messages.');
    reducer.upsertMessage(id, redactSecrets(item.text));
    emit({ type: 'assistant_message', messageId: id, text: reducer.getMessageMap().get(id) ?? '' });
  }
  function acceptItem(method: string, item: Record<string, unknown> | null) {
    if (!item || typeof item.type !== 'string') protocolError('Codex item is missing.');
    const started = method === 'item/started';
    if (item.type === 'agentMessage') {
      if (started) emit({ type: 'status', message: 'Formulating findings...' });
      else acceptMessage(item);
      return;
    }
    if (item.type === 'reasoning') {
      if (started) emit({ type: 'status', message: 'Analyzing context and architecture...' });
      return;
    }
    const name = TOOL_ITEMS[item.type];
    if (!name) return;
    if (!validEventIdentifier(item.id)) protocolError('Invalid Codex tool ID.');
    if (started) {
      emit({ type: 'status', message: `Executing ${name}...` });
      emit({ type: 'tool_started', toolId: item.id as string, name: item.type });
    } else {
      emit({ type: 'tool_finished', toolId: item.id as string, name: item.type,
        success: item.status === 'completed' && item.error == null && item.success !== false && (item.exitCode == null || item.exitCode === 0) });
    }
  }
  function acceptUsage(params: Record<string, unknown>) {
    const last = record(record(params.tokenUsage)?.last);
    if (!last) protocolError('Invalid Codex token usage.');
    inputTokens += count(last.inputTokens);
    outputTokens += count(last.outputTokens);
    usageSeen = true;
  }
  function acceptTurnCompleted(params: Record<string, unknown>) {
    const turn = record(params.turn);
    if (!turn || typeof turn.status !== 'string') protocolError('Invalid Codex turn completion.');
    if (turnId !== null && turn.id !== turnId) return;
    if (terminal) protocolError('Codex emitted a second terminal event.');
    terminal = true;
    if (turn.status === 'failed') {
      providerError = classifyCodexTurnError(turn.error, 'Codex turn failed.');
    } else if (turn.status === 'interrupted') {
      interrupted = true;
    } else if (turn.status !== 'completed') protocolError(`Codex turn ended with status '${turn.status.slice(0, 32)}'.`);
  }
  /**
   * Accepts one server notification. The app-server session routes responses and
   * server requests elsewhere.
   */
  function notify(method: string, value: unknown) {
    const params = record(value);
    if (!params) protocolError('Invalid Codex notification.');
    // Thread-scoped notifications for other threads (sub-agents) are not this run's answer.
    if (typeof params.threadId === 'string' && threadId !== null && params.threadId !== threadId) return;
    if (method === 'error') {
      const error = record(params.error);
      if (params.willRetry === true) emit({ type: 'warning', message: redactDiagnostic(`Codex is retrying: ${String(error?.message ?? 'unknown error')}`, 512) });
      else providerError = classifyCodexTurnError(error, 'Codex reported an error.');
      return;
    }
    if (method === 'turn/completed') { acceptTurnCompleted(params); return; }
    // The server keeps sending thread status updates after the turn; they carry no answer.
    if (terminal) return;
    if (method === 'turn/started') emit({ type: 'status', message: 'Starting task analysis...' });
    else if (method === 'item/started' || method === 'item/completed') acceptItem(method, record(params.item));
    else if (method === 'item/agentMessage/delta') {
      if (!validEventIdentifier(params.itemId) || typeof params.delta !== 'string') protocolError('Invalid Codex message delta.');
      // Deltas stop at the public budget; the completed message still replaces the draft.
      streamedBytes += Buffer.byteLength(params.delta);
      if (streamedBytes <= reducer.maxTotalBytes) emit({ type: 'assistant_delta', messageId: params.itemId as string, text: params.delta });
    } else if (method === 'thread/tokenUsage/updated') {
      if (turnId === null || params.turnId === turnId) acceptUsage(params);
    }
  }
  /** Records the thread verified by the session's `thread/start` or `thread/resume` response. */
  function initialize(id: string) {
    if (initialized || !validEventIdentifier(id) || (options.nativeSessionId && options.nativeSessionId !== id)) protocolError('Codex returned an inconsistent thread ID.');
    initialized = true;
    threadId = id;
    emit({ type: 'status', message: 'Initializing Codex session...' });
  }
  /** Records the turn started by the session; notifications for other turns are ignored. */
  function beginTurn(id: string) {
    if (!validEventIdentifier(id)) protocolError('Codex returned an invalid turn ID.');
    turnId = id;
  }
  /** Parses one notification line (`{"method": ..., "params": ...}`), as used by parser regressions. */
  function line(raw: string) {
    if (!raw.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { protocolError('Invalid Codex JSONL record.'); }
    const message = record(parsed);
    if (!message || typeof message.method !== 'string') protocolError('Invalid Codex notification.');
    notify(message.method, message.params);
  }
  function snapshot() {
    const joined = [...reducer.getMessageMap().values()].join('\n\n');
    const output = truncateToByteLength(joined, reducer.maxTotalBytes);
    const truncated = reducer.isTruncated() || reducer.hasOversizedLine() || output !== joined;
    const usage: TerminalExecutionResult['usage'] = usageSeen
      ? { source: 'provider', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } : undefined;
    return { threadId, turnId, initialized, terminal, interrupted, usage, truncated, output,
      error: providerError || (truncated ? { code: 'BUFFER_LIMIT' as const, message: 'Codex public output exceeded the byte budget.', retryable: false } : undefined) };
  }
  return { notify, initialize, beginTurn, line, snapshot,
    isTerminal: () => terminal,
    pushChunk: (chunk: string) => reducer.pushChunk(chunk, line),
    flush: () => reducer.flush(line),
    getCapturedThreadId: () => threadId,
    getFormattedOutput: () => snapshot().output,
    getRawFallbackLines: () => [],
    getJsonErrors: () => providerError ? [providerError.message] : [],
    hasOversizedLine: () => reducer.hasOversizedLine(),
  };
}
