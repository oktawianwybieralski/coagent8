/**
 * Synchronous write delegation (`DELEGATE-001w`): one `workspace-write` turn with the
 * workspace's writer slot held and its Git state compared before and after.
 *
 * @remarks
 * The order is: Git work tree check, writer slot, snapshot, turn, snapshot, release. The slot
 * is taken before consent and session acquisition, so a second writer is refused before it
 * asks the user anything. The second snapshot runs after failed, cancelled and timed-out turns
 * too, with its own Git deadlines instead of the call's spent budget; a failed snapshot is
 * reported in the result instead of replacing it, and so is a failed release.
 *
 * Asynchronous delegation (`DELEGATE-001e`) runs the same operation under its own cancellation
 * and deadline. The call returns once the backend turn starts, so consent still uses the open
 * request and a refusal is still the call's error. The result is persisted before the slot is
 * released, and a waiter sees it only then.
 *
 * @packageDocumentation
 */
import crypto from 'node:crypto';
import { errorCodeOf, ToolError, type TaskExecutionResult, type WorkspaceChanges } from '../contracts/index.js';
import {
  MAX_ASYNC_TIMEOUT_MS,
  type BackendReadContext,
  type ExecutionBudget,
  type ExecutionLimits,
  type RootLimits,
  type TaskRole,
  type TimeoutBound,
} from '../contracts/execution.js';
import { loadConfig, resolveExecutionLimits, resolveTurnTimeout } from '../config.js';
import { redactDiagnostic } from '../security/index.js';
import { isRecordedProcessAlive, ownProcessIdentity } from '../sessions/activity.js';
import { cancelSession } from '../sessions/session.js';
import { acquireWriterLease } from '../sessions/writer.js';
import { createExecutionBudget } from './runtime/budget.js';
import { jobHelperPath } from './job-helper.js';
import { withRequiredJobHelper, withWorkerGroups } from './process.js';
import {
  claimTaskRequest,
  createTaskHandle,
  pruneTasks,
  readTask,
  writeFinalTask,
  writeTask,
  type DelegationTask,
} from '../sessions/tasks.js';
import {
  bindRootTask,
  cancelRoot,
  createRoot,
  endRootTask,
  findRootOfSession,
  findRootOfTask,
  isRootTaskServerAlive,
  pruneRoots,
  readRoot,
  refundRootTask,
  removeUnusedRoot,
  reserveRootCall,
  rootGraceMinutes,
  rootTimeLimitError,
  touchRootTask,
  reserveRootTask,
  ROOT_SEEN_TICKS,
  ROOT_WATCH_MS,
} from '../sessions/roots.js';
import {
  captureWorkspace,
  compareWorkspace,
  readWorkspaceRepository,
  resolveWriteClaim,
  type WorkspaceSnapshot,
} from '../workspace/changes.js';
import { canonicalPath } from '../workspace/identity.js';
import { setTaskCanceller, type ExecutionRequest, type TaskOptions } from './controller.js';
import { runTask } from './task.js';

/** Why a loop stops or cannot pass when a worker's process tree was not confirmed ended. */
export const UNCONFIRMED_WORKER_TREE =
  'The end of a worker process tree could not be confirmed, so a process may still change the work tree; the loop does not pass.';

/**
 * Runs one delegated write turn.
 * @param scope - Normalized workspace-relative scope entries; empty means the whole workspace.
 * @returns The turn's result with the observed changes.
 * @throws `INPUT_LIMIT` outside a Git work tree, `SESSION_BUSY` while another writer holds the
 * workspace, and every refusal `executeTask` raises before a turn starts.
 */
