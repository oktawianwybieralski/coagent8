/** Public Claude Code stream-json collector shared by production execution and parser regressions. @packageDocumentation */
import { BufferLimitError, truncateToByteLength } from '../../execution/runtime/stream.js';
import { StreamReducer } from '../../execution/stream-reducer.js';
import { redactDiagnostic } from '../../security/redaction.js';
import { ToolError, validEventIdentifier, type AdapterEvent, type ExecutionError, type TokenUsage } from '../../contracts/index.js';
import type { TerminalExecutionResult } from '../types.js';
import { classifyClaudeFailure } from './errors.js';
import { isValidModelIdentifier } from '../../models/identifier.js';

/**
 * Event types emitted by `claude -p --output-format stream-json --verbose` (observed with 2.1.289).
 * `tool_progress` (2.1.332) reports a running tool's elapsed time; tool events already show the activity.
 */
const KNOWN_TYPES = new Set([
  'system',
  'assistant',
  'user',
  'stream_event',
  'result',
  'rate_limit_event',
  'control_response',
  'tool_progress',
]);
/**
 * `system` subtypes the collector understands; others produce one warning each.
 * `permission_denied` (2.1.300) repeats a denial that the denied tool's result already reports.
 * `thinking_tokens` and `compact_boundary` (2.1.332) are internal progress/compaction markers.
 * The task subtypes (2.1.332) describe background tasks, such as a Bash command run in the background.
 */
const KNOWN_SYSTEM_SUBTYPES = new Set([
  'init',
  'status',
  'thinking_tokens',
  'compact_boundary',
  'api_retry',
  'permission_denied',
  'task_started',
  'task_updated',
  'task_notification',
  'background_tasks_changed',
]);
/** Upper bound of a task description or summary quoted in a status or warning. */
const MAX_TASK_TEXT = 160;
/** Upper bound of the background tasks tracked at once, so a runaway list cannot grow memory. */
const MAX_TASKS = 64;
/** Marks the latest assistant text returned when a turn ended without its answer (#231). */
export const PARTIAL_PROGRESS_NOTICE = '[Partial progress: the turn ended before its final answer; this is the latest assistant message.]';

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
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function fail(code: 'PROTOCOL_ERROR' | 'SANDBOX_UNAVAILABLE', message: string): never {
  throw new ToolError(code, message);
}
function isTaskSubtype(subtype: unknown): boolean {
  return typeof subtype === 'string' && (subtype.startsWith('task_') || subtype === 'background_tasks_changed');
}
function taskText(value: unknown): string {
  return typeof value === 'string' ? redactDiagnostic(value.replace(/\s+/g, ' ').trim(), MAX_TASK_TEXT) : '';
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
const known = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const USAGE_FIELDS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'cacheWriteLongInputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
] as const;

function parseResultUsage(raw: unknown): TokenUsage | undefined {
  const data = record(raw);
  if (!data) return undefined;
  // Anthropic reports cached input separately; the sum is the input actually processed
  // (AX-001c). Output includes extended thinking, reported as `output_tokens_details.thinking_tokens`.
  // Each count is kept only when reported; a sum only when every part is known.
  const uncached = data.input_tokens,
    read = data.cache_read_input_tokens,
    write = data.cache_creation_input_tokens;
  const output = data.output_tokens,
    thinking = record(data.output_tokens_details)?.thinking_tokens;
  const input = known(uncached) && known(read) && known(write) ? uncached + read + write : undefined;
  // Writes kept for an hour have their own list price; the split counts only when it adds up.
  const classes = record(data.cache_creation),
    short = classes?.ephemeral_5m_input_tokens,
    long = classes?.ephemeral_1h_input_tokens;
  const longWrite = known(write) && known(short) && known(long) && short + long === write ? long : undefined;
  const counts: TokenUsage = {
    source: 'provider',
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(known(read) ? { cachedInputTokens: read } : {}),
    ...(known(write) ? { cacheWriteInputTokens: write } : {}),
    ...(longWrite !== undefined ? { cacheWriteLongInputTokens: longWrite } : {}),
    ...(known(output) ? { outputTokens: output } : {}),
    ...(known(thinking) ? { reasoningTokens: thinking } : {}),
    ...(input !== undefined && known(output) ? { totalTokens: input + output } : {}),
  };
  return Object.keys(counts).length > 1 ? counts : undefined;
}

