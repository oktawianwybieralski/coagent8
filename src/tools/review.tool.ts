import type { ToolArguments, ToolProgress } from './arguments.js';
import { executeTask } from '../execution/controller.js';
import { collectGitScope } from '../execution/git.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';

export function getCanonicalReviewToolDefinition() {
  return {
    name: CANONICAL_TOOL_NAMES.REVIEW,
    description:
      'Run CoAgent Review: automated code review on uncommitted changes, staged index, branches, or commits using local reasoning agents in read-only sandbox mode.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description:
            'Target changes to review. Formats: "uncommitted" (default), "staged", commit SHA ("a1b2c3d"), revision ("HEAD~1"), base branch ("main"), or revision range ("main...feature").',
        },
        target: {
          type: 'string',
          description: 'Optional explicit target commit SHA, branch name, or revision range.',
        },
        instructions: {
          type: 'string',
          description: 'Review focus guidelines, constraints, conventions, or security/performance checks.',
        },
        backend: {
          type: 'string',
          enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'],
          description: 'CLI agent backend to execute the review (default: "auto").',
        },
        workspace_path: {
          type: 'string',
          description: 'Optional absolute path to workspace root.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the selected backend.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Reasoning depth level (e.g. "low", "medium", "high", "xhigh", "max").',
        },
        user_confirmed: {
          type: 'boolean',
          description: 'Mandatory true confirmation if invoking top-tier models (e.g. "astra", "claude-3-opus").',
        },
        session_handle: {
          type: 'string',
          description: 'Optional persistent session handle from a previous turn to preserve full multi-turn context.',
        },
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

