'use strict';

/**
 * EXEC-001-T07b: Monotonic budget primitive unit tests.
 *
 * Verifies:
 * - Injectable monotonic clock support.
 * - Single fixed monotonic deadline computed once at instantiation.
 * - Execution deadline reservation of a separate, finite teardown allowance.
 * - Non-resetting boundary arithmetic (already-expired, exact boundary, repeated checks).
 * - Explicit distinction between host cancellation ('caller_aborted') and timeout ('timed_out').
 * - Finite teardown allowance bounding cleanup time.
 * - Safe disposal and timer cleanup.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createExecutionBudget,
  isValidBudgetDuration,
} = require('../../src/execution/runtime/budget.ts');
const {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_TEARDOWN_GRACE_MS,
} = require('../../src/contracts/execution.ts');
const { ToolError } = require('../../src/contracts/error.ts');

function createFakeClock(initialTime = 1000) {
  let current = initialTime;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
    set: (t) => {
      current = t;
      return current;
    },
  };
}

test('isValidBudgetDuration validates positive finite numbers', () => {
  assert.equal(isValidBudgetDuration(100), true);
  assert.equal(isValidBudgetDuration(900000), true);
  assert.equal(isValidBudgetDuration(0.5), true);

  assert.equal(isValidBudgetDuration(0), false);
  assert.equal(isValidBudgetDuration(-10), false);
  assert.equal(isValidBudgetDuration(NaN), false);
  assert.equal(isValidBudgetDuration(Infinity), false);
  assert.equal(isValidBudgetDuration(-Infinity), false);
  assert.equal(isValidBudgetDuration('100'), false);
  assert.equal(isValidBudgetDuration(null), false);
  assert.equal(isValidBudgetDuration(undefined), false);
  assert.equal(isValidBudgetDuration({}), false);
});

test('createExecutionBudget initializes with default parameters', () => {
  const clock = createFakeClock(5000);
  const budget = createExecutionBudget({ clock: clock.now });

  try {
    assert.equal(budget.startedAtMs, 5000);
    assert.equal(budget.totalBudgetMs, DEFAULT_EXECUTION_TIMEOUT_MS);
    assert.equal(budget.teardownAllowanceMs, DEFAULT_TEARDOWN_GRACE_MS);
    assert.equal(budget.deadlineMs, 5000 + DEFAULT_EXECUTION_TIMEOUT_MS);
    assert.equal(
      budget.executionDeadlineMs,
      5000 + DEFAULT_EXECUTION_TIMEOUT_MS - DEFAULT_TEARDOWN_GRACE_MS
    );

    assert.equal(budget.status(), 'active');
    assert.equal(budget.isExecutionExpired(), false);
    assert.equal(budget.isTotalExpired(), false);
    assert.equal(budget.isCallerAborted(), false);
    assert.equal(budget.isTimedOut(), false);
    assert.equal(budget.abortReason(), undefined);

    assert.equal(budget.remainingTotalMs(), DEFAULT_EXECUTION_TIMEOUT_MS);
    assert.equal(
      budget.remainingExecutionMs(),
      DEFAULT_EXECUTION_TIMEOUT_MS - DEFAULT_TEARDOWN_GRACE_MS
    );
    assert.equal(budget.remainingTeardownMs(), DEFAULT_TEARDOWN_GRACE_MS);

    assert.equal(budget.executionSignal.aborted, false);
    assert.equal(budget.teardownSignal.aborted, false);
  } finally {
    budget.dispose();
  }
});

test('createExecutionBudget handles custom budget and teardown allowances', () => {
  const clock = createFakeClock(1000);
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
  });

  try {
    assert.equal(budget.startedAtMs, 1000);
    assert.equal(budget.totalBudgetMs, 60_000);
    assert.equal(budget.teardownAllowanceMs, 5_000);
    assert.equal(budget.deadlineMs, 61_000);
    assert.equal(budget.executionDeadlineMs, 56_000);

    assert.equal(budget.remainingExecutionMs(), 55_000);
    assert.equal(budget.remainingTotalMs(), 60_000);
    assert.equal(budget.remainingTeardownMs(), 5_000);
    assert.equal(budget.status(), 'active');
  } finally {
    budget.dispose();
  }
});

test('monotonic clock progression updates remaining time accurately', () => {
  const clock = createFakeClock(1000);
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
  });

  try {
    clock.advance(20_000); // at 21_000
    assert.equal(budget.remainingExecutionMs(), 35_000);
    assert.equal(budget.remainingTotalMs(), 40_000);
    assert.equal(budget.remainingTeardownMs(), 5_000);
    assert.equal(budget.isExecutionExpired(), false);
    assert.equal(budget.status(), 'active');

    clock.advance(34_999); // at 55_999, 1ms before execution deadline
    assert.equal(budget.remainingExecutionMs(), 1);
    assert.equal(budget.remainingTotalMs(), 5_001);
    assert.equal(budget.isExecutionExpired(), false);
    assert.equal(budget.executionSignal.aborted, false);
  } finally {
    budget.dispose();
  }
});

test('exact boundary condition: execution deadline expiration', () => {
  const clock = createFakeClock(1000);
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
  });

  try {
    // Advance to exactly executionDeadlineMs (56_000)
    clock.set(56_000);

    assert.equal(budget.remainingExecutionMs(), 0);
    assert.equal(budget.isExecutionExpired(), true);
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.isCallerAborted(), false);
    assert.equal(budget.status(), 'timed_out');

    // Execution signal aborts with ToolError('TIMEOUT', ...)
    assert.equal(budget.executionSignal.aborted, true);
    const reason = budget.abortReason();
    assert.ok(reason instanceof ToolError);
    assert.equal(reason.code, 'TIMEOUT');
    assert.match(reason.message, /Execution deadline exceeded \(60000 ms\)/);

    // Teardown allowance remains intact and active
    assert.equal(budget.remainingTotalMs(), 5_000);
    assert.equal(budget.remainingTeardownMs(), 5_000);
    assert.equal(budget.isTotalExpired(), false);
    assert.equal(budget.teardownSignal.aborted, false);
  } finally {
    budget.dispose();
  }
});

test('exact boundary condition: total call deadline expiration', () => {
  const clock = createFakeClock(1000);
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
  });

  try {
    // Advance to exactly deadlineMs (61_000)
    clock.set(61_000);

    assert.equal(budget.remainingExecutionMs(), 0);
    assert.equal(budget.remainingTotalMs(), 0);
    assert.equal(budget.remainingTeardownMs(), 0);
    assert.equal(budget.isExecutionExpired(), true);
    assert.equal(budget.isTotalExpired(), true);
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.status(), 'timed_out');

    assert.equal(budget.executionSignal.aborted, true);
    assert.equal(budget.teardownSignal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test('createExecutionBudget defaults nullish totalBudgetMs', () => {
  const clock = createFakeClock(2000);
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: null,
  });

  try {
    assert.equal(budget.totalBudgetMs, DEFAULT_EXECUTION_TIMEOUT_MS);
    assert.equal(budget.deadlineMs, 2000 + DEFAULT_EXECUTION_TIMEOUT_MS);
  } finally {
    budget.dispose();
  }
});

test('createExecutionBudget rejects zero, negative, and non-finite durations with INPUT_LIMIT', () => {
  const invalidDurations = [0, -1, -500, NaN, Infinity, -Infinity, '60000', {}, []];

  for (const invalid of invalidDurations) {
    assert.throws(
      () => createExecutionBudget({ totalBudgetMs: invalid }),
      (err) => err instanceof ToolError && err.code === 'INPUT_LIMIT' && err.message === 'Invalid deadline or buffer budget.'
    );
  }
});

test('already-expired execution phase cannot reset upon repeated checks', () => {
  const clock = createFakeClock(1000);
  // Initialized with total 100ms and teardown allowance 100ms: execution deadline is startedAtMs (1000)
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 100,
    teardownAllowanceMs: 100,
  });

  try {
    assert.equal(budget.totalBudgetMs, 100);
    assert.equal(budget.startedAtMs, 1000);
    assert.equal(budget.deadlineMs, 1100);
    assert.equal(budget.executionDeadlineMs, 1000);

    assert.equal(budget.remainingExecutionMs(), 0);
    assert.equal(budget.remainingTotalMs(), 100);
    assert.equal(budget.remainingTeardownMs(), 100);
    assert.equal(budget.isExecutionExpired(), true);
    assert.equal(budget.isTotalExpired(), false);
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.status(), 'timed_out');

    // Repeated checks do not change or reset deadlines
    for (let i = 0; i < 50; i++) {
      assert.equal(budget.remainingExecutionMs(), 0);
      assert.equal(budget.isExecutionExpired(), true);
      assert.equal(budget.status(), 'timed_out');
    }

    assert.equal(budget.deadlineMs, 1100);
    assert.equal(budget.executionDeadlineMs, 1000);
  } finally {
    budget.dispose();
  }
});

test('cleanup allowance is separate and strictly finite', () => {
  const clock = createFakeClock(1000);
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 100_000,
    teardownAllowanceMs: 5_000,
  });

  try {
    // Primary execution completes quickly at 5_000 ms (elapsed: 4_000 ms)
    clock.set(5_000);
    assert.equal(budget.remainingTotalMs(), 96_000);
    assert.equal(budget.remainingExecutionMs(), 91_000);

    // Teardown allowance is capped at 5_000 ms, NOT 96_000 ms!
    assert.equal(budget.remainingTeardownMs(), 5_000);

    // Later, when total remaining time is only 2_000 ms (at 99_000)
    clock.set(99_000);
    assert.equal(budget.remainingTotalMs(), 2_000);
    // Teardown is bounded by remaining total time
    assert.equal(budget.remainingTeardownMs(), 2_000);
  } finally {
    budget.dispose();
  }
});

test('distinguishes host cancellation from timeout (caller abort first)', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
    parentSignal: parentController.signal,
  });

  try {
    clock.advance(10_000);
    const customReason = new Error('User interrupted via Ctrl-C');
    parentController.abort(customReason);

    assert.equal(budget.isCallerAborted(), true);
    assert.equal(budget.isTimedOut(), false);
    assert.equal(budget.status(), 'caller_aborted');
    assert.equal(budget.abortReason(), customReason);

    assert.equal(budget.executionSignal.aborted, true);
    assert.equal(budget.executionSignal.reason, customReason);
    assert.equal(budget.teardownSignal.aborted, true);
    assert.equal(budget.teardownSignal.reason, customReason);

    // Even if clock later passes deadline, caller_aborted remains sticky
    clock.set(100_000);
    assert.equal(budget.isCallerAborted(), true);
    assert.equal(budget.status(), 'caller_aborted');
    assert.equal(budget.abortReason(), customReason);
  } finally {
    budget.dispose();
  }
});

test('distinguishes host cancellation from timeout (deadline expires first)', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
    parentSignal: parentController.signal,
  });

  try {
    // Advance past execution deadline
    clock.set(57_000);

    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.isCallerAborted(), false);
    assert.equal(budget.status(), 'timed_out');
    assert.equal(budget.abortReason().code, 'TIMEOUT');

    // Late parent signal abort does not override TIMEOUT
    parentController.abort(new Error('Late cancellation'));
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.status(), 'timed_out');
    assert.equal(budget.abortReason().code, 'TIMEOUT');
  } finally {
    budget.dispose();
  }
});

test('caller cancellation after an unobserved deadline expiration does not override TIMEOUT', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 5_000,
    parentSignal: parentController.signal,
  });

  try {
    // Advance clock past execution deadline (56_000) WITHOUT querying budget first
    clock.set(58_000);

    // Now parent aborts before any budget property was inspected
    parentController.abort(new Error('Late cancellation'));

    // The deadline had already expired according to monotonic clock: TIMEOUT must win
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.isCallerAborted(), false);
    assert.equal(budget.status(), 'timed_out');
    assert.equal(budget.abortReason().code, 'TIMEOUT');
  } finally {
    budget.dispose();
  }
});

test('automatic teardown timer expiry after immediate execution expiry', async () => {
  // Use real wall clock with short budget to verify asynchronous teardown timer firing
  const budget = createExecutionBudget({
    totalBudgetMs: 40,
    teardownAllowanceMs: 40,
  });

  try {
    // Execution deadline is already expired at start
    assert.equal(budget.isExecutionExpired(), true);
    assert.equal(budget.executionSignal.aborted, true);
    // Teardown signal is not yet expired
    assert.equal(budget.teardownSignal.aborted, false);

    // Await total timer expiration
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Teardown signal must now be aborted automatically by total timer
    assert.equal(budget.teardownSignal.aborted, true);
    assert.equal(budget.isTotalExpired(), true);
  } finally {
    budget.dispose();
  }
});

test('pre-aborted parentSignal enters caller_aborted immediately', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const preReason = new Error('Pre-aborted signal');
  parentController.abort(preReason);

  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    parentSignal: parentController.signal,
  });

  try {
    assert.equal(budget.isCallerAborted(), true);
    assert.equal(budget.isTimedOut(), false);
    assert.equal(budget.status(), 'caller_aborted');
    assert.equal(budget.abortReason(), preReason);
    assert.equal(budget.executionSignal.aborted, true);
    assert.equal(budget.teardownSignal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test('pre-aborted parentSignal with immediate execution expiry preserves caller_aborted (first-event precedence)', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const preReason = new Error('Pre-aborted signal before start');
  parentController.abort(preReason);

  // totalBudgetMs: 100 with default teardown allowance 3000 -> teardownAllowance clamped to 100
  // executionDeadlineMs === startedAtMs (1000), meaning execution expires immediately
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 100,
    parentSignal: parentController.signal,
  });

  try {
    assert.equal(budget.isCallerAborted(), true);
    assert.equal(budget.isTimedOut(), false);
    assert.equal(budget.status(), 'caller_aborted');
    assert.equal(budget.abortReason(), preReason);
    assert.equal(budget.executionSignal.aborted, true);
    assert.equal(budget.teardownSignal.aborted, true);
  } finally {
    budget.dispose();
  }
});

test('caller cancellation during teardown allowance aborts teardownSignal while preserving sticky timed_out status', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 10_000,
    parentSignal: parentController.signal,
  });

  try {
    // Advance past execution deadline (51_000) into teardown phase (remaining: 9_000 ms)
    clock.set(52_000);
    assert.equal(budget.isExecutionExpired(), true);
    assert.equal(budget.status(), 'timed_out');
    assert.equal(budget.executionSignal.aborted, true);
    assert.equal(budget.teardownSignal.aborted, false);

    // Caller now aborts during the teardown allowance
    const callerReason = new Error('Caller cancelled teardown phase');
    parentController.abort(callerReason);

    // Sticky status remains timed_out and isCallerAborted remains false
    assert.equal(budget.status(), 'timed_out');
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.isCallerAborted(), false);

    // But teardownSignal is now aborted with the caller's cancellation reason
    assert.equal(budget.teardownSignal.aborted, true);
    assert.equal(budget.teardownSignal.reason, callerReason);
  } finally {
    budget.dispose();
  }
});

test('caller cancellation after unobserved deadline aborts teardownSignal while preserving sticky timed_out status', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    teardownAllowanceMs: 10_000,
    parentSignal: parentController.signal,
  });

  try {
    // Advance clock past execution deadline without querying budget first
    clock.set(55_000);

    // Parent aborts while execution timeout is unobserved
    const callerReason = new Error('Caller cancelled without query');
    parentController.abort(callerReason);

    // Timeout wins first-event precedence for the execution phase
    assert.equal(budget.status(), 'timed_out');
    assert.equal(budget.isTimedOut(), true);
    assert.equal(budget.isCallerAborted(), false);
    assert.equal(budget.executionSignal.aborted, true);
    assert.equal(budget.abortReason() instanceof ToolError, true);

    // Teardown signal is aborted with caller's cancellation reason
    assert.equal(budget.teardownSignal.aborted, true);
    assert.equal(budget.teardownSignal.reason, callerReason);
  } finally {
    budget.dispose();
  }
});

test('dispose is safe and idempotent', () => {
  const clock = createFakeClock(1000);
  const parentController = new AbortController();
  const budget = createExecutionBudget({
    clock: clock.now,
    totalBudgetMs: 60_000,
    parentSignal: parentController.signal,
  });

  budget.dispose();
  budget.dispose(); // idempotent, no throw

  // Subsequent parent abort does not trigger listeners
  parentController.abort(new Error('Post-dispose abort'));
  assert.equal(budget.isCallerAborted(), false);
});