/** Sums two token-usage objects, keeping a field only when both parts report it (AX-001c). */
function mergeUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  const merged: TokenUsage = { source: 'provider' };
  for (const field of USAGE_FIELDS) {
    const a = current[field],
      b = next[field];
    if (a !== undefined && b !== undefined) merged[field] = a + b;
  }
  return Object.keys(merged).length > 1 ? merged : undefined;
}

/**
 * Collects public answers, tool activity, session identity and the terminal result from Claude Code.
 * @param options - Expected session, turn tools, callback and public-output budgets.
 * @returns A line collector whose snapshot is used directly by the production adapter.
 * @throws `SANDBOX_UNAVAILABLE` when `system/init` reports a tool, MCP server or
 * permission mode other than requested; `PROTOCOL_ERROR` on malformed
 * known events, a mismatched session ID or a second result without `origin`.
 * @remarks
 * Thinking blocks, tool inputs and tool results are discarded. Unknown event
 * types and `system` subtypes are tolerated with one warning per type. Answer
 * text is not passed through keyword redaction; only diagnostics are redacted.
 *
 * The prompt turn's `result` (no `origin`) and every following successful `result` with
 * `origin` (such as task-notification turns run by Claude Code 2.1.332 when a background
 * task ends) compose the delegated turn's answer in order, separated by blank lines (#245),
 * and per-result `usage` sums every counted result. A notification `result` with `is_error`
 * keeps the delivered answer and warns with the task and error; an unexpected `origin.kind`
 * warns once and behaves like a notification. A notification `result` that arrives before the
 * prompt turn's own result belongs to an earlier turn (#233), so it is skipped and named in
 * a warning; a second `result` without `origin` fails with `PROTOCOL_ERROR`.
 */
