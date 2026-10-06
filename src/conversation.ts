export const PROVIDERS = ['codex', 'gemini', 'claude'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type RoutingTarget = ProviderId | 'auto' | 'smart_quota';
export type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out';
export const ERROR_CODES = ['CLI_NOT_FOUND', 'CLI_UNSUPPORTED', 'AUTH_REQUIRED', 'MODEL_UNAVAILABLE',
  'RATE_LIMITED', 'SESSION_INVALID', 'SESSION_BUSY', 'ABORTED', 'TIMEOUT', 'SANDBOX_UNAVAILABLE',
  'PROTOCOL_ERROR', 'BUFFER_LIMIT', 'INPUT_LIMIT', 'PROCESS_ERROR', 'HISTORY_ERROR', 'POLICY_DENIED'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface ExecutionError { code: ErrorCode; message: string; retryable: boolean }
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
  schemaVersion: 1; eventId: string; sequence: number; timestamp: string;
  sessionHandle: string; turnId: string; provider: ProviderId; nativeEventId?: string;
};
/** Adapters emit public payloads; the pipeline owns IDs, ordering and persistence. */
export type AdapterEvent = ConversationPayload & { nativeEventId?: string };
export const EVENT_METADATA_BYTES = 256;
export function validEventIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= EVENT_METADATA_BYTES && !/[\x00-\x1f\x7f]/.test(value);
}