export async function executeDelegation(
  prompt: string,
  publicInput: string,
  args: ExecutionRequest,
  cwd: string,
  scope: readonly string[],
  abortSignal?: AbortSignal | null,
  onProgress?: ((info: { message?: string }) => void) | null,
  options: TaskOptions & {
    beforeRelease?: (outcome: TaskExecutionResult) => Promise<void>;
    supervise?: Supervise;
    /** Longest turn of a later round; replaceable by tests. */
    loopTurnMs?: number;
    /** Hold the whole work tree whatever the scope: the loop's checks and review read all of it. */
    exclusive?: boolean;
    /** Runs just before every backend turn after the first; a refusal fails that turn before it starts. */
    beforeRound?: () => Promise<void>;
    /** Asks what the user must settle, with the writer held so that an overlapping start asks nothing. */
    approveStart?: (signal: AbortSignal | null) => Promise<void>;
    /** Told the writer record once it is held. */
    onWriter?: (writer: { file: string; token: string }) => void;
    /** Told when a worker's process tree may have outlived its run, so what it held stays held. */
    onTreeUnconfirmed?: () => void;
  } = {},
): Promise<TaskExecutionResult> {
  const {
    beforeRelease,
    supervise,
    loopTurnMs = LOOP_TURN_MS,
    exclusive = false,
    beforeRound,
    approveStart,
    onWriter,
    onTreeUnconfirmed,
    ...taskOptions
  } = options;
  // A writer's descendants must end with its run; without the helper they could keep writing.
  if (process.platform === 'win32' && !jobHelperPath()) {
    throw new ToolError(
      'SANDBOX_UNAVAILABLE',
      'delegate needs the Windows job helper, which is missing or failed its digest check. Reinstall CoAgent8; in a source checkout run cargo build --release in native/coagent8-job.',
    );
  }
  const repo = await readWorkspaceRepository(cwd, options.context).catch(err => {
    if (err instanceof ToolError && ['ABORTED', 'TIMEOUT'].includes(err.code)) throw err;
    throw new ToolError('INPUT_LIMIT', 'delegate needs a Git work tree, so the server can report what changed; run it in a repository.');
  });
  // Resolved also when the loop holds the whole tree: this is what refuses an escaping scope.
  const claim = resolveWriteClaim(repo, scope);
  const lease = await acquireWriterLease(repo.gitDir, undefined, exclusive ? [] : claim);
  onWriter?.({ file: lease.file, token: lease.token });
  let outcome: TaskExecutionResult | undefined;
  let treeUnconfirmed = false;
  try {
    // The task's own signal: its cancellation and deadline close the form, and the writer is not held by it.
    const approvalSignal = options.budget?.executionSignal ?? abortSignal ?? null;
    try {
      await approveStart?.(approvalSignal);
    } catch (err) {
      if (approvalSignal?.aborted) {
        throw approvalSignal.reason instanceof ToolError
          ? approvalSignal.reason
          : new ToolError('ABORTED', 'The delegation was cancelled while waiting for the user.');
      }
      throw err;
    }
    const before: WorkspaceSnapshot = await captureWorkspace(cwd, repo, options.context);
    const turn = (text: string, turnArgs: ExecutionRequest, turnOptions: typeof taskOptions) =>
      runTask('delegate', {
        prompt: text,
        publicInput,
        args: turnArgs,
        cwd,
        abortSignal,
        onProgress,
        options: {
          ...turnOptions,
          // An adapter's own recovery turn is a backend turn too, in the first turn as in a later one.
          ...(beforeRound ? { beforeExtraTurn: beforeRound } : {}),
          writeScope: scope,
        },
      });
    const runSupervised = async () => {
      const first = await turn(prompt, args, taskOptions);
      if (!supervise) return first;
      // A worker process that may still run could change the tree after the checks and the review,
      // so no loop starts on it and none passes after it (#211 review).
      const unconfirmed = (result: TaskExecutionResult): TaskExecutionResult => ({
        ...result,
        loop: { ...(result.loop ?? { fixRounds: 0, checks: [] }), outcome: 'worker_failed', detail: UNCONFIRMED_WORKER_TREE },
      });
      if (treeUnconfirmed) return unconfirmed(first);
      // Each later turn has its own bound within what is left of the task's budget.
      const inRound: Supervision['inRound'] = async run => {
        const remainingMs = Math.min(loopTurnMs, options.budget?.remainingExecutionMs() ?? Number.POSITIVE_INFINITY);
        if (remainingMs <= 0) throw new ToolError('TIMEOUT', 'The task budget ended before the next turn.');
        const budget = createExecutionBudget({
          totalBudgetMs: remainingMs,
          parentSignal: abortSignal ?? undefined,
          clock: options.clock,
        });
        try {
          return await run({
            budget,
            context: { abortSignal: budget.executionSignal, budget, timeoutMs: budget.remainingExecutionMs() },
            onTurnStart: beforeRound,
            beforeExtraTurn: beforeRound,
          });
        } finally {
          budget.dispose();
        }
      };
      const supervised = await supervise(first, {
        signal: abortSignal ?? null,
        budget: options.budget,
        context: options.context,
        inRound,
        // The call that could show a form has ended: a model that needs approval is refused.
        fix: text =>
          inRound(round =>
            turn(text, { ...args, session_handle: first.sessionHandle ?? undefined }, { ...taskOptions, ...round, askConsent: undefined }),
          ),
      });
      return treeUnconfirmed && supervised.loop?.outcome === 'passed' ? unconfirmed(supervised) : supervised;
    };
    const runGrouped = () => withWorkerGroups(runSupervised, lease);
    outcome = await (process.platform === 'win32'
      ? withRequiredJobHelper(runGrouped, () => {
          treeUnconfirmed = true;
          onTreeUnconfirmed?.();
        })
      : runGrouped());
    let changes: WorkspaceChanges;
    try {
      changes = await compareWorkspace(cwd, repo, before, await captureWorkspace(cwd, repo), scope, undefined, lease.peerClaims());
    } catch (err) {
      changes = {
        changed: [],
        outsideScope: [],
        dirtyBefore: [],
        truncated: false,
        unavailable: redactDiagnostic((err as Error).message, 256),
      };
    }
    outcome = { ...outcome, changes };
    // A worker that was denied and changed nothing may still report a normal end (#127).
    const ownChanges = changes.changed.filter(change => !changes.possiblyOtherWriter?.includes(change.path));
    if (outcome.result.denials?.length && !ownChanges.length && !changes.unavailable) {
      const seen = changes.changed.length
        ? 'The worker was denied access, and the only changes seen are in paths another worker held, so either may have changed them.'
        : 'The worker was denied access and changed no file.';
      outcome = {
        ...outcome,
        warnings: [...(outcome.warnings ?? []), seen],
      };
    }
    if (treeUnconfirmed) {
      outcome = {
        ...outcome,
        warnings: [
          ...(outcome.warnings ?? []),
          'The end of the worker process tree could not be confirmed, so this work tree stays reserved until this CoAgent8 server restarts.',
        ],
      };
    }
    await beforeRelease?.(outcome);
    return outcome;
  } finally {
    try {
      // A process that may still run could still write: the slot then ends with this server.
      if (!treeUnconfirmed) await lease.release();
    } catch (err) {
      const warning = `The workspace writer slot was not released: ${redactDiagnostic((err as Error).message, 256)}`;
      // Without a result the call's own error is reported; the failed release goes to the log.
      if (outcome) outcome.warnings.push(warning);
      else process.stderr.write(`Warning: ${warning}\n`);
    }
  }
}

