/**
 * High-integrity append-only event store and history pagination service.
 *
 * @remarks
 * ## Architecture & Concurrency Contract
 * - **Append-Only Streaming**: Streaming assistant deltas append directly to a `.jsonl` log file
 *   without rewriting snapshots per delta. Serialization/copying scales with batch bytes; recovery and storage accounting can read history.
 * - **Monolithic Snapshots**: Materialized `.json` snapshots are written atomically via temporary
 *   files only when a message completes or the turn finishes (`turn_finished`).
 * - **Crash Resilience & Torn-Tail Repair**: Abrupt process terminations mid-write may leave an
 *   unterminated or invalid trailing line. Under file lock, `createHistoryWriter` detects torn tails,
 *   verifies workspace ownership, and executes an in-place `fs.truncate` to the last valid byte offset.
 * - **Deterministic Pagination & Cursors**: The `sessionHistory` pagination API returns at most
 *   100 events / 240 KiB per page. Cursors are opaque base64url-encoded structures bound to an exact
 *   SHA-256 snapshot revision. If concurrent writes alter history during pagination, `HISTORY_CHANGED`
 *   is raised to prevent consuming inconsistent event streams.
 * - **UTF-8 Fragment Streaming**: Messages larger than the available page budget are safely split
 *   across page boundaries without splitting multi-byte UTF-8 code points, carrying explicit
 *   `{ offsetBytes, totalBytes, complete }` descriptors.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { paginateHistory } from './history-page.js';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { withFileLock, atomicWrite } from './lock.js';
import { getDataDir } from '../paths.js';
import { canonicalPath, sanitizeHandle } from './identity.js';
import { redactDiagnostic, redactSecrets } from '../redaction.js';
import { truncateToByteLength, readBoundedFile } from '../execution/stream.js';
import type { AdapterEvent, ConversationEvent, ProviderId } from '../types/conversation.types.js';
import { validEventIdentifier, PROVIDERS, ERROR_CODES } from '../types/conversation.types.js';

/** Maximum byte capacity for a single session's history log (10 MiB). */
const SESSION_LIMIT = 10 * 1024 * 1024;
/** Global maximum storage capacity for all session history files combined (100 MiB). */
const TOTAL_LIMIT = 100 * 1024 * 1024;

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

/**
 * Returns the resolved directory path where session event logs and snapshots are persisted.
 */
export function getHistoryDir(): string { return path.join(getDataDir(), 'history'); }
function fileFor(handle: string): string { if (!sanitizeHandle(handle)) throw new Error('Invalid history handle.'); return path.join(getHistoryDir(), `${handle}.json`); }
function logFileFor(handle: string): string { if (!sanitizeHandle(handle)) throw new Error('Invalid history handle.'); return path.join(getHistoryDir(), `${handle}.jsonl`); }

function validateEvent(event: AdapterEvent) {
  if (event.nativeEventId != null && !validEventIdentifier(event.nativeEventId)) throw new Error('Invalid native event identifier.');
  switch (event.type) {
    case 'assistant_delta': case 'assistant_message':
      if (!validEventIdentifier(event.messageId)) throw new Error('Invalid message identifier.');
      if (typeof event.text !== 'string') throw new Error('Invalid public message.'); break;
    case 'user_message': if (typeof event.text !== 'string') throw new Error('Invalid public message.'); break;
    case 'tool_started': case 'tool_finished':
      if (!validEventIdentifier(event.toolId) || !validEventIdentifier(event.name)) throw new Error('Invalid tool metadata.');
      if (event.type === 'tool_finished' && typeof event.success !== 'boolean') throw new Error('Invalid tool result.'); break;
    case 'status': case 'warning': if (typeof event.message !== 'string') throw new Error('Invalid status.'); break;
    case 'error': if (!event.error || !ERROR_CODES.includes(event.error.code) || typeof event.error.message !== 'string' || typeof event.error.retryable !== 'boolean') throw new Error('Invalid public error.'); break;
    case 'turn_finished': if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(event.status)) throw new Error('Invalid terminal status.'); break;
    case 'turn_started': break;
    default: throw new Error('Invalid public event type.');
  }
}

function sanitize(event: AdapterEvent): AdapterEvent {
  const native = event.nativeEventId ? { nativeEventId: event.nativeEventId } : {};
  switch (event.type) {
    case 'assistant_delta': case 'assistant_message': return { type: event.type, messageId: event.messageId, text: redactSecrets(event.text), ...native };
    case 'user_message': return { type: event.type, text: redactSecrets(event.text), ...native };
    case 'warning': case 'status': return { type: event.type, message: redactDiagnostic(event.message), ...native };
    case 'error': return { type: event.type, error: { code: event.error.code, retryable: event.error.retryable, message: redactDiagnostic(event.error.message) }, ...native };
    case 'tool_started': return { type: event.type, toolId: event.toolId, name: redactDiagnostic(event.name, 128), ...native };
    case 'tool_finished': return { type: event.type, toolId: event.toolId, name: redactDiagnostic(event.name, 128), success: event.success, ...native };
    case 'turn_started': return { type: event.type };
    case 'turn_finished': return { type: event.type, status: event.status };
  }
}

