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
import { ToolError, type TaskExecutionResult, type WorkspaceChanges } from '../contracts/index.js';
import { DEFAULT_EXECUTION_TIMEOUT_MS, type RootLimits } from '../contracts/execution.js';
import { redactDiagnostic } from '../security/index.js';
import { ownProcessIdentity } from '../sessions/activity.js';
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
  isRootTaskActive,
  pruneRoots,
  readRoot,
  refundRootTask,
  removeUnusedRoot,
  reserveRootCall,
  reserveRootTask,
} from '../sessions/roots.js';
import {
  captureWorkspace,
  compareWorkspace,
  readWorkspaceRepository,
  resolveWriteClaim,
  type WorkspaceSnapshot,
} from '../workspace/changes.js';
import { executeTask, type ExecutionRequest, type TaskOptions } from './controller.js';

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
  options: Omit<TaskOptions, 'profile'> & {
    beforeRelease?: (outcome: TaskExecutionResult) => Promise<void>;
    supervise?: Supervise;
    /** Longest turn of a later round; replaceable by tests. */
    loopTurnMs?: number;
    /** Hold the whole work tree whatever the scope: the loop's checks and review read all of it. */
    exclusive?: boolean;
    /** Runs before every turn after the first; a refusal ends the round. */
    beforeRound?: () => Promise<void>;
    /** Asks what the user must settle, with the writer held so that an overlapping start asks nothing. */
    approveStart?: () => Promise<void>;
  } = {},
): Promise<TaskExecutionResult> {
  const { beforeRelease, supervise, loopTurnMs = LOOP_TURN_MS, exclusive = false, beforeRound, approveStart, ...taskOptions } = options;
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
  const lease = await acquireWriterLease(repo.gitDir, undefined, exclusive ? [] : resolveWriteClaim(repo, scope));
  let outcome: TaskExecutionResult | undefined;
  let treeUnconfirmed = false;
  try {
    await approveStart?.();
    const before: WorkspaceSnapshot = await captureWorkspace(cwd, repo, options.context);
    const turn = (text: string, turnArgs: ExecutionRequest, turnOptions: typeof taskOptions) =>
      executeTask(text, publicInput, turnArgs, cwd, abortSignal, onProgress, {
        ...turnOptions,
        profile: 'workspace-write',
        writeScope: scope,
      });
    const runSupervised = async () => {
      const first = await turn(prompt, args, taskOptions);
      if (!supervise) return first;
      // Each later turn has its own bound within what is left of the task's budget.
      const inRound: Supervision['inRound'] = async run => {
        const remainingMs = Math.min(loopTurnMs, options.budget?.remainingExecutionMs() ?? Number.POSITIVE_INFINITY);
        if (remainingMs <= 0) throw new ToolError('TIMEOUT', 'The task budget ended before the next turn.');
        await beforeRound?.();
        const budget = createExecutionBudget({
          totalBudgetMs: remainingMs,
          parentSignal: abortSignal ?? undefined,
          clock: options.clock,
        });
        try {
          return await run({ budget, context: { abortSignal: budget.executionSignal, budget, timeoutMs: budget.remainingExecutionMs() } });
        } finally {
          budget.dispose();
        }
      };
      return supervise(first, {
        signal: abortSignal ?? null,
        budget: options.budget,
        context: options.context,
        inRound,
        // The call that could show a form has ended: a model that needs approval is refused.
        fix: text =>
          inRound(round =>
            turn(
              text,
              { ...args, session_handle: first.sessionHandle ?? undefined },
              { ...taskOptions, ...round, askConsent: undefined, onTurnStart: undefined },
            ),
          ),
      });
    };
    const runTask = () => withWorkerGroups(runSupervised, lease);
    outcome = await (process.platform === 'win32'
      ? withRequiredJobHelper(runTask, () => {
          treeUnconfirmed = true;
        })
      : runTask());
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
        ? 'The worker was denied access, and the only changes seen are in paths another worker held.'
        : 'The worker was denied access and changed no file.';
      outcome = {
        ...outcome,
        warnings: [
          ...(outcome.warnings ?? []),
          `${seen} On Windows, a folder that does not inherit the permissions of the workspace stays closed to a Codex worker: check the denied path.`,
        ],
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

/**
 * Stops every asynchronous delegation of this server, at once also one still waiting for consent.
 * @returns Settles when each has stored its evidence and released its writer.
 */
/**
 * The running delegation of each worker session, so a cancel can wait for its final state (#136).
 * Settles with whether that state was stored.
 */
const delegationBySession = new Map<string, Promise<boolean>>();

/** How long a cancel waits for the delegation to store its final state. */
const CANCEL_SETTLE_MS = 15 * 1000;

/** How a cancelled delegation ended, as `awaitDelegation` reports it. */
export type DelegationSettlement = 'stored' | 'unstored' | 'pending' | 'none';

/**
 * Finds the delegation of a session, to wait for after a cancel. Call it before cancelling: one
 * that ends during the cancel still reports its outcome.
 * @returns A wait that starts its bound when called, so a slow cancel does not shorten it.
 */
export function captureDelegation(sessionHandle: string): (waitMs?: number) => Promise<DelegationSettlement> {
  const settled = delegationBySession.get(sessionHandle);
  return async (waitMs = CANCEL_SETTLE_MS) => {
    if (!settled) return 'none';
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'pending'>(resolve => {
      timer = setTimeout(() => resolve('pending'), waitMs);
    });
    try {
      return await Promise.race([settled.then(stored => (stored ? ('stored' as const) : ('unstored' as const))), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function stopActiveDelegations(): Promise<unknown> {
  for (const { controller } of activeDelegations.values()) controller.abort();
  return Promise.allSettled([...activeDelegations.keys()]);
}

/** How often a running delegation looks for a cancellation of its root by another server process. */
const ROOT_WATCH_MS = 1000;
/** Reads of a root that may fail in a row before its worker is stopped: a root nobody can read cannot cancel it. */
const ROOT_WATCH_FAILURES = 5;
const ROOT_SETTLE_POLL_MS = 100;

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
    const running = tasks.filter(isRootTaskActive);
    if (!running.length || Date.now() >= deadline) {
      return {
        ended: tasks.filter(task => task.endedAt).map(task => task.taskHandle),
        running: running.map(task => task.taskHandle),
        // Without a session the turn had not started, as the session is bound just before it.
        interrupted: tasks.filter(task => !task.endedAt && !isRootTaskActive(task) && task.sessionHandle).map(task => task.taskHandle),
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
function requestedRoot(start: DelegationStart): string | null {
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
const LOOP_TURN_MS = 30 * 60 * 1000;

/** What a supervisor gets to work with. */
export interface Supervision {
  signal: AbortSignal | null;
  budget?: TaskOptions['budget'];
  context?: TaskOptions['context'];
  /** Runs one turn under its own bound. */
  inRound: <T>(
    run: (round: { budget: NonNullable<TaskOptions['budget']>; context: NonNullable<TaskOptions['context']> }) => Promise<T>,
  ) => Promise<T>;
  fix: (prompt: string) => Promise<TaskExecutionResult>;
}

/** Supervises a change after the worker's first turn, with the writer held; returns the last result. */
export type Supervise = (first: TaskExecutionResult, turn: Supervision) => Promise<TaskExecutionResult>;

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
  /** Asks what must be settled before a new task starts, after a repeated request id was ruled out. */
  approve?: () => Promise<void>;
  supervise?: Supervise;
  /** Holds the whole work tree whatever the scope. */
  exclusive?: boolean;
  /** The root to join and the parent to name; without either a new root starts with `limits`. */
  root?: { handle?: string; parentTask?: string; limits?: Partial<RootLimits> };
  /** Formats the outcome the way the tool returns it. */
  format: (outcome: TaskExecutionResult) => { text: string; isError: boolean };
  options: Pick<TaskOptions, 'askConsent' | 'requireEnvelope' | 'warnings' | 'clock'>;
}

/** Identifies what a request id stands for, so a reused id cannot silently return another task. */
function requestFingerprint(start: DelegationStart): string {
  const { args, prompt, scope, root } = start;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ prompt, scope, args, root: root?.handle, parent: root?.parentTask }))
    .digest('hex');
}

/** Terminal task state of an outcome. */
function finalState(outcome: TaskExecutionResult): DelegationTask['state'] {
  const status = outcome.result.status;
  return status === 'completed' || status === 'cancelled' || status === 'timed_out' ? status : 'failed';
}

/**
 * Starts a delegation that outlives the call.
 * @param start - The request.
 * @returns The task, or the outcome when the call ended before a turn started.
 * @throws Refusals before the turn starts, such as a busy writer or a denied model.
 */
export async function startDelegation(start: DelegationStart): Promise<{ task: DelegationTask } | { outcome: TaskExecutionResult }> {
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
    return await launchDelegation(start, taskHandle, fingerprint);
  } finally {
    await releaseRequest();
  }
}

/** Reserves the task in its root and runs it; see {@link startDelegation}. */
async function launchDelegation(
  start: DelegationStart,
  taskHandle: string,
  fingerprint: string | undefined,
): Promise<{ task: DelegationTask } | { outcome: TaskExecutionResult }> {
  const joined = requestedRoot(start);
  const rootHandle = joined ?? (await createRoot(start.root?.limits)).rootHandle;
  const giveUpNewRoot = async () => {
    if (!joined) await removeUnusedRoot(rootHandle);
  };
  let reservation: { depth: number; remainingMs: number };
  try {
    reservation = await reserveRootTask(rootHandle, {
      taskHandle,
      ...(start.root?.parentTask ? { parentTask: start.root.parentTask } : {}),
      ...(typeof start.args.session_handle === 'string' ? { continues: start.args.session_handle } : {}),
    });
  } catch (err) {
    await giveUpNewRoot();
    throw err;
  }
  /** Returns the charge of a start that never reached a turn; a failure here must not hide its reason. */
  const refund = async () => {
    try {
      await refundRootTask(rootHandle, taskHandle);
      await giveUpNewRoot();
    } catch (err) {
      process.stderr.write(`CoAgent8: root ${rootHandle} was not updated: ${redactDiagnostic((err as Error).message, 512)}\n`);
    }
  };
  try {
    pruneTasks();
    pruneRoots();
  } catch (err) {
    // Old records are housekeeping; a new delegation does not depend on removing them.
    process.stderr.write(`CoAgent8: old tasks were not removed: ${redactDiagnostic((err as Error).message, 512)}
`);
  }

  const controller = new AbortController();
  const abortStart = () => controller.abort();
  start.requestSignal?.addEventListener('abort', abortStart, { once: true });
  if (start.requestSignal?.aborted) controller.abort();

  // Owned by the task from the first Git read on, so cancellation and timeout_ms bound all of it.
  const timeoutMs = start.args.timeout_ms;
  const budget = createExecutionBudget({
    // The root's time is shared: no task runs past it, whatever it asked for.
    totalBudgetMs: Math.min(
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_EXECUTION_TIMEOUT_MS,
      reservation.remainingMs,
    ),
    parentSignal: controller.signal,
    clock: start.options.clock,
  });
  const context = { abortSignal: budget.executionSignal, budget, timeoutMs: budget.remainingExecutionMs() };

  let task: DelegationTask | undefined;
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
  const finish = async (update: Pick<DelegationTask, 'state' | 'result'>) => {
    if (!task) return;
    task = { ...task, ...update, finishedAt: new Date().toISOString() };
    finalStored = await writeFinalTask(task);
    if (!finalStored) logUnstored();
  };
  /** Never rejects either: the root's books must not hide how the task ended. */
  const closeInRoot = async () => {
    if (!task) return refund();
    try {
      await endRootTask(rootHandle, taskHandle);
    } catch (err) {
      process.stderr.write(`CoAgent8: root ${rootHandle} was not updated: ${redactDiagnostic((err as Error).message, 512)}\n`);
    }
  };
  let watchFailures = 0;
  const watch = setInterval(() => {
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
  const operation = executeDelegation(start.prompt, start.publicInput, start.args, start.cwd, start.scope, controller.signal, null, {
    ...start.options,
    supervise: start.supervise,
    exclusive: start.exclusive,
    ...(start.approve ? { approveStart: start.approve } : {}),
    beforeRound: () => reserveRootCall(rootHandle),
    budget,
    context,
    onTurnStart: async turn => {
      const callerSession = process.env.CLAUDE_CODE_SESSION_ID;
      const initial: DelegationTask = {
        schemaVersion: 1,
        taskHandle,
        state: 'running',
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
        ...(start.root?.parentTask ? { parentTask: start.root.parentTask } : {}),
        depth: reservation.depth,
        ...(start.scope.length ? { scope: start.scope } : {}),
      };
      // The last check before the turn: a root cancelled until now prevents it.
      await bindRootTask(rootHandle, taskHandle, turn.sessionHandle);
      // A record that cannot be written fails the turn before it starts: nothing could be waited for.
      await writeTask(initial);
      task = initial;
      start.requestSignal?.removeEventListener('abort', abortStart);
      announce();
    },
    // The evidence is stored while the writer is held; the state turns final after the release, so
    // a woken caller can start the next delegation at once.
    beforeRelease: outcome => storeResult(start.format(outcome)),
  });
  const settled: Promise<{ outcome: TaskExecutionResult } | { error: unknown }> = operation.then(
    async outcome => {
      // Formatted again: a failed release adds its warning after the first copy was stored.
      await finish({ state: finalState(outcome), result: start.format(outcome) });
      await closeInRoot();
      return { outcome };
    },
    async (err: unknown) => {
      const message = redactDiagnostic((err as Error).message, 1024);
      await finish({ state: 'failed', result: { text: `The delegation failed: ${message}`, isError: true } });
      await closeInRoot();
      return { error: err };
    },
  );
  activeDelegations.set(settled, { controller, rootHandle });
  const outcomeStored = settled.then(() => finalStored);
  void running.then(() => {
    if (task) delegationBySession.set(task.sessionHandle, outcomeStored);
  });
  void settled.then(() => {
    activeDelegations.delete(settled);
    clearInterval(watch);
    // Only its own entry: a newer delegation in the same session may have registered meanwhile.
    if (task && delegationBySession.get(task.sessionHandle) === outcomeStored) delegationBySession.delete(task.sessionHandle);
    budget.dispose();
  });

  await Promise.race([running, settled]);
  start.requestSignal?.removeEventListener('abort', abortStart);
  if (task) return { task };
  const ended = await settled;
  if ('error' in ended) throw ended.error;
  return { outcome: ended.outcome };
}