/** Operations of asynchronous delegations in this server, awaited at shutdown. */
const activeDelegations = new Map<Promise<unknown>, { controller: AbortController; rootHandle: string }>();

type ActiveDelegationEntry = {
  controller: AbortController;
  settled: Promise<boolean>;
  workspace: string;
};

/**
 * The running task of each worker session, so a cancel can abort the task and wait for its final state (#136).
 * Settles with whether that state was stored.
 */
const delegationBySession = new Map<string, ActiveDelegationEntry>();
const delegationByTask = new Map<string, ActiveDelegationEntry>();

/** How long a cancel waits for the delegation to store its final state. */
const CANCEL_SETTLE_MS = 15 * 1000;

/** How a cancelled delegation ended, as `awaitDelegation` reports it. */
export type DelegationSettlement = 'stored' | 'unstored' | 'pending' | 'none';

async function waitDelegationEntry(settled: Promise<boolean>, waitMs = CANCEL_SETTLE_MS): Promise<DelegationSettlement> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'pending'>(resolve => {
    timer = setTimeout(() => resolve('pending'), waitMs);
  });
  try {
    return await Promise.race([settled.then(stored => (stored ? ('stored' as const) : ('unstored' as const))), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

setTaskCanceller(async (sessionHandle: string) => {
  const entry = delegationBySession.get(sessionHandle);
  if (!entry) return 'none';
  entry.controller.abort();
  const outcome = await waitDelegationEntry(entry.settled);
  return outcome === 'pending' ? 'timed_out' : 'settled';
});

/**
 * Finds the delegation of a session, to wait for after a cancel. Call it before cancelling: one
 * that ends during the cancel still reports its outcome.
 * @returns A wait that starts its bound when called, so a slow cancel does not shorten it.
 */
export function captureDelegation(sessionHandle: string): (waitMs?: number) => Promise<DelegationSettlement> {
  const entry = delegationBySession.get(sessionHandle);
  return async (waitMs = CANCEL_SETTLE_MS) => {
    if (!entry) return 'none';
    return waitDelegationEntry(entry.settled, waitMs);
  };
}

/**
 * Cancels an active background task (`delegate`, `review`, or `consult`) by its `taskHandle`,
 * aborting its entire controller and waiting for its final state to be stored.
 * @param taskHandle - Task handle to cancel.
 * @param workspace - Optional workspace path; rejects mismatches against the recorded task workspace.
 * @returns Cancellation status and human-readable summary.
 * @throws `INPUT_LIMIT` for a malformed handle, or an error when the workspace mismatches or another live server owns the task.
 */
export async function cancelTaskHandle(taskHandle: string, workspace?: string): Promise<{ cancelled: boolean; message: string }> {
  if (!/^task_[a-f0-9]{32}$/.test(taskHandle)) {
    throw new ToolError('INPUT_LIMIT', `Invalid task handle: '${redactDiagnostic(taskHandle, 80)}'.`);
  }
  const active = delegationByTask.get(taskHandle);
  const recorded = readTask(taskHandle);
  const taskWorkspace = active?.workspace ?? recorded?.workspace;
  if (workspace && taskWorkspace && canonicalPath(taskWorkspace) !== canonicalPath(workspace)) {
    throw new Error('Task workspace mismatch.');
  }
  if (active) {
    active.controller.abort();
    const settled = await waitDelegationEntry(active.settled);
    if (settled === 'pending') {
      return { cancelled: true, message: `Task '${taskHandle}' cancellation requested; final state is not stored yet.` };
    }
    if (settled === 'unstored') {
      return {
        cancelled: true,
        message: `Task '${taskHandle}' ended, but its final state could not be stored: check the work tree with git status.`,
      };
    }
    return { cancelled: true, message: `Task '${taskHandle}' execution cancelled and final state stored.` };
  }
  if (!recorded) return { cancelled: false, message: `Task '${taskHandle}' not found.` };
  if (recorded.state !== 'running') {
    return { cancelled: false, message: `Task '${taskHandle}' already ended (${recorded.state}); nothing to cancel.` };
  }
  if (recorded.serverPid !== process.pid && isRecordedProcessAlive(recorded.serverPid, recorded.serverIdentity)) {
    throw new Error(`Cannot cancel task '${taskHandle}': actively running in another CoAgent8 server process (PID ${recorded.serverPid}).`);
  }
  if (recorded.sessionHandle) return cancelSession(recorded.sessionHandle, workspace);
  return { cancelled: false, message: `Task '${taskHandle}' has no active local controller; nothing to cancel.` };
}

export function stopActiveDelegations(): Promise<unknown> {
  for (const { controller } of activeDelegations.values()) controller.abort();
  return Promise.allSettled([...activeDelegations.keys()]);
}

/** Reads of a root that may fail in a row before its worker is stopped: a root nobody can read cannot cancel it. */
const ROOT_WATCH_FAILURES = 5;
// ROOT_WATCH_MS and ROOT_SEEN_TICKS come from the roots, which charge a clock set back by that note interval.
const ROOT_SETTLE_POLL_MS = 100;
/** Attempts to mark a task ended in its root, so a passing failure does not keep its place. */
const ROOT_END_ATTEMPTS = 3;
const ROOT_END_RETRY_MS = 200;

/** What a root's cancellation reached. */
export interface RootCancellation {
  /** Ended tasks of the root. */
  ended: string[];
  /** Tasks still running when the wait ended. */
  running: string[];
  /** Tasks whose server process died while their turn may have run: on POSIX their processes can outlive it. */
  interrupted: string[];
}

/**
 * Cancels a root: no task starts from here on, this server's tasks stop at once and every other
 * server process's within its next look at the root. Nothing here signals a process by a recorded PID.
 * @returns What the tasks did within the wait.
 * @throws `SESSION_INVALID` when this data directory has no such root.
 */
export async function cancelRootTasks(rootHandle: string, waitMs = CANCEL_SETTLE_MS): Promise<RootCancellation> {
  await cancelRoot(rootHandle);
  for (const active of activeDelegations.values()) {
    if (active.rootHandle === rootHandle) active.controller.abort();
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const root = readRoot(rootHandle);
    const tasks = root?.tasks ?? [];
    // A task leaves the root just before its final state is stored: a read after this cancel must find that state.
    const running = tasks.filter(task => isRootTaskServerAlive(task) && (!task.endedAt || readTask(task.taskHandle)?.state === 'running'));
    if (!running.length || Date.now() >= deadline) {
      return {
        ended: tasks.filter(task => task.endedAt && !running.includes(task)).map(task => task.taskHandle),
        running: running.map(task => task.taskHandle),
        // Without a session the turn had not started, as the session is bound just before it.
        interrupted: tasks.filter(task => !task.endedAt && !isRootTaskServerAlive(task) && task.sessionHandle).map(task => task.taskHandle),
      };
    }
    await new Promise(resolve => setTimeout(resolve, ROOT_SETTLE_POLL_MS));
  }
}

/**
 * Finds the root of a request: the named one, or that of its parent or of the session it continues.
 * @returns The root, or null when the request starts a new one.
 * @throws `SESSION_INVALID` for a root or parent this data directory does not have, `INPUT_LIMIT`
 * when they name different roots.
 */
function requestedRoot(start: Pick<BackgroundTaskStart, 'root' | 'args'>): string | null {
  const named = start.root?.handle;
  if (named && !readRoot(named)) throw new ToolError('SESSION_INVALID', `No root ${named.slice(0, 80)} in this data directory.`);
  const parent = start.root?.parentTask;
  const ofParent = parent ? findRootOfTask(parent)?.rootHandle : undefined;
  if (parent && !ofParent) throw new ToolError('SESSION_INVALID', `No task ${parent.slice(0, 80)} in a root of this data directory.`);
  const session = start.args.session_handle;
  const ofSession = typeof session === 'string' ? findRootOfSession(session)?.rootHandle : undefined;
  const roots = new Set([named, ofParent, ofSession].filter((root): root is string => Boolean(root)));
  if (roots.size > 1) throw new ToolError('INPUT_LIMIT', 'root_handle, parent_task and session_handle name different roots.');
  return [...roots][0] ?? null;
}

/** Longest turn of a later round of the loop, fix or review. */
const LOOP_TURN_MS = MAX_ASYNC_TIMEOUT_MS;

/** What a supervisor gets to work with. */
export interface Supervision {
  signal: AbortSignal | null;
  budget?: TaskOptions['budget'];
  context?: TaskOptions['context'];
  /** Runs one turn under its own bound. */
  inRound: <T>(
    run: (round: {
      budget: NonNullable<TaskOptions['budget']>;
      context: NonNullable<TaskOptions['context']>;
      /** Pass to the turn, so it runs just before each backend turn of the round. */
      onTurnStart: (() => Promise<void>) | undefined;
      /** Pass to the turn too, for a recovery turn its adapter starts. */
      beforeExtraTurn: (() => Promise<void>) | undefined;
    }) => Promise<T>,
  ) => Promise<T>;
  fix: (prompt: string) => Promise<TaskExecutionResult>;
}

/** Supervises a change after the worker's first turn, with the writer held; returns the last result. */
export type Supervise = (first: TaskExecutionResult, turn: Supervision) => Promise<TaskExecutionResult>;

/** A started task, or how a call ended before a turn started. */
export type TaskCompletion = { task: DelegationTask } | { outcome: TaskExecutionResult };

/** Runtime environment passed by {@link startBackgroundTask} to the underlying role runner. */
export interface BackgroundTaskRunEnv {
  signal: AbortSignal;
  budget: ExecutionBudget;
  context: BackendReadContext;
  onTurnStart: NonNullable<TaskOptions['onTurnStart']>;
  beforeRound: () => Promise<void>;
  onWriter: (writer: { file: string; token: string }) => void;
  onTreeUnconfirmed: () => void;
  beforeRelease: (outcome: TaskExecutionResult) => Promise<void>;
}

/** A request for one asynchronous task (`delegate`, `review`, or `consult`). */
export interface BackgroundTaskStart {
  role: TaskRole;
  publicInput: string;
  args: ExecutionRequest;
  cwd: string;
  scope: readonly string[];
  /** Request-specific payload (e.g. prompt) hashed with `request_id` to detect mismatched reuse. */
  fingerprintInput?: unknown;
  /** The caller's id for this start; a repeat returns the existing task. */
  requestId?: string;
  /** Aborts the start until the turn runs; afterwards the request no longer owns the task. */
  requestSignal?: AbortSignal | null;
  /** Caller's pre-launch budget from server setup, so elapsed setup time is deducted cleanly. */
  callerBudget?: ExecutionBudget;
  /** The root to join and the parent to name; without either a new root starts with `limits`. */
  root?: { handle?: string; parentTask?: string; limits?: Partial<RootLimits> };
  /** Configured turn timeout limits; defaults to `resolveExecutionLimits(loadConfig())`. */
  limits?: Partial<ExecutionLimits>;
  /** Formats the outcome the way the tool returns it. */
  format: (outcome: TaskExecutionResult) => { text: string; isError: boolean };
  options: Pick<TaskOptions, 'askConsent' | 'requireEnvelope' | 'warnings' | 'clock'>;
  /** Executes the role's operation under the task's budget, signal, and hooks. */
  run: (env: BackgroundTaskRunEnv) => Promise<TaskExecutionResult>;
}

/** A request for one asynchronous delegation. */
export interface DelegationStart {
  prompt: string;
  publicInput: string;
  args: ExecutionRequest;
  cwd: string;
  scope: readonly string[];
  /** The caller's id for this start; a repeat returns the existing task. */
  requestId?: string;
  /** Aborts the start until the turn runs; afterwards the request no longer owns the worker. */
  requestSignal?: AbortSignal | null;
  /** Caller's pre-launch budget from server setup, so elapsed setup time is deducted cleanly. */
  callerBudget?: ExecutionBudget;
  /** Asks what must be settled before a new task starts, after a repeated request id was ruled out. */
  approve?: (signal: AbortSignal | null) => Promise<void>;
  supervise?: Supervise;
  /** Holds the whole work tree whatever the scope. */
  exclusive?: boolean;
  /** The root to join and the parent to name; without either a new root starts with `limits`. */
  root?: { handle?: string; parentTask?: string; limits?: Partial<RootLimits> };
  /** Configured turn timeout limits; defaults to `resolveExecutionLimits(loadConfig())`. */
  limits?: Partial<ExecutionLimits>;
  /** Formats the outcome the way the tool returns it. */
  format: (outcome: TaskExecutionResult) => { text: string; isError: boolean };
  options: Pick<TaskOptions, 'askConsent' | 'requireEnvelope' | 'warnings' | 'clock'>;
}

/** Identifies what a request id stands for, so a reused id cannot silently return another task. */
function requestFingerprint(start: Pick<BackgroundTaskStart, 'role' | 'fingerprintInput' | 'scope' | 'args' | 'root'>): string {
  const { role, fingerprintInput, args, scope, root } = start;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ role, prompt: fingerprintInput, scope, args, root: root?.handle, parent: root?.parentTask }))
    .digest('hex');
}

