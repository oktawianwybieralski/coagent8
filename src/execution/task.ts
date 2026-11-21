/**
 * One entry for every backend turn: consult, review, delegate and coordinator turns.
 *
 * @remarks
 * A role is data: the fixed {@link TaskOptions} it sets on every turn. Everything a caller
 * passes besides that stays its own (prompt, arguments, budget, review binding, write scope),
 * and server policy around a role (the review gate input, the writer lease, worker groups,
 * the coordination loop) stays in its own code (#209).
 *
 * @packageDocumentation
 */

import { combineSignals } from '../storage/lock.js';
import { ToolError } from '../contracts/error.js';
import type { BackendReadContext, ExecutionBudget, MonotonicClock, TaskExecutionResult, TimingObserver } from '../contracts/execution.js';
import { executeTask, type ExecutionRequest, type TaskOptions } from './controller.js';
import { createExecutionBudget } from './runtime/budget.js';
import { createPhaseTracker, type PhaseTracker } from './runtime/timing.js';

/** The kinds of turn the server runs. */
export type TaskRole = 'consult' | 'review' | 'delegate' | 'coordinate';

/** The options a role fixes for every turn; a caller cannot set them. */
type RolePolicy = Readonly<Pick<TaskOptions, 'requireEnvelope' | 'profile' | 'coordinatorTurn'>>;

/** What each role sets on its turns. */
export const ROLE_POLICIES: Readonly<Record<TaskRole, RolePolicy>> = Object.freeze({
  consult: Object.freeze({ requireEnvelope: false }),
  review: Object.freeze({ requireEnvelope: true }),
  delegate: Object.freeze({ profile: 'workspace-write' }),
  coordinate: Object.freeze({ requireEnvelope: false, coordinatorTurn: true }),
});

/** Options a caller passes to a turn of a role, without those the role fixes. */
export type RoleTaskOptions = Omit<TaskOptions, keyof RolePolicy>;

/** One backend turn of a role. */
export interface TaskRequest {
  /** The prompt the backend receives. */
  prompt: string;
  /** The request as the public history records it. */
  publicInput: string;
  args: ExecutionRequest;
  /** The workspace the turn runs in. */
  cwd: string;
  abortSignal?: AbortSignal | null;
  onProgress?: ((info: { message?: string }) => void) | null;
  options?: RoleTaskOptions;
}

/**
 * Runs one backend turn of a role.
 * @param role - The role whose fixed options the turn gets.
 * @param request - The turn.
 * @param execute - The controller; replaceable by tests.
 * @returns The turn's result.
 */
export function runTask(role: TaskRole, request: TaskRequest, execute: typeof executeTask = executeTask): Promise<TaskExecutionResult> {
  return execute(request.prompt, request.publicInput, request.args, request.cwd, request.abortSignal, request.onProgress, {
    ...request.options,
    ...ROLE_POLICIES[role],
  });
}

/** What a tool call shares with the caller: its budget, trace and observer. */
export interface CallScopeOptions {
  onTiming?: TimingObserver;
  tracker?: PhaseTracker;
  clock?: MonotonicClock;
  budget?: ExecutionBudget;
  context?: BackendReadContext;
}

/** The budget and trace of one tool call and how it ends before a turn. */
export interface CallScope {
  budget: ExecutionBudget;
  tracker: PhaseTracker;
  /** The read context of the call, bound to its budget and the caller's signal. */
  readContext: BackendReadContext;
  /** Ends the call before a turn: frees an owned budget and reports the trace. */
  close: () => void;
  /** Ends the call with `TIMEOUT` or `ABORTED` when its budget ran out or the caller cancelled. */
  assertLive: (abortMessage: string) => void;
  /** Frees the budget when the call owns it. */
  dispose: () => void;
}

/**
 * Opens a tool call's budget and trace: those the caller passed, or the call's own.
 * @param timeoutMs - The call's `timeout_ms` argument.
 * @param abortSignal - The caller's signal.
 * @param options - What the caller shares.
 * @returns The scope.
 */
export function openCallScope(timeoutMs: unknown, abortSignal: AbortSignal | null, options: CallScopeOptions): CallScope {
  const isOwnedTracker = !options.tracker;
  const tracker = options.tracker ?? createPhaseTracker({ clock: options.clock });
  const isOwnedBudget = !options.budget && !options.context?.budget;
  const budget =
    options.budget ??
    options.context?.budget ??
    createExecutionBudget({
      totalBudgetMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      parentSignal: abortSignal ?? undefined,
      clock: options.clock,
    });
  const readContext: BackendReadContext = {
    ...options.context,
    abortSignal: combineSignals(options.context?.abortSignal, abortSignal, budget.executionSignal) ?? undefined,
    budget,
    timeoutMs: budget.remainingExecutionMs(),
  };
  const dispose = () => {
    if (isOwnedBudget) budget.dispose();
  };
  const close = () => {
    dispose();
    if (!options.onTiming) return;
    try {
      const trace = isOwnedTracker ? tracker.complete() : tracker.getTrace();
      const ret: unknown = options.onTiming(trace);
      if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
        (ret as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Isolate observer failure
    }
  };
  const assertLive = (abortMessage: string) => {
    if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
      close();
      throw new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`);
    }
    if (budget.isCallerAborted()) {
      close();
      throw new ToolError('ABORTED', abortMessage);
    }
  };
  return { budget, tracker, readContext, close, assertLive, dispose };
}