export function createClaudeStreamCollector(options: ClaudeStreamCollectorOptions) {
  const reducer = new StreamReducer({
    maxTotalBytes: options.maxTotalMessageBytes ?? 512 * 1024,
    maxMessageBytes: options.maxTotalMessageBytes ?? 512 * 1024,
    maxMessages: options.maxMessages ?? 200,
  });
  const allowed = new Set(options.allowedTools);
  const tools = new Map<string, string>();
  const warned = new Set<string>();
  let sessionId: string | null = null;
  let model: string | undefined;
  let currentMessageId: string | null = null;
  let terminal = false;
  // Message ID of the latest public assistant text: the partial progress of an unfinished turn.
  let latestMessageId: string | null = null;
  // Background tasks still running: task ID to description.
  const tasks = new Map<string, string>();
  // Summaries of finished tasks by run ID, which a notification turn's `origin.runId` names.
  const summaries = new Map<string, string>();
  // Prompt turn answer text followed in order by each successful notification result text.
  const answerParts: string[] = [];
  let latestResultMessage: string | null = null;
  let streamedBytes = 0;
  let category: string | null = null;
  let rateLimitResetsAt: number | null = null;
  let resultFields: { isError: boolean; subtype: string | null; apiErrorStatus: number | null; errors: string[] } | null = null;
  // `stop_reason` of the result event (Claude Code stream-json), e.g. `end_turn` or `max_tokens`.
  let stopReason: string | null = null;
  let usage: TerminalExecutionResult['usage'];
  const emit = (event: AdapterEvent) => options.onEvent?.(event);
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    emit({ type: 'warning', message: redactDiagnostic(message, 512) });
  };
  const runningTasks = () => [...tasks].map(([id, description]) => description || id);

  function ensureInitialized() {
    if (sessionId === null) fail('SANDBOX_UNAVAILABLE', 'Claude Code emitted events before its initialization.');
  }

  /**
   * Validates `system/init`. A notification turn of a background task (2.1.332) starts
   * with another init of the same session, which must pass the same checks.
   */
  function acceptInit(event: Record<string, unknown>) {
    if (typeof event.session_id !== 'string' || event.session_id.toLowerCase() !== options.expectedSessionId.toLowerCase()) {
      fail('PROTOCOL_ERROR', 'Claude Code reported an unexpected session ID.');
    }
    const reported = event.tools,
      servers = event.mcp_servers;
    if (!Array.isArray(reported) || !reported.every(tool => typeof tool === 'string' && allowed.has(tool))) {
      fail('SANDBOX_UNAVAILABLE', 'Claude Code exposed tools outside the requested profile.');
    }
    if (!Array.isArray(servers) || servers.length > 0)
      fail('SANDBOX_UNAVAILABLE', 'Claude Code connected MCP servers despite the empty strict MCP configuration.');
    if (event.permissionMode !== 'dontAsk') fail('SANDBOX_UNAVAILABLE', 'Claude Code did not start in dontAsk permission mode.');
    if (sessionId !== null) return;
    sessionId = options.expectedSessionId.toLowerCase();
    // The CLI resolves aliases such as `opus`; report the model that actually answers.
    if (isValidModelIdentifier(event.model)) model = event.model;
    emit({ type: 'status', message: 'Initializing Claude Code session...' });
  }
  function acceptSystem(event: Record<string, unknown>) {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    if (subtype === 'init') acceptInit(event);
    else if (subtype === 'status') {
      if (event.status === 'requesting') emit({ type: 'status', message: 'Requesting model response...' });
    } else if (subtype === 'api_retry') {
      emit({
        type: 'warning',
        message: redactDiagnostic(
          `Claude API retry ${count(event.attempt)}/${count(event.max_retries)}: ${String(event.error ?? 'unknown')}`,
          512,
        ),
      });
    } else if (isTaskSubtype(subtype)) acceptTask(subtype, event);
    else if (!KNOWN_SYSTEM_SUBTYPES.has(subtype))
      warnOnce(`system/${subtype}`, `Ignoring unknown Claude Code system event '${subtype.slice(0, 64)}'.`);
  }
  /** Tracks background tasks, so the turn can name the ones it stops, and shows their progress. */
  function acceptTask(subtype: string, event: Record<string, unknown>) {
    if (!KNOWN_SYSTEM_SUBTYPES.has(subtype)) {
      warnOnce(`system/${subtype}`, `Ignoring unknown Claude Code system event '${subtype.slice(0, 64)}'.`);
      return;
    }
    const id = typeof event.task_id === 'string' ? event.task_id.slice(0, 128) : null;
    if (subtype === 'background_tasks_changed') {
      if (!Array.isArray(event.tasks)) return;
      // The list is the CLI's full set of running tasks, so it replaces the tracked one.
      tasks.clear();
      for (const entry of event.tasks.slice(0, MAX_TASKS)) {
        const task = record(entry);
        if (typeof task?.task_id === 'string') tasks.set(task.task_id.slice(0, 128), taskText(task.description));
      }
    } else if (subtype === 'task_started' && id) {
      if (!tasks.has(id) && tasks.size >= MAX_TASKS) return;
      const description = taskText(event.description);
      tasks.set(id, description);
      emit({ type: 'status', message: `Background task started: ${description || id}` });
    } else if (subtype === 'task_updated' && id) {
      const status = record(event.patch)?.status;
      if (typeof status === 'string' && status !== 'running' && status !== 'pending') tasks.delete(id);
    } else if (subtype === 'task_notification' && id) {
      const description = tasks.get(id);
      tasks.delete(id);
      const summary = taskText(event.summary) || description || id;
      if (typeof event.run_id === 'string' && summaries.size < MAX_TASKS) summaries.set(event.run_id, summary);
      emit({ type: 'status', message: `Background task ${taskText(event.status) || 'ended'}: ${summary}` });
    }
  }
  function acceptAssistant(event: Record<string, unknown>) {
    ensureInitialized();
    const message = record(event.message);
    if (!message || !Array.isArray(message.content) || !validEventIdentifier(message.id))
      fail('PROTOCOL_ERROR', 'Invalid Claude Code assistant event.');
    const id = message.id as string;
    if (typeof event.error === 'string') category = event.error;
    // API error notices are diagnostics carried in the result, not model answers.
    const publicText = event.is_api_error_message !== true;
    for (const value of message.content) {
      const block = record(value);
      if (!block) fail('PROTOCOL_ERROR', 'Invalid Claude Code content block.');
      if (block.type === 'text' && typeof block.text === 'string') {
        if (!publicText) continue;
        if (!reducer.getMessageMap().has(id) && reducer.getMessageMap().size >= reducer.maxMessages)
          throw new BufferLimitError('Too many Claude Code public messages.');
        reducer.upsertMessage(id, (reducer.getMessageMap().get(id) ?? '') + block.text);
        latestMessageId = id;
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
    const origin = record(event.origin);
    if (origin && origin.kind !== 'task-notification') {
      const kind = typeof origin.kind === 'string' && origin.kind.trim() ? origin.kind.slice(0, 64) : 'unknown';
      warnOnce(`origin/${kind}`, `Received Claude Code result with unexpected origin kind '${kind}'.`);
    }
    const runId = origin && typeof origin.runId === 'string' ? origin.runId : null;
    if (origin && !terminal) {
      // Before the prompt turn's answer it belongs to a task of an earlier turn (#233): skip it
      // and reset latestMessageId so its text cannot leak into partialProgress().
      latestMessageId = null;
      const summary = (runId && summaries.get(runId)) || taskText(event.result) || runId || 'unnamed task';
      emit({ type: 'warning', message: redactDiagnostic(`Skipped notification result from an earlier background task: ${summary}`, 512) });
      return;
    }
    if (!origin && terminal) fail('PROTOCOL_ERROR', 'Claude Code emitted a second result event.');
    if (typeof event.session_id === 'string' && event.session_id.toLowerCase() !== options.expectedSessionId.toLowerCase()) {
      fail('PROTOCOL_ERROR', 'Claude Code result reported an unexpected session ID.');
    }
    terminal = true;
    const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
    if (!isError && sessionId === null) {
      fail('SANDBOX_UNAVAILABLE', 'Claude Code completed successfully without its initialization.');
    }
    const resultMessage = typeof event.result === 'string' ? event.result : null;
    const errors = Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === 'string') : [];
    const subtype = typeof event.subtype === 'string' ? event.subtype : null;
    const apiErrorStatus = typeof event.api_error_status === 'number' ? event.api_error_status : null;
    usage = mergeUsage(usage, parseResultUsage(event.usage));
    if (origin) {
      if (isError) {
        const taskName = (runId && summaries.get(runId)) || runId || 'unnamed task';
        const failure = classifyClaudeFailure({ category, apiErrorStatus, subtype, errors, message: resultMessage, rateLimitResetsAt });
        category = null;
        rateLimitResetsAt = null;
        emit({
          type: 'warning',
          message: redactDiagnostic(`Background task notification failed (${taskName}): ${failure.message}`, 512),
        });
      } else {
        category = null;
        if (resultMessage !== null && resultMessage.trim().length > 0) answerParts.push(resultMessage);
        if (typeof event.stop_reason === 'string' && stopReason !== 'max_tokens') stopReason = event.stop_reason;
      }
    } else {
      if (!isError) category = null;
      resultFields = { isError, subtype, apiErrorStatus, errors };
      latestResultMessage = resultMessage;
      if (resultMessage !== null && resultMessage.trim().length > 0) answerParts.push(resultMessage);
      stopReason = typeof event.stop_reason === 'string' ? event.stop_reason : null;
    }
    const denials = Array.isArray(event.permission_denials)
      ? event.permission_denials.map(entry => record(entry)?.tool_name).filter(validEventIdentifier)
      : [];
    if (denials.length)
      emit({
        type: 'warning',
        message: `Claude Code denied tool calls outside the requested profile: ${[...new Set(denials)].join(', ')}.`,
      });
    const running = runningTasks();
    if (running.length) emit({ type: 'status', message: redactDiagnostic(`Waiting for background tasks: ${running.join('; ')}`, 512) });
  }
  function line(raw: string) {
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail('PROTOCOL_ERROR', 'Invalid Claude Code JSON record.');
    }
    const event = record(parsed);
    if (!event || typeof event.type !== 'string') fail('PROTOCOL_ERROR', 'Invalid Claude Code event.');
    if (event.type === 'system') acceptSystem(event);
    else if (event.type === 'assistant') acceptAssistant(event);
    else if (event.type === 'user') acceptUser(event);
    else if (event.type === 'stream_event') acceptStream(event);
    else if (event.type === 'result') acceptResult(event);
    else if (event.type === 'rate_limit_event') {
      const info = record(event.rate_limit_info);
      if (info?.status === 'rejected' && typeof info.resetsAt === 'number') rateLimitResetsAt = info.resetsAt;
    } else if (event.type === 'control_response') {
      // Acknowledges an interrupt; the turn still ends with its own `result`.
      const response = record(event.response);
      if (response?.subtype !== 'success') warnOnce('control_response', 'Claude Code rejected an interrupt request.');
    } else if (!KNOWN_TYPES.has(event.type)) warnOnce(event.type, `Ignoring unknown Claude Code event type '${event.type.slice(0, 64)}'.`);
  }
  function snapshot() {
    const text = answerParts.join('\n\n');
    const output = truncateToByteLength(text, reducer.maxTotalBytes);
    const truncated = output !== text || reducer.isTruncated();
    const error: ExecutionError | undefined = resultFields?.isError
      ? classifyClaudeFailure({
          category,
          apiErrorStatus: resultFields.apiErrorStatus,
          subtype: resultFields.subtype,
          errors: resultFields.errors,
          message: latestResultMessage,
          rateLimitResetsAt,
        })
      : truncated
        ? { code: 'BUFFER_LIMIT', message: 'Claude Code public output exceeded the byte budget.', retryable: false }
        : undefined;
    return {
      sessionId,
      initialized: sessionId !== null,
      model,
      terminal,
      usage,
      truncated,
      lengthLimited: stopReason === null ? undefined : stopReason === 'max_tokens',
      error,
      output: resultFields?.isError || !sessionId ? '' : output,
      hasAssistantMessage: reducer.getMessageMap().size > 0,
    };
  }
  /**
   * The latest public assistant text, marked as partial progress, for a turn that ended
   * without completing (#231, #245), together with any background tasks still running;
   * bounded by the public byte budget. Empty when there is neither text nor a running task.
   */
  function partialProgress(): string {
    const fallback = answerParts.join('\n\n');
    const latest = latestMessageId === null ? fallback : (reducer.getMessageMap().get(latestMessageId) ?? fallback);
    const text = latest.trim() ? latest : '';
    const running = runningTasks();
    if (!text && !running.length) return '';
    const header = running.length
      ? `${PARTIAL_PROGRESS_NOTICE}\nBackground tasks still running: ${running.join('; ')}.`
      : PARTIAL_PROGRESS_NOTICE;
    return truncateToByteLength(text ? `${header}\n\n${text}` : header, reducer.maxTotalBytes);
  }
  return {
    line,
    snapshot,
    partialProgress,
    isTerminal: () => terminal,
    /** Descriptions (or IDs) of the background tasks still running. */
    runningTasks,
  };
}
