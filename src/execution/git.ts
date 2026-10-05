import { runCommand } from './process.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readBoundedFile, truncateToByteLength } from './stream.js';

export interface GitScopeInfo {
  type: 'uncommitted' | 'staged' | 'range' | 'commit' | 'branch';
  label: string;
  diff: string;
  nativeArgs: string[] | null;
}

export const GIT_DIFF_PATHSPEC_EXCLUSIONS: readonly string[] = [
  ':(exclude)dist/**',
  ':(exclude)*.map',
  ':(exclude)*-lock.json',
  ':(exclude)package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)yarn.lock',
];

export function isExcludedPath(relPath: string): boolean {
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
function boundedSnapshot(text: string): string {
  return truncateToByteLength(text.trim(), SNAPSHOT_BYTES, '\n[Incomplete snapshot: total prompt budget reached.]');
}

export async function runGit(
  args: string[],
  cwd = process.cwd(),
  abortSignal: AbortSignal | null = null,
  timeoutMs = 15000
): Promise<string> {
  const result = await runCommand('git', args, {
    cwd,
    abortSignal,
    timeoutMs,
    maxBufferBytes: 4 * 1024 * 1024,
  });

  if (result.status !== 'completed') {
    throw new Error(result.error?.message || result.stderr.trim() || `Git exited with code ${result.exitCode}`);
  }
  if (result.isTruncated || result.stdout.includes('...[stdout truncated: buffer limit reached]')) {
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
  abortSignal: AbortSignal | null = null
): Promise<GitScopeInfo> {
  const scope = typeof rawScope === 'string' && rawScope.trim() ? rawScope.trim() : 'uncommitted';

  if (scope !== 'uncommitted' && scope.startsWith('-')) {
    throw new Error('Validation Error: scope cannot start with a dash or flag.');
  }

  // 1. Uncommitted working changes (Default: staged + unstaged + untracked)
  if (scope === 'uncommitted' || scope === 'working' || scope === 'all') {
    let hasHead = true;
    try {
      await runGit(['rev-parse', '--verify', 'HEAD'], workspaceCwd, abortSignal);
    } catch (_) {
      hasHead = false;
    }

    const unstaged = await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);
    const staged = hasHead
      ? await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--cached', 'HEAD', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal)
      : await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--cached', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);

    let diff = [staged.trim(), unstaged.trim()].filter(Boolean).join('\n\n');
    if (!diff && hasHead) {
      diff = (await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal)).trim();
    }

    const untracked = (await runGit(['ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal)).split('\0').filter(Boolean);
    if (untracked.length) {
      diff += '\n\n--- UNTRACKED FILE SNAPSHOT (workspace scope) ---\n';
      const root = await fs.realpath(workspaceCwd);
      for (const filename of untracked) {
        if (isExcludedPath(filename)) continue;
        if (Buffer.byteLength(diff) >= SNAPSHOT_BYTES) { diff += '\n[Additional untracked files omitted: prompt budget.]'; break; }
        try {
          const file = path.resolve(root, filename), stat = await fs.lstat(file);
          if (!stat.isFile() || !file.startsWith(root + path.sep)) { diff += `\n[Omitted non-regular file: ${filename}]`; continue; }
          const real = await fs.realpath(file);
          if (!real.startsWith(root + path.sep)) { diff += `\n[Omitted file outside workspace: ${filename}]`; continue; }
          const text = await readBoundedFile(file, 256 * 1024);
          diff += text.includes('\0') ? `\n[Binary file omitted: ${filename}]` : `\n--- ${filename} ---\n${text}\n`;
        } catch { diff += `\n[Omitted unreadable or oversized file: ${filename}]`; }
      }
    }

    return {
      type: 'uncommitted',
      label: 'Uncommitted working changes (staged, unstaged, untracked)',
      diff: boundedSnapshot(diff),
      nativeArgs: ['--uncommitted'],
    };
  }

  // 2. Staged index changes only
  if (scope === 'staged' || scope === 'cached' || scope === 'index') {
    const diff = await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', '--cached', '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);
    return {
      type: 'staged',
      label: 'Staged index changes',
      diff: boundedSnapshot(diff),
      nativeArgs: null,
    };
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
    const diff = await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', cleanRange, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);
    return {
      type: 'range',
      label: `Revision range (${cleanRange})`,
      diff: boundedSnapshot(diff),
      nativeArgs: null,
    };
  }

  // 4. Specific commit (SHA hex, commit:prefix, or relative revision)
  const commitMatch = scope.match(/^commit:([0-9a-f]{7,40})$/i) || scope.match(/^([0-9a-f]{7,40})$/i);
  if (commitMatch) {
    const sha = commitMatch[1];
    const diff = await runGit(['show', '--unified=1', '--no-ext-diff', '--no-textconv', sha, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);
    return {
      type: 'commit',
      label: `Commit ${sha}`,
      diff: boundedSnapshot(diff),
      nativeArgs: ['--commit', sha],
    };
  }

  if (scope.startsWith('commit:') || /^HEAD([~^]\d*)*$/i.test(scope)) {
    const rawRev = scope.replace(/^commit:/i, '');
    const rev = sanitizeGitRef(rawRev);
    const diff = await runGit(['show', '--unified=1', '--no-ext-diff', '--no-textconv', rev, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);
    return {
      type: 'commit',
      label: `Revision ${rev}`,
      diff: boundedSnapshot(diff),
      nativeArgs: null,
    };
  }

  // 5. Branch comparison / PR diff against base (e.g. main, origin/main, feature/auth, base:main)
  const rawBranch = scope.replace(/^(base|branch):/i, '');
  const branchName = sanitizeGitRef(rawBranch);
  const diff = await runGit(['diff', '--unified=1', '--no-ext-diff', '--no-textconv', `${branchName}...HEAD`, '--', '.', ...GIT_DIFF_PATHSPEC_EXCLUSIONS], workspaceCwd, abortSignal);
  return {
    type: 'branch',
    label: `Branch comparison against ${branchName} (${branchName}...HEAD)`,
    diff: boundedSnapshot(diff),
    nativeArgs: null,
  };
}
