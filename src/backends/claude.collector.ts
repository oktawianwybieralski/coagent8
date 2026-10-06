/** Public Claude Code stream-json collector shared by production execution and parser regressions. @packageDocumentation */
import { BufferLimitError, StreamReducer, truncateToByteLength } from '../execution/stream.js';
import { redactDiagnostic } from '../redaction.js';
import { validEventIdentifier } from '../types/conversation.types.js';
import type { AdapterEvent, ExecutionError, TerminalExecutionResult } from '../types/adapter.types.js';
import { classifyClaudeFailure } from './claude-errors.js';

/** Event types emitted by `claude -p --output-format stream-json --verbose` (observed with 2.1.289). */
const KNOWN_TYPES = new Set(['system', 'assistant', 'user', 'stream_event', 'result', 'rate_limit_event']);
/** `system` subtypes the collector understands; others produce one warning each. */
const KNOWN_SYSTEM_SUBTYPES = new Set(['init', 'status', 'thinking_tokens', 'api_retry']);

export interface ClaudeStreamCollectorOptions {
  /** Session ID passed as `--session-id` or `--resume`; `system/init` must report the same ID. */
  expectedSessionId: string;
  /** Built-in tools the run may expose; `system/init` must not report any other tool. */
  allowedTools: readonly string[];
  onEvent?: (event: AdapterEvent) => void;
  maxTotalMessageBytes?: number;
  maxMessages?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function fail(code: 'PROTOCOL_ERROR' | 'SANDBOX_UNAVAILABLE', message: string): never {
  throw Object.assign(new Error(message), { code });
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Collects public answers, tool activity, session identity and the terminal result from Claude Code.
 * @param options - Expected session, read-only tool profile, callback and public-output budgets.
 * @returns A line collector whose snapshot is used directly by the production adapter.
 * @throws `SANDBOX_UNAVAILABLE` when `system/init` reports a tool, MCP server or
 * permission mode outside the read-only profile; `PROTOCOL_ERROR` on malformed
 * known events, a mismatched session ID or a second terminal result.
 * @remarks
 * Thinking blocks, tool inputs and tool results are discarded. Unknown event
 * types and `system` subtypes are tolerated with one warning per type. Answer
 * text is not passed through keyword redaction; only diagnostics are redacted.
 */
export function createClaudeStreamCollector(options: ClaudeStreamCollectorOptions) {
  const reducer = new StreamReducer({ maxTotalBytes: options.maxTotalMessageBytes ?? 512 * 1024,
    maxMessageBytes: options.maxTotalMessageBytes ?? 512 * 1024, maxMessages: options.maxMessages ?? 200 });
  const allowed = new Set(options.allowedTools);
  const tools = new Map<string, string>();
  const warned = new Set<string>();
  let sessionId: string | null = null;
  let currentMessageId: string | null = null;
  let terminal = false;
  let finalText: string | null = null;
  let streamedBytes = 0;
  let category: string | null = null;
  let rateLimitResetsAt: number | null = null;
  let resultFields: { isError: boolean; subtype: string | null; apiErrorStatus: number | null; errors: string[] } | null = null;
  let usage: TerminalExecutionResult['usage'];
  const emit = (event: AdapterEvent) => options.onEvent?.(event);
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    emit({ type: 'warning', message: redactDiagnostic(message, 512) });
  };

  function ensureInitialized() {
    if (sessionId === null) fail('SANDBOX_UNAVAILABLE', 'Claude Code emitted events before read-only initialization.');
  }

  function acceptInit(event: Record<string, unknown>) {
    if (sessionId !== null) fail('PROTOCOL_ERROR', 'Claude Code emitted a second init event.');
    if (typeof event.session_id !== 'string' || event.session_id.toLowerCase() !== options.expectedSessionId.toLowerCase()) {
      fail('PROTOCOL_ERROR', 'Claude Code reported an unexpected session ID.');
    }
    const reported = event.tools, servers = event.mcp_servers;
    if (!Array.isArray(reported) || !reported.every(tool => typeof tool === 'string' && allowed.has(tool))) {
      fail('SANDBOX_UNAVAILABLE', 'Claude Code exposed tools outside the read-only profile.');
    }
    if (!Array.isArray(servers) || servers.length > 0) fail('SANDBOX_UNAVAILABLE', 'Claude Code connected MCP servers despite the empty strict MCP configuration.');
    if (event.permissionMode !== 'dontAsk') fail('SANDBOX_UNAVAILABLE', 'Claude Code did not start in dontAsk permission mode.');
    sessionId = options.expectedSessionId.toLowerCase();
    emit({ type: 'status', message: 'Initializing Claude Code session...' });
  }
  function acceptSystem(event: Record<string, unknown>) {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    if (subtype === 'init') acceptInit(event);
    else if (subtype === 'status') { if (event.status === 'requesting') emit({ type: 'status', message: 'Requesting model response...' }); }
    else if (subtype === 'api_retry') {
      emit({ type: 'warning', message: redactDiagnostic(`Claude API retry ${count(event.attempt)}/${count(event.max_retries)}: ${String(event.error ?? 'unknown')}`, 512) });
    } else if (!KNOWN_SYSTEM_SUBTYPES.has(subtype)) warnOnce(`system/${subtype}`, `Ignoring unknown Claude Code system event '${subtype.slice(0, 64)}'.`);
  }
  function acceptAssistant(event: Record<string, unknown>) {
    ensureInitialized();
    const message = record(event.message);
    if (!message || !Array.isArray(message.content) || !validEventIdentifier(message.id)) fail('PROTOCOL_ERROR', 'Invalid Claude Code assistant event.');
    const id = message.id as string;
    if (typeof event.error === 'string') category = event.error;
    // API error notices are diagnostics carried in the result, not model answers.
    const publicText = event.is_api_error_message !== true;
    for (const value of message.content) {
      const block = record(value);
      if (!block) fail('PROTOCOL_ERROR', 'Invalid Claude Code content block.');
      if (block.type === 'text' && typeof block.text === 'string') {
        if (!publicText) continue;
        if (!reducer.getMessageMap().has(id) && reducer.getMessageMap().size >= reducer.maxMessages) throw new BufferLimitError('Too many Claude Code public messages.');
        reducer.upsertMessage(id, (reducer.getMessageMap().get(id) ?? '') + block.text);
        emit({ type: 'assistant_message', messageId: id, text: reducer.getMessageMap().get(id) ?? '' });
      } else if (block.type === 'tool_use') {
        if (!validEventIdentifier(block.id) || !validEventIdentifier(block.name)) fail('PROTOCOL_ERROR', 'Invalid Claude Code tool call.');
        if (tools.has(block.id as string)) continue;
        tools.set(block.id as string, block.name as string);
        emit({ type: 'tool_started', toolId: block.id as string, name: block.name as string });
      }
    }
  }
  function acceptUser(event: Record<string, unknown>) {
    ensureInitialized();
    const message = record(event.message);
    if (!message || !Array.isArray(message.content)) return;
    for (const value of message.content) {
      const block = record(value);
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const name = tools.get(block.tool_use_id);
      if (name) emit({ type: 'tool_finished', toolId: block.tool_use_id, name, success: block.is_error !== true });
    }
  }
  function acceptStream(event: Record<string, unknown>) {
    ensureInitialized();
    const inner = record(event.event);
    if (!inner) fail('PROTOCOL_ERROR', 'Invalid Claude Code stream event.');
    if (inner.type === 'message_start') {
      const message = record(inner.message);
      if (message && validEventIdentifier(message.id)) currentMessageId = message.id as string;
    } else if (inner.type === 'content_block_start' && record(inner.content_block)?.type === 'thinking') {
      emit({ type: 'status', message: 'Analyzing context...' });
    } else if (inner.type === 'content_block_delta') {
      const delta = record(inner.delta);
      if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || !currentMessageId) return;
      // Deltas stop at the public budget; the bounded assistant message still replaces the draft.
      streamedBytes += Buffer.byteLength(delta.text);
      if (streamedBytes <= reducer.maxTotalBytes) emit({ type: 'assistant_delta', messageId: currentMessageId, text: delta.text });
    }
  }
  function acceptResult(event: Record<string, unknown>) {
    if (terminal) fail('PROTOCOL_ERROR', 'Claude Code emitted a second result event.');
    if (typeof event.session_id === 'string' && event.session_id.toLowerCase() !== options.expectedSessionId.toLowerCase()) {
      fail('PROTOCOL_ERROR', 'Claude Code result reported an unexpected session ID.');
    }
    terminal = true;
    const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
    if (!isError && sessionId === null) {
      fail('SANDBOX_UNAVAILABLE', 'Claude Code completed successfully without read-only initialization.');
    }
    resultFields = { isError, subtype: typeof event.subtype === 'string' ? event.subtype : null,
      apiErrorStatus: typeof event.api_error_status === 'number' ? event.api_error_status : null,
      errors: Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === 'string') : [] };
    if (typeof event.result === 'string') finalText = event.result;
    const data = record(event.usage);
    if (data) {
      // Anthropic reports cached input separately; the sum is the input actually processed.
      const input = count(data.input_tokens) + count(data.cache_creation_input_tokens) + count(data.cache_read_input_tokens);
      const output = count(data.output_tokens);
      usage = { source: 'provider', inputTokens: input, outputTokens: output, totalTokens: input + output };
    }
    const denials = Array.isArray(event.permission_denials) ? event.permission_denials.map(entry => record(entry)?.tool_name).filter(validEventIdentifier) : [];
    if (denials.length) emit({ type: 'warning', message: `Claude Code denied tool calls outside the read-only profile: ${[...new Set(denials)].join(', ')}.` });
  }
  function line(raw: string) {
    if (!raw.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail('PROTOCOL_ERROR', 'Invalid Claude Code JSON record.'); }
    const event = record(parsed);
    if (!event || typeof event.type !== 'string') fail('PROTOCOL_ERROR', 'Invalid Claude Code event.');
    if (terminal && event.type !== 'result') return;
    if (event.type === 'system') acceptSystem(event);
    else if (event.type === 'assistant') acceptAssistant(event);
    else if (event.type === 'user') acceptUser(event);
    else if (event.type === 'stream_event') acceptStream(event);
    else if (event.type === 'result') acceptResult(event);
    else if (event.type === 'rate_limit_event') {
      const info = record(event.rate_limit_info);
      if (info?.status === 'rejected' && typeof info.resetsAt === 'number') rateLimitResetsAt = info.resetsAt;
    } else if (!KNOWN_TYPES.has(event.type)) warnOnce(event.type, `Ignoring unknown Claude Code event type '${event.type.slice(0, 64)}'.`);
  }
  function snapshot() {
    const text = finalText ?? '';
    const output = truncateToByteLength(text, reducer.maxTotalBytes);
    const truncated = output !== text || reducer.isTruncated();
    const error: ExecutionError | undefined = resultFields?.isError
      ? classifyClaudeFailure({ category, apiErrorStatus: resultFields.apiErrorStatus, subtype: resultFields.subtype,
        errors: resultFields.errors, message: finalText, rateLimitResetsAt })
      : truncated ? { code: 'BUFFER_LIMIT', message: 'Claude Code public output exceeded the byte budget.', retryable: false } : undefined;
    return { sessionId, initialized: sessionId !== null, terminal, usage, truncated, error, output: (resultFields?.isError || !sessionId) ? '' : output, hasAssistantMessage: reducer.getMessageMap().size > 0 };
  }
  return { line, snapshot };
}
