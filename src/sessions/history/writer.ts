/**
 * Append-only session history writer and streaming delta coalescer.
 *
 * @remarks
 * ## Streaming & Persistence Contract
 * - Appends coalesced assistant deltas to `.jsonl` log without rewriting snapshots per chunk.
 * - Under `${handle}.lock`, checks for torn tails from unexpected crashes and truncates
 *   in-place to the last valid byte offset, adjusting capacity accounting.
 * - Materializes `.json` snapshot atomically upon message completion or `turn_finished`.
 * - Holds back incomplete credentials using `computeSafeCommitPoint` from security.
 *
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock, atomicWrite, type FileLockOptions } from '../../storage/lock.js';
import { canonicalPath } from '../../workspace/identity.js';
import { truncateToByteLength } from '../../execution/runtime/stream.js';
import { computeSafeCommitPoint, redactCredentialFormats } from '../../security/index.js';
import type { AdapterEvent, ConversationEvent, ProviderId, BackendReadContext, ExecutionBudget } from '../../contracts/index.js';
import {
  SESSION_LIMIT,
  getHistoryDir,
  fileFor,
  logFileFor,
  sizeIfExists,
  validateEvent,
  sanitize,
} from './types.js';
import { load, invalidateHistoryCache } from './reader.js';
import {
  reserveCapacity,
  releaseCapacity,
  adjustCapacityMeta,
  pruneHistoryDirectoryInternal,
} from './retention.js';

/** Bytes read per step while scanning a log backward for its last record. */
const TAIL_BLOCK_BYTES = 8 * 1024;

/**
 * Finds a torn final record left by a crash (AUDIT-001-A16-A18).
 *
 * @remarks Reads backward in {@link TAIL_BLOCK_BYTES} blocks until it holds the last
 * non-blank line whole, so it reads about one record instead of the whole log (up to
 * `SESSION_LIMIT`), which `load()` has read already. Records have no size limit: the scan
 * continues to the file start if needed. Lines are split on `\n` bytes and decoded whole, so
 * UTF-8 sequences never break. Semantics match the former whole-file scan: trailing blank
 * lines are ignored, a final record that parses is kept (with or without its newline), and
 * an unparsable one is removed together with everything after it.
 * @param logFile - The `.jsonl` log, read under the history lock.
 * @param size - Its current size in bytes.
 * @returns The byte length to truncate the log to, or `null` when its last record is whole
 * or it holds only blank lines.
 */
