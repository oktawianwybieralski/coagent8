/**
 * The reviewed state as a separate work tree (#213): a reviewer runs its commands in a copy of
 * exactly what it reviews, not in the user's work tree.
 *
 * @remarks
 * Uncommitted changes become a commit built from a temporary index (a copy of the user's index
 * plus every untracked, non-ignored file within the review bounds); staged changes become a
 * commit of the index alone; committed scopes use their target revision. The commit is held by
 * one ref per workspace while the turn runs and is checked out detached, without hooks, in one
 * directory per workspace, so a follow-up review resumes in the same place (Claude Code keeps
 * its sessions per directory). The file lock of the workspace's snapshot holds both for the
 * whole review, so a second review of the workspace runs in the workspace instead. A repository
 * whose attributes name any filter (such as Git LFS) is not materialized: neither its clean nor
 * its smudge filter runs; nor is one with submodules. Whatever cannot be materialized runs the review in the workspace, as
 * before. The snapshot is a working directory, not a boundary.
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
import { LockTimeoutError, withFileLock } from '../storage/lock.js';

/** Untracked bytes a snapshot hashes at most, per file and in total, as the review input does. */
export const SNAPSHOT_MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
export const SNAPSHOT_MAX_UNTRACKED_TOTAL_BYTES = 3 * 1024 * 1024;

/** How long a review waits for another review's snapshot of the same workspace. */
const SNAPSHOT_LOCK_WAIT_MS = 250;

/** A materialized review state. */
export interface ReviewSnapshot {
  /** The separate work tree. */
  path: string;
  /** Where the reviewer runs: the workspace's place inside the work tree. */
  cwd: string;
  /** The commit it shows. */
  commit: string;
}

/** A fixed identity for the snapshot commit, which no one but the review sees. */
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

/** The workspace's key: one snapshot directory, lock and ref per workspace. */
function workspaceKey(workspace: string): string {
  return crypto.createHash('sha256').update(canonicalPath(workspace)).digest('hex').slice(0, 12);
}

/** One directory per workspace: a follow-up review resumes where the first ran. */
export function snapshotPath(workspace: string): string {
  return path.join(snapshotRoot(), workspaceKey(workspace));
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
 * Runs `fn` with the reviewed state materialized, or in the workspace when it cannot be.
 * @param info - The collected review scope.
 * @param workspace - The user's work tree.
 * @param context - The call's read context; its budget bounds the Git commands that build the snapshot.
 * @param fn - Gets the snapshot, or undefined and why there is none.
 * @returns What `fn` returns.
 */
export async function withReviewSnapshot<T>(
  info: GitScopeInfo,
  workspace: string,
  context: BackendReadContext | undefined,
  fn: (snapshot: ReviewSnapshot | undefined, skipped?: string) => Promise<T>,
): Promise<T> {
  const lock = path.join(snapshotRoot(), `${workspaceKey(workspace)}.lock`);
  let ran = false;
  try {
    fs.mkdirSync(snapshotRoot(), { recursive: true });
    return await withFileLock(
      lock,
      async () => {
        ran = true;
        return runInSnapshot(info, workspace, context, fn);
      },
      { timeoutMs: SNAPSHOT_LOCK_WAIT_MS },
    );
  } catch (err) {
    // Anything `fn` threw stands; before it ran, a lock another review holds, or any failure to set
    // up the lock, sends this review to the workspace. A cancellation or deadline ends it.
    if (ran) throw err;
    if (err instanceof ToolError && (err.code === 'TIMEOUT' || err.code === 'ABORTED')) throw err;
    return fn(
      undefined,
      err instanceof LockTimeoutError
        ? 'another review of this workspace is using its snapshot'
        : `the snapshot lock could not be set up: ${(err as Error).message.slice(0, 200)}`,
    );
  }
}

async function runInSnapshot<T>(
  info: GitScopeInfo,
  workspace: string,
  context: BackendReadContext | undefined,
  fn: (snapshot: ReviewSnapshot | undefined, skipped?: string) => Promise<T>,
): Promise<T> {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => runGit(args, workspace, context, 15000, undefined, undefined, env);
  // A listing cut at the output bound is no inventory: whatever it would miss could not be checked.
  const list = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      let cut = false;
      runGit(args, workspace, context, 15000, () => {
        cut = true;
      }).then(out => (cut ? reject(new Error('a Git listing exceeded its output bound')) : resolve(out)), reject);
    });
  // Cleanup runs without the call's signal: a cancelled or expired call still removes what it made.
  const cleanupGit = (args: string[]) => runGit(args, workspace, null, 15000);
  const target = snapshotPath(workspace);
  const ref = `refs/coagent8/review/${workspaceKey(workspace)}`;
  let snapshot: ReviewSnapshot | undefined;
  let skipped: string | undefined;
  try {
    const made = await materialize(info, workspace, git, list, target, ref);
    if (typeof made === 'string') skipped = made;
    else snapshot = made;
  } catch (err) {
    await cleanUp(cleanupGit, target, ref);
    if (err instanceof ToolError && (err.code === 'TIMEOUT' || err.code === 'ABORTED')) throw err;
    skipped = `the snapshot could not be prepared: ${(err as Error).message.slice(0, 200)}`;
  }
  // Without a snapshot, what an earlier, crashed review left is removed before the turn.
  if (!snapshot) await cleanUp(cleanupGit, target, ref);
  try {
    return await fn(snapshot, skipped);
  } finally {
    if (snapshot) await cleanUp(cleanupGit, target, ref);
  }
}

