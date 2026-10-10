/**
 * Monotonic execution budget primitive tracking call deadlines and teardown allowances.
 *
 * @remarks
 * Implements the complete-call budget contract (`EXEC-001-T07`):
 * - Injectable monotonic clock (defaults to `performance.now`).
 * - Fixed absolute deadline computed once at instantiation.
 * - Distinct execution deadline reserving a finite teardown allowance.
 * - Non-resetting boundary arithmetic (already-expired, exact boundary, repeated checks).
 * - Explicit distinction between host/caller cancellation (`ABORTED`) and budget expiration (`TIMEOUT`).
 * - Guaranteed timer cleanup and listener teardown on dispose.
 * - Strict isolation from MCP and transport layers.
 *
 * @packageDocumentation
 */

import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_TEARDOWN_GRACE_MS,
  type BudgetStatus,
  type ExecutionBudget,
  type ExecutionBudgetOptions,
  type MonotonicClock,
} from '../../contracts/execution.js';
import { ToolError } from '../../contracts/error.js';

export type { BudgetStatus, ExecutionBudget, ExecutionBudgetOptions, MonotonicClock };

/**
 * Validates whether a value is a valid positive finite budget duration.
 *
 * @param val - The candidate duration to validate.
 * @returns True if `val` is a finite positive number.
 */
export function isValidBudgetDuration(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

/**
 * Sanitizes budget duration to a safe non-negative integer or fallback.
 *
 * @param val - Candidate duration value.
 * @param fallback - Fallback value if candidate is invalid.
 * @returns Sanitized non-negative integer.
 */
function sanitizeBudgetDuration(val: unknown, fallback: number): number {
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return Math.floor(val);
  }
  return fallback;
}

/**
 * Creates a monotonic execution budget instance.
 *
 * @param options - Configuration options for the budget.
 * @returns Monotonic execution budget handle.
 */
