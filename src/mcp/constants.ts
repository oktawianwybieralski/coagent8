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
  // Deprecated legacy aliases maintained through 1.0.x; removal planned for v1.1.0
  ANALYZE: 'analyze',
  DEBUG: 'debug',
  IMPLEMENT: 'implement',
  RUN: 'run',
} as const;

/**
 * Six canonical tools defined by the SURFACE-001 public contract.
 */
export const CORE_CANONICAL_TOOL_NAMES = [
  CANONICAL_TOOL_NAMES.CONSULT,
  CANONICAL_TOOL_NAMES.REVIEW,
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
export const SERVER_INSTRUCTIONS = 'Asks another local coding agent (Codex, Claude Code or Antigravity) in a read-only sandbox. '
  + 'Use consult for a second opinion on a question, design, bug or plan, and review for an independent review of Git changes. '
  + 'Not for reading files, running commands or what the workspace already answers. '
  + 'The answer is another model\'s opinion: verify facts before acting on them. '
  + 'Leave backend and model unset unless the user names one or a price limit; doctor lists the models, efforts and prices each backend accepts.';

