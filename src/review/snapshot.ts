/**
 * The reviewed state as a separate work tree (#213): a reviewer runs its commands in a copy of
 * exactly what it reviews, and the user's work tree stays untouched.
 *
 * @remarks
 * Uncommitted changes become a commit built from a temporary index (a copy of the user's index
 * plus every untracked, non-ignored file within the review bounds); staged changes become a
 * commit of the index alone; committed scopes use their target revision. The commit is held by a
 * ref until the turn ends and is checked out detached, without hooks, filters' downloads (LFS) or
 * submodules, in one directory per workspace, so a follow-up review resumes in the same place
 * (Claude Code keeps its sessions per directory). Whatever cannot be materialized within the
 * bounds is skipped: the review then runs in the workspace as before.
 *
 * @packageDocumentation
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit, type GitScopeInfo } from '../workspace/git.js';
import { canonicalPath } from '../workspace/identity.js';
import type { BackendReadContext } from '../contracts/execution.js';

/** Untracked bytes a snapshot hashes at most, per file and in total, as the review input does. */
export const SNAPSHOT_MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
export const SNAPSHOT_MAX_UNTRACKED_TOTAL_BYTES = 3 * 1024 * 1024;

/** A materialized review state. */
export interface ReviewSnapshot {
  /** The separate work tree the reviewer runs in. */
  path: string;
  /** The commit it shows. */
  commit: string;
  /** Removes the work tree and its ref; safe to call more than once. */
  dispose: () => Promise<void>;
}

/** Why no snapshot was made; the review then runs in the workspace. */
export interface SnapshotSkipped {
  skipped: string;
}

/** A fixed identity, so the same state gives the same commit. */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'CoAgent8',
  GIT_AUTHOR_EMAIL: 'coagent8@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'CoAgent8',
  GIT_COMMITTER_EMAIL: 'coagent8@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

/** The short root of every snapshot work tree; short, because Windows paths have a limit. */
export function snapshotRoot(): string {
  return path.join(os.tmpdir(), 'c8wt');
}

/** One directory per workspace: a follow-up review resumes where the first ran. */
export function snapshotPath(workspace: string): string {
  return path.join(snapshotRoot(), crypto.createHash('sha256').update(canonicalPath(workspace)).digest('hex').slice(0, 12));
}

/**
 * The revision a committed scope reviews.
 * @returns The target revision, or null for the uncommitted and staged scopes.
 */
export function targetRevision(info: Pick<GitScopeInfo, 'type' | 'revision'>): string | null {
  if (info.type === 'commit') return info.revision ?? null;
  if (info.type === 'branch') return 'HEAD';
  if (info.type === 'range') {
    const parts = (info.revision ?? '').split(/\.{2,3}/);
    return parts[1] || 'HEAD';
  }
  return null;
}

/**
 * Materializes the reviewed state in its own work tree.
 * @param info - The collected review scope.
 * @param workspace - The user's work tree.
 * @param context - The call's read context; its budget bounds every Git command.
 * @returns The snapshot, or why none was made.
 */
export async function materializeReviewSnapshot(
  info: GitScopeInfo,
  workspace: string,
  context?: BackendReadContext,
): Promise<ReviewSnapshot | SnapshotSkipped> {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => runGit(args, workspace, context, 15000, undefined, undefined, env);
  let commit: string;
  const target = targetRevision(info);
  if (target) {
    commit = (await git(['rev-parse', '--verify', `${target}^{commit}`])).trim();
  } else {
    const gitDir = path.resolve(workspace, (await git(['rev-parse', '--git-dir'])).trim());
    const index = path.join(gitDir, 'index');
    const temporary = path.join(gitDir, `coagent8-index-${crypto.randomBytes(6).toString('hex')}`);
    try {
      // A copy of the user's index: its staged entries and flags stay, and the user's index is never written.
      if (fs.existsSync(index)) fs.copyFileSync(index, temporary);
      const env = { GIT_INDEX_FILE: temporary };
      if (info.type === 'uncommitted') {
        const skipped = untrackedOverBounds(await git(['ls-files', '--others', '--exclude-standard', '-z']), workspace);
        if (skipped) return { skipped };
        await git(['-c', 'core.autocrlf=false', 'add', '-A', '--', '.'], env);
      }
      const tree = (await git(['write-tree'], env)).trim();
      const head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
      commit = (await git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'CoAgent8 review snapshot'], COMMIT_ENV)).trim();
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const target_ = snapshotPath(workspace);
  // One review at a time per workspace: another one keeps this call in the workspace.
  const release = claimSnapshot(target_);
  if (!release) return { skipped: 'another review of this workspace is using its snapshot' };
  const id = crypto.randomBytes(8).toString('hex');
  const ref = `refs/coagent8/review/${id}`;
  try {
    await git(['update-ref', ref, commit]);
    // An earlier review's tree at this place is replaced.
    await removeWorkTree(git, target_);
  } catch (err) {
    await git(['update-ref', '-d', ref]).catch(() => undefined);
    release();
    return { skipped: `the snapshot directory could not be prepared: ${(err as Error).message.slice(0, 200)}` };
  }
  fs.mkdirSync(snapshotRoot(), { recursive: true });
  const hooks = path.join(snapshotRoot(), 'no-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  try {
    await git(['-c', `core.hooksPath=${hooks}`, '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', '--force', target_, commit], {
      GIT_LFS_SKIP_SMUDGE: '1',
    });
  } catch (err) {
    await git(['update-ref', '-d', ref]).catch(() => undefined);
    await removeWorkTree(git, target_).catch(() => undefined);
    release();
    return { skipped: `the snapshot could not be checked out: ${(err as Error).message.slice(0, 200)}` };
  }
  let disposed = false;
  return {
    path: target_,
    commit,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await git(['update-ref', '-d', ref]).catch(() => undefined);
      await removeWorkTree(git, target_).catch(() => undefined);
      release();
    },
  };
}

/**
 * Claims a snapshot directory for this process; a claim of a process that ended is taken over.
 * @returns Releases the claim, or null while a live process holds it.
 */
export function claimSnapshot(target: string): (() => void) | null {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const owner = Number(fs.readFileSync(lock, { encoding: 'utf8', flag: 'r' }));
      if (Number.isSafeInteger(owner) && owner > 0 && isAlive(owner)) return null;
      fs.rmSync(lock, { force: true });
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The reason to skip a snapshot whose untracked files exceed the review bounds, if any. */
function untrackedOverBounds(listing: string, workspace: string): string | null {
  let total = 0;
  for (const file of listing.split('\0').filter(Boolean)) {
    const size = fs.statSync(path.join(workspace, file), { throwIfNoEntry: false })?.size ?? 0;
    if (size > SNAPSHOT_MAX_UNTRACKED_FILE_BYTES) return `untracked file ${file} is larger than the review bounds`;
    total += size;
    if (total > SNAPSHOT_MAX_UNTRACKED_TOTAL_BYTES) return 'untracked files are larger than the review bounds';
  }
  return null;
}

/** Removes a snapshot work tree and its registration; a missing one is fine. */
async function removeWorkTree(git: (args: string[]) => Promise<string>, target: string): Promise<void> {
  if (fs.existsSync(target)) {
    await git(['worktree', 'remove', '--force', target]).catch(() => undefined);
    // A directory Git no longer knows, such as one a crashed server left.
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }
  await git(['worktree', 'prune']);
}

/** Whether a materialization was skipped. */
export function isSnapshotSkipped(value: ReviewSnapshot | SnapshotSkipped): value is SnapshotSkipped {
  return 'skipped' in value;
}
