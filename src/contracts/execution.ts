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
  /**
   * Backend process-phase budget in milliseconds.
   * @remarks
   * Under the complete-call budget contract (`EXEC-001-T07`, `EXEC-001-T11a`), this receives the remaining
   * monotonic execution time (`budget.remainingExecutionMs()`) from the complete-call budget after Git collection,
   * preparation, and consent phases. Defaults to remaining execution time under {@link DEFAULT_EXECUTION_TIMEOUT_MS} (900,000 ms minus teardown allowance and early phases) when no caller budget is specified.
   */
  timeoutMs?: number;
  nativeSessionId?: string | null;
  onEvent?: (event: AdapterEvent) => void;
}

/**
 * Default total execution timeout in milliseconds (15 minutes).
 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 900_000;

/**
 * Default process termination grace period in milliseconds before SIGKILL (3 seconds).
 */
export const DEFAULT_TEARDOWN_GRACE_MS = 3_000;

/**
 * Minimum allowable execution timeout in milliseconds (100 ms).
 */
export const MIN_EXECUTION_TIMEOUT_MS = 100;

/**
 * Maximum allowable execution timeout in milliseconds (30 minutes).
 */
export const MAX_EXECUTION_TIMEOUT_MS = 1_800_000;

/**
 * Status indicating whether an execution budget is actively running or stopped.
 */
export type BudgetStatus = 'active' | 'caller_aborted' | 'timed_out';

/**
 * Options configuring execution budget initialization.
 */
export interface ExecutionBudgetOptions {
  /** Total call budget in milliseconds. Must be a finite positive number. */
  totalBudgetMs?: number;
  /** Reserved finite teardown allowance in milliseconds. Defaults to {@link DEFAULT_TEARDOWN_GRACE_MS}. */
  teardownAllowanceMs?: number;
  /** Optional monotonic clock returning milliseconds; defaults to performance.now. */
  clock?: MonotonicClock;
  /** Optional parent abort signal from the caller or host. */
  parentSignal?: AbortSignal;
}

/**
 * Monotonic budget contract tracking execution deadlines and distinguishing timeouts from caller aborts.
 */
export interface ExecutionBudget {
  /** Start time in monotonic milliseconds. */
  readonly startedAtMs: number;
  /** Total budget duration in milliseconds. */
  readonly totalBudgetMs: number;
  /** Finite cleanup allowance duration in milliseconds. */
  readonly teardownAllowanceMs: number;
  /** Absolute monotonic deadline for the complete call including cleanup. */
  readonly deadlineMs: number;
  /** Monotonic deadline for primary execution before entering teardown. */
  readonly executionDeadlineMs: number;
  /** Remaining wall-clock time for the complete call in milliseconds, clamped to zero. */
  remainingTotalMs(): number;
  /** Remaining wall-clock time for the primary execution phase in milliseconds, clamped to zero. */
  remainingExecutionMs(): number;
  /** Remaining wall-clock time allocated for teardown in milliseconds, strictly bounded. */
  remainingTeardownMs(): number;
  /** Whether the primary execution deadline has been reached or exceeded. */
  isExecutionExpired(): boolean;
  /** Whether the total call deadline has been reached or exceeded. */
  isTotalExpired(): boolean;
  /** Whether the budget was cancelled by the caller host signal. */
  isCallerAborted(): boolean;
  /** Whether the budget has timed out due to deadline expiration. */
  isTimedOut(): boolean;
  /** Current lifecycle status of the budget. */
  status(): BudgetStatus;
  /** Reason why the budget stopped being active, or undefined if still active. */
  abortReason(): unknown;
  /** Abort signal that fires when primary execution deadline expires or parent signal aborts. */
  readonly executionSignal: AbortSignal;
  /** Abort signal that fires when absolute call deadline expires or parent signal aborts. */
  readonly teardownSignal: AbortSignal;
  /** Releases all scheduled timers and event listeners associated with this budget. */
  dispose(): void;
}

/**
 * Cancellation and deadline context for backend observation reads (`EXEC-001-T08`).
 *
 * @remarks
 * Encapsulates per-waiter cancellation and deadline semantics for non-turn backend
 * reads (probes, model catalogs, observed models, quota inspection, and inherited tools).
 * Distinct from turn-level {@link ExecutionOptions}.
 */
export interface BackendReadContext {
  /** Optional cancellation signal for interrupting the observation read. */
  abortSignal?: AbortSignal;
  /** Optional operation-level timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional complete-call execution budget handle if available. */
  budget?: ExecutionBudget;
  /** Optional execution budget phase indicating whether execution or teardown allowance applies. */
  phase?: 'execution' | 'teardown';
}

