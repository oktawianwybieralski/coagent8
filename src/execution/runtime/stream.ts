/**
 * Byte, stream, and decoding runtime primitives.
 *
 * @packageDocumentation
 */

import { StringDecoder } from 'node:string_decoder';
import { BufferLimitError } from '../../contracts/error.js';

export { BufferLimitError };

/**
 * Truncates a UTF-8 string to a maximum byte length without splitting multi-byte characters.
 * Guarantees that the resulting string's UTF-8 byte length NEVER exceeds maxBytes.
 */
export function truncateToByteLength(str: string, maxBytes: number, suffix = '...[truncated]'): string {
  if (typeof str !== 'string' || maxBytes <= 0) return '';
  if (str.length <= maxBytes && Buffer.byteLength(str, 'utf8') <= maxBytes) return str;

  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes >= maxBytes) {
    const sBuf = Buffer.allocUnsafe(maxBytes);
    const written = sBuf.write(suffix, 0, maxBytes, 'utf8');
    return sBuf.toString('utf8', 0, written);
  }

  const targetBytes = maxBytes - suffixBytes;
  const buf = Buffer.allocUnsafe(targetBytes);
  const written = buf.write(str, 0, targetBytes, 'utf8');
  return buf.toString('utf8', 0, written) + suffix;
}

export function createLineDecoder(onLine: (line: string) => void, maxBytes = 512 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '',
    pendingBytes = 0;
  function consume(text: string) {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const piece = text.slice(start, end < 0 ? undefined : end);
      const size = Buffer.byteLength(piece);
      if (pendingBytes + size > maxBytes) throw new BufferLimitError('CLI record exceeds the UTF-8 byte limit.');
      pending += piece;
      pendingBytes += size;
      if (end < 0) return;
      const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      pending = '';
      pendingBytes = 0;
      if (line.trim()) onLine(line);
      start = end + 1;
    }
  }
  return {
    push(chunk: Buffer) {
      consume(decoder.write(chunk));
    },
    finish() {
      consume(decoder.end());
      if (pending.trim()) onLine(pending);
      pending = '';
      pendingBytes = 0;
    },
  };
}
