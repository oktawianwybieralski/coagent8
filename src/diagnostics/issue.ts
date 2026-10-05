/**
 * Privacy-sanitizing issue generator and GitHub bug report builder.
 *
 * @remarks
 * ## Sanitization & Privacy Contract
 * - **Code Block Elimination**: CommonMark-compliant fence parsing strips repository code blocks
 *   (delimited by 3+ backticks or tildes) to avoid leaking proprietary code in public bug reports.
 * - **Diff Stripping**: Erases raw Git diffs (`diff --git ...`, `--- a/... +++ b/...`) from reports.
 * - **Credential & Path Masking**: Strips recognized API keys, Bearer/Basic tokens, private keys,
 *   passwords, and the local user's home directory (`~`) using `redactDiagnostic` and `redactSecrets`.
 *   Redaction strictly precedes byte truncation to ensure credential prefixes cannot be exposed.
 * - **Pre-Filled GitHub URL Construction**: Builds URL-encoded issue links targeting the canonical
 *   GitHub repository issues page (`/issues/new?title=...&body=...`), including system architecture,
 *   Node runtime, OS version, and non-sensitive CLI doctor diagnostics.
 *
 * @packageDocumentation
 */

import os from 'os';
import { redactDiagnostic } from '../redaction.js';
import { truncateToByteLength } from '../execution/stream.js';
import { BugReportOptions, BugReportResult } from '../types/issue.types.js';
import { BRAND } from '../constants/index.js';

export const REPO_OWNER = BRAND.GITHUB_OWNER;
export const REPO_NAME = BRAND.GITHUB_REPO;
export const GITHUB_NEW_ISSUE_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`;
export const MAX_RAW_INPUT_LENGTH = 4096;

/**
 * Safely slices a string at unicode character boundaries with an ellipsis indicator.
 *
 * @param str - Source string to slice.
 * @param maxLength - Maximum number of unicode code points (default: 80).
 * @returns Sliced string or empty string.
 */
export function safeSlice(str?: string | null, maxLength = 80): string {
  if (!str || typeof str !== 'string') return '';
  const chars = Array.from(str);
  if (chars.length <= maxLength) return str;
  return chars.slice(0, maxLength).join('') + '\n\n...[truncated]';
}

/**
 * Strips code blocks delimited by triple backticks or tildes according to CommonMark fence rules.
 *
 * @param text - Text containing potential code blocks.
 * @returns Text with code blocks replaced by redaction placeholders.
 */
export function redactCodeBlocks(text?: string | null): string {
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
 * Collects runtime environment parameters (Node.js, OS architecture, CLI doctor status),
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

    const firstLine = cleanError.split(/\r?\n/)[0] || 'Unknown error';
    const title = `[Bug]: ${safeSlice(firstLine, 80)}`;

    let doctorSummary = 'Not provided';
    if (doctorReport && doctorReport.backends) {
      doctorSummary = Object.entries(doctorReport.backends)
        .map(([id, backend]) => `- **${sanitizeText(backend.name || id)}**: ${backend.installed ? `v${sanitizeText(backend.version || 'unknown')}` : 'Not installed'}`)
        .join('\n');
    }

    const safeContext = safeSlice(cleanContext, 300);
    const safeDiag = safeSlice(cleanError, 800);

    const body = `### Description & Context
${safeContext}

### Error Diagnostic
\`\`\`text
${safeDiag}
\`\`\`

### Environment Details
- **${BRAND.NAME} MCP Version**: ${BRAND.SERVER_VERSION}
- **Node.js**: ${process.version}
- **OS**: ${os.type()} ${os.release()} (${os.arch()})
- **Detected CLIs**:
${doctorSummary}

---
*Note: Best-effort automated redaction was applied. Please review the details above before submitting to ensure no sensitive or proprietary data is included.*
`;

    // Safely encode URL parameters
    let issueUrl: string;
    try {
      const encodedTitle = encodeURIComponent(title);
      const encodedBody = encodeURIComponent(body);
      issueUrl = `${GITHUB_NEW_ISSUE_BASE}?title=${encodedTitle}&body=${encodedBody}`;
    } catch (_) {
      issueUrl = GITHUB_NEW_ISSUE_BASE;
    }

    return {
      title,
      body,
      issueUrl,
      prompt:
        `Would you like to report this issue to GitHub to help improve ${BRAND.NAME}?\n\n` +
        `Click the link below to review and submit the pre-filled issue in your browser (no tokens or extra login needed):\n\n` +
        `**[Submit Bug Report on GitHub](${issueUrl})**\n\n` +
        `<details><summary>Preview Sanitized Report</summary>\n\n${body}\n</details>`,
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

