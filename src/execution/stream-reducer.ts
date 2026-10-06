import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

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

export interface StreamReducerOptions {
  onProgress?: ((message: string) => void) | null;
  maxLineBuffer?: number;
  maxTotalBytes?: number;
  maxMessageBytes?: number;
  maxMessages?: number;
  maxFallbackLines?: number;
  maxActivities?: number;
  maxTools?: number;
}

export interface ActivityStep {
  text: string;
  timestamp: number;
}

/**
 * Unified Stream Reducer
 * Standardizes chunk buffering, multi-byte UTF-8 boundary preservation,
 * per-record line bounding, response assembly, terminal answer replacement,
 * activity tracking, and strict memory bounds across provider adapters.
 */
export class StreamReducer {
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private stdoutBufferBytes = 0;
  private discardingOversizedLine = false;
  private hasDiscardedOversizedLine = false;
  private messageTruncated = false;
  private totalMessageBytes = 0;
  private readonly messageMap = new Map<string, string>();
  private readonly messageBytesMap = new Map<string, number>();
  private readonly rawFallbackLines: string[] = [];
  private readonly errorLines: string[] = [];
  private readonly activeTools = new Map<string, string>();
  private readonly finishedTools = new Set<string>();
  private readonly activities: ActivityStep[] = [];

  readonly maxLineBuffer: number;
  readonly maxTotalBytes: number;
  readonly maxMessageBytes: number;
  readonly maxMessages: number;
  readonly maxFallbackLines: number;
  readonly maxActivities: number;
  readonly maxTools: number;
  readonly onProgress: ((message: string) => void) | null;

  constructor(options: StreamReducerOptions = {}) {
    this.maxLineBuffer = options.maxLineBuffer ?? 64 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 512 * 1024;
    this.maxMessageBytes = options.maxMessageBytes ?? 256 * 1024;
    this.maxMessages = options.maxMessages ?? 50;
    this.maxFallbackLines = options.maxFallbackLines ?? 20;
    this.maxActivities = options.maxActivities ?? 50;
    this.maxTools = options.maxTools ?? 50;
    this.onProgress = options.onProgress ?? null;
  }

  /**
   * Buffers incoming chunks using StringDecoder to prevent UTF-8 multi-byte split corruption.
   * Enforces maxLineBuffer on every newline-delimited record and discards oversized records cleanly.
   */
  pushChunk(chunk: string | Buffer, onLine?: (line: string) => void): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    if (this.discardingOversizedLine) {
      const nlIdx = text.indexOf('\n');
      if (nlIdx === -1) {
        return; // Still discarding oversized line, discard without buffering
      }
      this.discardingOversizedLine = false;
      this.stdoutBuffer = text.slice(nlIdx + 1);
      this.stdoutBufferBytes = Buffer.byteLength(this.stdoutBuffer, 'utf8');
    } else {
      const incomingBytes = Buffer.byteLength(text, 'utf8');
      if (this.stdoutBufferBytes + incomingBytes > this.maxLineBuffer && !this.stdoutBuffer.includes('\n') && !text.includes('\n')) {
        this.stdoutBuffer = '';
        this.stdoutBufferBytes = 0;
        this.discardingOversizedLine = true;
        this.hasDiscardedOversizedLine = true;
        return;
      }
      this.stdoutBuffer += text;
      this.stdoutBufferBytes += incomingBytes;
    }

    if (!this.stdoutBuffer.includes('\n')) {
      return;
    }

