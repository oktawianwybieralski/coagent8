/**
 * Canonical issue and bug reporting MCP tool.
 *
 * @remarks
 * Provides a privacy-sanitized bug report generator, pre-filled GitHub issue URL,
 * and optional detected CLI version attachment (no readiness or quota) via doctor service.
 *
 * @packageDocumentation
 */

import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { generateBugReport } from '../../diagnostics/issue.js';
import { runDoctor, DoctorReport } from '../../diagnostics/doctor.js';

export interface IssueToolArgs {
  error_message?: string;
  context?: string;
  include_doctor?: boolean;
}

export const issueOutputSchema = {
  type: 'object',
  required: ['title', 'body', 'issueUrl'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    issueUrl: { type: 'string' },
  },
};

export const issueToolDefinition = {
  name: CANONICAL_TOOL_NAMES.ISSUE,
  description: 'Sanitized bug report with GitHub link. Be concise and actionable: reproduction steps, expected/actual behavior, impact, sanitized telemetry (tool/backend/model, CLI versions, errors, timing, scope/check evidence). Mark unknown facts; never invent them. Keep issueUrl verbatim; do not decode or re-escape it.',
  outputSchema: issueOutputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      error_message: { type: 'string' },
      context: { type: 'string', description: 'What led to it.' },
      include_doctor: { type: 'boolean', description: 'Default true: CLI versions only, no readiness/quota.' },
    },
  },
};

/**
 * Handles the canonical issue tool execution.
 *
 * Sanitizes input to strip secrets, passwords, git diffs, and code blocks before
 * assembling a pre-filled GitHub issue URL and preview prompt. When `include_doctor`
 * is enabled (the default), attaches detected CLI versions only (no readiness or quota).
 *
 * @param args - Issue parameters including optional error message, context, and doctor flag.
 * @returns MCP tool result with user prompt and structuredContent.
 */
export async function handleIssue(args: IssueToolArgs = {}) {
  let doctorReport: DoctorReport | null = null;
  if (args.include_doctor !== false) {
    try {
      doctorReport = await runDoctor({ quota: false });
    } catch (_) {
      doctorReport = null;
    }
  }

  const report = generateBugReport({
    errorMessage: args.error_message,
    context: args.context,
    doctorReport,
  });

  return {
    content: [{ type: 'text', text: report.prompt }],
    structuredContent: {
      title: report.title,
      body: report.body,
      issueUrl: report.issueUrl,
    },
  };
}