interface CachedHistorySnapshot {
  history: History;
  jsonMtimeMs: number;
  jsonSize: number;
  logMtimeMs: number;
  logSize: number;
}

const historyCache = new Map<string, CachedHistorySnapshot>();
const MAX_HISTORY_CACHE_ENTRIES = 64;

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

function cloneEvent(e: ConversationEvent): ConversationEvent {
  if (e.type === 'error') return { ...e, error: { ...e.error } };
  return { ...e };
}

function cloneHistory(h: History): History {
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

async function load(handle: string, forceLog = false): Promise<History | null> {
  const jsonFile = fileFor(handle);
  const logFile = logFileFor(handle);

  let jsonStat: { mtimeMs: number; size: number } | null = null;
  let logStat: { mtimeMs: number; size: number } | null = null;
  try { jsonStat = await fs.stat(jsonFile); } catch {}
  try { logStat = await fs.stat(logFile); } catch {}

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
        if (Buffer.byteLength(JSON.stringify(e.type === 'assistant_message' || e.type === 'user_message' ? { ...e, text: '' } : e)) > 8192) throw new Error('History event metadata exceeds storage limit.');
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
          if (Buffer.byteLength(JSON.stringify(e.type === 'assistant_message' || e.type === 'user_message' ? { ...e, text: '' } : e)) > 8192) throw new Error('History event metadata exceeds storage limit.');
          if (!validEventIdentifier(e.eventId) || !validEventIdentifier(e.turnId) || !PROVIDERS.includes(e.provider)) throw new Error('Invalid history event metadata.');

          if (e.type === 'assistant_message') {
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

async function calculateDirectoryBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if ((!name.endsWith('.json') && !name.endsWith('.jsonl')) || !sanitizeHandle(name.replace(/\.jsonl?$/, ''))) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        total += stat.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return total;
}

async function pruneHistoryDirectoryInternal(dir: string, extraBytes = 0): Promise<number> {
  const metaFile = path.join(dir, '.capacity.meta');
  await fs.rm(metaFile, { force: true });
  let total = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if ((!name.endsWith('.json') && !name.endsWith('.jsonl')) || !sanitizeHandle(name.replace(/\.jsonl?$/, ''))) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs > 7 * 24 * 3600 * 1000) {
          try {
            await fs.rm(file, { force: true });
          } catch {
            total += stat.size;
          }
        } else {
          total += stat.size;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== 'ENOENT') throw statErr;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await atomicWrite(metaFile, JSON.stringify({ totalBytes: total }));
  } catch {
    await fs.rm(metaFile, { force: true }).catch(() => {});
  }
  if (total + extraBytes > TOTAL_LIMIT) {
    throw new Error('History total limit reached.');
  }
  return total;
}

/**
 * Sweeps the history directory, removing sessions older than 7 days and checking
 * the total byte limit under an exclusive directory file lock.
 *
 * @param extraBytes - Expected additional bytes to allocate in the current write.
 * @returns Total storage bytes currently occupied after pruning.
 */
export async function pruneHistoryDirectory(extraBytes = 0): Promise<number> {
  const dir = getHistoryDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return withFileLock(path.join(dir, 'store'), () => pruneHistoryDirectoryInternal(dir, extraBytes));
}

/**
 * Creates an append-only history writer for an active conversation turn.
 *
 * ### Streaming & Persistence Guarantees:
 * - Appends bounded JSONL batches; serialization and copying scale with batch bytes.
 * - Under store lock, verifies the session's workspace ownership to prevent cross-workspace contamination.
 * - Detects torn/partial trailing lines caused by unexpected process crashes and executes
 *   an in-place `fs.truncate` byte boundary repair to the last valid newline.
 * - Materializes the consolidated `.json` snapshot only upon message completion or `turn_finished`.
 *
 * @param handle - Valid session handle.
 * @param workspace - Absolute canonical workspace path.
 * @param provider - Execution provider ID (e.g. 'codex', 'gemini', 'claude').
 * @param turnId - Unique turn UUID for event correlation.
 * @returns Object exposing `accept(event)`, `flush()`, and `disabled`.
 */
