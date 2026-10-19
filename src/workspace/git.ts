/**
 * Bounded Git evidence collection and workspace snapshot identity.
 *
 * @packageDocumentation
 */

import { runCommand } from '../execution/process.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readBoundedFile } from '../storage/read.js';
import { truncateToByteLength } from '../execution/runtime/stream.js';
import { ToolError } from '../contracts/error.js';
import type { BackendReadContext } from '../contracts/execution.js';

export interface GitScopeInfo {
  type: 'uncommitted' | 'staged' | 'range' | 'commit' | 'branch';
  label: string;
  diff: string;
  nativeArgs: string[] | null;
  /** The reviewed revision or range for commit, range and branch scopes. */
  revision?: string;
  /** Whether every requested input byte was collected within the bounds. */
  inputComplete: boolean;
  /** Concrete omissions, separate from model-written coverage claims. */
  omissions: string[];
  /** NUL-delimited Git inventory, decoded independently of human-readable diff headers. */
  changedPaths: string[];
  /**
   * Binary files the scope changes: named, with an identity of their content, but not
   * collected, since a model cannot review them as text (`FEEDBACK-070d`).
   */
  binaryFiles: BinaryChange[];
}

/** One binary file a review scope changes. */
export interface BinaryChange {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  /** Git blob id of the reviewed content; `deleted` for a removal. */
  id: string;
}


export const GIT_DIFF_PATHSPEC_EXCLUSIONS: readonly string[] = [
  ':(exclude)dist/**',
  ':(exclude)*.map',
  ':(exclude)*-lock.json',
  ':(exclude)package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)yarn.lock',
];

function isExcludedPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  return (
    norm.startsWith('dist/') ||
    norm === 'dist' ||
    /(?:^|\/)dist\//.test(norm) ||
    norm.endsWith('.map') ||
    norm.endsWith('-lock.json') ||
    norm.endsWith('package-lock.json') ||
    norm.endsWith('pnpm-lock.yaml') ||
    norm.endsWith('yarn.lock')
  );
}

const SNAPSHOT_BYTES = 3 * 1024 * 1024;
function boundedSnapshot(text: string, omissions: string[]): string {
  if (Buffer.byteLength(text.trim()) > SNAPSHOT_BYTES) omissions.push('Total snapshot byte budget reached.');
  return truncateToByteLength(text.trim(), SNAPSHOT_BYTES, '\n[Incomplete snapshot: total prompt budget reached.]');
}