export function createExecutionBudget(options: ExecutionBudgetOptions = {}): ExecutionBudget {
  const clock: MonotonicClock = options.clock ?? (() => performance.now());
  const startedAtMs = clock();

  let totalBudgetMs: number;
  if (options.totalBudgetMs == null) {
    totalBudgetMs = DEFAULT_EXECUTION_TIMEOUT_MS;
  } else if (
    typeof options.totalBudgetMs !== 'number' ||
    !Number.isFinite(options.totalBudgetMs) ||
    options.totalBudgetMs <= 0
  ) {
    throw new ToolError('INPUT_LIMIT', 'Invalid deadline or buffer budget.');
  } else {
    totalBudgetMs = Math.floor(options.totalBudgetMs);
  }

  const rawTeardown = options.teardownAllowanceMs != null
    ? sanitizeBudgetDuration(options.teardownAllowanceMs, DEFAULT_TEARDOWN_GRACE_MS)
    : Math.min(DEFAULT_TEARDOWN_GRACE_MS, Math.max(1, Math.floor(totalBudgetMs * 0.2)));

  // Cleanup allowance is finite and cannot exceed total budget
  const teardownAllowanceMs = Math.min(rawTeardown, totalBudgetMs);

  const deadlineMs = startedAtMs + totalBudgetMs;
  const executionDeadlineMs = startedAtMs + Math.max(0, totalBudgetMs - teardownAllowanceMs);

  const executionController = new AbortController();
  const teardownController = new AbortController();

  let abortOrigin: 'caller' | 'timeout' | null = null;
  let customAbortReason: unknown = undefined;

  let executionTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const parentSignal = options.parentSignal;

  function clearTimers(): void {
    if (executionTimer) {
      clearTimeout(executionTimer);
      executionTimer = undefined;
    }
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
  }

  function handleCallerAbort(isPreAborted = false): void {
    if (abortOrigin !== null) {
      // If execution has already timed out (abortOrigin === 'timeout'),
      // caller cancellation must still propagate to teardownSignal to immediately abort teardown.
      if (!teardownController.signal.aborted) {
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = undefined;
        }
        const reason = parentSignal?.reason ?? new ToolError('ABORTED', 'Execution was aborted by caller.');
        teardownController.abort(reason);
      }
      return;
    }
    // Check if monotonic clock has already passed the execution deadline.
    // An earlier deadline expiration must not be overridden by subsequent caller cancellation,
    // but a pre-aborted parent signal was cancelled before the budget started (first-event precedence).
    if (!isPreAborted) {
      const current = clock();
      if (current >= executionDeadlineMs) {
        handleExecutionTimeout();
        if (!teardownController.signal.aborted) {
          if (totalTimer) {
            clearTimeout(totalTimer);
            totalTimer = undefined;
          }
          const reason = parentSignal?.reason ?? new ToolError('ABORTED', 'Execution was aborted by caller.');
          teardownController.abort(reason);
        }
        return;
      }
    }

    abortOrigin = 'caller';
    clearTimers();
    const reason = parentSignal?.reason ?? new ToolError('ABORTED', 'Execution was aborted by caller.');
    customAbortReason = reason;
    if (!executionController.signal.aborted) {
      executionController.abort(reason);
    }
    if (!teardownController.signal.aborted) {
      teardownController.abort(reason);
    }
  }

  function handleExecutionTimeout(): void {
    if (executionTimer) {
      clearTimeout(executionTimer);
      executionTimer = undefined;
    }
    if (abortOrigin === null) {
      abortOrigin = 'timeout';
      const reason = new ToolError('TIMEOUT', `Execution deadline exceeded (${totalBudgetMs} ms).`);
      customAbortReason = reason;
      if (!executionController.signal.aborted) {
        executionController.abort(reason);
      }
    }
  }

  function handleTotalTimeout(): void {
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
    if (abortOrigin !== 'caller') {
      const reason = customAbortReason ?? new ToolError('TIMEOUT', `Total execution budget exceeded (${totalBudgetMs} ms).`);
      if (!teardownController.signal.aborted) {
        teardownController.abort(reason);
      }
    }
  }

  // Bind parent signal
  let onParentAbort: (() => void) | undefined;
  if (parentSignal) {
    if (parentSignal.aborted) {
      handleCallerAbort(true);
    } else {
      onParentAbort = () => { handleCallerAbort(false); };
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  // Check initial state against clock
  const now = clock();
  if (abortOrigin === null) {
    if (now >= executionDeadlineMs) {
      handleExecutionTimeout();
    }
    if (now >= deadlineMs) {
      handleTotalTimeout();
    }
  }

  // Schedule timers for asynchronous execution
  if (now < executionDeadlineMs && abortOrigin === null) {
    const execDelay = Math.max(0, Math.ceil(executionDeadlineMs - now));
    if (execDelay > 0 && Number.isFinite(execDelay)) {
      executionTimer = setTimeout(() => {
        handleExecutionTimeout();
      }, execDelay);
      if (typeof executionTimer.unref === 'function') {
        executionTimer.unref();
      }
    }
  }

  // Schedule total timer independently if total deadline remains pending and caller has not aborted
  if (now < deadlineMs && abortOrigin !== 'caller') {
    const totalDelay = Math.max(0, Math.ceil(deadlineMs - now));
    if (totalDelay > 0 && Number.isFinite(totalDelay)) {
      totalTimer = setTimeout(() => {
        handleTotalTimeout();
      }, totalDelay);
      if (typeof totalTimer.unref === 'function') {
        totalTimer.unref();
      }
    }
  }

  /**
   * Internal synchronizer: checks monotonic clock and updates controllers if deadline passed.
   */
  function syncClock(): void {
    if (abortOrigin === 'caller') return;
    const current = clock();
    if (current >= executionDeadlineMs && !executionController.signal.aborted) {
      handleExecutionTimeout();
    }
    if (current >= deadlineMs && !teardownController.signal.aborted) {
      handleTotalTimeout();
    }
  }

  const budget: ExecutionBudget = {
    startedAtMs,
    totalBudgetMs,
    teardownAllowanceMs,
    deadlineMs,
    executionDeadlineMs,

    remainingTotalMs(): number {
      syncClock();
      return Math.max(0, Math.floor(deadlineMs - clock()));
    },

    remainingExecutionMs(): number {
      syncClock();
      return Math.max(0, Math.floor(executionDeadlineMs - clock()));
    },

    remainingTeardownMs(): number {
      syncClock();
      const remTotal = Math.max(0, Math.floor(deadlineMs - clock()));
      return Math.min(teardownAllowanceMs, remTotal);
    },

    isExecutionExpired(): boolean {
      syncClock();
      return clock() >= executionDeadlineMs;
    },

    isTotalExpired(): boolean {
      syncClock();
      return clock() >= deadlineMs;
    },

    isCallerAborted(): boolean {
      return abortOrigin === 'caller';
    },

    isTimedOut(): boolean {
      syncClock();
      return abortOrigin === 'timeout' || (abortOrigin === null && clock() >= executionDeadlineMs);
    },

    status(): BudgetStatus {
      syncClock();
      if (abortOrigin === 'caller') return 'caller_aborted';
      if (abortOrigin === 'timeout' || clock() >= executionDeadlineMs) return 'timed_out';
      return 'active';
    },

    abortReason(): unknown {
      syncClock();
      if (abortOrigin === 'caller') return customAbortReason ?? parentSignal?.reason;
      if (abortOrigin === 'timeout' || clock() >= executionDeadlineMs) {
        return customAbortReason ?? executionController.signal.reason ?? new ToolError('TIMEOUT', `Execution deadline exceeded (${totalBudgetMs} ms).`);
      }
      return undefined;
    },

    get executionSignal(): AbortSignal {
      syncClock();
      return executionController.signal;
    },

    get teardownSignal(): AbortSignal {
      syncClock();
      return teardownController.signal;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      if (parentSignal && onParentAbort) {
        parentSignal.removeEventListener('abort', onParentAbort);
        onParentAbort = undefined;
      }
    },
  };

  return budget;
}
