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
 * @packageDocumentation
 */
import { ToolError, type TaskExecutionResult, type WorkspaceChanges } from '../contracts/index.js';
import { redactDiagnostic } from '../security/index.js';
import { acquireWriterLease } from '../sessions/writer.js';
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
  options: Omit<TaskOptions, 'profile'> = {}
): Promise<TaskExecutionResult> {
  const repo = await readWorkspaceRepository(cwd, options.context).catch(err => {
    if (err instanceof ToolError && ['ABORTED', 'TIMEOUT'].includes(err.code)) throw err;
    throw new ToolError('INPUT_LIMIT', 'delegate needs a Git work tree, so the server can report what changed; run it in a repository.');
  });
  const lease = await acquireWriterLease(repo.gitDir);
  let outcome: TaskExecutionResult | undefined;
  try {
    const before: WorkspaceSnapshot = await captureWorkspace(cwd, repo, options.context);
    outcome = await executeTask(prompt, publicInput, args, cwd, abortSignal, onProgress, { ...options, profile: 'workspace-write' });
    let changes: WorkspaceChanges;
    try {
      changes = await compareWorkspace(cwd, repo, before, await captureWorkspace(cwd, repo), scope);
    } catch (err) {
      changes = { changed: [], outsideScope: [], dirtyBefore: [], truncated: false, unavailable: redactDiagnostic((err as Error).message, 256) };
    }
    outcome = { ...outcome, changes };
    return outcome;
  } finally {
    try {
      await lease.release();
    } catch (err) {
      const warning = `The workspace writer slot was not released: ${redactDiagnostic((err as Error).message, 256)}`;
      // Without a result the call's own error is reported; the failed release goes to the log.
      if (outcome) outcome.warnings.push(warning);
      else process.stderr.write(`Warning: ${warning}\n`);
    }
  }
}
