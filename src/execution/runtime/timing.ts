/**
 * Monotonic phase timing and execution tracing runtime primitive.
 *
 * @remarks
 * Guarantees:
 * - Injectable monotonic clock (defaults to performance.now).
 * - Bounded phase count and span count to prevent unbounded memory growth.
 * - Merged overlapping and nested intervals per phase to preserve true wall time.
 * - Idempotent span closing (closing twice does not double-count).
 * - Strict isolation from transport and MCP layers.
 *
 * @packageDocumentation
 */

import type {
  MonotonicClock,
  PhaseSpan,
  ExecutionTrace,
} from '../../contracts/execution.js';

export type { MonotonicClock, PhaseSpan, ExecutionTrace };

/**
 * Handle to an active phase span, allowing explicit completion.
 */
export interface PhaseSpanHandle {
  readonly name: string;
  readonly startMs: number;
  end(): void;
}

/**
 * Configuration options for phase tracker initialization.
 */
export interface PhaseTrackerOptions {
  /** Injectable monotonic clock returning milliseconds; defaults to performance.now. */
  clock?: MonotonicClock;
  /** Maximum number of distinct phase names allowed (default: 64). */
  maxPhases?: number;
  /** Maximum number of spans allowed across the trace (default: 128). */
  maxSpans?: number;
}

const DEFAULT_MAX_PHASES = 64;
const DEFAULT_MAX_SPANS = 128;
const MAX_PHASE_NAME_LENGTH = 64;
const VALID_PHASE_NAME_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
const FORBIDDEN_PHASE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

interface InternalSpan {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  closed: boolean;
}

/**
 * Sanitizes and validates non-negative integer limits against NaN / Infinity.
 */
function sanitizeLimit(val: unknown, fallback: number): number {
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return Math.floor(val);
  }
  return fallback;
}

/**
 * Merges overlapping and nested intervals to compute exact active wall-clock duration.
 *
 * @param intervals - List of intervals with start and end times in milliseconds.
 * @returns Total non-overlapping active wall duration in rounded milliseconds.
 */
export function computeMergedIntervalsDuration(
  intervals: Array<{ start: number; end: number }>
): number {
  if (intervals.length === 0) return 0;

  // Filter out invalid intervals and sort by start ascending, then end ascending
  const valid = intervals
    .filter((inv) => Number.isFinite(inv.start) && Number.isFinite(inv.end) && inv.end >= inv.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (valid.length === 0) return 0;

  let totalMs = 0;
  let currentStart = valid[0].start;
  let currentEnd = valid[0].end;

  for (let i = 1; i < valid.length; i++) {
    const next = valid[i];
    if (next.start <= currentEnd) {
      // Overlapping or contiguous interval
      currentEnd = Math.max(currentEnd, next.end);
    } else {
      // Disjoint interval: commit accumulated span
      totalMs += Math.max(0, currentEnd - currentStart);
      currentStart = next.start;
      currentEnd = next.end;
    }
  }

  totalMs += Math.max(0, currentEnd - currentStart);
  return Math.max(0, Math.round(totalMs));
}

/**
 * Validates and sanitizes a phase name.
 */
function sanitizePhaseName(name: string): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_PHASE_NAME_LENGTH) return null;
  if (!VALID_PHASE_NAME_PATTERN.test(trimmed)) return null;
  if (FORBIDDEN_PHASE_NAMES.has(trimmed)) return null;
  return trimmed;
}

/**
 * Monotonic tracker for recording execution phases and spans.
 */
export class PhaseTracker {
  private readonly clock: MonotonicClock;
  private readonly maxPhases: number;
  private readonly maxSpans: number;
  private readonly startTimestamp: number;
  private endTimestamp?: number;
  private readonly spans: InternalSpan[] = [];
  private readonly knownPhases = new Set<string>();
  private completed = false;

  constructor(options: PhaseTrackerOptions = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.maxPhases = sanitizeLimit(options.maxPhases, DEFAULT_MAX_PHASES);
    this.maxSpans = sanitizeLimit(options.maxSpans, DEFAULT_MAX_SPANS);
    this.startTimestamp = this.clock();
  }

