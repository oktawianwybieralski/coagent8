/**
 * Conversation history snapshot reading, LRU caching, and crash recovery.
 *
 * @remarks
 * Reads consolidated `.json` snapshots or replays append-only `.jsonl` deltas.
 * Recovers from ungraceful process crashes by ignoring torn trailing lines,
 * and maintains an in-memory snapshot cache bounded to 64 entries.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock } from '../../storage/lock.js';
import { readBoundedFile } from '../../storage/read.js';
import { canonicalPath } from '../../workspace/identity.js';
import type { ConversationEvent } from '../../contracts/index.js';
import { validEventIdentifier, PROVIDERS } from '../../contracts/index.js';
import type { History, CachedHistorySnapshot } from './types.js';
import {
  SESSION_LIMIT,
  getHistoryDir,
  fileFor,
  logFileFor,
  statIfExists,
  sizeIfExists,
  validateEvent,
  cloneHistory,
} from './types.js';
import { paginateHistory } from './page.js';
import { setHistoryEvictionCallback, readCapacityMeta, writeCapacityMeta } from './retention.js';

const historyCache = new Map<string, CachedHistorySnapshot>();
const MAX_HISTORY_CACHE_ENTRIES = 64;

// Connect retention eviction to history cache invalidation
setHistoryEvictionCallback(invalidateHistoryCache);

/**
 * Clears the in-memory history snapshot cache.
 * Useful for tests or state resets.
 */
export function clearHistoryCache(): void {
  historyCache.clear();
}

/**
 * Invalidates the in-memory history snapshot cache for a specific session handle.
 *
 * @param handle - Session handle to invalidate.
 */
export function invalidateHistoryCache(handle: string): void {
  historyCache.delete(handle);
}

/**
 * Low-level history loader with automatic cache management and crash recovery.
 *
 * @param handle - Valid session handle.
 * @param forceLog - If true, bypasses the JSON snapshot and replays the JSONL log directly.
 * @returns History snapshot or null if no record exists.
 */
