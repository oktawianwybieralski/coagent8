/**
 * Conversation history management, streaming persistence, and retention service.
 *
 * @remarks
 * Composes append-only writing, torn-tail recovery, monolithic JSON snapshots,
 * safe UTF-8 page streaming, and capacity bounds into a unified service.
 *
 * @packageDocumentation
 */

export * from './types.js';
export * from './page.js';
export * from './retention.js';
export * from './reader.js';
export * from './writer.js';
export { computeSafeCommitPoint } from '../../security/index.js';

