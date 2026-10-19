/**
 * History snapshot schemas, capacity limits, and validation helpers.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '../../paths.js';
import { sanitizeHandle } from '../identity.js';
import { redactDiagnostic, redactCredentialFormats } from '../../security/index.js';
import type { AdapterEvent, ConversationEvent } from '../../contracts/index.js';
import { validEventIdentifier, PROVIDERS, ERROR_CODES } from '../../contracts/index.js';
import type { TokenUsage } from '../../contracts/index.js';

/** Maximum byte capacity for a single session's history log (10 MiB). */
export const SESSION_LIMIT = 10 * 1024 * 1024;

/** Global maximum storage capacity for all session history files combined (100 MiB). */
export const TOTAL_LIMIT = 100 * 1024 * 1024;

/**
 * Materialized history snapshot representing all validated conversation events for a session.
 */
export type History = {
  schemaVersion: 1;
  sessionHandle: string;
  workspace: string;
  updatedAt: string;
  revision: string;
  nextSequence: number;
  events: ConversationEvent[];
};

/** Internal structure for cached history snapshots in memory. */
export interface CachedHistorySnapshot {
  history: History;
  jsonMtimeMs: number;
  jsonSize: number;
  logMtimeMs: number;
  logSize: number;
}

/**
 * Returns the resolved directory path where session event logs and snapshots are persisted.
 */
export function getHistoryDir(): string {
  return path.join(getDataDir(), 'history');
}

/** Stats of a file, or null when it does not exist; other I/O errors propagate. */
export async function statIfExists(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    return await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Size of a file, or 0 when it does not exist. */
export async function sizeIfExists(file: string): Promise<number> {
  return (await statIfExists(file))?.size ?? 0;
}

/** Computes the JSON snapshot file path for a session handle. */
export function fileFor(handle: string): string {
  if (!sanitizeHandle(handle)) throw new Error('Invalid history handle.');
  return path.join(getHistoryDir(), `${handle}.json`);
}

/** Computes the JSONL append log file path for a session handle. */
export function logFileFor(handle: string): string {
  if (!sanitizeHandle(handle)) throw new Error('Invalid history handle.');
  return path.join(getHistoryDir(), `${handle}.jsonl`);
}

/** Validates that an incoming event conforms to the strict conversation event contract. */
export function validateEvent(event: AdapterEvent): void {
  if (event.nativeEventId != null && !validEventIdentifier(event.nativeEventId)) {
    throw new Error('Invalid native event identifier.');
  }
  switch (event.type) {
    case 'assistant_delta':
    case 'assistant_message':
      if (!validEventIdentifier(event.messageId)) throw new Error('Invalid message identifier.');
      if (typeof event.text !== 'string') throw new Error('Invalid public message.');
      break;
    case 'user_message':
      if (typeof event.text !== 'string') throw new Error('Invalid public message.');
      break;
    case 'tool_started':
    case 'tool_finished':
      if (!validEventIdentifier(event.toolId) || !validEventIdentifier(event.name)) throw new Error('Invalid tool metadata.');
      if (event.type === 'tool_finished' && typeof event.success !== 'boolean') throw new Error('Invalid tool result.');
      break;
    case 'status':
    case 'warning':
      if (typeof event.message !== 'string') throw new Error('Invalid status.');
      break;
    case 'error':
      if (!event.error || !ERROR_CODES.includes(event.error.code) || typeof event.error.message !== 'string' || typeof event.error.retryable !== 'boolean') {
        throw new Error('Invalid public error.');
      }
      break;
    case 'turn_finished':
      if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(event.status)) throw new Error('Invalid terminal status.');
      if (event.usage !== undefined && !validUsage(event.usage)) throw new Error('Invalid token usage.');
      break;
    case 'turn_started':
      break;
    default:
      throw new Error('Invalid public event type.');
  }
}

const USAGE_COUNTS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;

/** Whether a value is a {@link TokenUsage} with only known non-negative integer counts. */
function validUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (usage.source !== 'provider') return false;
  return Object.keys(usage).every(key => key === 'source' || ((USAGE_COUNTS as readonly string[]).includes(key) && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0));
}

/** Redacts sensitive content from an adapter event before persisting to history. */
export function sanitize(event: AdapterEvent): AdapterEvent {
  const native = event.nativeEventId ? { nativeEventId: event.nativeEventId } : {};
  switch (event.type) {
    case 'assistant_delta':
    case 'assistant_message':
      return { type: event.type, messageId: event.messageId, text: redactCredentialFormats(event.text), ...native };
    case 'user_message':
      return { type: event.type, text: redactCredentialFormats(event.text), ...native };
    case 'warning':
    case 'status':
      return { type: event.type, message: redactDiagnostic(event.message), ...native };
    case 'error':
      return { type: event.type, error: { code: event.error.code, retryable: event.error.retryable, message: redactDiagnostic(event.error.message) }, ...native };
    case 'tool_started':
      return { type: event.type, toolId: event.toolId, name: redactDiagnostic(event.name, 128), ...native };
    case 'tool_finished':
      return { type: event.type, toolId: event.toolId, name: redactDiagnostic(event.name, 128), success: event.success, ...native };
    case 'turn_started':
      return { type: event.type };
    case 'turn_finished':
      return { type: event.type, status: event.status, ...(event.usage && validUsage(event.usage) ? { usage: { ...event.usage } } : {}) };
  }
}

/** Deep clones a single conversation event. */
export function cloneEvent(e: ConversationEvent): ConversationEvent {
  if (e.type === 'error') return { ...e, error: { ...e.error } };
  return { ...e };
}

/** Deep clones a full materialized history snapshot. */
export function cloneHistory(h: History): History {
  return {
    schemaVersion: h.schemaVersion,
    sessionHandle: h.sessionHandle,
    workspace: h.workspace,
    updatedAt: h.updatedAt,
    revision: h.revision,
    nextSequence: h.nextSequence,
    events: h.events.map(cloneEvent),
  };
}

