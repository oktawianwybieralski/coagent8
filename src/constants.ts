/**
 * Central branding, naming, and tool constants for CoAgent8 MCP Server.
 *
 * @remarks
 * Prevents magic strings across tool definitions, dispatchers, handlers, and configuration.
 *
 * @packageDocumentation
 */

import { version } from '../package.json';

export const BRAND = {
  NAME: 'CoAgent8',
  TAGLINE: 'Cross-Agent CLI Bridge',
  PACKAGE_NAME: 'coagent8',
  SERVER_NAME: 'coagent8',
  SERVER_VERSION: version,
  GITHUB_OWNER: 'oktawianwybieralski',
  GITHUB_REPO: 'coagent8',
} as const;

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

