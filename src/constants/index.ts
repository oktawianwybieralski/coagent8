/**
 * Central branding, naming, and tool constants for CoAgent MCP Server.
 *
 * @remarks
 * Prevents magic strings across tool definitions, dispatchers, handlers, and configuration.
 *
 * @packageDocumentation
 */

import { version } from '../../package.json';

export const BRAND = {
  NAME: 'CoAgent',
  TAGLINE: 'Cross-Agent CLI Bridge',
  PACKAGE_NAME: 'coagent8',
  SERVER_NAME: 'coagent8',
  SERVER_VERSION: version,
  GITHUB_OWNER: 'oktawianwybieralski',
  GITHUB_REPO: 'coagent8',
} as const;

export const CONFIG_CONSTANTS = {
  DIR_NAME: '.coagent8',
  FILE_NAME: 'config.json',
  ENV_DIR: 'coagent8_DIR',
  ENV_CONFIG: 'coagent8_CONFIG',
  ENV_SESSIONS_DIR: 'coagent8_SESSIONS_DIR',
} as const;

export const SESSION_CONSTANTS = {
  PREFIX: 'syn_sess_',
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

/**
 * Redundant canonical tools deprecated and aliased to consult through 1.0.x; removal planned for v1.1.0.
 */
export const DEPRECATED_LEGACY_TOOL_NAMES = [
  CANONICAL_TOOL_NAMES.ANALYZE,
  CANONICAL_TOOL_NAMES.DEBUG,
  CANONICAL_TOOL_NAMES.IMPLEMENT,
] as const;

/**
 * Enumeration of all registered tool names across CoAgent v1.0 canonical profile and compact gateway.
 */
export const TOOL_NAMES = CANONICAL_TOOL_NAMES;

export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[keyof typeof CANONICAL_TOOL_NAMES];
export type ToolName = CanonicalToolName;

