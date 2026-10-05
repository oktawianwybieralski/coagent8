/** Public Codex JSONL collector shared by production execution and parser regressions. @packageDocumentation */
import { BufferLimitError, StreamReducer, truncateToByteLength } from '../execution/stream.js';
import { redactSecrets } from '../redaction.js';
import { validEventIdentifier } from '../types/conversation.types.js';
import type { AdapterEvent, ExecutionError, TerminalExecutionResult } from '../types/adapter.types.js';
import { extractStructuredCodexError } from './codex-errors.js';

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

/**
 * Collects validated snapshots, session identity, tools and terminal state from Codex.
 * @param options - Owned callback and bounded public-output budgets, in bytes/counts.
 * @returns A line/chunk collector whose snapshot is used directly by the production adapter.
 * @throws On malformed events, inconsistent thread identity or events after terminal state.
 * @remarks
 * Private reasoning, raw commands and tool output are discarded. Latest public
 * snapshots replace drafts, including under budget pressure. Truncation is explicit;
 * the adapter returns BUFFER_LIMIT rather than claiming a complete answer.
 */
export function createCodexStreamCollector(options: CodexStreamCollectorOptions = {}) {
  const reducer = new StreamReducer({ maxLineBuffer: options.maxLineBuffer ?? 512 * 1024,
    maxTotalBytes: options.maxTotalMessageBytes ?? 512 * 1024, maxMessages: options.maxMessages ?? 50,
    maxMessageBytes: options.maxTextPerMessage ?? 512 * 1024 });
  let threadId = options.nativeSessionId ?? null;
  let initialized = false;
  let terminal = false;
  let providerError: ExecutionError | undefined;
  let usage: TerminalExecutionResult['usage'];
  const emit = (event: AdapterEvent) => {
    options.onEvent?.(event);
    if (event.type === 'status') options.onProgress?.(event.message);
  };
  function acceptMessage(item: Record<string, unknown>) {
    if (!validEventIdentifier(item.id) || typeof item.text !== 'string') protocolError('Invalid public Codex message.');
    const id = item.id as string;
    if (!reducer.getMessageMap().has(id) && reducer.getMessageMap().size >= reducer.maxMessages) throw new BufferLimitError('Too many Codex public messages.');
    reducer.upsertMessage(id, redactSecrets(item.text));
    const text = reducer.getMessageMap().get(id) ?? '';
    emit({ type: 'assistant_message', messageId: id, text });
  }
  function acceptUsage(value: unknown) {
    const data = record(value);
    if (!data) protocolError('Invalid Codex usage.');
    const input = data.input_tokens;
    const output = data.output_tokens;
    if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 &&
        typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 && Number.isSafeInteger(input + output)) {
      usage = { source: 'provider', inputTokens: input, outputTokens: output, totalTokens: input + output };
    }
  }
  function acceptItem(event: Record<string, unknown>) {
    const item = record(event.item);
    if (!item || typeof item.type !== 'string') protocolError('Codex item is missing.');
    if (item.type === 'agent_message') {
      if (event.type === 'item.started') emit({ type: 'status', message: 'Formulating findings...' });
      acceptMessage(item);
      return;
    }
    if (['reasoning', 'thought'].includes(item.type)) {
      if (event.type === 'item.started' || event.type === 'item.created') emit({ type: 'status', message: 'Analyzing context and architecture...' });
      return;
    }
    if (!['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(item.type)) return;
    if (!validEventIdentifier(item.id)) protocolError('Invalid Codex tool ID.');
    if (event.type === 'item.started' || event.type === 'item.created') {
      const name = item.type === 'command_execution' ? 'sandbox command' : item.type === 'mcp_tool_call' ? 'MCP tool' : item.type === 'web_search' ? 'web search' : 'file change';
      emit({ type: 'status', message: `Executing ${name}...` });
      emit({ type: 'tool_started', toolId: item.id as string, name: item.type });
    } else if (event.type === 'item.completed') {
      emit({ type: 'tool_finished', toolId: item.id as string, name: item.type,
        success: item.status !== 'failed' && !item.error && (item.exit_code == null || item.exit_code === 0) });
    }
  }
  function line(raw: string) {
    if (!raw.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { protocolError('Invalid Codex JSONL record.'); }
    const event = record(parsed);
    if (!event || typeof event.type !== 'string') protocolError('Invalid Codex event.');
    if (terminal) protocolError('Codex emitted data after its terminal event.');
    if (event.type === 'thread.started') {
      if (initialized || !validEventIdentifier(event.thread_id) || (options.nativeSessionId && options.nativeSessionId !== event.thread_id)) protocolError('Codex returned an inconsistent thread ID.');
      initialized = true;
      threadId = event.thread_id as string;
      emit({ type: 'status', message: 'Initializing Codex session...' });
    } else if (event.type === 'turn.started') emit({ type: 'status', message: 'Starting task analysis...' });
    else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      terminal = true;
      if (event.type === 'turn.failed') providerError = extractStructuredCodexError(event.error, typeof event.message === 'string' ? event.message : 'Codex turn failed.');
      else if (event.usage !== undefined) acceptUsage(event.usage);
    } else if (event.type === 'error') providerError = extractStructuredCodexError(event.error || event, typeof event.message === 'string' ? event.message : 'Codex reported an error.');
    else if (['item.created', 'item.started', 'item.updated', 'item.completed'].includes(event.type)) acceptItem(event);
  }
  function snapshot() {
    const joined = [...reducer.getMessageMap().values()].join('\n\n');
    const output = truncateToByteLength(joined, reducer.maxTotalBytes);
    const truncated = reducer.isTruncated() || reducer.hasOversizedLine() || output !== joined;
    return { threadId, initialized, terminal, usage, truncated, output,
      error: providerError || (truncated ? { code: 'BUFFER_LIMIT' as const, message: 'Codex public output exceeded the byte budget.', retryable: false } : undefined) };
  }
  return { line, snapshot,
    pushChunk: (chunk: string) => reducer.pushChunk(chunk, line),
    flush: () => reducer.flush(line),
    getCapturedThreadId: () => threadId,
    getFormattedOutput: () => snapshot().output,
    getRawFallbackLines: () => [],
    getJsonErrors: () => providerError ? [providerError.message] : [],
    hasOversizedLine: () => reducer.hasOversizedLine(),
  };
}