/** Terminal task state of an outcome. */
function finalState(outcome: TaskExecutionResult): DelegationTask['state'] {
  const status = outcome.result.status;
  if (status === 'completed' || status === 'cancelled' || status === 'timed_out') return status;
  const code = outcome.result.error?.code;
  if (code === 'ABORTED') return 'cancelled';
  if (code === 'TIMEOUT') return 'timed_out';
  return 'failed';
}

/**
 * Starts an asynchronous background task (`delegate`, `review`, or `consult`) that outlives the call.
 * @param start - Task specification and runner callback.
 * @returns The running/finished task record, or the outcome when the call ended before a turn started.
 * @throws Refusals before the turn starts, such as `INPUT_LIMIT`, `ROOT_LIMIT`, `SESSION_BUSY`, or `POLICY_DENIED`.
 */
export async function startBackgroundTask(start: BackgroundTaskStart): Promise<TaskCompletion> {
  const key = start.requestId ? `${start.cwd}\n${start.requestId}` : undefined;
  const taskHandle = createTaskHandle(key);
  const fingerprint = key ? requestFingerprint(start) : undefined;
  const existingTask = () => {
    const existing = key ? readTask(taskHandle) : null;
    if (existing && existing.requestFingerprint !== fingerprint) {
      throw new ToolError('INPUT_LIMIT', `request_id '${start.requestId?.slice(0, 80)}' was already used for a different delegation.`);
    }
    return existing;
  };
  const existing = existingTask();
  if (existing) return { task: existing };
  const releaseRequest = key ? await claimTaskRequest(taskHandle) : async () => undefined;
  try {
    // The first start may have recorded its task between the look above and this claim.
    const recorded = existingTask();
    if (recorded) return { task: recorded };
    return await launchTask(start, taskHandle, fingerprint);
  } finally {
    await releaseRequest();
  }
}