export function createHistoryWriter(handle: string, workspace: string, provider: ProviderId, turnId: string) {
  const pending: AdapterEvent[] = [];
  const assembled = new Map<string, string>();
  let chain = Promise.resolve(), writeError: Error | undefined;
  let hasPruned = false;
  let headerWritten = false;
  let nextSeq = 1;
  let currentFileBytes = 0;
  const disabled = process.env.coagent8_HISTORY === 'off';

  let isStreaming = false;

  function accept(event: AdapterEvent) {
    if (disabled) return;
    validateEvent(event);
    if (event.type === 'assistant_delta') isStreaming = true;
    if (event.type === 'turn_finished') isStreaming = false;
    if (event.type === 'user_message' && pending.some(e => e.type === 'user_message')) return;
    if (event.type === 'assistant_delta' || event.type === 'assistant_message') {
      const text = event.type === 'assistant_delta' ? (assembled.get(event.messageId) || '') + event.text : event.text;
      const bounded = truncateToByteLength(text, 1024 * 1024); assembled.set(event.messageId, bounded);
      const index = pending.findIndex(e => e.type === 'assistant_message' && e.messageId === event.messageId);
      const snapshot: AdapterEvent = { type: 'assistant_message', messageId: event.messageId, text: redactSecrets(bounded) };
      if (index >= 0) pending[index] = snapshot; else pending.push(snapshot);
    } else pending.push(sanitize(event));
    if (pending.length > 10000) throw new Error('History event limit exceeded.');
  }

  async function flush() {
    if (disabled) return;
    const batch = pending.splice(0).map(sanitize);
    if (!batch.length) return;

    chain = chain.then(async () => {
      const dir = getHistoryDir();
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await withFileLock(path.join(dir, 'store'), async () => {
        if (!hasPruned) {
          hasPruned = true;
          await pruneHistoryDirectoryInternal(dir);
        }

        const metaFile = path.join(dir, '.capacity.meta');
        let currentTotal: number | null = null;
        try {
          const raw = await readBoundedFile(metaFile, 1024);
          const parsed = JSON.parse(raw);
          if (typeof parsed?.totalBytes === 'number' && Number.isFinite(parsed.totalBytes) && parsed.totalBytes >= 0) {
            currentTotal = parsed.totalBytes;
          }
        } catch {}

        if (currentTotal == null) {
          currentTotal = await calculateDirectoryBytes(dir);
        }

        const logFile = logFileFor(handle);
        const jsonFile = fileFor(handle);

        // Initialize sequence counter and file size if not done
        if (!headerWritten) {
          let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
          try {
            stat = await fs.stat(logFile);
          } catch (err: unknown) {
            if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err;

          }

          if (stat) {
            currentFileBytes = stat.size;
            headerWritten = true;

            const existing = await load(handle);
            if (existing) {
              if (existing.workspace !== canonicalPath(workspace)) throw new Error('History workspace mismatch.');
              nextSeq = existing.nextSequence;
            }

            // Inspect for torn tail from an abrupt crash and truncate only the invalid suffix
            const content = await fs.readFile(logFile, 'utf8');
            const lines = content.split('\n');
            while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
              lines.pop();
            }
            if (lines.length > 0) {
              const lastLine = lines[lines.length - 1].trim();
              let tornTail = false;
              try {
                JSON.parse(lastLine);
              } catch {
                tornTail = true;
              }
              if (tornTail) {
                lines.pop();
                const validText = lines.length > 0 ? lines.join('\n') + '\n' : '';
                const validBytes = Buffer.byteLength(validText, 'utf8');
                await fs.truncate(logFile, validBytes);
                if (currentTotal != null) {
                  currentTotal = Math.max(0, currentTotal - (stat.size - validBytes));
                }
                currentFileBytes = validBytes;
              }
            }
          } else {
            // logFile does not exist yet. Check if jsonFile exists from earlier turn
            const existing = await load(handle);
            if (existing) {
              if (existing.workspace !== canonicalPath(workspace)) throw new Error('History workspace mismatch.');
              nextSeq = existing.nextSequence;
            }
            const header = JSON.stringify({
              _type: 'header',
              schemaVersion: 1,
              sessionHandle: handle,
              workspace: canonicalPath(workspace),
              createdAt: new Date().toISOString(),
              nextSequence: nextSeq,
            }) + '\n';
            const headerBytes = Buffer.byteLength(header, 'utf8');
            if (currentTotal + headerBytes > TOTAL_LIMIT) throw new Error('History total limit reached.');
            await fs.appendFile(logFile, header, 'utf8');
            currentFileBytes = headerBytes;
            currentTotal += headerBytes;
            headerWritten = true;
          }
        }

        // Serialize the batch as JSONL; copying cost scales with serialized batch bytes.
        let appendLines = '';
        for (const event of batch) {
          const fullEvent: ConversationEvent = {
            ...event,
            schemaVersion: 1,
            eventId: randomUUID(),
            sequence: nextSeq++,
            timestamp: new Date().toISOString(),
            sessionHandle: handle,
            turnId,
            provider,
          };
          appendLines += JSON.stringify(fullEvent) + '\n';
        }

        let prefix = '';
        if (currentFileBytes > 0) {
          try {
            const fd = await fs.open(logFile, 'r');
            try {
              const stat = await fd.stat();
              if (stat.size > 0) {
                const buf = Buffer.alloc(1);
                await fd.read(buf, 0, 1, stat.size - 1);
                if (buf[0] !== 0x0A) {
                  prefix = '\n';
                }
              }
            } finally {
              await fd.close();
            }
          } catch {}
        }

        if (prefix) {
          appendLines = prefix + appendLines;
        }

        const appendBytes = Buffer.byteLength(appendLines, 'utf8');
        if (currentFileBytes + appendBytes > SESSION_LIMIT) throw new Error('History session limit reached.');
        if (currentTotal + appendBytes > TOTAL_LIMIT) throw new Error('History total limit reached.');

        await fs.appendFile(logFile, appendLines, 'utf8');
        currentFileBytes += appendBytes;
        currentTotal += appendBytes;

        // Materialize/update consolidated JSON snapshot on completed message or turn finish
        // Streaming deltas avoid monolithic snapshot rewrites, but still serialize batch bytes.
        const isTurnFinished = batch.some(e => e.type === 'turn_finished');
        const shouldMaterialize = isTurnFinished || (!isStreaming && batch.some(e => e.type === 'user_message' || e.type === 'assistant_message'));
        if (shouldMaterialize) {
          const h = await load(handle, true);
          if (h) {
            h.updatedAt = new Date().toISOString();
            const text = JSON.stringify(h);
            const jsonBytes = Buffer.byteLength(text);
            let oldJsonBytes = 0;
            try { const s = await fs.stat(jsonFile); oldJsonBytes = s.size; } catch {}
            currentTotal = currentTotal - oldJsonBytes + jsonBytes;
            await atomicWrite(jsonFile, text);
          }
        }

        try {
          await atomicWrite(metaFile, JSON.stringify({ totalBytes: currentTotal }));
        } catch {
          await fs.rm(metaFile, { force: true }).catch(() => {});
        }
        historyCache.delete(handle);
      });
    }).catch(err => { writeError = err; });

    await chain;
    if (writeError) throw writeError;
  }

  return { accept, flush, disabled };
}

