/**
 * The reviewed state as a separate work tree (#213): a reviewer runs its commands in a copy of
 * exactly what it reviews, and the user's work tree stays untouched.
 *
 * @remarks
 * Uncommitted changes become a commit built from a temporary index (a copy of the user's index
 * plus every untracked, non-ignored file within the review bounds); staged changes become a
 * commit of the index alone; committed scopes use their target revision. The commit is held by a
 * ref until the turn ends and is checked out detached, without hooks, filters' downloads (LFS) or
 * submodules (a repository with checkout filters such as Git LFS is not materialized), in one directory per workspace, so a follow-up review resumes in the same place
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
import { ToolError } from '../contracts/error.js';

/** Untracked bytes a snapshot hashes at most, per file and in total, as the review input does. */
export const SNAPSHOT_MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
export const SNAPSHOT_MAX_UNTRACKED_TOTAL_BYTES = 3 * 1024 * 1024;

/** A materialized review state. */
export interface ReviewSnapshot {
  /** The separate work tree. */
  path: string;
  /** Where the reviewer runs: the workspace's place inside the work tree. */
  cwd: string;
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
  const target = targetRevision(info);
  const none = Promise.resolve('');
  // Independent reads at once: each Git start costs time, on Windows most of all.
  const [where, untracked, head, targetCommit] = await Promise.all([
    git(['rev-parse', '--git-dir', '--show-prefix']),
    info.type === 'uncommitted' ? git(['ls-files', '--others', '--exclude-standard', '-z']) : none,
    target ? none : git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => ''),
    target ? git(['rev-parse', '--verify', `${target}^{commit}`]) : none,
  ]);
  const [gitDirLine, prefixLine] = where.split(/\r?\n/);
  // Exactly as Git prints it, without its line end and trailing slash: a directory name may start with a space.
  const prefix = (prefixLine ?? '').replace(/\/+$/, '');
  let commit = targetCommit.trim();
  if (!target) {
    const skipped = untrackedOverBounds(untracked, workspace);
    if (skipped) return { skipped };
    const gitDir = path.resolve(workspace, gitDirLine.trim());
    const index = path.join(gitDir, 'index');
    const temporary = path.join(gitDir, `coagent8-index-${crypto.randomBytes(6).toString('hex')}`);
    try {
      // A copy of the user's index: its staged entries and flags stay, and the user's index is never written.
      if (fs.existsSync(index)) fs.copyFileSync(index, temporary);
      const env = { GIT_INDEX_FILE: temporary };
      if (info.type === 'uncommitted') await git(['-c', 'core.autocrlf=false', 'add', '-A', '--', '.'], env);
      const tree = (await git(['write-tree'], env)).trim();
      const parent = head.trim();
      commit = (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'CoAgent8 review snapshot'], COMMIT_ENV)).trim();
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  // A changed file under a filter attribute, such as a Git LFS pointer, would not be checked out as
  // reviewed. Git's effective attributes for the snapshot's tree decide, from every attribute source.
  if (await filtered(git, commit, info.changedPaths)) return { skipped: 'changed files use checkout filters (such as Git LFS)' };
  const target_ = snapshotPath(workspace);
  // One review at a time per workspace: another one keeps this call in the workspace.
  const release = claimSnapshot(target_);
  if (!release) return { skipped: 'another review of this workspace is using its snapshot' };
  const ref = `refs/coagent8/review/${crypto.randomBytes(8).toString('hex')}`;
  // Cleanup runs without the call's signal: a cancelled or expired call still removes what it made.
  const cleanupGit = (args: string[]) => runGit(args, workspace, null, 15000);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await Promise.all([
        cleanupGit(['update-ref', '-d', ref]).catch(() => undefined),
        removeWorkTree(cleanupGit, target_).catch(() => undefined),
      ]);
    } finally {
      release();
    }
  };
  try {
    // An earlier review's tree at this place is replaced.
    await removeWorkTree(git, target_);
    const hooks = path.join(snapshotRoot(), 'no-hooks');
    fs.mkdirSync(hooks, { recursive: true });
    // Both settle before any cleanup: a cleanup must not race a command that is still running.
    const settled = await Promise.allSettled([
      git(['update-ref', ref, commit]),
      git(['-c', `core.hooksPath=${hooks}`, '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', '--force', target_, commit]),
    ]);
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    // A revision without the workspace's subdirectory has no place to run in.
    if (prefix && !fs.statSync(path.join(target_, prefix), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('the reviewed revision has no such subdirectory');
    }
  } catch (err) {
    await dispose();
    if (err instanceof ToolError && (err.code === 'TIMEOUT' || err.code === 'ABORTED')) throw err;
    return { skipped: `the snapshot could not be prepared: ${(err as Error).message.slice(0, 200)}` };
  }
  return { path: target_, cwd: prefix ? path.join(target_, prefix) : target_, commit, dispose };
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

/** Paths checked per `git check-attr` call. */
const ATTR_BATCH = 200;

/** Whether any of the paths has a filter attribute in the given tree. */
async function filtered(git: (args: string[]) => Promise<string>, commit: string, paths: readonly string[]): Promise<boolean> {
  for (let i = 0; i < paths.length; i += ATTR_BATCH) {
    const out = await git(['check-attr', '--source', commit, 'filter', '--', ...paths.slice(i, i + ATTR_BATCH)]);
    if (out.split(/\r?\n/).some(line => /: filter: (?!unspecified$|unset$)/.test(line))) return true;
  }
  return false;
}

/** Removes a snapshot work tree and its registration; a missing one is fine. */
async function removeWorkTree(git: (args: string[]) => Promise<string>, target: string): Promise<void> {
  if (!fs.existsSync(target)) return;
  await git(['worktree', 'remove', '--force', target]).catch(() => undefined);
  // A directory Git no longer knows, such as one a crashed server left; then its registration goes too.
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    await git(['worktree', 'prune']);
  }
}