export async function tornTailOffset(logFile: string, size: number): Promise<number | null> {
  const handle = await fs.open(logFile, 'r');
  try {
    let tail = Buffer.alloc(0);
    let position = size;
    while (position > 0) {
      const length = Math.min(TAIL_BLOCK_BYTES, position);
      position -= length;
      const block = Buffer.alloc(length);
      // A read may return fewer bytes than asked; fill the block, and on an early end of file
      // (the log shrank) keep the log as it is rather than judge a record from a gap.
      for (let filled = 0; filled < length;) {
        const { bytesRead } = await handle.read(block, filled, length - filled, position + filled);
        if (bytesRead === 0) return null;
        filled += bytesRead;
      }
      tail = Buffer.concat([block, tail]);
      // Lines after the first `\n` in `tail` are complete; the first one is complete only at the file start.
      let end = tail.length;
      // A negative offset would count from the end of the buffer, so the search stops at index 0.
      const previousNewline = (before: number) => (before > 0 ? tail.lastIndexOf(0x0a, before - 1) : -1);
      for (let newline = previousNewline(end); ; newline = previousNewline(newline)) {
        if (newline < 0 && position > 0) break;
        const start = newline + 1;
        const line = tail.subarray(start, end).toString('utf8').trim();
        if (line.length > 0) {
          try { JSON.parse(line); return null; } catch { return position + start; }
        }
        if (newline < 0) return null;
        end = newline;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Creates an append-only history writer for an active conversation turn.
 *
 * @param handle - Valid session handle.
 * @param workspace - Absolute canonical workspace path.
 * @param provider - Execution provider ID (e.g. 'codex', 'agy', 'claude').
 * @param turnId - Unique turn UUID for event correlation.
 * @param options - Optional context, abort signal, or execution budget (`EXEC-001-T09c`).
 * @returns Object exposing `accept(event)`, `flush()`, and `disabled`.
 */
export function createHistoryWriter(
  handle: string,
  workspace: string,
  provider: ProviderId,
  turnId: string,
  options?: { context?: BackendReadContext; abortSignal?: AbortSignal; budget?: ExecutionBudget }
) {
  const pending: AdapterEvent[] = [];
  const rawAssembled = new Map<string, string>();
  const emittedRedactedText = new Map<string, string>();
  let chain = Promise.resolve();
  let writeError: Error | undefined;
  let writerDisabled = false;
  let hasPruned = false;
  let headerWritten = false;
  let nextSeq = 1;
  let currentFileBytes = 0;
  const disabled = process.env.coagent8_HISTORY === 'off';
  let isStreaming = false;

  function accept(event: AdapterEvent) {
    if (disabled || writerDisabled) return;
    validateEvent(event);
    if (event.type === 'assistant_delta') isStreaming = true;
    if (event.type === 'turn_finished') isStreaming = false;
    if (event.type === 'user_message' && pending.some(e => e.type === 'user_message')) return;

    if (pending.length >= 10000) throw new Error('History event limit exceeded.');

    if (event.type === 'assistant_delta') {
      const prev = rawAssembled.get(event.messageId) || '';
      const bounded = truncateToByteLength(prev + event.text, 1024 * 1024);
      rawAssembled.set(event.messageId, bounded);
      const last = pending[pending.length - 1];
      if (last && last.type === 'assistant_delta' && last.messageId === event.messageId) {
        last.text += event.text;
      } else {
        pending.push({ ...event });
      }
    } else if (event.type === 'assistant_message') {
      const bounded = truncateToByteLength(event.text, 1024 * 1024);
      rawAssembled.set(event.messageId, bounded);
      const redacted = redactCredentialFormats(bounded);
      emittedRedactedText.set(event.messageId, redacted);
      const index = pending.findIndex(e => e.type === 'assistant_message' && e.messageId === event.messageId);
      const snapshot: AdapterEvent = { type: 'assistant_message', messageId: event.messageId, text: redacted };
      if (index >= 0) pending[index] = snapshot; else pending.push(snapshot);
    } else {
      pending.push(sanitize(event));
    }
  }

  async function flush() {
    if (disabled || writerDisabled) return;

    // Coalesce assistant_delta events in place to preserve chronological ordering
    const isTurnFinished = pending.some(e => e.type === 'turn_finished');
    const processedMessageIds = new Set<string>();
    const coalesced: AdapterEvent[] = [];

    const commitMessage = (messageId: string, isFinished: boolean) => {
      const rawText = rawAssembled.get(messageId) || '';
      const safePoint = computeSafeCommitPoint(rawText, isFinished);
      const rawToCommit = rawText.slice(0, safePoint);
      const redacted = redactCredentialFormats(rawToCommit);
      const previouslyEmitted = emittedRedactedText.get(messageId) || '';

      if (redacted.length > previouslyEmitted.length) {
        if (redacted.startsWith(previouslyEmitted)) {
          coalesced.push({
            type: 'assistant_delta',
            messageId,
            text: redacted.slice(previouslyEmitted.length),
          });
          emittedRedactedText.set(messageId, redacted);
        } else {
          // A boundary rewrite occurred; emit assistant_message replacement so load() updates the full message
          coalesced.push({
            type: 'assistant_message',
            messageId,
            text: redacted,
          });
          emittedRedactedText.set(messageId, redacted);
        }
      }
    };

    for (let i = 0; i < pending.length; i++) {
      const event = pending[i];
      if (event.type === 'assistant_delta') {
        if (processedMessageIds.has(event.messageId)) continue;

        const msgIndex = pending.findLastIndex(e => e.type === 'assistant_message' && e.messageId === event.messageId);
        if (msgIndex !== -1 && i < msgIndex) {
          continue;
        }

        processedMessageIds.add(event.messageId);
        commitMessage(event.messageId, isTurnFinished);
      } else if (event.type === 'turn_finished') {
        // Before finalizing turn, flush all uncommitted tails from rawAssembled
        for (const [msgId] of rawAssembled.entries()) {
          if (!processedMessageIds.has(msgId)) {
            processedMessageIds.add(msgId);
            commitMessage(msgId, true);
          }
        }
        coalesced.push(event);
      } else {
        coalesced.push(event);
      }
    }
    pending.length = 0;

    const batch = coalesced.map(sanitize);
    if (!batch.length) return;

    const isInitialBatch = !headerWritten && !isTurnFinished;
    const initLockOptions: FileLockOptions | undefined = isInitialBatch
      ? (options?.context ?? (options?.abortSignal || options?.budget ? { abortSignal: options.abortSignal, budget: options.budget } : undefined))
      : undefined;

    chain = chain.then(async () => {
      const dir = getHistoryDir();
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const sessionLockFile = path.join(dir, `${handle}.lock`);
      await withFileLock(sessionLockFile, async () => {
        if (!hasPruned) {
          hasPruned = true;
          await withFileLock(path.join(dir, '.capacity.lock'), () => pruneHistoryDirectoryInternal(dir, 0, handle), initLockOptions);
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
            const validBytes = await tornTailOffset(logFile, stat.size);
            if (validBytes !== null) {
              const truncatedBytes = stat.size - validBytes;
              await fs.truncate(logFile, validBytes);
              currentFileBytes = validBytes;
              if (truncatedBytes > 0) {
                const capLockFile = path.join(dir, '.capacity.lock');
                await withFileLock(capLockFile, async () => {
                  const metaFile = path.join(dir, '.capacity.meta');
                  await adjustCapacityMeta(metaFile, -truncatedBytes);
                }, initLockOptions);
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

            await reserveCapacity(dir, headerBytes, handle, initLockOptions);
            try {
              await fs.appendFile(logFile, header, 'utf8');
              currentFileBytes = headerBytes;
              headerWritten = true;
            } catch (appendErr) {
              await releaseCapacity(dir, headerBytes);
              throw appendErr;
            }
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
          } catch (err) {
            // A log removed meanwhile needs no separator; any other read error stops the append.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }

        if (prefix) {
          appendLines = prefix + appendLines;
        }

        const appendBytes = Buffer.byteLength(appendLines, 'utf8');
        if (currentFileBytes + appendBytes > SESSION_LIMIT) throw new Error('History session limit reached.');

        await reserveCapacity(dir, appendBytes, handle);
        try {
          await fs.appendFile(logFile, appendLines, 'utf8');
          currentFileBytes += appendBytes;
        } catch (appendErr) {
          await releaseCapacity(dir, appendBytes);
          throw appendErr;
        }

        // Materialize/update consolidated JSON snapshot on turn finish or non-streaming user_message
        const isTurnFinished = batch.some(e => e.type === 'turn_finished');
        const shouldMaterialize = isTurnFinished || (!isStreaming && batch.some(e => e.type === 'user_message' || e.type === 'assistant_message'));
        if (shouldMaterialize) {
          const h = await load(handle, true);
          if (h) {
            h.updatedAt = new Date().toISOString();
            const text = JSON.stringify(h);
            const jsonBytes = Buffer.byteLength(text);
            const oldJsonBytes = await sizeIfExists(jsonFile);
            const deltaBytes = jsonBytes - oldJsonBytes;
            // A growing snapshot reserves its bytes before the write, like an append; a
            // shrinking one releases them after it (CUR-012).
            if (deltaBytes > 0) await reserveCapacity(dir, deltaBytes, handle);
            try {
              await atomicWrite(jsonFile, text);
            } catch (writeErr) {
              if (deltaBytes > 0) await releaseCapacity(dir, deltaBytes);
              throw writeErr;
            }
            if (deltaBytes < 0) {
              await withFileLock(path.join(dir, '.capacity.lock'), () => adjustCapacityMeta(path.join(dir, '.capacity.meta'), deltaBytes));
            }
          }
        }

        invalidateHistoryCache(handle);
      }, initLockOptions);
    }).catch(err => {
      writeError = err;
      writerDisabled = true;
    });

    await chain;
    if (writeError) throw writeError;
  }

  return { accept, flush, disabled };
}

