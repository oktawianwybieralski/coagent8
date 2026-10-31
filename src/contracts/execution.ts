/**
 * Shared execution options and execution result contracts.
 *
 * @packageDocumentation
 */

import type { ProviderId } from './provider.js';
import type { AdapterEvent, TerminalStatus, TokenUsage } from './conversation.js';
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
 *
 * @remarks
 * Under the honest timing lifecycle (`EXEC-001-T11c`), {@link durationMs} represents total
 * wall-clock duration from root call entry (including preparation, consent, acquisition, execution,
 * and finalization/teardown overruns) to completion or failure, maintaining backward compatibility.
 * {@link totalMs} is an explicit alias for total wall-clock duration. Discrete phase durations are
 * detailed in {@link phases}.
 */
export interface ExecutionMeta {
  turn: number;
  toolCount: number;
  /** Total elapsed wall-clock call duration in milliseconds from entry to return or error. */
  durationMs: number;
  historyAvailable: boolean;
  /** Breakdown of wall-clock duration in milliseconds by execution phase. */
  phases?: Record<string, number>;
  /** Explicit total elapsed wall-clock call duration in milliseconds. */
  totalMs?: number;
}

/**
 * Neutral execution outcome returned by the execution controller.
 * Contains all evidence required by transport adapters without MCP formatting.
 */
/**
 * The list price of the model a turn ran, from an exact price-list match (`AX-001g`).
 * @remarks USD per million tokens; `null` when the list states none. A list price is not
 * what a subscription CLI bills; it only states what the tokens would cost at that price.
 */
export interface ListPrice {
  /** The model the price belongs to; a result of another model gets no list price. */
  model: string;
  inputUsdPerMTok: number | null;
  cachedInputUsdPerMTok: number | null;
  /** Cache writes kept for minutes. */
  cacheWriteUsdPerMTok: number | null;
  /** Cache writes kept for an hour. */
  cacheWriteLongUsdPerMTok: number | null;
  /** The prompt size in tokens from which other prices apply; null for one price, 0 when unknown. */
  tieredFromInputTokens: number | null;
  outputUsdPerMTok: number | null;
  /** Where the list came from and when it was read (`openrouter 2026-10-19`). */
  source: string;
}

export interface TaskExecutionResult {
  isError: boolean;
  provider: ProviderId | null;
  /** Raw adapter result; downstream presentation layers (e.g. MCP) are responsible for credential redaction before display. */
  result: TerminalExecutionResult;
  sessionHandle: string | null;
  meta: ExecutionMeta;
  warnings: string[];
  price?: string;
  /** List price of the model, when the price list matched it exactly. */
  listPrice?: ListPrice;
  review?: {
    verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
    reason?: string;
  };
  /** What the server observed in the workspace around a `workspace-write` turn (`DELEGATE-001w`). */
  changes?: WorkspaceChanges;
}

/**
 * The execution profile of a turn. `workspace-write` lets the backend change files in the
 * workspace (`DELEGATE-001w`); only the server chooses it, never a call argument.
 */
export type ExecutionProfile = 'read-only' | 'workspace-write';

/** One changed path, relative to the workspace, as the server observed it. */
export interface ObservedChange {
  path: string;
  /** `added` and `deleted` compare presence; `modified` covers content, index or mode changes. */
  kind: 'added' | 'modified' | 'deleted';
}

/**
 * Workspace state the server compared before and after a `workspace-write` turn, separate
 * from what the backend reported. `unavailable` replaces the lists when a snapshot failed.
 */
export interface WorkspaceChanges {
  changed: ObservedChange[];
  /** Changed paths outside the call's scope. */
  outsideScope: string[];
  /** Changed paths that already had uncommitted changes before the turn. */
  dirtyBefore: string[];
  /** Commits between the HEAD before and after the turn, or a branch switch. */
  headMoved?: { before: string | null; after: string | null; commits: number; branchBefore: string | null; branchAfter: string | null };
  /** `git diff --stat` of each changed tracked path against HEAD after the turn, bounded. */
  diffStat?: string;
  /** More changed paths than were listed. */
  truncated: boolean;
  unavailable?: string;
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
  /**
   * The backend reported that the model stopped at its output length limit; `undefined`
   * when the backend reports no stop reason. A review cut off this way is never judged.
   */
  lengthLimited?: boolean;
  continuationAvailable?: boolean;
  usage?: TokenUsage;
  /** Observed tool/filesystem permission denials or policy rejections during execution. */
  denials?: Array<{ path?: string; operation?: string; reason?: string }>;
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
  /** Execution profile of the turn; read-only when absent. */
  profile?: ExecutionProfile;
}

/**
 * Default total execution timeout in milliseconds (15 minutes).
 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 900_000;

/**
 * Default total diagnostic timeout in milliseconds (60 seconds).
 * Bounds one doctor call (health or models), 3 s of it reserved for teardown.
 */
export const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 60_000;

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
  /** Elapsed wall-clock time in milliseconds since budget instantiation. */
  elapsedMs?(): number;
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

