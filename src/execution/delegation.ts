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
import { redactDiagnostic } from '../security/index.js';
import { ownProcessStartTime } from '../sessions/activity.js';
import { acquireWriterLease } from '../sessions/writer.js';
import { createExecutionBudget } from './runtime/budget.js';
import { jobHelperPath } from './job-helper.js';
import { withRequiredJobHelper, withWorkerGroups } from './process.js';
import { createTaskHandle, pruneTasks, readTask, writeFinalTask, writeTask, type DelegationTask } from '../sessions/tasks.js';
import { captureWorkspace, compareWorkspace, readWorkspaceRepository, type WorkspaceSnapshot } from '../workspace/changes.js';
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
  options: Omit<TaskOptions, 'profile'> & { beforeRelease?: (outcome: TaskExecutionResult) => Promise<void> } = {},
): Promise<TaskExecutionResult> {
  const { beforeRelease, ...taskOptions } = options;
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
  const lease = await acquireWriterLease(repo.gitDir);
  let outcome: TaskExecutionResult | undefined;
  let treeUnconfirmed = false;
  try {
    const before: WorkspaceSnapshot = await captureWorkspace(cwd, repo, options.context);
    const runTask = () =>
      withWorkerGroups(
        () => executeTask(prompt, publicInput, args, cwd, abortSignal, onProgress, { ...taskOptions, profile: 'workspace-write' }),
        lease,
      );
    outcome = await (process.platform === 'win32'
      ? withRequiredJobHelper(runTask, () => {
          treeUnconfirmed = true;
        })
      : runTask());
    let changes: WorkspaceChanges;
    try {
      changes = await compareWorkspace(cwd, repo, before, await captureWorkspace(cwd, repo), scope);
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
const activeDelegations = new Map<Promise<unknown>, AbortController>();

/**
 * Stops every asynchronous delegation of this server, at once also one still waiting for consent.
 * @returns Settles when each has stored its evidence and released its writer.
 */
export function stopActiveDelegations(): Promise<unknown> {
  for (const controller of activeDelegations.values()) controller.abort();
  return Promise.allSettled([...activeDelegations.keys()]);
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
  /** Formats the outcome the way the tool returns it. */
  format: (outcome: TaskExecutionResult) => { text: string; isError: boolean };
  options: Pick<TaskOptions, 'askConsent' | 'requireEnvelope' | 'warnings' | 'clock'>;
}

/** Identifies what a request id stands for, so a reused id cannot silently return another task. */
function requestFingerprint(start: DelegationStart): string {
  const { args, prompt, scope } = start;
  return crypto.createHash('sha256').update(JSON.stringify({ prompt, scope, args })).digest('hex');
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
  const existing = key ? readTask(taskHandle) : null;
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new ToolError('INPUT_LIMIT', `request_id '${start.requestId?.slice(0, 80)}' was already used for a different delegation.`);
    }
    return { task: existing };
  }
  try {
    pruneTasks();
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
    totalBudgetMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
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
  const finish = async (update: Pick<DelegationTask, 'state' | 'result'>) => {
    if (!task) return;
    task = { ...task, ...update, finishedAt: new Date().toISOString() };
    if (!(await writeFinalTask(task))) logUnstored();
  };
  const operation = executeDelegation(start.prompt, start.publicInput, start.args, start.cwd, start.scope, controller.signal, null, {
    ...start.options,
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
        serverStartedAt: ownProcessStartTime(),
        startedAt: new Date().toISOString(),
        ...(callerSession ? { callerSession } : {}),
        ...(fingerprint ? { requestFingerprint: fingerprint } : {}),
      };
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
      return { outcome };
    },
    async (err: unknown) => {
      const message = redactDiagnostic((err as Error).message, 1024);
      await finish({ state: 'failed', result: { text: `The delegation failed: ${message}`, isError: true } });
      return { error: err };
    },
  );
  activeDelegations.set(settled, controller);
  void settled.then(() => {
    activeDelegations.delete(settled);
    budget.dispose();
  });

  await Promise.race([running, settled]);
  start.requestSignal?.removeEventListener('abort', abortStart);
  if (task) return { task };
  const ended = await settled;
  if ('error' in ended) throw ended.error;
  return { outcome: ended.outcome };
}