/**
 * Starts a delegation that outlives the call.
 * @param start - The request.
 * @returns The task, or the outcome when the call ended before a turn started.
 * @throws Refusals before the turn starts, such as a busy writer or a denied model.
 */
export async function startDelegation(start: DelegationStart): Promise<TaskCompletion> {
  return startBackgroundTask({
    role: 'delegate',
    publicInput: start.publicInput,
    args: start.args,
    cwd: start.cwd,
    scope: start.scope,
    fingerprintInput: start.prompt,
    requestId: start.requestId,
    requestSignal: start.requestSignal,
    callerBudget: start.callerBudget,
    root: start.root,
    limits: start.limits,
    format: start.format,
    options: start.options,
    run: env =>
      executeDelegation(start.prompt, start.publicInput, start.args, start.cwd, start.scope, env.signal, null, {
        ...start.options,
        supervise: start.supervise,
        exclusive: start.exclusive,
        ...(start.approve ? { approveStart: start.approve } : {}),
        onWriter: env.onWriter,
        onTreeUnconfirmed: env.onTreeUnconfirmed,
        beforeRound: env.beforeRound,
        budget: env.budget,
        context: env.context,
        onTurnStart: env.onTurnStart,
        beforeRelease: env.beforeRelease,
      }),
  });
}

