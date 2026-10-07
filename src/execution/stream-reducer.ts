import { Buffer } from 'node:buffer';
import { truncateToByteLength } from './stream.js';

export interface StreamReducerOptions {
  maxTotalBytes?: number;
  maxMessageBytes?: number;
  maxMessages?: number;
  maxTools?: number;
}

/**
 * Unified Stream Reducer
 * Standardizes response assembly, terminal answer replacement, tool tracking,
 * and strict memory bounds across provider adapters. Line framing belongs to
 * createLineDecoder in execution/stream.
 */
export class StreamReducer {
  private messageTruncated = false;
  private totalMessageBytes = 0;
  private readonly messageMap = new Map<string, string>();
  private readonly messageBytesMap = new Map<string, number>();
  private readonly activeTools = new Map<string, string>();
  private readonly finishedTools = new Set<string>();

  readonly maxTotalBytes: number;
  readonly maxMessageBytes: number;
  readonly maxMessages: number;
  readonly maxTools: number;

  constructor(options: StreamReducerOptions = {}) {
    this.maxTotalBytes = options.maxTotalBytes ?? 512 * 1024;
    this.maxMessageBytes = options.maxMessageBytes ?? 256 * 1024;
    this.maxMessages = options.maxMessages ?? 50;
    this.maxTools = options.maxTools ?? 50;
  }

  private setBoundedActiveTool(id: string, name: string): void {
    if (!this.activeTools.has(id) && this.activeTools.size >= this.maxTools) {
      const firstKey = this.activeTools.keys().next().value;
      if (firstKey) this.activeTools.delete(firstKey);
    }
    this.activeTools.set(id, name);
  }

  private addBoundedFinishedTool(id: string): void {
    if (!this.finishedTools.has(id) && this.finishedTools.size >= this.maxTools) {
      const firstKey = this.finishedTools.values().next().value;
      if (firstKey) this.finishedTools.delete(firstKey);
    }
    this.finishedTools.add(id);
  }

  /**
   * Appends or updates an assistant response message fragment.
   * Under budget pressure, always replaces draft with latest bounded text and markers.
   */
  upsertMessage(id: string, text: string, options: { delta?: boolean } = {}): void {
    if (typeof text !== 'string') return;
    const isDelta = Boolean(options.delta);
    const prevText = this.messageMap.get(id);
    const prevBytes = this.messageBytesMap.get(id) || 0;

    // Fast-path for incremental streaming deltas within budget
    if (isDelta && prevText !== undefined) {
      const prevLast = prevText.length > 0 ? prevText.charCodeAt(prevText.length - 1) : 0;
      const currFirst = text.length > 0 ? text.charCodeAt(0) : 0;
      const hasSurrogateJoin = (prevLast >= 0xd800 && prevLast <= 0xdbff) && (currFirst >= 0xdc00 && currFirst <= 0xdfff);
      const incomingBytes = hasSurrogateJoin
        ? Buffer.byteLength(prevText + text, 'utf8') - prevBytes
        : Buffer.byteLength(text, 'utf8');

      const projectedMsgBytes = prevBytes + incomingBytes;
      const projectedTotalBytes = this.totalMessageBytes + incomingBytes;

      if (projectedMsgBytes <= this.maxMessageBytes && projectedTotalBytes <= this.maxTotalBytes) {
        this.messageMap.set(id, prevText + text);
        this.messageBytesMap.set(id, projectedMsgBytes);
        this.totalMessageBytes = projectedTotalBytes;
        return;
      }
    }

    let fullText = isDelta ? (prevText || '') + text : text;

    if (fullText.length > this.maxMessageBytes || Buffer.byteLength(fullText, 'utf8') > this.maxMessageBytes) {
      this.messageTruncated = true;
      fullText = truncateToByteLength(fullText, this.maxMessageBytes, this.maxMessageBytes >= 20 ? '\n...[truncated]' : '...');
    }

    const msgBytes = Buffer.byteLength(fullText, 'utf8');

    if (prevText !== undefined) {
      const deltaBytes = msgBytes - prevBytes;

      if (this.totalMessageBytes + deltaBytes <= this.maxTotalBytes) {
        this.messageMap.set(id, fullText);
        this.messageBytesMap.set(id, msgBytes);
        this.totalMessageBytes += deltaBytes;
      } else {
        this.messageTruncated = true;
        const availableBytes = Math.max(0, this.maxTotalBytes - (this.totalMessageBytes - prevBytes));
        if (availableBytes > 0) {
          const truncated = truncateToByteLength(
            fullText,
            availableBytes,
            availableBytes >= 20 ? '\n...[truncated]' : '...'
          );
          const truncatedBytes = Buffer.byteLength(truncated, 'utf8');
          this.messageMap.set(id, truncated);
          this.messageBytesMap.set(id, truncatedBytes);
          this.totalMessageBytes = (this.totalMessageBytes - prevBytes) + truncatedBytes;
        } else {
          this.messageMap.set(id, '');
          this.messageBytesMap.set(id, 0);
          this.totalMessageBytes = this.totalMessageBytes - prevBytes;
        }
      }
    } else {
      if (this.messageMap.size >= this.maxMessages) {
        this.messageTruncated = true;
        return;
      }

      if (this.totalMessageBytes + msgBytes <= this.maxTotalBytes) {
        this.messageMap.set(id, fullText);
        this.messageBytesMap.set(id, msgBytes);
        this.totalMessageBytes += msgBytes;
      } else {
        this.messageTruncated = true;
        const availableBytes = Math.max(0, this.maxTotalBytes - this.totalMessageBytes);
        if (availableBytes > 0) {
          const truncated = truncateToByteLength(
            fullText,
            availableBytes,
            availableBytes >= 20 ? '\n...[truncated]' : '...'
          );
          const truncatedBytes = Buffer.byteLength(truncated, 'utf8');
          this.messageMap.set(id, truncated);
          this.messageBytesMap.set(id, truncatedBytes);
          this.totalMessageBytes += truncatedBytes;
        }
      }
    }
  }