/** Whether a materialization was skipped. */
export function isSnapshotSkipped(value: ReviewSnapshot | SnapshotSkipped): value is SnapshotSkipped {
  return 'skipped' in value;
}

/** How long a claim without a readable owner counts as being written, not as abandoned. */
const CLAIM_SETTLE_MS = 60_000;

/**
 * Claims a snapshot directory for this process; a claim of a process that ended is taken over.
 * The owner is written to a private file first and linked into place, so a claim is never seen
 * without its owner; a claim that still has none is left alone for a minute.
 * @returns Releases the claim, or null while another live claim holds it.
 */
export function claimSnapshot(target: string): (() => void) | null {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  const own = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(own, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(own, lock);
        return () => fs.rmSync(lock, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
        let owner: number;
        let age: number;
        try {
          owner = Number(fs.readFileSync(lock, 'utf8'));
          age = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
          // Released meanwhile: try again.
          continue;
        }
        const known = Number.isSafeInteger(owner) && owner > 0;
        if (known ? isAlive(owner) : age < CLAIM_SETTLE_MS) return null;
        // Only the process whose rename succeeds removes the stale claim, and only that claim:
        // it checks the owner again on its private copy, which no other process can replace.
        const stale = `${own}.stale`;
        try {
          fs.renameSync(lock, stale);
        } catch {
          continue;
        }
        const moved = Number(fs.readFileSync(stale, 'utf8'));
        if (moved !== owner) {
          // Another process replaced the claim meanwhile: put it back and leave it alone.
          try {
            fs.linkSync(stale, lock);
          } catch {
            // A third claim took the place; this one is not ours to keep.
          }
          fs.rmSync(stale, { force: true });
          return null;
        }
        fs.rmSync(stale, { force: true });
      }
    }
    return null;
  } finally {
    fs.rmSync(own, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
