/**
 * Shared conversation events, status, and payload contracts.
 *
 * @packageDocumentation
 */

import type { ProviderId } from './provider.js';
import type { ExecutionError } from './error.js';

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
  | { type: 'turn_finished'; status: TerminalStatus };

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

