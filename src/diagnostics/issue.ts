/**
 * Privacy-sanitizing issue generator and GitHub bug report builder.
 *
 * @remarks
 * ## Sanitization & Privacy Contract
 * - **Code Block Elimination**: CommonMark-compliant fence parsing strips repository code blocks
 *   (delimited by 3+ backticks or tildes) to avoid leaking proprietary code in public bug reports.
 * - **Diff Stripping**: Erases raw Git diffs (`diff --git ...`, `--- a/... +++ b/...`) from reports.
 * - **Credential & Path Masking**: Strips recognized API keys, Bearer/Basic tokens, private keys,
 *   passwords, and the local user's home directory (`~`) using `redactDiagnostic`.
 *   Redaction strictly precedes byte truncation to ensure credential prefixes cannot be exposed.
 * - **Pre-Filled GitHub URL Construction**: Builds URL-encoded issue links targeting the canonical
 *   GitHub repository issues page (`/issues/new?title=...&body=...`), including system architecture,
 *   Node runtime, OS version, and detected CLI versions only (no readiness or quota).
 *
 * @packageDocumentation
 */

import os from 'os';
import { redactDiagnostic } from '../security/redaction.js';
import { truncateToByteLength } from '../execution/runtime/stream.js';
import { BRAND } from '../brand.js';

export interface BugReportOptions {
  errorMessage?: string;
  context?: string;
  doctorReport?: { backends?: Record<string, { name?: string; installed: boolean; version?: string }> } | null;
}

export interface BugReportResult {
  title: string;
  body: string;
  issueUrl: string;
  prompt: string;
}

const REPO_OWNER = BRAND.GITHUB_OWNER;
const REPO_NAME = BRAND.GITHUB_REPO;
export const GITHUB_NEW_ISSUE_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`;
export const GITHUB_BUG_REPORT_TEMPLATE_URL = `${GITHUB_NEW_ISSUE_BASE}?template=bug_report.yml`;
export const MAX_ENCODED_ISSUE_URL_LENGTH = 2048;
const MAX_RAW_INPUT_LENGTH = 4096;

/**
 * Safely slices a string at unicode character boundaries with an ellipsis indicator.
 *
 * @param str - Source string to slice.
 * @param maxLength - Maximum number of unicode code points before the marker.
 * @returns Sliced string or empty string.
 */
function safeSlice(str: string, maxLength: number): string {
  if (!str || typeof str !== 'string') return '';
  const chars = Array.from(str);
  if (chars.length <= maxLength) return str;
  return chars.slice(0, maxLength).join('') + '...';
}

/**
 * Strips code blocks delimited by triple backticks or tildes according to CommonMark fence rules.
 *
 * @param text - Text containing potential code blocks.
 * @returns Text with code blocks replaced by redaction placeholders.
 */
function redactCodeBlocks(text?: string | null): string {
  if (!text || typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let inBlock = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock) {
      const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})/);
      if (match) {
        inBlock = true;
        fenceChar = match[1][0];
        fenceLen = match[1].length;
        result.push('[code block redacted for privacy]');
        continue;
      }
      result.push(line);
    } else {
      const closeMatch = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ ]*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        inBlock = false;
        fenceChar = '';
        fenceLen = 0;
        continue;
      }
    }
  }
  return result.join('\n');
}

/**
 * Strips secrets, API keys, Bearer/Basic tokens, private keys, and user home directory paths.
 * Redaction precedes truncation so a cut cannot reveal a credential prefix.
 *
 * @param text - Raw diagnostic or error text to sanitize.
 * @returns Sanitized string bounded within MAX_RAW_INPUT_LENGTH bytes.
 */
export function sanitizeText(text?: string | null): string {
  if (!text || typeof text !== 'string') return '';

  // 1. Strip raw repository code blocks with CommonMark compliant fence parser
  let sanitized = redactCodeBlocks(redactDiagnostic(text, MAX_RAW_INPUT_LENGTH));
  sanitized = sanitized.replace(/diff --git [\s\S]*/g, '[git diff redacted for privacy]\n');
  sanitized = sanitized.replace(/--- a\/[\s\S]*?\+\+\+ b\/[\s\S]*/g, '[git diff redacted for privacy]\n');

  return truncateToByteLength(sanitized, MAX_RAW_INPUT_LENGTH);
}

/**
 * Builds a sanitized, pre-filled GitHub bug report URL and markdown preview.
 *
 * Collects runtime environment parameters (Node.js, OS architecture, detected CLI versions),
 * strips sensitive code blocks and credentials, and encodes parameters into a GitHub new issue URL.
 *
 * @param options - Error message, context, and optional DoctorReport diagnostics.
 * @returns Object containing title, body, pre-filled issue URL, and markdown prompt.
 */
export function generateBugReport(options: BugReportOptions): BugReportResult {
  const { errorMessage, context, doctorReport = null } = options;
  try {
    const cleanError = sanitizeText(errorMessage || 'Unknown error occurred');
    const cleanContext = sanitizeText(context || 'Execution during MCP tool call');

    const firstLine = cleanError.split(/[\r\n\u2028\u2029]/)[0].replace(/\s+/g, ' ').trim() || 'Unknown error';
    const title = `[Bug]: ${safeSlice(firstLine, 110)}`;

    const singleLine = (text: string) => text.replace(/\s+/g, ' ').trim();
    const backendEntries = Object.entries(doctorReport?.backends ?? {});
    const detectedClis = backendEntries.length > 0
      ? `- **Detected CLIs**:\n${backendEntries
          .map(([id, backend]) => {
            const label = singleLine(sanitizeText(backend.name || id)) || singleLine(sanitizeText(id)) || 'unknown';
            const value = backend.installed
              ? (singleLine(sanitizeText(backend.version || 'unknown')) || 'unknown')
              : 'Not installed';
            return `  - **${label}**: ${value}`;
          })
          .join('\n')}`
      : '- **Detected CLIs**: Not provided';

    const body = `### Description & Context
