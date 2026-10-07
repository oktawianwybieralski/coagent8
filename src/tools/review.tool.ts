import type { ToolArguments, ToolProgress } from './arguments.js';
import { EXECUTION_PARAMETERS } from './schema.js';
import { executeTask, type TaskOptions } from '../execution/controller.js';
import { collectGitScope, snapshotId } from '../execution/git.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';

export function getCanonicalReviewToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.REVIEW,
    description: 'Code review of git changes by another coding agent; returns VERDICT READY or BLOCKED.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'uncommitted (default), staged, a commit, a branch or a range a...b.' },
        // Accepted alias of scope.
        target: { type: 'string' },
        instructions: { type: 'string', description: 'Review focus.' },
        ...EXECUTION_PARAMETERS,
      },
    },
  };
}

export async function handleReview(
  toolName: string,
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: Pick<TaskOptions, 'askConsent'> = {}
) {
  const effectiveScope = args.scope || args.target;
  const scopeInfo = await collectGitScope(effectiveScope, workspaceCwd, abortSignal);
  const instructions = args.instructions || 'Review correctness, security, edge cases and architecture.';
  const snapshot = await snapshotId(scopeInfo, workspaceCwd, abortSignal);
  // The answer is read in the caller's context: findings only, each as short as its evidence allows.
  const prompt = [
    `Review this diff: ${scopeInfo.label}. Read other files only to check direct imports or call sites.`,
    'Focus: ' + instructions,
    'Answer with exactly this envelope and nothing before it:',
    'REVIEW: <turn>',
    `SNAPSHOT: ${snapshot}`,
    'COVERAGE: COMPLETE | PARTIAL',
    'VERDICT: READY | BLOCKED',
    '[P1|P2|P3] <file>:<line>',
    'Problem: <one sentence>',
    'Evidence: <at most two sentences, citing file:line>',
    'Fix: <one sentence>',
    'CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>',
    'END_REVIEW',
    'P1: defect, security flaw, crash or breaking change. P2: logic bug, regression, missing error handling or edge case. Any P1 or P2 means VERDICT: BLOCKED, none means READY. P3: style or polish, one line without Evidence and Fix.',
    'DIFF:',
    scopeInfo.diff || '[No changes in this scope]',
  ].join('\n');
  return executeTask(
    prompt,
    'Review ' + scopeInfo.label + '\n' + instructions,
    { ...args, backend: args.backend },
    workspaceCwd,
    abortSignal,
    onProgress,
    { requireEnvelope: true, askConsent: options.askConsent }
  );
}

