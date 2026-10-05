/** Pure pagination of a validated, owned history snapshot. @packageDocumentation */
import { truncateToByteLength } from '../execution/stream.js';
import type { History } from './history.js';
import type { ConversationEvent } from '../types/conversation.types.js';
import { validEventIdentifier } from '../types/conversation.types.js';
const PAGE_LIMIT = 240 * 1024;

/**
 * Renders a bounded page of public events without reading or writing storage.
 * @param h - Validated snapshot whose ownership has already been checked.
 * @param handle - Exact session handle bound into continuation cursors.
 * @param cursor - Optional revision-bound base64url cursor, at most 512 characters.
 * @param limit - Maximum events, 1..100; defaults to 50.
 * @returns Events, safe UTF-8 fragments, and an opaque continuation cursor.
 * @throws On malformed cursor, changed revision or invalid page size.
 * @remarks Metadata and text jointly consume the 240 KiB serialized page budget.
 */
export function paginateHistory(h: History, handle: string, cursor?: string, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('History limit must be 1..100.');
  let after = 0, offset = 0;
  let expectedRevision: string | undefined;
  if (cursor) {
    if (cursor.length > 512) throw new Error('Invalid history cursor.');
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid history cursor.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid history cursor.');
    const c = parsed as Record<string, unknown>;
    if (c.handle !== handle || !validEventIdentifier(c.revision) || typeof c.after !== 'number' || !Number.isSafeInteger(c.after) || c.after < 0 || (c.offset != null && (typeof c.offset !== 'number' || !Number.isSafeInteger(c.offset) || c.offset < 0))) throw new Error('Invalid history cursor.');
    after = c.after; offset = c.offset || 0; expectedRevision = c.revision;
  }

  if (expectedRevision && expectedRevision !== h.revision) throw new Error('HISTORY_CHANGED: Conversation updated during pagination; restart without a cursor to read the current canonical messages.');

  const events: (ConversationEvent & { fragment?: { offsetBytes: number; totalBytes: number; complete: boolean } })[] = [];
  let bytes = 0;
  let nextPosition: { handle: string; after: number; offset?: number } | null = null;

  const startIdx = after > 0 ? findFirstEventIndexAfter(h.events, after) : 0;
  for (let i = startIdx; i < h.events.length; i++) {
    const e = h.events[i];
    if (events.length >= limit) break;
    const copy = { ...e };
    let fragmentPosition: { handle: string; after: number; offset?: number } | null = null;

    if (copy.type === 'assistant_message' || copy.type === 'user_message') {
      const raw = Buffer.from(copy.text);
      const start = events.length === 0 ? offset : 0;
      if (start > raw.length || (start < raw.length && (raw[start] & 0xc0) === 0x80)) throw new Error('Invalid history fragment offset.');
      const metaSize = Buffer.byteLength(JSON.stringify({ ...copy, text: '', fragment: { offsetBytes: start, totalBytes: raw.length, complete: false } }));
      const availableBudget = Math.max(0, PAGE_LIMIT - 2048 - bytes - metaSize);
      if (availableBudget < 4096) break;

      const remainingBytes = raw.length - start;
      const targetTextBudget = Math.floor(availableBudget / 2);
      if (remainingBytes <= targetTextBudget) {
        let text = raw.subarray(start).toString('utf8');
        if (start > 0) {
          Object.assign(copy, { fragment: { offsetBytes: start, totalBytes: raw.length, complete: true } });
        }
        copy.text = text;
      } else {
        if (events.length > 0) {
          // Break page before this large event
          break;
        }
        let text = truncateToByteLength(raw.subarray(start, start + targetTextBudget).toString('utf8'), targetTextBudget, '');
        const end = start + Buffer.byteLength(text);
        if (end === start && start < raw.length) throw new Error('History fragment cannot make progress within page budget.');
        Object.assign(copy, { fragment: { offsetBytes: start, totalBytes: raw.length, complete: end === raw.length } });
        if (end < raw.length) {
          fragmentPosition = { handle, after: copy.sequence - 1, offset: end };
        }
        copy.text = text;
      }
    }

    const size = Buffer.byteLength(JSON.stringify(copy));
    if (bytes + size > PAGE_LIMIT - 1024) break;
    events.push(copy);
    bytes += size;
    nextPosition = fragmentPosition;
    if (nextPosition) break;
  }

  const last = events.at(-1)?.sequence ?? after;
  if (!nextPosition && h.events.length > 0 && h.events[h.events.length - 1].sequence > last) {
    nextPosition = { handle, after: last };
  }
  const nextCursor = nextPosition ? Buffer.from(JSON.stringify({ ...nextPosition, revision: h.revision })).toString('base64url') : null;
  return { schemaVersion: 1, sessionHandle: handle, revision: h.revision, events, nextCursor };
}

function findFirstEventIndexAfter(events: ConversationEvent[], afterSeq: number): number {
  let low = 0, high = events.length - 1, ans = events.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (events[mid].sequence > afterSeq) {
      ans = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return ans;
}