export function combineSignals(
  signal1?: AbortSignal | null,
  signal2?: AbortSignal | null
): AbortSignal | null {
  const activeSignals = [signal1, signal2].filter((s): s is AbortSignal => !!s);
  if (activeSignals.length === 0) return null;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  for (const s of activeSignals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

export function boundGitTimeout(context: BackendReadContext | undefined, defaultMs = 15000): number {
  let bounded = defaultMs;
  if (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs)) {
    bounded = Math.min(bounded, context.timeoutMs);
  }
  if (context?.budget) {
    const remaining = context.phase === 'teardown'
      ? context.budget.remainingTeardownMs()
      : context.budget.remainingExecutionMs();
    bounded = Math.min(bounded, remaining);
  }
  return Math.max(0, bounded);
}

export function normalizeSignalAndContext(
  signalOrContext?: AbortSignal | null | BackendReadContext,
  explicitContext?: BackendReadContext
): { abortSignal?: AbortSignal; context?: BackendReadContext } {
  if (signalOrContext && typeof (signalOrContext as AbortSignal).addEventListener !== 'function' && typeof (signalOrContext as AbortSignal).aborted !== 'boolean') {
    const ctx = signalOrContext as BackendReadContext;
    return { abortSignal: ctx.abortSignal, context: ctx };
  }
  const abortSignal = (signalOrContext as AbortSignal) ?? undefined;
  const context = explicitContext ?? (abortSignal ? { abortSignal } : undefined);
  return { abortSignal, context };
}

export function assertNotExpired(
  effectiveSignal?: AbortSignal | null,
  context?: BackendReadContext,
  phase = 'Git operation',
  isPreLaunch = false
): void {
  const isExpired = context?.phase === 'teardown'
    ? Boolean(context.budget?.isTotalExpired() || (context.budget && context.budget.remainingTeardownMs() <= 0))
    : Boolean(context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut() || (context?.budget && context.budget.remainingExecutionMs() <= 0));

  if (effectiveSignal?.aborted) {
    if (isExpired) {
      throw new ToolError('TIMEOUT', `Execution budget expired ${isPreLaunch ? 'before' : 'during'} ${phase.toLowerCase()}.`);
    }
    throw new ToolError('ABORTED', `${phase} cancelled${isPreLaunch ? ' before launch' : ''}.`);
  }
  if (isExpired) {
    throw new ToolError('TIMEOUT', `Execution budget expired ${isPreLaunch ? 'before' : 'during'} ${phase.toLowerCase()}.`);
  }
}

export async function runGit(
  args: string[],
  cwd = process.cwd(),
  abortSignalOrContext?: AbortSignal | null | BackendReadContext,
  timeoutMs = 15000,
  onTruncated?: () => void,
  explicitContext?: BackendReadContext
): Promise<string> {
  const { abortSignal, context } = normalizeSignalAndContext(abortSignalOrContext, explicitContext);
  const contextSignal = context?.phase === 'teardown'
    ? (context.abortSignal ?? context.budget?.teardownSignal)
    : (context?.budget?.executionSignal ?? context?.abortSignal);
  const effectiveSignal = combineSignals(abortSignal, contextSignal);
  const effectiveTimeout = boundGitTimeout(context, timeoutMs);

  // Pre-flight validation
  assertNotExpired(effectiveSignal, context, 'Git command', true);
  if (effectiveTimeout <= 0) {
    throw new ToolError('TIMEOUT', 'Git operation deadline expired.');
  }

  const result = await runCommand('git', args, {
    cwd,
    abortSignal: effectiveSignal,
    timeoutMs: effectiveTimeout,
    maxBufferBytes: 4 * 1024 * 1024,
  });

  if (result.status !== 'completed') {
    const isBudgetExceeded = context?.phase === 'teardown'
      ? Boolean(context.budget?.isTotalExpired() || (context.budget && context.budget.remainingTeardownMs() <= 0))
      : Boolean(context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut() || (context?.budget && context.budget.remainingExecutionMs() <= 0));
    if (isBudgetExceeded) {
      throw new ToolError('TIMEOUT', 'Execution budget expired during Git operation.');
    }
    if (result.status === 'cancelled' || result.error?.code === 'ABORTED' || effectiveSignal?.aborted) {
      throw new ToolError('ABORTED', result.error?.message || 'Git operation cancelled.');
    }
    if (result.status === 'timed_out' || result.error?.code === 'TIMEOUT') {
      throw new ToolError('TIMEOUT', result.error?.message || 'Git operation timed out.');
    }
    throw new Error(result.error?.message || result.stderr.trim() || `Git exited with code ${result.exitCode}`);
  }

  assertNotExpired(effectiveSignal, context, 'Git operation');

  if (result.isTruncated) {
    onTruncated?.();
    return result.stdout + '\n\n[Warning: Git diff exceeded buffer limit (4MB) and was truncated.]';
  }
  return result.stdout;
}

export function sanitizeGitRef(ref: unknown): string {
  if (typeof ref !== 'string') {
    throw new Error('Validation Error: Git ref must be a string.');
  }
  const clean = ref.trim();
  if (!clean || clean.startsWith('-')) {
    throw new Error(`Validation Error: Git ref cannot be empty or start with a dash ('${ref}').`);
  }
  if (/[\s;`$|<>&"'\0]/.test(clean)) {
    throw new Error(`Validation Error: invalid characters in Git ref '${ref}'.`);
  }
  return clean;
}

export async function collectGitScope(
  rawScope?: string | null,
  workspaceCwd = process.cwd(),
  abortSignalOrContext?: AbortSignal | null | BackendReadContext,
  explicitContext?: BackendReadContext
): Promise<GitScopeInfo> {
  const { abortSignal, context } = normalizeSignalAndContext(abortSignalOrContext, explicitContext);
  const omissions: string[] = [];
  const untrackedBinaries: string[] = [];
  const git = (args: string[]) => runGit(args, workspaceCwd, abortSignal, 15000,
    () => { omissions.push('Git command output exceeded its byte budget.'); }, context);
  const describe = async (info: Omit<GitScopeInfo, 'inputComplete' | 'omissions' | 'changedPaths' | 'binaryFiles'>): Promise<GitScopeInfo> => {
    if (/^GIT binary patch$|^Submodule |^[+-]Subproject commit |^(?:new|deleted) file mode 160000$/m.test(info.diff)) omissions.push('Submodule contents were omitted.');
    const index = await git(['ls-files', '--stage', '-z', '--', '.']);
    if (/\b160000 [0-9a-f]+ [0-3]\t/.test(index)) omissions.push('Workspace contains submodules whose contents are not collected.');
    if (/(?:^|\0)\d{6} [0-9a-f]+ [123]\t/.test(index)) omissions.push('Unmerged index entries prevent a complete snapshot.');
    const flags = await git(['ls-files', '-v', '-z', '--', '.']);
    if (flags.split('\0').some(entry => /^[a-zS] /.test(entry))) omissions.push('Index flags hide working-file changes (assume-unchanged or skip-worktree).');
    const names = ['--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
    let inventory: string;
    if (info.type === 'uncommitted') {
      inventory = await git(['diff', ...names, '--', '.']);
      inventory += await git(['diff', '--cached', ...names, '--', '.']);
      inventory += await git(['ls-files', '-z', '--others', '--exclude-standard', '--', '.']);
    } else if (info.type === 'staged') inventory = await git(['diff', '--cached', ...names, '--', '.']);
    else if (info.type === 'commit') inventory = await git(['show', '--format=', ...names, info.revision!, '--', '.']);
    else inventory = await git(['diff', ...names, info.type === 'branch' ? `${info.revision}...HEAD` : info.revision!, '--', '.']);
    const changedPaths = [...new Set(inventory.split('\0').filter(Boolean))].filter(file => !isExcludedPath(file));
    const diff = boundedSnapshot(info.diff, omissions);
    const binaryFiles = await identifyBinaries(info);
    return { ...info, diff, changedPaths, binaryFiles, inputComplete: omissions.length === 0, omissions };
  };
  /**
   * Finds the scope's binary changes from Git's machine-readable output, never from diff text a
   * file could imitate, and gives each the Git blob id of its reviewed content, so an unchanged
   * repeat is recognized only when those bytes are unchanged too. Working-tree content is
   * hashed by `git hash-object`, bounded like every Git call. Paths are relative to the
   * workspace. A binary whose identity cannot be found makes the input incomplete.
   */
  const identifyBinaries = async (info: Pick<GitScopeInfo, 'type' | 'revision'>): Promise<BinaryChange[]> => {
    let comparisons: string[][];
    if (info.type === 'uncommitted') {
      let hasHead = true;
      try { await git(['rev-parse', '--verify', '-q', 'HEAD']); } catch (err) {
        if (err instanceof ToolError) throw err;
        hasHead = false;
      }
      comparisons = hasHead ? [['diff', 'HEAD']] : [['diff', '--cached'], ['diff']];
    } else if (info.type === 'staged') comparisons = [['diff', '--cached']];
    else if (info.type === 'commit') comparisons = [['show', '--format=', info.revision!]];
    else comparisons = [['diff', info.type === 'branch' ? `${info.revision}...HEAD` : info.revision!]];
    const options = ['-z', '--no-renames', '--relative', '--no-ext-diff', '--no-textconv'];
    const found = new Map<string, { status: BinaryChange['status']; id?: string }>();
    for (const comparison of comparisons) {
      const numstat = (await git([...comparison, '--numstat', ...options, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS])).split('\0');
      const binary = new Set(numstat.map(entry => /^-\t-\t([\s\S]+)$/.exec(entry.replace(/^\n/, ''))?.[1]).filter((file): file is string => Boolean(file)));
      if (!binary.size) continue;
      // `--raw -z`: a `:<modes> <old> <new> <status>` field, then the path.
      const raw = (await git([...comparison, '--raw', '--no-abbrev', ...options, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS])).split('\0');
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const match = /^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(raw[i].replace(/^\n/, ''));
        const file = raw[i + 1];
        if (!match || !binary.has(file)) continue;
        const status = match[2] === 'A' ? 'added' : match[2] === 'D' ? 'deleted' : 'modified';
        const earlier = found.get(file);
        found.set(file, { status: earlier?.status === 'added' && status !== 'deleted' ? 'added' : status, id: /^0+$/.test(match[1]) ? undefined : match[1] });
      }
    }
    for (const file of untrackedBinaries) found.set(file, { status: 'added' });
    // The working tree has no blob id yet; Git hashes those files itself.
    const unhashed = [...found].filter(([, change]) => change.status !== 'deleted' && (info.type === 'uncommitted' || !change.id)).map(([file]) => file);
    for (let start = 0; start < unhashed.length; start += 100) {
      const batch = unhashed.slice(start, start + 100);
      const ids = (await git(['hash-object', '--', ...batch])).split(/\r?\n/).filter(Boolean);
      batch.forEach((file, index) => { if (/^[0-9a-f]{40,64}$/.test(ids[index] ?? '')) found.get(file)!.id = ids[index]; });
    }
    return [...found].map(([file, change]) => {
      if (change.status !== 'deleted' && !change.id) omissions.push(`Binary file identity unavailable: ${file}`);
      return { path: file, status: change.status, id: change.status === 'deleted' ? 'deleted' : change.id ?? 'unknown' };
    });
  };
  const scope = typeof rawScope === 'string' && rawScope.trim() ? rawScope.trim() : 'uncommitted';

  if (scope !== 'uncommitted' && scope.startsWith('-')) {
    throw new Error('Validation Error: scope cannot start with a dash or flag.');
  }

  // Outside a repository, or in one Git refuses (dubious ownership), `git diff` falls back to
  // `--no-index` and rejects `--cached`. Report Git's own reason instead of that symptom.
  try {
    await git(['rev-parse', '--git-dir']);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const reason = (err as Error).message.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'git rev-parse failed';
    throw new ToolError('INPUT_LIMIT', `Review needs a Git repository that Git accepts in this workspace. Git: ${reason}`);
  }

  // 1. Uncommitted working changes (Default: staged + unstaged + untracked)
  if (scope === 'uncommitted' || scope === 'working' || scope === 'all') {
    let hasHead = true;
    try {
      await git(['rev-parse', '--verify', 'HEAD']);
    } catch (err) {
      if (err instanceof ToolError && (err.code === 'ABORTED' || err.code === 'TIMEOUT')) {
        throw err;
      }
      hasHead = false;
    }

    const unstaged = await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);
    const staged = hasHead
      ? await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--cached', 'HEAD', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS])
      : await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--cached', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);

    let diff = [staged.trim(), unstaged.trim()].filter(Boolean).join('\n\n');
    if (!diff && hasHead) {
      diff = (await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS])).trim();
    }

    const untracked = (await git(['ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS])).split('\0').filter(Boolean);
    if (untracked.length) {
      diff += '\n\n--- UNTRACKED FILE SNAPSHOT (workspace scope) ---\n';
      const root = await fs.realpath(workspaceCwd);
      const contextSignal = context?.phase === 'teardown'
        ? (context.abortSignal ?? context.budget?.teardownSignal)
        : (context?.budget?.executionSignal ?? context?.abortSignal);
      const effectiveSignal = combineSignals(abortSignal, contextSignal);
      for (const filename of untracked) {
        assertNotExpired(effectiveSignal, context, 'Untracked file collection');
        if (isExcludedPath(filename)) continue;
        if (Buffer.byteLength(diff) >= SNAPSHOT_BYTES) { omissions.push('Additional untracked files omitted.'); diff += '\n[Additional untracked files omitted: prompt budget.]'; break; }
        try {
          const file = path.resolve(root, filename), stat = await fs.lstat(file);
          if (!stat.isFile() || !file.startsWith(root + path.sep)) { omissions.push(`Non-regular file: ${filename}`); diff += `\n[Omitted non-regular file: ${filename}]`; continue; }
          const real = await fs.realpath(file);
          if (!real.startsWith(root + path.sep)) { omissions.push(`File outside workspace: ${filename}`); diff += `\n[Omitted file outside workspace: ${filename}]`; continue; }
          const text = await readBoundedFile(file, 256 * 1024);
          if (text.includes('\0')) untrackedBinaries.push(filename);
          diff += text.includes('\0') ? `\n[Binary file not collected: ${filename}]` : `\n--- ${filename} ---\n${text}\n`;
        } catch { omissions.push(`Unreadable or oversized file: ${filename}`); diff += `\n[Omitted unreadable or oversized file: ${filename}]`; }
      }
    }

    return describe({
      type: 'uncommitted',
      label: 'Uncommitted working changes (staged, unstaged, untracked)',
      diff,
      nativeArgs: ['--uncommitted'],
    });
  }

  // 2. Staged index changes only
  if (scope === 'staged' || scope === 'cached' || scope === 'index') {
    const diff = await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--cached', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);
    return describe({
      type: 'staged',
      label: 'Staged index changes',
      diff,
      nativeArgs: null,
    });
  }

  // 3. Revision ranges (e.g. main..feature, v1.0.0...v2.0.0, HEAD~3..HEAD)
  if (scope.includes('..')) {
    const cleanRange = scope.replace(/^(range|compare):/i, '').trim();
    if (cleanRange.startsWith('-')) {
      throw new Error(`Validation Error: range cannot start with a dash ('${scope}').`);
    }
    const parts = cleanRange.split('..').filter(Boolean);
    if (parts.length === 0 || parts.length > 2) {
      throw new Error(`Validation Error: invalid revision range '${scope}'.`);
    }
    for (const p of parts) {
      sanitizeGitRef(p);
    }
    const diff = await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', cleanRange, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);
    return describe({
      type: 'range',
      label: `Revision range (${cleanRange})`,
      diff,
      nativeArgs: null,
      revision: cleanRange,
    });
  }

  // 4. Specific commit (SHA hex, commit:prefix, or relative revision)
  const commitMatch = scope.match(/^commit:([0-9a-f]{7,40})$/i) || scope.match(/^([0-9a-f]{7,40})$/i);
  if (commitMatch) {
    const sha = commitMatch[1];
    const diff = await git(['show', '--unified=1', '--no-ext-diff', '--no-textconv', sha, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);
    return describe({
      type: 'commit',
      label: `Commit ${sha}`,
      diff,
      nativeArgs: ['--commit', sha],
      revision: sha,
    });
  }

  if (scope.startsWith('commit:') || /^HEAD([~^]\d*)*$/i.test(scope)) {
    const rawRev = scope.replace(/^commit:/i, '');
    const rev = sanitizeGitRef(rawRev);
    const diff = await git(['show', '--unified=1', '--no-ext-diff', '--no-textconv', rev, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);
    return describe({
      type: 'commit',
      label: `Revision ${rev}`,
      diff,
      nativeArgs: null,
      revision: rev,
    });
  }

  // 5. Branch comparison / PR diff against base (e.g. main, origin/main, feature/auth, base:main)
  const rawBranch = scope.replace(/^(base|branch):/i, '');
  const branchName = sanitizeGitRef(rawBranch);
  const diff = await git(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', `${branchName}...HEAD`, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS]);
  return describe({
    type: 'branch',
    label: `Branch comparison against ${branchName} (${branchName}...HEAD)`,
    diff,
    nativeArgs: null,
    revision: branchName,
  });
}

/**
 * Names the reviewed snapshot for the State Envelope `SNAPSHOT` line, so the reviewer need not look it up.
 * @returns The short commit: HEAD with `+uncommitted` or `+staged` for working changes, the
 * reviewed commit, `<range>` for a range, `<base>...<HEAD>` for a branch, or `no-commit`.
 */
export async function snapshotId(
  scope: GitScopeInfo,
  workspaceCwd = process.cwd(),
  abortSignalOrContext?: AbortSignal | null | BackendReadContext,
  explicitContext?: BackendReadContext
): Promise<string> {
  const { abortSignal, context } = normalizeSignalAndContext(abortSignalOrContext, explicitContext);
  if (scope.type === 'range') return scope.revision as string;
  const short = async (rev: string) => (await runGit(['rev-parse', '--short', rev], workspaceCwd, abortSignal, 15000, undefined, context)).trim();
  if (scope.type === 'commit') return short(scope.revision as string);
  let head: string;
  try {
    head = await short('HEAD');
  } catch (err) {
    if (err instanceof ToolError && (err.code === 'ABORTED' || err.code === 'TIMEOUT')) {
      throw err;
    }
    // A repository without commits has no HEAD; any other failure is real.
    try {
      await runGit(['rev-parse', '--git-dir'], workspaceCwd, abortSignal, 15000, undefined, context);
      return 'no-commit';
    } catch (gitDirErr) {
      if (gitDirErr instanceof ToolError) throw gitDirErr;
      throw err;
    }
  }
  return scope.type === 'branch' ? `${scope.revision}...${head}` : `${head}+${scope.type}`;
}

/** Refuses a revision review when direct file reads would see another tree. */
export async function assertReviewWorkspace(
  scope: GitScopeInfo,
  cwd: string,
  signalOrContext?: AbortSignal | null | BackendReadContext,
  explicitContext?: BackendReadContext
): Promise<void> {
  const { abortSignal, context } = normalizeSignalAndContext(signalOrContext, explicitContext);
  const flags = await runGit(['ls-files', '-v', '-z', '--', '.'], cwd, abortSignal, 15000, undefined, context);
  if (flags.split('\0').some(entry => /^[a-zS] /.test(entry))) throw new ToolError('POLICY_DENIED',
    'Index flags hide working-file changes (assume-unchanged or skip-worktree). Review cannot verify these files. No model turn started.');
  if (scope.type === 'uncommitted') return;
  const target = scope.type === 'commit' ? scope.revision! : scope.type === 'range' ? scope.revision!.split(/\.\.\.?/)[1] || 'HEAD' : 'HEAD';
  const args = scope.type === 'staged' ? [] : [sanitizeGitRef(target)];
  const changed = await runGit(['diff', '--name-only', '--no-ext-diff', '--no-textconv', ...args, '--', '.'], cwd, abortSignal, 15000, undefined, context);
  const untracked = await runGit(['ls-files', '-z', '--others', '--exclude-standard', '--', '.'], cwd, abortSignal, 15000, undefined, context);
  if (changed.trim() || untracked) throw new ToolError('POLICY_DENIED',
    'Review target does not match the files in the current workspace. Review uncommitted changes instead. No model turn started.');
}

