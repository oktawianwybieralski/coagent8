/** Bounded Gemini public-event parsing, independent of process launch. @packageDocumentation */
import { BufferLimitError, StreamReducer } from '../execution/stream.js';
import { redactDiagnostic } from '../redaction.js';
import { validEventIdentifier } from '../types/conversation.types.js';
import type { AdapterEvent, ExecutionError, TerminalExecutionResult } from '../types/adapter.types.js';
import { extractStructuredGeminiError } from './gemini-errors.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Collects supported native event dialects into one bounded public result.
 * @param onEvent - Optional public-event callback; private thought/tool operands are omitted.
 * @returns Line collector, independent denial evidence, and terminal snapshot.
 * @throws On malformed public metadata, duplicate terminals or byte/count overflow.
 * @remarks Process execution owns line decoding and cleanup. stderr denial never
 * creates a terminal event. stdout alone establishes native terminal identity.
 */
export function createGeminiCollector(onEvent?: (event: AdapterEvent) => void) {
  let nativeSessionId: string | null = null;
  let model: string | undefined;
  let terminal = false;
  let terminalError: ExecutionError | undefined;
  let sandboxDenied = false;
  const reducer = new StreamReducer({ maxTotalBytes: 512 * 1024, maxMessageBytes: 256 * 1024, maxLineBuffer: 64 * 1024, maxTools: 50, maxMessages: 50 });
  const seen = new Set<string>();
  let messageId = 'assistant-1';
  let messageNumber = 1;
  let usage: TerminalExecutionResult['usage'];

  function checkMetadata(key: string, val: unknown) {
    if (val != null && !validEventIdentifier(val)) {
      throw new Error(`Invalid Gemini ${key} metadata.`);
    }
  }

  function line(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) {
      if (/^warning:\s*conversation.*not found/i.test(trimmed)) {
        onEvent?.({ type: 'warning', message: redactDiagnostic(trimmed) });
        return;
      }
      if (/^jetski:/i.test(trimmed)) {
        onEvent?.({ type: 'warning', message: redactDiagnostic(trimmed) });
        return;
      }
      return;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid Gemini event.');
    }
    const e = parsed as Record<string, unknown>;

    for (const key of ['event_id', 'message_id', 'tool_id', 'tool_name', 'model', 'conversation_id']) {
      checkMetadata(key, e[key]);
    }

    if (typeof e.event_id === 'string') {
      if (seen.has(e.event_id)) return;
      if (seen.size >= 10000) throw new BufferLimitError('Too many native events.');
      seen.add(e.event_id);
    }

    const eventType = (e.event || e.type) as string | undefined;
    if (typeof eventType !== 'string' && typeof e.conversation_id !== 'string') {
      throw new Error('Gemini event has no type.');
    }

    // 1. Single-turn JSON payload (from agy --output-format json)
    if (!eventType && typeof e.conversation_id === 'string') {
      if (terminal) throw new Error('Invalid or duplicate Gemini terminal result.');
      terminal = true;
      if (UUID.test(e.conversation_id)) nativeSessionId = e.conversation_id;
      const statusStr = String(e.status || '').toLowerCase();
      if (!['success', 'error'].includes(statusStr)) throw new Error('Invalid or duplicate Gemini terminal result.');
      if (statusStr === 'error') {
        terminalError ||= extractStructuredGeminiError(e.error, typeof e.message === 'string' ? e.message : undefined);
      }
      if (Array.isArray(e.denied_actions) && e.denied_actions.length > 0) {
        sandboxDenied = true;
      }
      if (typeof e.response === 'string' && e.response) {
        reducer.setFinalAnswer(e.response);
        onEvent?.({ type: 'assistant_message', messageId: 'final', text: e.response });
      }
      if (e.usage && typeof e.usage === 'object') {
        const u = e.usage as Record<string, unknown>;
        usage = { source: 'provider' };
        if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
        if (typeof u.total_tokens === 'number') usage.totalTokens = u.total_tokens;
      }
      return;
    }

    // 2. Init event
    if (eventType === 'init') {
      const sid = (e.conversation_id || e.session_id) as string | undefined;
      if (typeof sid !== 'string' || !UUID.test(sid)) throw new Error('Invalid Gemini init metadata.');
      if (e.model != null && typeof e.model !== 'string') throw new Error('Invalid Gemini init metadata.');
      if (nativeSessionId && nativeSessionId !== sid) throw new Error('Gemini changed session within a turn.');
      nativeSessionId = sid;
      if (typeof e.model === 'string') model = e.model;
      return;
    }

    // 3. Step update event (agy stream-json)
    if (eventType === 'step_update') {
      const u = e.step_update as Record<string, unknown> | undefined;
      if (!u || typeof u !== 'object') throw new Error('Invalid Gemini step_update.');
      for (const key of ['conversation_id', 'tool_name']) checkMetadata(key, u[key]);

      if (u.step_type === 'user_input' || u.step_type === 'system_message') return;

      if (u.step_type === 'agent_response') {
        if (typeof u.text_delta === 'string') {
          const key = `msg-${u.step_index ?? messageNumber}`;
          if (reducer.getTotalBytes() + Buffer.byteLength(u.text_delta) > reducer.maxTotalBytes) {
            throw new BufferLimitError('Public answer exceeds budget.');
          }
          reducer.upsertMessage(key, u.text_delta, { delta: true });
          if (reducer.getTotalBytes() > reducer.maxTotalBytes) throw new BufferLimitError('Public answer exceeds budget.');
          onEvent?.({ type: 'assistant_delta', messageId: key, text: u.text_delta });
        }
        if (u.usage && typeof u.usage === 'object') {
          const rawU = u.usage as Record<string, unknown>;
          usage = { source: 'provider' };
          if (typeof rawU.input_tokens === 'number') usage.inputTokens = rawU.input_tokens;
          if (typeof rawU.output_tokens === 'number') usage.outputTokens = rawU.output_tokens;
          if (typeof rawU.total_tokens === 'number') usage.totalTokens = rawU.total_tokens;
        }
        return;
      }

      if (u.step_type === 'tool') {
        const toolId = `tool-${u.step_index ?? reducer.getActiveTools().size + 1}`;
        const toolName = String(u.tool_name || (u.tool_info as Record<string, unknown>)?.name || 'tool');
        if (!validEventIdentifier(toolId) || !validEventIdentifier(toolName)) throw new Error('Invalid Gemini tool metadata.');

        if (u.state === 'ACTIVE') {
          if (reducer.recordTool(toolId, toolName, 'active')) {
            onEvent?.({ type: 'tool_started', toolId, name: toolName });
          }
        } else if (u.state === 'DONE' || u.state === 'ERROR') {
          if (reducer.recordTool(toolId, toolName, u.state === 'DONE' ? 'done' : 'error')) {
            onEvent?.({ type: 'tool_finished', toolId, name: toolName, success: u.state === 'DONE' });
          }
        }
        return;
      }
      return;
    }

    // 4. Message event (legacy protocol)
    if (eventType === 'message') {
      if (e.role !== 'assistant') return;
      for (const key of ['thought', 'reasoning']) {
        if (e[key] != null && typeof e[key] !== 'boolean') throw new Error('Invalid Gemini thought metadata.');
      }
      if (e.thought === true || e.reasoning === true) return;
      if (typeof e.content !== 'string' || (e.delta != null && typeof e.delta !== 'boolean')) {
        throw new Error('Invalid Gemini public message.');
      }
      if (Buffer.byteLength(e.content) > reducer.maxMessageBytes) throw new BufferLimitError('Public message exceeds limit.');
      const key = typeof e.message_id === 'string' ? e.message_id : messageId;
      if (!reducer.getMessageMap().has(key) && reducer.getMessageMap().size >= reducer.maxMessages) {
        throw new BufferLimitError('Too many public messages.');
      }
      reducer.upsertMessage(key, e.content, { delta: e.delta === true });
      if (reducer.getTotalBytes() > reducer.maxTotalBytes) throw new BufferLimitError('Public answer exceeds budget.');
      if (reducer.getMessageMap().size > reducer.maxMessages) throw new BufferLimitError('Too many public messages.');
      onEvent?.({ type: e.delta === true ? 'assistant_delta' : 'assistant_message', messageId: key, text: e.content });
      return;
    }

    // 5. Tool events (legacy protocol)
    if (eventType === 'tool_use') {
      if (typeof e.tool_id !== 'string' || typeof e.tool_name !== 'string') throw new Error('Invalid Gemini tool event.');
      const activeTools = reducer.getActiveTools();
      if (activeTools.has(e.tool_id)) {
        if (activeTools.get(e.tool_id) !== e.tool_name) throw new Error('Gemini reused a tool identifier.');
        return;
      }
      if (activeTools.size >= 10000) throw new BufferLimitError('Too many tools.');
      reducer.recordTool(e.tool_id, e.tool_name, 'active');
      onEvent?.({ type: 'tool_started', toolId: e.tool_id, name: e.tool_name });
      messageId = `assistant-${++messageNumber}`;
      return;
    }
    if (eventType === 'tool_result') {
      const activeTools = reducer.getActiveTools();
      if (typeof e.tool_id !== 'string' || !activeTools.has(e.tool_id) || !['success', 'error'].includes(String(e.status))) {
        throw new Error('Invalid Gemini tool result.');
      }
      if (reducer.getFinishedTools().has(e.tool_id)) return;
      reducer.recordTool(e.tool_id, activeTools.get(e.tool_id)!, e.status === 'success' ? 'done' : 'error');
      onEvent?.({ type: 'tool_finished', toolId: e.tool_id, name: activeTools.get(e.tool_id)!, success: e.status === 'success' });
      return;
    }

    // 6. Error event
    if (eventType === 'error') {
      const detail = typeof e.message === 'string' ? e.message : JSON.stringify(e.error || 'Gemini error');
      if (e.severity === 'warning') {
        onEvent?.({ type: 'warning', message: redactDiagnostic(detail) });
      } else {
        terminalError = extractStructuredGeminiError(e.error, typeof e.message === 'string' ? e.message : undefined);
        onEvent?.({ type: 'error', error: terminalError });
      }
      return;
    }

    // 7. Result event (both agy stream-json and legacy)
    if (eventType === 'result') {
      if (terminal) throw new Error('Invalid or duplicate Gemini terminal result.');
      terminal = true;
      const resObj = (e.result && typeof e.result === 'object') ? (e.result as Record<string, unknown>) : e;
      const statusStr = String(resObj.status || '').toLowerCase();
      if (!['success', 'error'].includes(statusStr)) throw new Error('Invalid or duplicate Gemini terminal result.');

      if (typeof resObj.conversation_id === 'string' && UUID.test(resObj.conversation_id)) {
        nativeSessionId ||= resObj.conversation_id;
      }

      if (statusStr === 'error') {
        terminalError ||= extractStructuredGeminiError(resObj.error, typeof resObj.message === 'string' ? resObj.message : undefined);
      }

      if (Array.isArray(resObj.denied_actions) && resObj.denied_actions.length > 0) {
        sandboxDenied = true;
      }

      if (typeof resObj.response === 'string' && resObj.response) {
        const hadMessages = reducer.getMessages().some(m => m.trim().length > 0);
        reducer.setFinalAnswer(resObj.response);
        if (!hadMessages) {
          onEvent?.({ type: 'assistant_message', messageId: 'final', text: resObj.response });
        }
      }

      const rawStats = (resObj.usage || resObj.stats) as Record<string, unknown> | undefined;
      if (rawStats && typeof rawStats === 'object') {
        usage = { source: 'provider' };
        if (typeof rawStats.input_tokens === 'number') usage.inputTokens = rawStats.input_tokens;
        if (typeof rawStats.output_tokens === 'number') usage.outputTokens = rawStats.output_tokens;
        if (typeof rawStats.total_tokens === 'number') usage.totalTokens = rawStats.total_tokens;
      }
      return;
    }

    if (eventType === 'thought' || eventType === 'reasoning') return;
    throw new Error(`Unsupported Gemini event type: ${String(eventType).slice(0, 80)}`);
  }

  function snapshot() {
    return {
      output: reducer.getFormattedOutput(),
      nativeSessionId,
      model,
      terminal,
      terminalError,
      sandboxDenied,
      usage,
      truncated: reducer.isTruncated(),
    };
  }

  return { line, snapshot, denySandbox() { sandboxDenied = true; } };
}
