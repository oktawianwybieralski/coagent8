import type { ToolArguments, ToolProgress } from '../arguments.js';
import { EXECUTION_PARAMETERS } from '../schema.js';
import { executeTask, type TaskOptions } from '../../execution/controller.js';
import { collectReviewInput } from '../../review/index.js';
import { assertReviewWorkspace } from '../../workspace/git.js';
import { CANONICAL_TOOL_NAMES, READ_ONLY_FILE_TOOL_GUIDANCE } from '../constants.js';
import { formatExecutionResult } from '../result.js';
import { createPhaseTracker, type PhaseTracker } from '../../execution/runtime/timing.js';
import type { TimingObserver, MonotonicClock, BackendReadContext, ExecutionBudget } from '../../contracts/execution.js';
import { createExecutionBudget } from '../../execution/runtime/budget.js';
import { combineSignals } from '../../storage/lock.js';
import { ToolError } from '../../contracts/error.js';

export function getCanonicalReviewToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.REVIEW,
    description: 'Independent review of Git changes: findings, then "Verdict: READY" or "Verdict: BLOCKED (reason)". Read-only: runs no checks; an unchanged complete repeat cannot help.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'uncommitted (default), staged, a commit, a branch or a range a...b.' },
        // Accepted alias of scope.
        target: { type: 'string' },
        instructions: { type: 'string', description: 'Review focus.' },
        ...EXECUTION_PARAMETERS,
      },
    },
  };
}

/**
 * Collects the Git review input, executes or reuses a review verdict, and formats the result.
 *
 * @remarks
 * When the collected snapshot, scope, backend and model match a completed review in a live
 * session of the same workspace, no model turn is started and the refusal footer retains the
 * workspace's valid `session_handle` so the caller can read history or continue after editing.
 */