export async function load(handle: string, forceLog = false): Promise<History | null> {
  const jsonFile = fileFor(handle);
  const logFile = logFileFor(handle);

  let jsonStat: { mtimeMs: number; size: number } | null = null;
  let logStat: { mtimeMs: number; size: number } | null = null;
  jsonStat = await statIfExists(jsonFile);
  logStat = await statIfExists(logFile);

  if (!jsonStat && !logStat) {
    historyCache.delete(handle);
    return null;
  }

  const currentJsonMtime = jsonStat?.mtimeMs ?? 0;
  const currentJsonSize = jsonStat?.size ?? 0;
  const currentLogMtime = logStat?.mtimeMs ?? 0;
  const currentLogSize = logStat?.size ?? 0;

  if (!forceLog) {
    const cached = historyCache.get(handle);
    if (
      cached &&
      cached.jsonMtimeMs === currentJsonMtime &&
      cached.jsonSize === currentJsonSize &&
      cached.logMtimeMs === currentLogMtime &&
      cached.logSize === currentLogSize
    ) {
      historyCache.delete(handle);
      historyCache.set(handle, cached);
      return cloneHistory(cached.history);
    }
  }

  // Prefer jsonFile only if no logFile exists or jsonFile was updated at or after logFile
  if (!forceLog && jsonStat && (!logStat || jsonStat.mtimeMs >= logStat.mtimeMs)) {
    try {
      const raw = await readBoundedFile(jsonFile, SESSION_LIMIT);
      const h = JSON.parse(raw) as History;
      if (h.revision == null) h.revision = createHash('sha256').update(raw).digest('hex');
      if (!validEventIdentifier(h.revision)) throw new Error('Invalid history revision.');
      if (h.schemaVersion !== 1 || h.sessionHandle !== handle || typeof h.workspace !== 'string' || !Number.isSafeInteger(h.nextSequence) || !Array.isArray(h.events) || !Number.isFinite(Date.parse(h.updatedAt))) throw new Error('Invalid history schema.');
      let seq = 0;
      for (const e of h.events) {
        if (e.schemaVersion !== 1 || e.sessionHandle !== handle || !Number.isSafeInteger(e.sequence) || e.sequence <= seq || typeof e.eventId !== 'string' || typeof e.turnId !== 'string' || !Number.isFinite(Date.parse(e.timestamp))) throw new Error('Invalid history event.');
        seq = e.sequence;
        validateEvent(e);
        if (Buffer.byteLength(JSON.stringify(e.type === 'assistant_message' || e.type === 'assistant_delta' || e.type === 'user_message' ? { ...e, text: '' } : e)) > 8192) throw new Error('History event metadata exceeds storage limit.');
        if (!validEventIdentifier(e.eventId) || !validEventIdentifier(e.turnId) || !PROVIDERS.includes(e.provider)) throw new Error('Invalid history event metadata.');
      }
      if (h.nextSequence <= seq) throw new Error('Invalid history sequence counter.');

      historyCache.delete(handle);
      if (historyCache.size >= MAX_HISTORY_CACHE_ENTRIES) {
        const oldest = historyCache.keys().next().value;
        if (oldest) historyCache.delete(oldest);
      }
      historyCache.set(handle, {
        history: cloneHistory(h),
        jsonMtimeMs: currentJsonMtime,
        jsonSize: currentJsonSize,
        logMtimeMs: currentLogMtime,
        logSize: currentLogSize,
      });
      return cloneHistory(h);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // Load from append-only logFile (.jsonl)
  if (logStat) {
    try {
      const raw = await readBoundedFile(logFile, SESSION_LIMIT);
      let schemaVersion: 1 = 1;
      let sessionHandle = handle;
      let workspace = '';
      let updatedAt = new Date(logStat.mtimeMs).toISOString();
      let nextSequence = 1;
      const events: ConversationEvent[] = [];

      let lineStart = 0;
      while (lineStart < raw.length) {
        const nextNl = raw.indexOf('\n', lineStart);
        const lineEnd = nextNl === -1 ? raw.length : nextNl;
        const line = raw.slice(lineStart, lineEnd).trim();
        lineStart = nextNl === -1 ? raw.length : nextNl + 1;
        if (!line) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (parseErr) {
          // If the last non-empty line was truncated/incomplete (e.g. abrupt process crash), ignore it
          if (lineStart >= raw.length || raw.slice(lineStart).trim().length === 0) {
            break;
          }
          throw parseErr;
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid history record.');
        const item = parsed as Record<string, unknown>;
        if (item._type === 'header') {
          if (item.schemaVersion === 1) schemaVersion = 1;
          if (typeof item.workspace === 'string') workspace = item.workspace;
          if (typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))) updatedAt = item.updatedAt;
          if (typeof item.nextSequence === 'number' && Number.isSafeInteger(item.nextSequence)) nextSequence = item.nextSequence;
        } else {
          const e = item as unknown as ConversationEvent;
          validateEvent(e);
          if (e.schemaVersion !== 1 || e.sessionHandle !== handle || !Number.isSafeInteger(e.sequence) || typeof e.eventId !== 'string' || typeof e.turnId !== 'string' || !Number.isFinite(Date.parse(e.timestamp))) throw new Error('Invalid history event.');
          if (Buffer.byteLength(JSON.stringify(e.type === 'assistant_message' || e.type === 'assistant_delta' || e.type === 'user_message' ? { ...e, text: '' } : e)) > 8192) throw new Error('History event metadata exceeds storage limit.');
          if (!validEventIdentifier(e.eventId) || !validEventIdentifier(e.turnId) || !PROVIDERS.includes(e.provider)) throw new Error('Invalid history event metadata.');

          if (e.type === 'assistant_delta') {
            const idx = events.findIndex(x => x.turnId === e.turnId && x.type === 'assistant_message' && x.messageId === e.messageId);
            if (idx >= 0) {
              (events[idx] as { text: string }).text += e.text;
            } else {
              events.push({
                ...e,
                type: 'assistant_message',
              });
            }
          } else if (e.type === 'assistant_message') {
            const idx = events.findIndex(x => x.turnId === e.turnId && x.type === 'assistant_message' && x.messageId === e.messageId);
            if (idx >= 0) {
              events[idx] = { ...e, sequence: events[idx].sequence };
            } else {
              events.push(e);
            }
          } else if (e.type === 'turn_finished') {
            const idx = events.findIndex(x => x.turnId === e.turnId && x.type === 'turn_finished');
            if (idx >= 0) {
              events[idx] = { ...e, sequence: events[idx].sequence };
            } else {
              events.push(e);
            }
          } else {
            events.push(e);
          }
          if (e.sequence >= nextSequence) nextSequence = e.sequence + 1;
          updatedAt = e.timestamp;
        }
      }

      const revision = createHash('sha256').update(raw).digest('hex');
      const h: History = { schemaVersion, sessionHandle, workspace, updatedAt, revision, nextSequence, events };
      if (!forceLog) {
        historyCache.delete(handle);
        if (historyCache.size >= MAX_HISTORY_CACHE_ENTRIES) {
          const oldest = historyCache.keys().next().value;
          if (oldest) historyCache.delete(oldest);
        }
        historyCache.set(handle, {
          history: cloneHistory(h),
          jsonMtimeMs: currentJsonMtime,
          jsonSize: currentJsonSize,
          logMtimeMs: currentLogMtime,
          logSize: currentLogSize,
        });
      }
      return cloneHistory(h);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  return null;
}

/**
 * Loads the complete conversation history for a given session handle.
 * Reads the latest valid `.jsonl` or `.json` event snapshot.
 *
 * @param handle - Validated session handle string (e.g. `syn_sess_abc123`).
 * @returns History snapshot, or null if no history exists or cannot be read.
 */
export async function getHistory(handle: string): Promise<History | null> {
  return await load(handle);
}

/**
 * Paginates through conversation history events for a given session handle.
 *
 * @param handle - Session handle to paginate.
 * @param workspace - Calling workspace path for ownership enforcement.
 * @param cursor - Optional opaque continuation cursor from a previous page.
 * @param limit - Page size limit (1..100, default 50).
 * @returns Page object containing schemaVersion, sessionHandle, revision, events array, and nextCursor.
 */
export async function sessionHistory(handle: string, workspace: string, cursor?: string, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('History limit must be 1..100.');
  const h = await load(handle);
  if (!h || h.workspace !== canonicalPath(workspace)) throw new Error('History not found in this workspace.');
  return paginateHistory(h, handle, cursor, limit);
}

/**
 * Permanently removes all history records (.jsonl log and .json snapshot) for a session,
 * reclaiming storage bytes under directory file lock.
 *
 * @param handle - Session handle to delete.
 * @param workspace - Calling workspace path for verification.
 */
export async function deleteHistory(handle: string, workspace: string): Promise<void> {
  if (process.env.coagent8_HISTORY === 'off') return;
  const dir = getHistoryDir();
  const sessionLockFile = path.join(dir, `${handle}.lock`);
  await withFileLock(sessionLockFile, async () => {
    const h = await load(handle);
    if (h && h.workspace !== canonicalPath(workspace)) throw new Error('History workspace mismatch.');
    const jsonFile = fileFor(handle);
    const logFile = logFileFor(handle);

    const removedBytes = await sizeIfExists(jsonFile) + await sizeIfExists(logFile);

    await fs.rm(jsonFile, { force: true });
    await fs.rm(logFile, { force: true });
    historyCache.delete(handle);

    if (removedBytes > 0) {
      const capLockFile = path.join(dir, '.capacity.lock');
      await withFileLock(capLockFile, async () => {
        const metaFile = path.join(dir, '.capacity.meta');
        let currentTotal = await readCapacityMeta(metaFile);
        if (currentTotal != null) {
          await writeCapacityMeta(metaFile, Math.max(0, currentTotal - removedBytes));
        }
      });
    }
  });
}

/**
 * Builds a mapping of turnId UUIDs to 1-based chronological turn sequence numbers.
 *
 * @param handle - Session handle to inspect.
 * @param workspace - Calling workspace path.
 * @returns Map from turnId string to 1-based turn number.
 */
export async function getTurnMapping(handle: string, workspace: string): Promise<Map<string, number>> {
  const h = await load(handle);
  const map = new Map<string, number>();
  if (!h || h.workspace !== canonicalPath(workspace)) return map;
  let turn = 0;
  for (const e of h.events) {
    if (!map.has(e.turnId)) {
      turn++;
      map.set(e.turnId, turn);
    }
  }
  return map;
}

