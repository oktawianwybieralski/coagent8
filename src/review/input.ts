/**
 * Input completeness and identity for review approval.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { collectGitScope, snapshotId, type GitScopeInfo } from '../workspace/git.js';
import type { ReviewGateContext } from './gate.js';
import type { TimingTracer } from '../contracts/execution.js';

/** Captures review input together with the live workspace used for direct file reads. */
export async function collectReviewInput(
  scope: string | undefined,
  cwd: string,
  signal: AbortSignal | null,
  tracer?: TimingTracer
) {
  const span = tracer?.startPhase('git_collection');
  try {
    const info = await collectGitScope(scope, cwd, signal);
    const working = info.type === 'uncommitted' ? info : await collectGitScope('uncommitted', cwd, signal);
    const identity = await snapshotId(info, cwd, signal);
    const workingIdentity = await snapshotId(working, cwd, signal);
    const digest = createHash('sha256').update(JSON.stringify({
      identity,
      workingIdentity,
      diff: info.diff,
      workspace: working.diff,
      changedPaths: info.changedPaths,
      omissions: [...info.omissions, ...working.omissions],
    })).digest('hex');
    const context: ReviewGateContext = {
      expectedSnapshot: `${identity}#${digest}`,
      inputComplete: info.inputComplete && working.inputComplete,
      requiredChecks: proseOnly(info) ? [] : ['typecheck', 'tests'],
    };
    return { info, context };
  } finally {
    span?.end();
  }
}

export function proseOnly(info: GitScopeInfo): boolean {
  return info.changedPaths.every(file => /\.md$/i.test(file));
}

