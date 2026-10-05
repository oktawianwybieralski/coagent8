import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
export * from './stream-reducer.js';

export class BufferLimitError extends Error { readonly code = 'BUFFER_LIMIT'; }
export function readBoundedFileSync(file: string, limit = 64 * 1024): string {
  const fd = fsSync.openSync(file, 'r');
  try {
    if (fsSync.fstatSync(fd).size > limit) throw new BufferLimitError('Local data file exceeds the byte limit.');
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) { const read = fsSync.readSync(fd, buffer, offset, buffer.length - offset, null); if (!read) break; offset += read; }
    if (offset > limit) throw new BufferLimitError('Local data file grew beyond the byte limit.');
    return new StringDecoder('utf8').end(buffer.subarray(0, offset));
  } finally { fsSync.closeSync(fd); }
}

export function createLineDecoder(onLine: (line: string) => void, maxBytes = 512 * 1024) {
  const decoder = new StringDecoder('utf8');
  let pending = '', pendingBytes = 0;
  function consume(text: string) {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      const piece = text.slice(start, end < 0 ? undefined : end);
      const size = Buffer.byteLength(piece);
      if (pendingBytes + size > maxBytes) throw new BufferLimitError('CLI record exceeds the UTF-8 byte limit.');
      pending += piece; pendingBytes += size;
      if (end < 0) return;
      const line = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      pending = ''; pendingBytes = 0;
      if (line.trim()) onLine(line);
      start = end + 1;
    }
  }
  return {
    push(chunk: Buffer) { consume(decoder.write(chunk)); },
    finish() { consume(decoder.end()); if (pending.trim()) onLine(pending); pending = ''; pendingBytes = 0; },
  };
}
export async function readBoundedFile(file: string, limit = 1024 * 1024): Promise<string> {
  const fd = await fs.open(file, 'r');
  try {
    if ((await fd.stat()).size > limit) throw new BufferLimitError('CLI output file exceeds the byte limit.');
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new BufferLimitError('CLI output file grew beyond the byte limit.');
    return new StringDecoder('utf8').end(buffer.subarray(0, offset));
  } finally { await fd.close(); }
}