/** Reserves the task in its root and runs it; see {@link startBackgroundTask}. */
async function launchTask(start: BackgroundTaskStart, taskHandle: string, fingerprint: string | undefined): Promise<TaskCompletion> {
  const limits = start.limits ?? resolveExecutionLimits(loadConfig());
  const requestedTimeoutMs = resolveTurnTimeout('async', start.args.timeout_ms, limits);
  const hasExplicitTimeout = typeof start.args.timeout_ms === 'number' && Number.isFinite(start.args.timeout_ms);
  const callerBudget = start.callerBudget;
  if (callerBudget?.isCallerAborted()) {
    const reason = callerBudget.abortReason();
    throw reason instanceof Error ? reason : new ToolError('ABORTED', 'Request cancelled before the task started.');
  }
  if (
    callerBudget &&
    (callerBudget.isTimedOut() ||
      callerBudget.isExecutionExpired() ||
      callerBudget.remainingExecutionMs() <= 0 ||
      callerBudget.remainingTotalMs() <= 0)
  ) {
    throw new ToolError('TIMEOUT', `Execution deadline exceeded (${requestedTimeoutMs} ms).`);
  }

  const joined = requestedRoot(start);
  try {
    pruneTasks();
    pruneRoots(undefined, joined ?? undefined);
  } catch (err) {
    // Old records are housekeeping; a new task does not depend on removing them.
    process.stderr.write(`CoAgent8: old tasks were not removed: ${redactDiagnostic((err as Error).message, 512)}\n`);
  }
  const clock = start.options.clock ?? (() => performance.now());
  const rootHandle = joined ?? (await createRoot(start.root?.limits)).rootHandle;
  const giveUpNewRoot = async () => {
    if (!joined) await removeUnusedRoot(rootHandle);
  };
  let reservation: Awaited<ReturnType<typeof reserveRootTask>>;
  try {
    reservation = await reserveRootTask(rootHandle, {
      taskHandle,
      ...(start.root?.parentTask ? { parentTask: start.root.parentTask } : {}),
      ...(typeof start.args.session_handle === 'string' ? { continues: start.args.session_handle } : {}),
      ...(start.options.clock ? { clock: start.options.clock } : {}),
    });
  } catch (err) {
    await giveUpNewRoot();
    throw err;
  }
  // Measured from the accounting point inside the locked reservation (excludes lock wait, includes persistence).
  const reservedAt = reservation.accountedAtMs;
  const elapsedMs = () => Math.max(0, clock() - reservedAt);
  /** Returns the charge of a start that never reached a turn; a failure here must not hide its reason. */
  const refund = async () => {
    try {
      await refundRootTask(rootHandle, taskHandle, elapsedMs());
      await giveUpNewRoot();
    } catch (err) {
      process.stderr.write(`CoAgent8: root ${rootHandle} was not updated: ${redactDiagnostic((err as Error).message, 512)}\n`);
    }
  };

  const controller = new AbortController();
  const abortStart = () => controller.abort();
  const onCallerBudgetAbort = () => {
    if (callerBudget?.isCallerAborted()) controller.abort();
  };
  const detachCallerAbort = () => {
    start.requestSignal?.removeEventListener('abort', abortStart);
    callerBudget?.executionSignal.removeEventListener('abort', onCallerBudgetAbort);
  };
  start.requestSignal?.addEventListener('abort', abortStart, { once: true });
  callerBudget?.executionSignal.addEventListener('abort', onCallerBudgetAbort, { once: true });
  if (start.requestSignal?.aborted || callerBudget?.isCallerAborted()) controller.abort();

  if (callerBudget?.isCallerAborted()) {
    await refund();
    detachCallerAbort();
    const reason = callerBudget.abortReason();
    throw reason instanceof Error ? reason : new ToolError('ABORTED', 'Request cancelled before the task started.');
  }
  const callerRemainingMs = callerBudget ? Math.min(requestedTimeoutMs, callerBudget.remainingTotalMs()) : requestedTimeoutMs;
  if (
    callerBudget &&
    (callerBudget.isTimedOut() || callerBudget.isExecutionExpired() || callerBudget.remainingExecutionMs() <= 0 || callerRemainingMs <= 0)
  ) {
    await refund();
    detachCallerAbort();
    throw new ToolError('TIMEOUT', `Execution deadline exceeded (${requestedTimeoutMs} ms).`);
  }

  // The root's running time is shared: deduct time elapsed since reservation before creating the budget.
  const sinceReservedMs = Math.floor(elapsedMs());
  const rootRemainingMs = Math.floor(reservation.remainingMs) - sinceReservedMs;
  const rootBaseRemainingMs = Math.floor(reservation.baseRemainingMs) - sinceReservedMs;
  if (rootRemainingMs <= 0) {
    const root = readRoot(rootHandle);
    await refund();
    detachCallerAbort();
    throw root
      ? rootTimeLimitError(
          root,
          root.limits.maxMinutes * 60_000 + (reservation.continuation ? rootGraceMinutes(root) * 60_000 : 0),
          reservation.continuation,
        )
      : new ToolError('ROOT_LIMIT', `Root ${rootHandle} has no remaining running time.`);
  }
  const effectiveBudgetMs = Math.min(callerRemainingMs, rootRemainingMs);
  let timeoutBound: TimeoutBound;
  if (rootRemainingMs < callerRemainingMs) {
    timeoutBound = reservation.continuation && rootBaseRemainingMs < callerRemainingMs ? 'root_grace' : 'root_remaining';
  } else {
    timeoutBound = hasExplicitTimeout ? 'timeout_ms' : 'async_default';
  }
  const budgetBound = { ms: effectiveBudgetMs, bound: timeoutBound } as const;

  // Owned by the task from the first Git read on, so cancellation and timeout_ms bound all of it.
  const budget = createExecutionBudget({
    totalBudgetMs: effectiveBudgetMs,
    parentSignal: controller.signal,
    clock,
  });
  const context = { abortSignal: budget.executionSignal, budget, timeoutMs: budget.remainingExecutionMs() };

  let task: DelegationTask | undefined;
  let writer: { file: string; token: string } | undefined;
  /** The worker's tree may still run: like the writer slot, its place in the root stays until this server ends. */
  let workerMayRun = false;
  let announce!: () => void;
  const running = new Promise<void>(resolve => {
    announce = resolve;
  });
  const logUnstored = () => process.stderr.write(`CoAgent8: task ${taskHandle} could not be recorded.\n`);
  /** The result, kept for a crash before the release; a failure only delays it to the final record. */
  const storeResult = async (result: DelegationTask['result']) => {
    if (!task) return;
    task = { ...task, result };
    await writeTask(task).catch(logUnstored);
  };
  /** Never rejects: a waiter must learn the end, and nobody awaits this but the shutdown. */
  /** Whether the final state was stored; a reader cannot learn the end when it was not. */
  let finalStored = false;
  const finish = async (update: Pick<DelegationTask, 'state' | 'result' | 'sessionHandle' | 'review'>) => {
    if (!task) return;
    task = { ...task, ...update, finishedAt: new Date().toISOString() };
    finalStored = await writeFinalTask(task);
    if (!finalStored) logUnstored();
  };
  /** Never rejects either: the root's books must not hide how the task ended. */
  const closeInRoot = async () => {
    if (!task) return refund();
    if (workerMayRun) return;
    // A lock held by another reservation can time out once; a root that stays unwritable refuses every reservation anyway.
    for (let attempt = 1; ; attempt++) {
      try {
        await endRootTask(rootHandle, taskHandle, elapsedMs());
        return;
      } catch (err) {
        if (attempt >= ROOT_END_ATTEMPTS) {
          process.stderr.write(`CoAgent8: root ${rootHandle} was not updated: ${redactDiagnostic((err as Error).message, 512)}\n`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, ROOT_END_RETRY_MS));
      }
    }
  };
  let watchFailures = 0;
  let watchTicks = 0;
  let touching = false;
  const watch = setInterval(() => {
    // Notes the task as running once a minute, so a crash of this server stops its time near the crash.
    if (++watchTicks % ROOT_SEEN_TICKS === 0 && !touching) {
      touching = true;
      touchRootTask(rootHandle, { taskHandle, elapsedMs: elapsedMs() })
        .catch(err =>
          process.stderr.write(`CoAgent8: root ${rootHandle} was not updated: ${redactDiagnostic((err as Error).message, 512)}\n`),
        )
        .finally(() => {
          touching = false;
        });
    }
    try {
      const root = readRoot(rootHandle);
      watchFailures = root ? 0 : watchFailures + 1;
      if (root?.state === 'cancelled') controller.abort();
    } catch {
      // A rename by another process can fail one read on Windows; only repeated failures count.
      watchFailures++;
    }
    if (watchFailures >= ROOT_WATCH_FAILURES) controller.abort();
  }, ROOT_WATCH_MS);
  watch.unref();

  const registeredSessions = new Set<string>();
  let resolveOutcomeStored!: (stored: boolean) => void;
  const outcomeStored = new Promise<boolean>(resolve => {
    resolveOutcomeStored = resolve;
  });
  const taskEntry: ActiveDelegationEntry = { controller, settled: outcomeStored, workspace: start.cwd };

  const onTurnStart: NonNullable<TaskOptions['onTurnStart']> = async turn => {
    if (task) {
      // A multi-part review or synthesis turn charges its call in the root and tracks its session.
      await reserveRootCall(rootHandle, taskHandle, turn.sessionHandle);
      if (!registeredSessions.has(turn.sessionHandle)) {
        registeredSessions.add(turn.sessionHandle);
        delegationBySession.set(turn.sessionHandle, taskEntry);
      }
      return;
    }
    const callerSession = process.env.CLAUDE_CODE_SESSION_ID;
    const initial: DelegationTask = {
      schemaVersion: 1,
      taskHandle,
      state: 'running',
      role: start.role,
      workspace: start.cwd,
      sessionHandle: turn.sessionHandle,
      backend: turn.backend,
      model: turn.model,
      serverPid: process.pid,
      serverIdentity: ownProcessIdentity(),
      startedAt: new Date().toISOString(),
      ...(callerSession ? { callerSession } : {}),
      ...(fingerprint ? { requestFingerprint: fingerprint } : {}),
      rootHandle,
      ...(reservation.parentTask ? { parentTask: reservation.parentTask } : {}),
      depth: reservation.depth,
      ...(start.scope.length ? { scope: start.scope } : {}),
      timeoutMs: effectiveBudgetMs,
      timeoutBound,
    };
    // The last check before the turn: a root cancelled until now prevents it.
    await bindRootTask(rootHandle, taskHandle, turn.sessionHandle, writer);
    // A record that cannot be written fails the turn before it starts: nothing could be waited for.
    await writeTask(initial);
    task = initial;
    if (!registeredSessions.has(turn.sessionHandle)) {
      registeredSessions.add(turn.sessionHandle);
      delegationBySession.set(turn.sessionHandle, taskEntry);
    }
    delegationByTask.set(taskHandle, taskEntry);
    detachCallerAbort();
    announce();
  };
  const beforeRound = () => reserveRootCall(rootHandle, taskHandle);
  const operation = start.run({
    signal: controller.signal,
    budget,
    context,
    onTurnStart,
    beforeRound,
    onWriter: held => {
      writer = held;
    },
    onTreeUnconfirmed: () => {
      workerMayRun = true;
    },
    // The evidence is stored while the writer is held; the state turns final after the release, so
    // a woken caller can start the next delegation at once.
    beforeRelease: outcome => storeResult(start.format({ ...outcome, budgetBound })),
  });
  const settled: Promise<{ outcome: TaskExecutionResult } | { error: unknown }> = operation.then(
    async outcome => {
      const boundedOutcome: TaskExecutionResult = { ...outcome, budgetBound };
      // Formatted again: a failed release adds its warning after the first copy was stored.
      // Its place in the root goes first, like the writer: a woken caller can start the next task at once.
      await closeInRoot();
      await finish({
        state: finalState(boundedOutcome),
        result: start.format(boundedOutcome),
        sessionHandle: boundedOutcome.sessionHandle ?? task?.sessionHandle ?? '',
        ...(boundedOutcome.review ? { review: boundedOutcome.review } : {}),
      });
      return { outcome: boundedOutcome };
    },
    async (err: unknown) => {
      const message = redactDiagnostic((err as Error).message, 1024);
      const roleLabel = start.role === 'review' ? 'review' : start.role === 'consult' ? 'consult' : 'delegation';
      const code = errorCodeOf(err);
      const state: DelegationTask['state'] = code === 'ABORTED' ? 'cancelled' : code === 'TIMEOUT' ? 'timed_out' : 'failed';
      await closeInRoot();
      await finish({
        state,
        result: { text: `The ${roleLabel} failed: ${message}`, isError: true },
        sessionHandle: task?.sessionHandle ?? '',
      });
      return { error: err };
    },
  );
  activeDelegations.set(settled, { controller, rootHandle });
  void settled.then(
    () => resolveOutcomeStored(finalStored),
    () => resolveOutcomeStored(finalStored),
  );
  void settled.then(() => {
    activeDelegations.delete(settled);
    if (delegationByTask.get(taskHandle) === taskEntry) delegationByTask.delete(taskHandle);
    clearInterval(watch);
    // Only its own entry: a newer task in the same session may have registered meanwhile.
    for (const sessionHandle of registeredSessions) {
      if (delegationBySession.get(sessionHandle) === taskEntry) delegationBySession.delete(sessionHandle);
    }
    budget.dispose();
  });

  await Promise.race([running, settled]);
  detachCallerAbort();
  if (task) return { task };
  const ended = await settled;
  if ('error' in ended) throw ended.error;
  return { outcome: ended.outcome };
}
