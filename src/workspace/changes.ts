/**
 * Workspace changes the server observes around a `workspace-write` turn (`DELEGATE-001w`).
 *
 * @remarks
 * A snapshot records HEAD, the branch, `git status` of the workspace (untracked files
 * included, ignored files not), the staged blob and mode of every staged path, and a content
 * signature of every dirty working file. Comparing two snapshots yields every path whose
 * status, staged entry or content differs, plus the paths of commits made between them.
 * Everything here is evidence the server observed, separate from what the backend reports.
 * Every Git listing is complete or the read fails: a listing cut at the Git output limit, or
 * a failed command, is never compared as if it were whole.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runGit } from './git.js';
import { ToolError, type BackendReadContext, type ObservedChange, type WorkspaceChanges } from '../contracts/index.js';

/** Changed paths listed at most in a result. */
export const MAX_LISTED_CHANGES = 200;
/** Working files larger than this are compared by size and modification time only. */
const MAX_HASHED_BYTES = 16 * 1024 * 1024;

/** One path of a {@link WorkspaceSnapshot}: its Git status and a signature of its content. */
export interface PathState {
  /** Porcelain v1 status code, such as ` M`, `A `, `??` or ` D`. */
  status: string;
  /** Staged mode and blob, when the path differs from HEAD in the index. */
  staged?: string;
  /** Signature of the working file, or null when it does not exist. */
  content: string | null;
}

/** State of a workspace at one moment; paths are relative to the workspace, with `/`. */
export interface WorkspaceSnapshot {
  head: string | null;
  branch: string | null;
  paths: Map<string, PathState>;
}

/** Repository root and the workspace's place in it, read once per call. */
export interface WorkspaceRepository {
  root: string;
  /** Workspace path relative to the repository root, `''` or ending in `/`. */
  prefix: string;
  /** Absolute Git directory of the work tree; each linked worktree has its own. */
  gitDir: string;
}

/**
 * Normalizes a caller's scope entry to a workspace-relative path with `/` separators.
 * @returns The entry, `''` for the whole workspace, or null when it is absolute or leaves the workspace.
 */
export function normalizeScopeEntry(entry: string): string | null {
  const slashed = entry.trim().replace(/\\/g, '/');
  if (!slashed || path.posix.isAbsolute(slashed) || /^[a-zA-Z]:/.test(slashed)) return slashed ? null : '';
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? '' : normalized;
}

/** Whether a workspace-relative path lies in the scope; whole path segments must match. */
export function inScope(file: string, scope: readonly string[]): boolean {
  if (!scope.length) return true;
  return scope.some(entry => entry === '' || file === entry || file.startsWith(`${entry}/`));
}

/**
 * Reads the repository that holds the workspace.
 * @throws When the workspace is not inside a Git work tree.
 */
export async function readWorkspaceRepository(cwd: string, context?: BackendReadContext): Promise<WorkspaceRepository> {
  const root = (await runGit(['rev-parse', '--show-toplevel'], cwd, context)).trim();
  const prefix = (await runGit(['rev-parse', '--show-prefix'], cwd, context)).trim();
  const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], cwd, context)).trim();
  if (!root || !gitDir) throw new Error('The workspace is not inside a Git work tree.');
  return { root, prefix, gitDir };
}

/**
 * Runs a Git command whose output this module parses as a complete listing. `diff.relative`
 * would print paths relative to the workspace instead of the repository root.
 * @throws When the output reached the Git output limit and was cut.
 */
async function listing(args: string[], cwd: string, context?: BackendReadContext): Promise<string[]> {
  let cut = false;
  const output = await runGit(['-c', 'diff.relative=false', ...args], cwd, context, undefined, () => {
    cut = true;
  });
  if (cut) throw new Error('Git output exceeded its size limit, so the changes cannot be compared reliably.');
  return output.split('\0').filter(Boolean);
}

/**
 * Reads a value whose absence is an expected repository state, such as HEAD before the first
 * commit or the branch of a detached HEAD: the quiet command then exits 1 without output.
 * @throws Every other failure, such as a timeout or a broken repository.
 */
async function optional(args: string[], cwd: string, context?: BackendReadContext): Promise<string | null> {
  try {
    return (await runGit(args, cwd, context)).trim() || null;
  } catch (err) {
    if (!(err instanceof ToolError) && (err as Error).message === 'Git exited with code 1') return null;
    throw err;
  }
}

/** Workspace-relative form of a repository-relative path, or null outside the workspace. */
function relativeToWorkspace(repo: WorkspaceRepository, file: string): string | null {
  if (!repo.prefix) return file;
  return file.startsWith(repo.prefix) ? file.slice(repo.prefix.length) : null;
}

function signature(repo: WorkspaceRepository, file: string): string | null {
  const full = path.join(repo.root, file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(full)}`;
  if (!stat.isFile()) return `other:${stat.mode}`;
  // Git tracks the executable bit; Windows reports none.
  const mode = stat.mode & 0o111 ? 'x' : '-';
  if (stat.size > MAX_HASHED_BYTES) return `large:${mode}:${stat.size}:${stat.mtimeMs}`;
  return `${mode}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
}

