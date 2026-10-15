/**
 * Input completeness and identity for review approval.
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import { collectGitScope, snapshotId, type GitScopeInfo } from '../workspace/git.js';
import type { ReviewGateContext } from './gate.js';
import type { TimingTracer, BackendReadContext } from '../contracts/execution.js';

function isTimingTracer(val: unknown): val is TimingTracer {
  return typeof val === 'object' && val !== null && 'startPhase' in val && typeof (val as TimingTracer).startPhase === 'function';
}

function isAbortSignal(val: unknown): val is AbortSignal {
  return typeof val === 'object' && val !== null && ('addEventListener' in val || 'aborted' in val);
}

function isBackendReadContext(val: unknown): val is BackendReadContext {
  return typeof val === 'object' && val !== null && !isTimingTracer(val) && !isAbortSignal(val);
}

/** Captures review input together with the live workspace used for direct file reads. */
export async function collectReviewInput(
  scope: string | undefined,
  cwd: string,
  signalOrContext?: AbortSignal | null | BackendReadContext,
  tracerOrContext?: TimingTracer | BackendReadContext,
  optionsContext?: BackendReadContext
) {
  let signal: AbortSignal | null = null;
  let tracer: TimingTracer | undefined = undefined;
  let context: BackendReadContext | undefined = undefined;

  if (isAbortSignal(signalOrContext)) {
    signal = signalOrContext;
  } else if (isBackendReadContext(signalOrContext)) {
    context = signalOrContext;
    signal = context.abortSignal ?? null;
  }

  if (isTimingTracer(tracerOrContext)) {
    tracer = tracerOrContext;
  } else if (isBackendReadContext(tracerOrContext)) {
    context = tracerOrContext;
    if (!signal) signal = context.abortSignal ?? null;
  }

  if (optionsContext) {
    context = optionsContext;
    if (!signal) signal = context.abortSignal ?? null;
  }

  if (signal && !context) {
    context = { abortSignal: signal };
  }

  const span = tracer?.startPhase('git_collection');
  try {
    const info = await collectGitScope(scope, cwd, signal, context);
    const working = info.type === 'uncommitted' ? info : await collectGitScope('uncommitted', cwd, signal, context);
    const identity = await snapshotId(info, cwd, signal, context);
    const workingIdentity = await snapshotId(working, cwd, signal, context);
    const digest = createHash('sha256').update(JSON.stringify({
      identity,
      workingIdentity,
      diff: info.diff,
      workspace: working.diff,
      changedPaths: info.changedPaths,
      omissions: [...info.omissions, ...working.omissions],
    })).digest('hex');
    const reviewGateContext: ReviewGateContext = {
      expectedSnapshot: `${identity}#${digest}`,
      inputComplete: info.inputComplete && working.inputComplete,
      requiredChecks: proseOnly(info) ? [] : ['typecheck', 'tests'],
      requiredFiles: info.changedPaths,
      workspaceRoot: cwd,
    };
    return { info, context: reviewGateContext };
  } finally {
    span?.end();
  }
}

export function proseOnly(info: GitScopeInfo): boolean {
  return info.changedPaths.every(file => /\.md$/i.test(file));
}