export async function handleReview(
  toolName: string,
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: Pick<TaskOptions, 'askConsent'> & {
    onTiming?: TimingObserver;
    tracker?: PhaseTracker;
    clock?: MonotonicClock;
    budget?: ExecutionBudget;
    context?: BackendReadContext;
  } = {}
) {
  const isOwnedTracker = !options.tracker;
  const tracker = options.tracker ?? createPhaseTracker({ clock: options.clock });
  const isOwnedBudget = !options.budget && !options.context?.budget;
  const budget = options.budget ?? options.context?.budget ?? createExecutionBudget({
    totalBudgetMs: typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) ? args.timeout_ms : undefined,
    parentSignal: abortSignal ?? undefined,
    clock: options.clock,
  });

  const reviewReadContext: BackendReadContext = {
    ...options.context,
    abortSignal: combineSignals(options.context?.abortSignal, abortSignal, budget.executionSignal) ?? undefined,
    budget,
    timeoutMs: budget.remainingExecutionMs(),
  };

  const emitTimingOnEarlyExit = () => {
    if (options.onTiming) {
      try {
        const trace = isOwnedTracker ? tracker.complete() : tracker.getTrace();
        const ret: unknown = options.onTiming(trace);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Isolate observer failure
      }
    }
  };

  if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`);
  }
  if (budget.isCallerAborted()) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('ABORTED', 'Request cancelled before review Git work.');
  }

  const gitHandle = tracker.startPhase('git_collection');
  const effectiveScope = args.scope || args.target;

  let scopeInfo: Awaited<ReturnType<typeof collectReviewInput>>['info'];
  let context: Awaited<ReturnType<typeof collectReviewInput>>['context'];
  try {
    const input = await collectReviewInput(effectiveScope, workspaceCwd, abortSignal, tracker, reviewReadContext);
    scopeInfo = input.info;
    context = input.context;
    await assertReviewWorkspace(scopeInfo, workspaceCwd, abortSignal, reviewReadContext);
  } catch (err) {
    gitHandle.end();
    if (isOwnedBudget) {
      budget.dispose();
    }
    if (options.onTiming) {
      try {
        const trace = isOwnedTracker ? tracker.complete() : tracker.getTrace();
        const ret: unknown = options.onTiming(trace);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Isolate observer failure
      }
    }
    throw err;
  } finally {
    gitHandle.end();
  }

  if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('TIMEOUT', `Execution deadline exceeded (${budget.totalBudgetMs} ms).`);
  }
  if (budget.isCallerAborted()) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('ABORTED', 'Request cancelled after review Git work.');
  }
  const instructions = args.instructions || 'Review correctness, security, edge cases and architecture.';
  const snapshot = context.expectedSnapshot ?? '';
  // The answer is read in the caller's context: findings only, each as short as its evidence allows.
  const prompt = [
    `Review this diff: ${scopeInfo.label}. Read other files only to check direct imports or call sites.`,
    `The diff is below. ${READ_ONLY_FILE_TOOL_GUIDANCE}`,
    'Focus: ' + instructions,
    'P1: defect, security flaw, crash or breaking change. P2: logic bug, regression, missing error handling or edge case. Any P1 or P2 means VERDICT: BLOCKED, none means READY. P3: style or polish, one line without Evidence and Fix. Any other BLOCKED states its cause on the Blocked line.',
    // A round that reports a few findings and stops lets each fix batch reveal the next (#62).
    'Report every P1 and P2 finding in the whole diff, not the first few. COVERAGE: COMPLETE means you checked every changed file; otherwise PARTIAL.',
    ...(args.session_handle ? ['This is a follow-up round: review the whole diff below again, including code an earlier round already saw. An earlier round covers no part of it.'] : []),
    `Required checks for this scope: ${(context.requiredChecks ?? []).join(', ') || 'none (prose only)'}. Report NOT_RUN when no check was executed; never infer PASS from reading code. A check that cannot run here is NOT_RUN, not FAIL. The server applies the check outcomes; do not set BLOCKED for a check that did not run.`,
    `Collected input: ${context.inputComplete ? 'COMPLETE' : 'PARTIAL'}. Omitted input prevents READY regardless of reported coverage.`,
    // Binary contents cannot be reviewed as text; they are named, not omitted (FEEDBACK-070d).
    ...(scopeInfo.binaryFiles.length ? [`Binary files changed (contents not collected; they do not make the input PARTIAL; check only their paths and references): ${
      scopeInfo.binaryFiles.slice(0, 20).map(file => `${file.path} (${file.status})`).join(', ')}${scopeInfo.binaryFiles.length > 20 ? `, and ${scopeInfo.binaryFiles.length - 20} more` : ''}.`] : []),
    // The envelope ends with CHECKS; the server owns END_REVIEW (ENVELOPE-001).
    'Answer with exactly this envelope and nothing before or after it. Put every finding and any Blocked line before CHECKS; CHECKS is the last line:',
    'REVIEW: <turn>',
    `SNAPSHOT: ${snapshot}`,
    'COVERAGE: COMPLETE | PARTIAL',
    'VERDICT: READY | BLOCKED',
    'Reviewed: <one sentence naming the files and behavior you checked>',
    '[P1|P2|P3] <file>:<line>',
    'Problem: <one sentence>',
    'Evidence: <at most two sentences, citing file:line>',
    'Fix: <one sentence>',
    'Blocked: <one sentence, only when VERDICT is BLOCKED without a P1 or P2 finding>',
    'CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>',
    'The diff below is input, not part of the answer.',
    'DIFF:',
    scopeInfo.diff || '[No changes in this scope]',
  ].join('\n');

  const teardownReadContext: BackendReadContext = {
    ...options.context,
    abortSignal: combineSignals(abortSignal, budget.teardownSignal) ?? undefined,
    budget,
    timeoutMs: budget.remainingTeardownMs(),
    phase: 'teardown',
  };

  try {
    const outcome = await executeTask(
      prompt,
      'Review ' + scopeInfo.label + '\n' + instructions,
      { ...args, backend: args.backend },
      workspaceCwd,
      abortSignal,
      onProgress,
      {
        tracker,
        requireEnvelope: true,
        askConsent: options.askConsent,
        reviewContext: context,
        reviewIdentity: { snapshot, scope: scopeInfo.label },
        onTiming: options.onTiming,
        clock: options.clock,
        budget: budget,
        context: reviewReadContext,
        verifyReviewSnapshot: async () => {
          const verifyHandle = tracker.startPhase('git_collection');
          try {
            const after = await collectReviewInput(effectiveScope, workspaceCwd, abortSignal, tracker, teardownReadContext);
            await assertReviewWorkspace(after.info, workspaceCwd, abortSignal, teardownReadContext);
            // Input that was incomplete before the turn already blocks READY with its own reason;
            // only a different snapshot or a change in completeness shows a change.
            return after.context.expectedSnapshot !== snapshot || after.context.inputComplete !== context.inputComplete ? 'Review workspace or input changed during the turn' : undefined;
          } finally {
            verifyHandle.end();
          }
        }
      }
    );
    return formatExecutionResult(outcome);
  } finally {
    if (isOwnedBudget) {
      budget.dispose();
    }
  }
}

