/**
 * Canonical issue and bug reporting MCP tool.
 *
 * @remarks
 * Provides a privacy-sanitized bug report generator, pre-filled GitHub issue URL,
 * and optional diagnostic probe via doctor service.
 *
 * @packageDocumentation
 */

import { CANONICAL_TOOL_NAMES } from '../constants/index.js';
import { generateBugReport } from '../diagnostics/issue.js';
import { runDoctor, DoctorReport } from '../diagnostics/doctor.js';

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
  description:
    'Prepare a privacy-sanitized bug report, pre-filled GitHub issue URL, and CLI command to report issues or submit feedback.',
  outputSchema: issueOutputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      error_message: {
        type: 'string',
        description: 'Error message, stack trace, or diagnostic snippet to include.',
      },
      context: {
        type: 'string',
        description: 'Context or actions that led to the problem.',
      },
      include_doctor: {
        type: 'boolean',
        description: 'Whether to attach non-sensitive CLI doctor diagnostics (default: true).',
      },
    },
  },
};

/**
 * Handles the canonical issue tool execution.
 *
 * Sanitizes input to strip secrets, passwords, git diffs, and code blocks before
 * assembling a pre-filled GitHub issue URL and preview prompt.
 *
 * @param args - Issue parameters including optional error message, context, and doctor flag.
 * @returns MCP tool result with user prompt and structuredContent.
 */
export async function handleIssue(args: IssueToolArgs = {}) {
  let doctorReport: DoctorReport | null = null;
  if (args.include_doctor !== false) {
    try {
      doctorReport = await runDoctor();
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
