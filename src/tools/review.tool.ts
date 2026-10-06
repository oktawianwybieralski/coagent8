import type { ToolArguments, ToolProgress } from './arguments.js';
import { EXECUTION_PARAMETERS } from './schema.js';
import { executeTask } from '../execution/controller.js';
import { collectGitScope } from '../execution/git.js';
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
  onProgress: ToolProgress = null
) {
  const effectiveScope = args.scope || args.target;
  const scopeInfo = await collectGitScope(effectiveScope, workspaceCwd, abortSignal);
  const instructions = args.instructions || 'Review correctness, security, edge cases and architecture.';
  const prompt = [
    '[TASK: CODE REVIEW & AUDIT]',
    'Scope: ' + scopeInfo.label,
    'Guidelines & Instructions:',
    '- Evaluate the provided diff directly. Do not initiate exploratory file traversal or searches across unrelated repository folders unless strictly necessary to verify direct imports or call sites.',
    '- Provide concise, actionable findings formatted strictly in the State Envelope protocol:',
    '',
    'REVIEW: <turn>',
    'SNAPSHOT: <hash>',
    'COVERAGE: COMPLETE | PARTIAL',
    'VERDICT: READY | BLOCKED',
    '',
    '[P1/P2/P3] <file>:<line>',
    'Problem: <concise statement>',
    'Evidence: <reproducible detail>',
    'Fix: <actionable remedy>',
    '',
    'CHECKS: typecheck=<PASS|FAIL>; tests=<PASS|FAIL|NOT_RUN>',
    'END_REVIEW',
    '',
    'Severity definitions:',
    '  * P1 (Blocker): Critical defects, security vulnerabilities, breaking changes, or crashes. Forces VERDICT: BLOCKED.',
    '  * P2 (Important): Logic bugs, performance regressions, missing error handling, or edge cases. Forces VERDICT: BLOCKED.',
    '  * P3 (Nit/Polish): Code style, documentation, minor cleanups, or non-critical suggestions.',
    '- If no P1 or P2 issues are found, set VERDICT: READY.',
    'Focus: ' + instructions,
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
    { requireEnvelope: true }
  );
}