/**
 * Paginates through conversation history events for a given session handle.
 *
 * ### Pagination & Stability Guarantees:
 * - Deterministically constrained to at most 100 events and a 240 KiB page budget.
 * - Cursors are opaque base64url-encoded structures containing sequence pointers and snapshot revision.
 * - If history changes during pagination (e.g. concurrent write), raises `HISTORY_CHANGED` to ensure
 *   the consumer never misses a finalized response or reads a torn stream.
 * - Messages larger than the page text budget are split at code point safe UTF-8 byte boundaries
 *   with `{ offsetBytes, totalBytes, complete }` descriptors.
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
  const dir = getHistoryDir();
  await withFileLock(path.join(dir, 'store'), async () => {
    const h = await load(handle);
    if (h && h.workspace !== canonicalPath(workspace)) throw new Error('History workspace mismatch.');
    const jsonFile = fileFor(handle);
    const logFile = logFileFor(handle);
    const metaFile = path.join(dir, '.capacity.meta');

    let removedBytes = 0;
    try { const stat = await fs.stat(jsonFile); removedBytes += stat.size; } catch {}
    try { const stat = await fs.stat(logFile); removedBytes += stat.size; } catch {}

    let previousTotal: number | null = null;
    try {
      const raw = await readBoundedFile(metaFile, 1024);
      const parsed = JSON.parse(raw);
      if (typeof parsed?.totalBytes === 'number' && Number.isFinite(parsed.totalBytes)) {
        previousTotal = parsed.totalBytes;
      }
    } catch {}

    await fs.rm(metaFile, { force: true });
    await fs.rm(jsonFile, { force: true });
    await fs.rm(logFile, { force: true });
    historyCache.delete(handle);

    if (removedBytes > 0 && previousTotal != null) {
      const updated = Math.max(0, previousTotal - removedBytes);
      try {
        await atomicWrite(metaFile, JSON.stringify({ totalBytes: updated }));
      } catch {
        await fs.rm(metaFile, { force: true }).catch(() => {});
      }
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