/** Builds the snapshot, or says why it cannot be built; throws on a Git failure. */
async function materialize(
  info: GitScopeInfo,
  workspace: string,
  git: (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>,
  list: (args: string[]) => Promise<string>,
  target: string,
  ref: string,
): Promise<ReviewSnapshot | string> {
  const revision = targetRevision(info);
  const none = Promise.resolve('');
  // Independent reads at once: each Git start costs time, on Windows most of all.
  const [where, untracked, head, targetCommit, systemAttributes, globalAttributes] = await Promise.all([
    git(['rev-parse', '--git-dir', '--show-prefix', '--git-path', 'info/attributes']),
    info.type === 'uncommitted' ? list(['ls-files', '--others', '--exclude-standard', '-z', '--', ':(top)']) : none,
    revision ? none : git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => ''),
    revision ? git(['rev-parse', '--verify', `${revision}^{commit}`]) : none,
    // Where Git itself reads system and global attributes, whatever this installation configured.
    git(['var', 'GIT_ATTR_SYSTEM']),
    git(['var', 'GIT_ATTR_GLOBAL']),
  ]);
  const [gitDirLine = '', prefixLine = '', infoAttributesLine = ''] = where.split(/\r?\n/);
  // Exactly as Git prints it, without its trailing slash: a directory name may start with a space.
  const prefix = prefixLine.replace(/\/+$/, '');
  // Any filter in any attribute source keeps the review in the workspace, before a filter could run.
  if (await namesFilter(git, info.type, revision, workspace, [infoAttributesLine, systemAttributes, globalAttributes])) {
    return 'the repository names a checkout filter (such as Git LFS) in its attributes';
  }
  let commit = targetCommit.trim();
  if (!revision) {
    const overBounds = untrackedOverBounds(untracked, workspace);
    if (overBounds) return overBounds;
    const gitDir = path.resolve(workspace, gitDirLine.trim());
    const index = path.join(gitDir, 'index');
    const temporary = path.join(gitDir, `coagent8-index-${crypto.randomBytes(6).toString('hex')}`);
    try {
      // A copy of the user's index: its staged entries and flags stay, and the user's index is never written.
      if (fs.existsSync(index)) {
        fs.copyFileSync(index, temporary);
        // The copy keeps the index's time: Git compares an entry's time with it to tell a file changed
        // in the same second as it was staged ("racily clean"), and a newer copy would hide that change.
        const { atime, mtime } = fs.statSync(index);
        fs.utimesSync(temporary, atime, mtime);
      }
      const env = { GIT_INDEX_FILE: temporary };
      if (info.type === 'uncommitted') await git(['-c', 'core.autocrlf=false', 'add', '-A', '--', ':(top)'], env);
      const tree = (await git(['write-tree'], env)).trim();
      const parent = head.trim();
      commit = (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'CoAgent8 review snapshot'], COMMIT_ENV)).trim();
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  // A gitlink (a submodule, or a nested repository added without one) would be an empty directory
  // in the snapshot, not the reviewed content. One word per entry keeps the listing small.
  const types = await list(['ls-tree', '-r', '--full-tree', '--format=%(objecttype)', commit]);
  if (/^commit$/m.test(types)) return 'the repository has submodules or nested repositories, which a snapshot would leave empty';
  // An earlier review's tree and ref at this place are replaced, also those of a server that ended.
  await removeWorkTree(git, target);
  const hooks = path.join(snapshotRoot(), 'no-hooks');
  fs.mkdirSync(hooks, { recursive: true });
  await git(['update-ref', ref, commit]);
  await git(['-c', `core.hooksPath=${hooks}`, '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', '--force', target, commit]);
  // A revision without the workspace's subdirectory has no place to run in.
  if (prefix && !fs.statSync(path.join(target, prefix), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('the reviewed revision has no such subdirectory');
  }
  return { path: target, cwd: prefix ? path.join(target, prefix) : target, commit };
}

/** Whether any attribute source of the reviewed state names a filter. */
async function namesFilter(
  git: (args: string[]) => Promise<string>,
  type: GitScopeInfo['type'],
  revision: string | null,
  workspace: string,
  attributeFiles: readonly string[],
): Promise<boolean> {
  const pathspec = ['--', ':(top,glob)**/.gitattributes'];
  // The attribute files the snapshot will contain: the working tree's (tracked or not), the index's, or the revision's.
  // `git grep` exits 1 for no match; any other failure leaves an attribute file unread, which ends
  // the snapshot (the caller then runs in the workspace).
  const grep = (args: string[], tree?: string) =>
    git(['grep', ...args, '-l', '-I', '-e', 'filter=', ...(tree ? [tree] : []), ...pathspec]).catch((err: unknown) => {
      if ((err as Error).message === 'Git exited with code 1') return '';
      throw err;
    });
  // The working tree's (tracked or not, ignored too) and the index's: Git falls back to the index
  // for an attribute file missing from the working tree. Staged: the index's. Committed: the revision's.
  const searches =
    type === 'uncommitted'
      ? [grep(['--untracked', '--no-exclude-standard']), grep(['--cached'])]
      : type === 'staged'
        ? [grep(['--cached'])]
        : [grep([], revision ?? 'HEAD')];
  if ((await Promise.all(searches)).some(found => found.trim())) return true;
  for (const file of attributeFiles.map(entry => entry.trim()).filter(Boolean)) {
    if (/(^|\s)filter=/m.test(readText(path.resolve(workspace, file)))) return true;
  }
  return false;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
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

/** Removes the snapshot's ref and work tree; nothing there is fine, and nothing here throws. */
async function cleanUp(git: (args: string[]) => Promise<string>, target: string, ref: string): Promise<void> {
  await Promise.all([git(['update-ref', '-d', ref]).catch(() => undefined), removeWorkTree(git, target).catch(() => undefined)]);
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
