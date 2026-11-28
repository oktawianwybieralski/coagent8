/**
 * Canonical issue and bug reporting MCP tool.
 *
 * @remarks
 * Builds a privacy-sanitized bug report (optional detected CLI versions via the doctor service,
 * no readiness or quota) and prefilled GitHub bug report form link, and opens it in the user's
 * browser only when `open_browser: true` is explicitly passed.
 *
 * @packageDocumentation
 */

import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { generateBugReport } from '../../diagnostics/issue.js';
import { openBrowser } from '../../diagnostics/issue-cli.js';
import { runDoctor, DoctorReport } from '../../diagnostics/doctor.js';

export interface IssueToolArgs {
  title?: string;
  error_message?: string;
  context?: string;
  include_doctor?: boolean;
  open_browser?: boolean;
}

/** Dependencies of the issue tool that tests replace. */
export interface IssueToolDeps {
  openBrowser?: (url: string) => boolean | Promise<boolean>;
}

export const issueOutputSchema = {
  type: 'object',
  required: ['title', 'body', 'issueUrl', 'prompt', 'pasteRequired', 'opened'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    issueUrl: { type: 'string' },
    prompt: { type: 'string' },
    pasteRequired: { type: 'boolean' },
    opened: { type: 'boolean' },
  },
};

export const issueToolDefinition = {
  name: CANONICAL_TOOL_NAMES.ISSUE,
  description:
    'Fills the bug report form link with a sanitized report for the user to review and submit. Be concise: reproduction steps, expected/actual behavior, impact, sanitized telemetry (tool/backend/model, CLI versions, errors, timing, scope/check evidence). Mark unknown facts; never invent them.',
  outputSchema: issueOutputSchema,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      error_message: { type: 'string' },
      context: { type: 'string', description: 'What led to it.' },
      include_doctor: { type: 'boolean', description: 'Default true: CLI versions only, no readiness/quota.' },
      open_browser: { type: 'boolean', description: 'Default false.' },
    },
  },
};

/**
 * Handles the canonical issue tool execution.
 *
 * Sanitizes input to strip secrets, passwords, git diffs, and code blocks before filling the
 * form link, returning the report first and opening it in the browser only when `open_browser`
 * is `true`. When `include_doctor` is enabled (the default), attaches detected CLI versions only
 * (no readiness or quota).
 *
 * @param args - Issue parameters: title, error message, context, doctor and browser flags.
 * @param deps - Replaceable dependencies for tests.
 * @returns MCP tool result with user prompt and structuredContent.
 */
export async function handleIssue(args: IssueToolArgs = {}, deps: IssueToolDeps = {}) {
  let doctorReport: DoctorReport | null = null;
  if (args.include_doctor !== false) {
    try {
      doctorReport = await runDoctor({ quota: false });
    } catch (_) {
      doctorReport = null;
    }
  }

  const report = generateBugReport({
    title: args.title,
    errorMessage: args.error_message,
    context: args.context,
    doctorReport,
  });

  let opened = false;
  if (args.open_browser === true) {
    try {
      opened = (await (deps.openBrowser ?? openBrowser)(report.issueUrl)) !== false;
    } catch (_) {
      opened = false;
    }
  }
  const prompt = opened
    ? `Opened the filled-in bug report form in your browser. Check it for anything private and click Submit new issue.

${report.prompt}`
    : report.prompt;

  return {
    content: [{ type: 'text', text: prompt }],
    structuredContent: {
      title: report.title,
      body: report.body,
      issueUrl: report.issueUrl,
      prompt,
      pasteRequired: report.pasteRequired,
      opened,
    },
  };
}