${cleanContext}

### Error Diagnostic
\`\`\`text
${cleanError}
\`\`\`

### Environment Details
- **${BRAND.NAME} MCP Version**: ${BRAND.SERVER_VERSION}
- **Node.js**: ${process.version}
- **OS**: ${os.type()} ${os.release()} (${os.arch()})
${detectedClis}

For setup, sign-in or quota problems, paste the output of doctor (scope: health).

---
*Note: Best-effort automated redaction was applied. Please review the details above before submitting to ensure no sensitive or proprietary data is included.*
`;

    // Build template URL pointing to the canonical bug_report.yml template
    let issueUrl = GITHUB_BUG_REPORT_TEMPLATE_URL;
    if (Buffer.byteLength(issueUrl) > MAX_ENCODED_ISSUE_URL_LENGTH) {
      issueUrl = GITHUB_NEW_ISSUE_BASE;
    }

    // Calculate outer CommonMark code fence to prevent internal ``` from closing the copy block prematurely
    const backtickMatches = body.match(/`+/g) || [];
    const maxBackticks = backtickMatches.reduce((max, m) => Math.max(max, m.length), 0);
    const outerFence = '`'.repeat(Math.max(4, maxBackticks + 1));

    return {
      title,
      body,
      issueUrl,
      prompt:
        `Would you like to report this issue to GitHub to help improve ${BRAND.NAME}?\n\n` +
        `Click the link below to open the bug report template in your browser (GitHub sign-in required to submit):\n\n` +
        `**[Submit Bug Report on GitHub](<${issueUrl}>)**\n\n` +
        `Link URL:\n\n\`\`\`text\n${issueUrl}\n\`\`\`\n\n` +
        `Review the sanitized report below, copy it, paste it into the "CoAgent8 issue output" field of the bug report form, complete the required fields and submit:\n\n` +
        `${outerFence}text\n${body}\n${outerFence}\n\n` +
        `Preview Sanitized Report\n\n${body}`,
    };
  } catch (_err) {
    return {
      title: '[Bug]: Unhandled Error',
      body: 'Unable to construct sanitized diagnostic.',
      issueUrl: GITHUB_NEW_ISSUE_BASE,
      prompt:
        `An unexpected error occurred. You can submit feedback or a bug report here:\n\n` +
        `**[Submit Bug Report on GitHub](${GITHUB_NEW_ISSUE_BASE})**`,
    };
  }
}