/** Records the workspace's Git state, for comparison after a turn. */
export async function captureWorkspace(cwd: string, repo: WorkspaceRepository, context?: BackendReadContext): Promise<WorkspaceSnapshot> {
  const head = await optional(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd, context);
  const branch = await optional(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, context);
  const status = await listing(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], cwd, context);
  const paths = new Map<string, PathState>();
  for (let i = 0; i < status.length; i++) {
    const record = status[i]!;
    const code = record.slice(0, 2),
      file = record.slice(3);
    // A rename or copy is followed by its source path, which the rename removed.
    if (code[0] === 'R' || code[0] === 'C') {
      const source = status[++i];
      const relative = source === undefined ? null : relativeToWorkspace(repo, source);
      if (code[0] === 'R' && relative !== null && !paths.has(relative))
        paths.set(relative, { status: 'D ', content: signature(repo, source!) });
    }
    const relative = relativeToWorkspace(repo, file);
    if (relative !== null) paths.set(relative, { status: code, content: signature(repo, file) });
  }
  // Staged content can change while the status code and working file stay the same. Without
  // HEAD, `--cached` compares the index with the empty tree.
  const staged = await listing(['diff', '--cached', '--raw', '--no-renames', '-z', '--', '.'], cwd, context);
  for (let i = 0; i + 1 < staged.length; i += 2) {
    const fields = staged[i]!.split(' '),
      relative = relativeToWorkspace(repo, staged[i + 1]!);
    const entry = relative === null ? undefined : paths.get(relative);
    if (entry) entry.staged = `${fields[1]} ${fields[3]}`;
  }
  return { head, branch, paths };
}

/** Workspace paths tracked in a commit; a clean path missing from a status listing exists exactly when tracked. */
async function trackedPaths(
  cwd: string,
  repo: WorkspaceRepository,
  head: string | null,
  context?: BackendReadContext,
): Promise<Set<string>> {
  if (!head) return new Set();
  const files = await listing(['ls-tree', '-r', '-z', '--full-name', '--name-only', head, '--', '.'], cwd, context);
  return new Set(files.map(file => relativeToWorkspace(repo, file)).filter((file): file is string => file !== null));
}

/**
 * Compares two snapshots of the same workspace.
 * @param scope - Normalized scope entries; empty means the whole workspace.
 * @returns The observed changes, listed up to {@link MAX_LISTED_CHANGES}.
 * @throws When a Git listing fails or is cut; the caller reports the changes as unavailable.
 */
export async function compareWorkspace(
  cwd: string,
  repo: WorkspaceRepository,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  scope: readonly string[],
  context?: BackendReadContext,
): Promise<WorkspaceChanges> {
  const changed = new Map<string, ObservedChange['kind']>();
  const differing = [...new Set([...before.paths.keys(), ...after.paths.keys()])].filter(file => {
    const a = before.paths.get(file),
      b = after.paths.get(file);
    return !(a && b && a.status === b.status && a.staged === b.staged && a.content === b.content);
  });
  // Read only when a differing path is missing from one listing, which makes it clean there.
  const needsTree = (snapshot: WorkspaceSnapshot) => differing.some(file => !snapshot.paths.has(file));
  const trackedBefore = needsTree(before) ? await trackedPaths(cwd, repo, before.head, context) : new Set<string>();
  const trackedAfter = needsTree(after) ? await trackedPaths(cwd, repo, after.head, context) : new Set<string>();
  for (const file of differing) {
    const a = before.paths.get(file),
      b = after.paths.get(file);
    const was = a ? a.content !== null : trackedBefore.has(file);
    const is = b ? b.content !== null : trackedAfter.has(file);
    // Absent on both sides, the path's deletion moved, for example from the index into a commit.
    changed.set(file, !was && is ? 'added' : !is ? 'deleted' : 'modified');
  }
  let headMoved: WorkspaceChanges['headMoved'];
  if (before.head !== after.head || before.branch !== after.branch) {
    let commits = 0;
    if (after.head) {
      const range = before.head ? [`${before.head}..${after.head}`] : [after.head];
      commits = Number((await runGit(['rev-list', '--count', ...range], cwd, context)).trim()) || 0;
      // Files committed during the turn are changes even when the tree is clean again.
      const committed = await listing(
        before.head
          ? ['diff', '--name-status', '--no-renames', '-z', before.head, after.head, '--', '.']
          : ['show', '--name-status', '--no-renames', '--format=', '-z', after.head, '--', '.'],
        cwd,
        context,
      );
      for (let i = 0; i + 1 < committed.length; i += 2) {
        const relative = relativeToWorkspace(repo, committed[i + 1]!);
        if (relative !== null && !changed.has(relative))
          changed.set(relative, committed[i] === 'A' ? 'added' : committed[i] === 'D' ? 'deleted' : 'modified');
      }
    }
    headMoved = { before: before.head, after: after.head, commits, branchBefore: before.branch, branchAfter: after.branch };
  }
  const all = [...changed.entries()].sort(([x], [y]) => x.localeCompare(y));
  const listed = all.slice(0, MAX_LISTED_CHANGES).map(([file, kind]) => ({ path: file, kind }));
  const tracked = listed
    .filter(change => change.kind !== 'added' || after.paths.get(change.path)?.status !== '??')
    .map(change => change.path);
  // At most MAX_LISTED_CHANGES lines; the formatter redacts and bounds the whole text.
  const diffStat =
    after.head && tracked.length
      ? (await listing(['diff', '--stat=120', 'HEAD', '--', ...tracked.map(file => `:(literal)${file}`)], cwd, context))
          .join('')
          .trimEnd() || undefined
      : undefined;
  return {
    changed: listed,
    outsideScope: listed.filter(change => !inScope(change.path, scope)).map(change => change.path),
    dirtyBefore: listed.filter(change => before.paths.has(change.path)).map(change => change.path),
    ...(headMoved ? { headMoved } : {}),
    ...(diffStat ? { diffStat } : {}),
    truncated: all.length > listed.length,
  };
}
