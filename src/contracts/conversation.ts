/**
 * Shared conversation events, status, and payload contracts.
 *
 * @packageDocumentation
 */

import type { ProviderId } from './provider.js';
import type { ExecutionError } from './error.js';

/**
 * Tokens one turn used, as the backend reported them (`AX-001a`).
 * @remarks An absent field is unknown, never zero. `inputTokens` counts every input token
 * the model processed, cached ones included; `cachedInputTokens` and
 * `cacheWriteInputTokens` are the parts read from and written to the prompt cache, and
 * `cacheWriteLongInputTokens` the part of the writes kept for an hour instead of minutes.
 * `outputTokens` counts every output token, reasoning included; `reasoningTokens` is the
 * reasoning part. These are counts, not billing: a subscription CLI may charge nothing per
 * token, and a list-price equivalent is a separate calculation.
 */
export interface TokenUsage {
  source: 'provider';
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWriteLongInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';

export type ConversationPayload =
  | { type: 'turn_started' }
  | { type: 'user_message'; text: string }
  | { type: 'assistant_delta'; messageId: string; text: string }
  | { type: 'assistant_message'; messageId: string; text: string }
  | { type: 'tool_started'; toolId: string; name: string }
  | { type: 'tool_finished'; toolId: string; name: string; success: boolean }
  | { type: 'status'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: ExecutionError }
  /** `usage` is optional: older histories and backends without counts have none (AX-001f). */
  | { type: 'turn_finished'; status: TerminalStatus; usage?: TokenUsage };

export type ConversationEvent = ConversationPayload & {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  timestamp: string;
  sessionHandle: string;
  turnId: string;
  provider: ProviderId;
  nativeEventId?: string;
};

/** Adapters emit public payloads; the pipeline owns IDs, ordering and persistence. */
export type AdapterEvent = ConversationPayload & { nativeEventId?: string };

const EVENT_METADATA_BYTES = 256;

export function validEventIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= EVENT_METADATA_BYTES && !/[\x00-\x1f\x7f]/.test(value);
}