  /**
   * Terminal answer replacement: supersedes intermediate draft messages
   * with the authoritative completed response.
   */
  setFinalAnswer(finalText: string): void {
    if (typeof finalText !== 'string') return;
    this.messageMap.clear();
    this.messageBytesMap.clear();
    this.totalMessageBytes = 0;
    this.upsertMessage('final', finalText);
  }

  /**
   * Drops messages that are not part of the answer, such as commentary a backend marks as
   * interim once its final answer arrives; their bytes return to the budget.
   */
  removeMessages(ids: Iterable<string>): void {
    for (const id of ids) {
      this.totalMessageBytes -= this.messageBytesMap.get(id) || 0;
      this.messageMap.delete(id);
      this.messageBytesMap.delete(id);
    }
  }

  /**
   * Records tool state transition with bound protection. Returns true if transition was newly recorded.
   */
  recordTool(id: string, name: string, status: 'active' | 'done' | 'error'): boolean {
    if (status === 'active') {
      if (!this.activeTools.has(id)) {
        this.setBoundedActiveTool(id, name);
        return true;
      }
    } else {
      if (!this.finishedTools.has(id)) {
        this.addBoundedFinishedTool(id);
        this.setBoundedActiveTool(id, name);
        return true;
      }
    }
    return false;
  }

  /**
   * Formats the consolidated output for terminal reporting.
   * @returns The backend's own text, or an empty string when it produced none: a
   * placeholder here would read as an answer beside a failure the adapter reports.
   */
  getFormattedOutput(): string {
    const messages = Array.from(this.messageMap.values()).filter(m => m.trim().length > 0);
    if (messages.length === 0) return '';
    const joined = messages.join('\n\n').trim();
    if (Buffer.byteLength(joined, 'utf8') > this.maxTotalBytes) {
      this.messageTruncated = true;
      return truncateToByteLength(joined, this.maxTotalBytes, this.maxTotalBytes >= 20 ? '\n...[truncated]' : '...');
    }
    return joined;
  }

  getMessageMap(): Map<string, string> {
    return this.messageMap;
  }

  getMessages(): string[] {
    return Array.from(this.messageMap.values());
  }

  getTotalBytes(): number {
    return this.totalMessageBytes;
  }

  isTruncated(): boolean {
    return this.messageTruncated;
  }

  getActiveTools(): Map<string, string> {
    return new Map(this.activeTools);
  }

  getFinishedTools(): Set<string> {
    return new Set(this.finishedTools);
  }
}

export function createStreamReducer(options?: StreamReducerOptions): StreamReducer {
  return new StreamReducer(options);
}
