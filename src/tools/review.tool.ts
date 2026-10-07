import type { ToolArguments, ToolProgress } from './arguments.js';
import { EXECUTION_PARAMETERS } from './schema.js';
import { executeTask, type TaskOptions } from '../execution/controller.js';
import { collectReviewInput } from './review-input.js';
import { assertReviewWorkspace } from '../execution/git.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';

export function getCanonicalReviewToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.REVIEW,
    description: 'Independent review of Git changes by another coding agent. Returns findings, then "> Verdict: READY" or "> Verdict: BLOCKED (reason)".',
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
  const { info: scopeInfo, context } = await collectReviewInput(effectiveScope, workspaceCwd, abortSignal);
  await assertReviewWorkspace(scopeInfo, workspaceCwd, abortSignal);
  const instructions = args.instructions || 'Review correctness, security, edge cases and architecture.';
  const snapshot = context.expectedSnapshot;
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
    `Required checks for this scope: ${context.requiredChecks.join(', ') || 'none (prose only)'}. Report NOT_RUN when no check was executed; never infer PASS from reading code. A check that cannot run here is NOT_RUN, not FAIL.`,
    `Collected input: ${context.inputComplete ? 'COMPLETE' : 'PARTIAL'}. Omitted input prevents READY regardless of reported coverage.`,
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
    { requireEnvelope: true, askConsent: options.askConsent, reviewContext: context,
      verifyReviewSnapshot: async () => {
        const after = await collectReviewInput(effectiveScope, workspaceCwd, abortSignal);
        await assertReviewWorkspace(after.info, workspaceCwd, abortSignal);
        return after.context.expectedSnapshot !== snapshot || !after.context.inputComplete ? 'Review workspace or input changed during the turn' : undefined;
      } }
  );
}

