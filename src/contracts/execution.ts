/**
 * Shared execution options and execution result contracts.
 *
 * @packageDocumentation
 */

import type { ProviderId } from './provider.js';
import type { AdapterEvent, TerminalStatus } from './conversation.js';
import type { ExecutionError } from './error.js';

/**
 * Monotonic clock returning time in milliseconds.
 */
export type MonotonicClock = () => number;

/**
 * A discrete span recorded during execution.
 */
export interface PhaseSpan {
  readonly name: string;
  readonly startMs: number;
  readonly endMs?: number;
  readonly durationMs?: number;
}

/**
 * Trace record summarizing wall-clock execution time and phase breakdowns.
 */
export interface ExecutionTrace {
  readonly totalDurationMs: number;
  readonly phases: Record<string, number>;
  readonly spans?: readonly PhaseSpan[];
}

/**
 * Minimal timing tracer interface for recording phase spans.
 */
export interface TimingTracer {
  startPhase(name: string): { end(): void };
}

/**
 * Observer callback for execution timing events, including early failures.
 */
export type TimingObserver = (trace: ExecutionTrace) => void;

/**
 * Execution metadata collected across the turn lifecycle.
 */
export interface ExecutionMeta {
  turn: number;
  toolCount: number;
  durationMs: number;
  historyAvailable: boolean;
  phases?: Record<string, number>;
}

/**
 * Neutral execution outcome returned by the execution controller.
 * Contains all evidence required by transport adapters without MCP formatting.
 */
export interface TaskExecutionResult {
  isError: boolean;
  provider: ProviderId | null;
  /** Raw adapter result; downstream presentation layers (e.g. MCP) are responsible for credential redaction before display. */
  result: TerminalExecutionResult;
  sessionHandle: string | null;
  meta: ExecutionMeta;
  warnings: string[];
  price?: string;
  review?: {
    verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
    reason?: string;
  };
}

/**
 * Output resulting from executing a prompt against a CLI adapter.
 */
export interface ExecutionResult {
  /** Whether execution failed or exited with an error. */
  isError: boolean;
  /** Bounded public answer or partial text; inspect truncated/status for completeness. */
  output: string;
  /** Optional error trace or failure message. */
  errorDetail?: string;
  /** Persistent conversation/thread identifier for multi-turn sessions. */
  threadId?: string | null;
  /** Process exit status code. */
  exitCode?: number | null;
  /** Legacy helpers may omit this; registered adapters require a terminal result. */
  status?: TerminalStatus;
  error?: ExecutionError;
  nativeSessionId?: string | null;
  signal?: NodeJS.Signals | null;
  model?: string;
  truncated?: boolean;
  continuationAvailable?: boolean;
  usage?: { source: 'provider'; inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface TerminalExecutionResult extends ExecutionResult {
  status: TerminalStatus;
  truncated: boolean;
  continuationAvailable: boolean;
}

/**
 * Options configuring adapter execution.
 */
export interface ExecutionOptions {
  /** Current working directory for CLI execution. */
  cwd?: string;
  /** Model override name. */
  model?: string;
  /** Reasoning effort level override. */
  reasoningEffort?: string;
  /** Cancellation signal for interrupting execution. */
  abortSignal?: AbortSignal;
  /** Real-time progress callback. */
  onProgress?: (info: { message?: string; percent?: number }) => void;
  /** Existing thread or session ID for resuming multi-turn conversation. */
  threadId?: string | null;
  /** Backend process-phase budget in milliseconds; defaults to 900,000, excluding controller preparation. */
  timeoutMs?: number;
  nativeSessionId?: string | null;
  onEvent?: (event: AdapterEvent) => void;
}

