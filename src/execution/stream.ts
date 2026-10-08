/**
 * Stream and bounded file operations compatibility re-exports.
 * Concrete implementations moved to `src/execution/runtime/stream.ts` and `src/storage/read.ts` (SIMPLIFY-001 S1).
 *
 * @packageDocumentation
 */

export { truncateToByteLength, createLineDecoder } from './runtime/stream.js';
export { readBoundedFile, readBoundedFileSync, BufferLimitError } from '../storage/read.js';
