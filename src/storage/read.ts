/**
 * Bounded file reading primitives with byte limits.
 *
 * @packageDocumentation
 */

import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { BufferLimitError } from '../contracts/error.js';

export { BufferLimitError };

/**
 * Synchronously reads a file up to `limit` bytes.
 * Throws BufferLimitError if the file size or read content exceeds `limit`.
 */
export function readBoundedFileSync(file: string, limit = 64 * 1024): string {
  const fd = fsSync.openSync(file, 'r');
  try {
    if (fsSync.fstatSync(fd).size > limit) throw new BufferLimitError('Local data file exceeds the byte limit.');
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fsSync.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!read) break;
      offset += read;
    }
    if (offset > limit) throw new BufferLimitError('Local data file grew beyond the byte limit.');
    return new StringDecoder('utf8').end(buffer.subarray(0, offset));
  } finally {
    fsSync.closeSync(fd);
  }
}

/**
 * Asynchronously reads a file up to `limit` bytes.
 * Throws BufferLimitError if the file size or read content exceeds `limit`.
 */
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
  } finally {
    await fd.close();
  }
}