    let start = 0;
    let nlIdx = -1;
    while ((nlIdx = this.stdoutBuffer.indexOf('\n', start)) !== -1) {
      let line = this.stdoutBuffer.slice(start, nlIdx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      start = nlIdx + 1;

      if (Buffer.byteLength(line, 'utf8') > this.maxLineBuffer) {
        this.hasDiscardedOversizedLine = true;
        continue;
      }

      onLine?.(line);
    }

    this.stdoutBuffer = start > 0 ? this.stdoutBuffer.slice(start) : this.stdoutBuffer;
    this.stdoutBufferBytes = Buffer.byteLength(this.stdoutBuffer, 'utf8');
    if (this.stdoutBufferBytes > this.maxLineBuffer) {
      this.stdoutBuffer = '';
      this.stdoutBufferBytes = 0;
      this.discardingOversizedLine = true;
      this.hasDiscardedOversizedLine = true;
    }
  }

  /**
   * Finalizes StringDecoder and flushes any remaining incomplete fragment in stdoutBuffer.
   */
  flush(onLine?: (line: string) => void): void {
    const remainingDecoded = this.decoder.end();
    if (remainingDecoded) {
      this.stdoutBuffer += remainingDecoded;
      this.stdoutBufferBytes += Buffer.byteLength(remainingDecoded, 'utf8');
    }

    if (this.stdoutBuffer) {
      if (!this.discardingOversizedLine) {
        if (this.stdoutBufferBytes > this.maxLineBuffer) {
          this.hasDiscardedOversizedLine = true;
        } else {
          onLine?.(this.stdoutBuffer);
        }
      }
      this.stdoutBuffer = '';
      this.stdoutBufferBytes = 0;
    }
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
   * Records a user-visible or audit activity step with sliding window bounds.
   */
  recordActivity(activity: string): void {
    if (!activity) return;
    if (this.activities.length >= this.maxActivities) {
      this.activities.shift();
    }
    this.activities.push({ text: activity, timestamp: Date.now() });
    if (this.onProgress) {
      this.onProgress(activity);
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
   * Records a diagnostic error line.
   */
  recordError(rawMsg: string, prefix = '[Error] '): void {
    if (this.errorLines.length >= this.maxFallbackLines) return;
    const maxLen = 500 - prefix.length;
    let clean = String(rawMsg);
    if (clean.length > maxLen) {
      clean = clean.slice(0, maxLen - 3) + '...';
    }
    this.errorLines.push(`${prefix}${clean}`);
  }

  /**
   * Records an unstructured non-JSON fallback line.
   */
  recordFallbackLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.rawFallbackLines.length < this.maxFallbackLines) {
      this.rawFallbackLines.push(trimmed.slice(0, 500));
    }
  }

  /**
   * Formats the consolidated output for terminal reporting.
   */
  getFormattedOutput(exitCode = 0, signal: NodeJS.Signals | null = null): string {
    const messages = Array.from(this.messageMap.values()).filter(m => m.trim().length > 0);
    if (messages.length > 0) {
      const joined = messages.join('\n\n').trim();
      if (Buffer.byteLength(joined, 'utf8') > this.maxTotalBytes) {
        this.messageTruncated = true;
        return truncateToByteLength(joined, this.maxTotalBytes, this.maxTotalBytes >= 20 ? '\n...[truncated]' : '...');
      }
      return joined;
    }
    if (this.rawFallbackLines.length > 0) {
      return this.rawFallbackLines.join('\n').trim();
    }
    if (exitCode === 0 && !signal) {
      return 'Task completed cleanly with no textual output.';
    }
    return '';
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

  hasOversizedLine(): boolean {
    return this.hasDiscardedOversizedLine;
  }

  isTruncated(): boolean {
    return this.hasDiscardedOversizedLine || this.messageTruncated;
  }

  getErrorLines(): string[] {
    return [...this.errorLines];
  }

  getRawFallbackLines(): string[] {
    return [...this.rawFallbackLines];
  }

  getActiveTools(): Map<string, string> {
    return new Map(this.activeTools);
  }

  getFinishedTools(): Set<string> {
    return new Set(this.finishedTools);
  }

  getActivities(): ActivityStep[] {
    return [...this.activities];
  }
}

export function createStreamReducer(options?: StreamReducerOptions): StreamReducer {
  return new StreamReducer(options);
}
