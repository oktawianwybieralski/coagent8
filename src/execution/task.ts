/**
 * One entry for every backend turn: consult, review and delegate turns.
 *
 * @remarks
 * A role is data: the fixed {@link TaskOptions} it sets on every turn. Everything a caller
 * passes besides that stays its own (prompt, arguments, budget, review binding, write scope),
 * and server policy around a role (the review gate input, the writer lease, worker groups,
 * the delegate loop) stays in its own code (#209).
 *
 * @packageDocumentation
 */

import { combineSignals } from '../storage/lock.js';
import { ToolError } from '../contracts/error.js';
import type {
  BackendReadContext,
  ExecutionBudget,
  MonotonicClock,
  TaskExecutionResult,
  TaskRole,
  TimingObserver,
} from '../contracts/execution.js';
import { executeTask, type ExecutionRequest, type TaskOptions } from './controller.js';
import { ensureHostConsent, type HostConsentPrompt } from './host-consent.js';
import { jobHelperPath } from './job-helper.js';
import { requiredJobHelperObserver, withRequiredJobHelper } from './process.js';
import { createExecutionBudget } from './runtime/budget.js';
import { createPhaseTracker, type PhaseTracker } from './runtime/timing.js';

export type { TaskRole };

/** The options a role fixes for every turn; a caller cannot set them. */
export type RolePolicy = Readonly<Pick<TaskOptions, 'requireEnvelope'>>;

/** Options the runner sets on every turn: the role's policy and the role itself. */
export type RunnerOptions = keyof RolePolicy | 'role' | 'treeUnconfirmed';

/** What each role sets on its turns. */
export const ROLE_POLICIES: Readonly<Record<TaskRole, RolePolicy>> = Object.freeze({
  consult: Object.freeze({ requireEnvelope: false }),
  review: Object.freeze({ requireEnvelope: true }),
  delegate: Object.freeze({}),
});

/** Options a caller passes to a turn of a role, without those the role fixes. */
export type RoleTaskOptions = Omit<TaskOptions, RunnerOptions>;

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
  /** Asks for host execution when the user has not accepted it yet (#211). */
  askHostConsent?: HostConsentPrompt;
}

/**
 * Runs one backend turn of a role.
 * @param role - The role whose fixed options the turn gets.
 * @param request - The turn.
 * @param execute - The controller; replaceable by tests.
 * @returns The turn's result.
 * @throws `POLICY_DENIED` without the user's consent to host execution; no turn starts.
 */
export async function runTask(
  role: TaskRole,
  request: TaskRequest,
  execute: typeof executeTask = executeTask,
): Promise<TaskExecutionResult> {
  // A turn's descendants must end with it: without a sandbox they could otherwise keep running.
  if (process.platform === 'win32' && !jobHelperPath()) {
    throw new ToolError(
      'SANDBOX_UNAVAILABLE',
      `${role} needs the Windows job helper, which is missing or failed its digest check. Reinstall CoAgent8; in a source checkout run cargo build --release in native/coagent8-job.`,
    );
  }
  await ensureHostConsent(request.askHostConsent, request.abortSignal);
  // On Windows every process of the turn starts inside the helper's job. A tree the helper could
  // not confirm ended is told to this turn, which then cannot judge READY or be remembered, and to
  // the writer around it, if any, which then keeps its lease (#211 review).
  let treeUnconfirmed = false;
  const outer = requiredJobHelperObserver();
  const turn = () =>
    execute(request.prompt, request.publicInput, request.args, request.cwd, request.abortSignal, request.onProgress, {
      ...request.options,
      ...ROLE_POLICIES[role],
      role,
      treeUnconfirmed: () => treeUnconfirmed,
    });
  const run = () =>
    process.platform !== 'win32'
      ? turn()
      : withRequiredJobHelper(turn, () => {
          treeUnconfirmed = true;
          outer?.();
        });
  return run().catch((err: unknown) => {
    throw withBudget(err, request.options?.budget?.totalBudgetMs ?? request.args.timeout_ms);
  });
}

/**
 * A timeout names the call's budget, wherever it struck: a probe or a lock wait reports its own
 * phase without it, and the caller needs the number to choose a longer one.
 */
export function withBudget(err: unknown, budgetMs: unknown): unknown {
  if (!(err instanceof ToolError) || err.code !== 'TIMEOUT' || typeof budgetMs !== 'number' || !Number.isFinite(budgetMs)) return err;
  if (err.message.includes(`${Math.floor(budgetMs)} ms`)) return err;
  return new ToolError('TIMEOUT', `${err.message} The call's budget was ${Math.floor(budgetMs)} ms.`, { cause: err });
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
