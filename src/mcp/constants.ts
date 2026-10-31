/**
 * MCP tool naming and protocol constants for CoAgent8.
 *
 * @packageDocumentation
 */

export const CANONICAL_TOOL_NAMES = {
  CONSULT: 'consult',
  REVIEW: 'review',
  DOCTOR: 'doctor',
  SESSION: 'session',
  CANCEL: 'cancel',
  ISSUE: 'issue',
  DELEGATE: 'delegate',
  // Deprecated legacy aliases maintained through 1.0.x; removal planned for v1.1.0
  ANALYZE: 'analyze',
  DEBUG: 'debug',
  IMPLEMENT: 'implement',
  RUN: 'run',
} as const;

/**
 * Canonical tools: the six of the SURFACE-001 public contract and `delegate` (`DELEGATE-001w`).
 */
export const CORE_CANONICAL_TOOL_NAMES = [
  CANONICAL_TOOL_NAMES.CONSULT,
  CANONICAL_TOOL_NAMES.REVIEW,
  CANONICAL_TOOL_NAMES.DELEGATE,
  CANONICAL_TOOL_NAMES.DOCTOR,
  CANONICAL_TOOL_NAMES.SESSION,
  CANONICAL_TOOL_NAMES.CANCEL,
  CANONICAL_TOOL_NAMES.ISSUE,
] as const;

/**
 * Server-wide initialization guidance; the host controls its visibility on model turns.
 * It explains when to use CoAgent8 and when not, and where the accepted models are listed.
 * Codex reads the first 512 characters on their own, so it stays within them; call-time rules
 * live in the parameter descriptions (`schema.ts`).
 */
export const SERVER_INSTRUCTIONS =
  'Asks another local coding agent (Codex, Claude Code or Antigravity). ' +
  'Read-only: consult for a second opinion on a question, design, bug or plan; review for an independent review of Git changes. ' +
  'delegate: it makes a code change, then you review it. ' +
  'Not for what you can read or run yourself. ' +
  "Answers are another model's opinion: verify facts before acting on them. " +
  'Leave backend and model unset unless the user names one or a price limit; doctor lists the models, efforts and prices each backend accepts.';

/**
 * Read-only tool guidance shared by `review` and structured `consult` prompts (`task_type` or `context_files`).
 * Claude and agy read with file tools, and agy ends its turn when its sandbox denies a command;
 * Codex has no file tool and reads only with commands in its read-only sandbox.
 */
export const READ_ONLY_FILE_TOOL_GUIDANCE =
  'Read files with your file tools; if you have none, read them with read-only shell commands (such as rg, git show or Get-Content) and run nothing that writes, builds or uses the network. With file tools, run no shell command: a sandbox may deny it and end the turn.';