  /**
   * Starts a named phase span.
   *
   * @param name - Identifier of the phase.
   * @returns Handle to complete the span idempotently.
   */
  startPhase(name: string): PhaseSpanHandle {
    const sanitized = sanitizePhaseName(name);
    if (!sanitized) {
      return { name: 'invalid', startMs: this.clock(), end: () => {} };
    }

    if (this.completed) {
      return { name: sanitized, startMs: this.endTimestamp ?? this.clock(), end: () => {} };
    }

    if (this.spans.length >= this.maxSpans) {
      return { name: sanitized, startMs: this.clock(), end: () => {} };
    }

    if (!this.knownPhases.has(sanitized)) {
      if (this.knownPhases.size >= this.maxPhases) {
        return { name: sanitized, startMs: this.clock(), end: () => {} };
      }
      this.knownPhases.add(sanitized);
    }

    const startMs = this.clock();
    const span: InternalSpan = {
      name: sanitized,
      startMs,
      closed: false,
    };
    this.spans.push(span);

    let closed = false;
    return {
      name: sanitized,
      startMs,
      end: () => {
        if (closed || span.closed) return;
        closed = true;
        span.closed = true;
        span.endMs = this.clock();
        span.durationMs = Math.max(0, span.endMs - span.startMs);
      },
    };
  }

  /**
   * Executes an asynchronous action wrapped inside a named phase.
   * Span is guaranteed to close even if the action rejects.
   */
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const handle = this.startPhase(name);
    try {
      return await fn();
    } finally {
      handle.end();
    }
  }

  /**
   * Executes a synchronous action wrapped inside a named phase.
   * Span is guaranteed to close even if the action throws.
   */
  spanSync<T>(name: string, fn: () => T): T {
    const handle = this.startPhase(name);
    try {
      return fn();
    } finally {
      handle.end();
    }
  }

  /**
   * Closes the most recently started unclosed span matching the specified name,
   * or the most recently started unclosed span if name is omitted.
   */
  closePhase(name?: string): void {
    if (this.completed) return;
    const sanitized = name !== undefined ? sanitizePhaseName(name) : undefined;
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const span = this.spans[i];
      if (!span.closed && (sanitized === undefined || span.name === sanitized)) {
        span.closed = true;
        span.endMs = this.clock();
        span.durationMs = Math.max(0, span.endMs - span.startMs);
        return;
      }
    }
  }

  /**
   * Completes the trace, auto-closing any remaining unclosed spans.
   */
  complete(): ExecutionTrace {
    if (!this.completed) {
      const now = this.clock();
      this.endTimestamp = now;
      for (const span of this.spans) {
        if (!span.closed) {
          span.closed = true;
          span.endMs = now;
          span.durationMs = Math.max(0, span.endMs - span.startMs);
        }
      }
      this.completed = true;
    }
    return this.getTrace();
  }

  /**
   * Returns the current execution trace snapshot.
   */
  getTrace(): ExecutionTrace {
    const now = this.completed && this.endTimestamp !== undefined ? this.endTimestamp : this.clock();
    const totalDurationMs = Math.max(0, Math.round(now - this.startTimestamp));

    const phaseIntervals = new Map<string, Array<{ start: number; end: number }>>();
    for (const span of this.spans) {
      const end = span.endMs !== undefined ? span.endMs : now;
      let list = phaseIntervals.get(span.name);
      if (!list) {
        list = [];
        phaseIntervals.set(span.name, list);
      }
      list.push({ start: span.startMs, end });
    }

    const phases: Record<string, number> = Object.create(null);
    for (const [phaseName, intervals] of phaseIntervals.entries()) {
      phases[phaseName] = computeMergedIntervalsDuration(intervals);
    }

    const readOnlySpans: PhaseSpan[] = this.spans.map((s) => ({
      name: s.name,
      startMs: Math.round(s.startMs),
      endMs: s.endMs !== undefined ? Math.round(s.endMs) : undefined,
      durationMs: s.durationMs !== undefined ? Math.round(s.durationMs) : undefined,
    }));

    return {
      totalDurationMs,
      phases,
      spans: readOnlySpans,
    };
  }
}

/**
 * Factory function creating a new PhaseTracker instance.
 */
export function createPhaseTracker(options?: PhaseTrackerOptions): PhaseTracker {
  return new PhaseTracker(options);
}

