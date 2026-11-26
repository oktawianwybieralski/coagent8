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
 * - **Prefilled Form**: Links to the repository's bug report form (`/issues/new?template=bug_report.yml`)
 *   with the title, "What happened" and "Environment" (architecture, Node runtime, OS version and
 *   detected CLI versions only, no readiness or quota) filled in through the query string, so the
 *   user only reviews and submits. A copy block to paste remains only when the report cannot fit.
 *
 * @packageDocumentation
 */

import os from 'os';
import { redactDiagnostic } from '../security/redaction.js';
import { truncateToByteLength } from '../execution/runtime/stream.js';
import { BRAND } from '../brand.js';

export interface BugReportOptions {
  /** A short title that states the problem; the first line of the error when absent. */
  title?: string;
  errorMessage?: string;
  context?: string;
  doctorReport?: { backends?: Record<string, { name?: string; installed: boolean; version?: string }> } | null;
}

export interface BugReportResult {
  title: string;
  body: string;
  /** The bug report form with the title and the fields filled in. */
  issueUrl: string;
  prompt: string;
  /** True only when the report did not fit in the link and must be pasted. */
  pasteRequired: boolean;
}

const REPO_OWNER = BRAND.GITHUB_OWNER;
const REPO_NAME = BRAND.GITHUB_REPO;
export const GITHUB_NEW_ISSUE_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`;
export const GITHUB_BUG_REPORT_TEMPLATE_URL = `${GITHUB_NEW_ISSUE_BASE}?template=bug_report.yml`;
/**
 * Ceiling for the prefilled form link. GitHub answers much longer issue links with an error page
 * (about 8 KB); browsers and the operating system's URL handlers accept more.
 */
export const MAX_ENCODED_ISSUE_URL_LENGTH = 7000;
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

/** The form's field ids in `.github/ISSUE_TEMPLATE/bug_report.yml`, which GitHub fills from the query string. */
export const BUG_REPORT_FIELDS = { whatHappened: 'what-happened', environment: 'environment' } as const;

const SHORTENED_MARKER = '\n\n[shortened to fit the form link]';

/**
 * Builds the bug report form link with the title and the fields filled in, within `maxLength`.
 * When the link would be too long, the "What happened" text is shortened and marked; the title
 * and the environment are short and stay whole.
 *
 * @param title - Issue title.
 * @param whatHappened - Text for the required "What happened" field.
 * @param environment - Text for the "Environment" field.
 * @param maxLength - Maximum length of the encoded link.
 * @returns The prefilled form link, or the empty form link when not even the title and the environment fit.
 */
export function buildPrefilledIssueUrl(
  title: string,
  whatHappened: string,
  environment: string,
  maxLength = MAX_ENCODED_ISSUE_URL_LENGTH,
): string {
  const build = (text: string) => {
    const query = new URLSearchParams({
      template: 'bug_report.yml',
      title,
      [BUG_REPORT_FIELDS.whatHappened]: text,
      [BUG_REPORT_FIELDS.environment]: environment,
    });
    // URLSearchParams writes a space as '+'; %20 reads the same everywhere.
    return `${GITHUB_NEW_ISSUE_BASE}?${query.toString().replace(/\+/g, '%20')}`;
  };
  const full = build(whatHappened);
  if (full.length <= maxLength) return full;
  const chars = Array.from(whatHappened);
  // The longest prefix that fits; the encoded length grows with the prefix.
  let low = -1;
  let high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2);
    if (build(chars.slice(0, mid).join('') + SHORTENED_MARKER).length <= maxLength) low = mid;
    else high = mid - 1;
  }
  return low < 0 ? GITHUB_BUG_REPORT_TEMPLATE_URL : build(chars.slice(0, low).join('').trimEnd() + SHORTENED_MARKER);
}

/**
 * Returns a code fence longer than any backtick run in the text, so the text cannot close it.
 *
 * @param text - Text the fence encloses.
 * @returns The fence.
 */
function fenceFor(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(4, longest + 1));
}

/**
 * Builds a sanitized bug report, the link to the bug report form with the report filled in, and
 * the prompt that shows the link.
 *
 * Collects runtime environment parameters (Node.js, OS architecture, detected CLI versions),
 * strips sensitive code blocks and credentials, and fills the title, "What happened" and
 * "Environment" fields of the form through the link, so the user only reviews and submits it.
 *
 * @param options - Title, error message, context, and optional DoctorReport diagnostics.
 * @returns Object containing title, body, the prefilled form URL, and markdown prompt.
 */
export function generateBugReport(options: BugReportOptions): BugReportResult {
  const { title: requestedTitle, errorMessage, context, doctorReport = null } = options;
  try {
    const cleanError = sanitizeText(errorMessage);
    const cleanContext = sanitizeText(context);
    const singleLine = (text: string) => text.replace(/[\s\u2028\u2029]+/g, ' ').trim();

    const headline = (singleLine(sanitizeText(requestedTitle)) || singleLine(cleanError.split(/[\r\n\u2028\u2029]/)[0] ?? '')).replace(
      /^\[Bug\]:\s*/i,
      '',
    );
    const title = `[Bug]: ${safeSlice(headline, 110)}`;

    const backendEntries = Object.entries(doctorReport?.backends ?? {});
    const detectedClis =
      backendEntries.length > 0
        ? `- **Detected CLIs**:\n${backendEntries
            .map(([id, backend]) => {
              const label = singleLine(sanitizeText(backend.name || id)) || singleLine(sanitizeText(id)) || 'unknown';
              const value = backend.installed ? singleLine(sanitizeText(backend.version || 'unknown')) || 'unknown' : 'Not installed';
              return `  - **${label}**: ${value}`;
            })
            .join('\n')}`
        : '- **Detected CLIs**: Not provided';

    // The error goes first, so a report shortened to fit the link keeps it.
    const errorFence = fenceFor(cleanError).slice(1);
    const sections: string[] = [];
    if (cleanError) sections.push(`Error:\n\n${errorFence}text\n${cleanError}\n${errorFence}`);
    if (cleanContext) sections.push(cleanContext);
    if (sections.length === 0) sections.push('Describe what you did, what you expected and what happened instead.');
    const whatHappened = `${sections.join('\n\n')}\n\n_Prepared by the ${BRAND.NAME} issue tool with best-effort redaction. Check it for private data before submitting._`;

    const environment = `- **${BRAND.NAME} MCP Version**: ${BRAND.SERVER_VERSION}
- **Node.js**: ${process.version}
- **OS**: ${os.type()} ${os.release()} (${os.arch()})
${detectedClis}

For setup, sign-in or quota problems, add the output of doctor (scope: health).`;

    const body = `### What happened\n\n${whatHappened}\n\n### Environment\n\n${environment}\n`;
    const issueUrl = buildPrefilledIssueUrl(title, whatHappened, environment);
    const empty = issueUrl === GITHUB_BUG_REPORT_TEMPLATE_URL;
    const shortened = !empty && new URL(issueUrl).searchParams.get(BUG_REPORT_FIELDS.whatHappened) !== whatHappened;
    const pasteRequired = empty || shortened;
    const fence = fenceFor(body);
    const pasteNote = empty
      ? 'The report does not fit in the link. Paste it into the form:'
      : 'The report was shortened to fit the link. Replace the form text with the full report:';

    return {
      title,
      body,
      issueUrl,
      pasteRequired,
      prompt:
        `The bug report form is filled in. Open it, check it for anything private and click Submit new issue (GitHub sign-in required):\n\n` +
        `**[Submit Bug Report on GitHub](<${issueUrl}>)**` +
        (pasteRequired ? `\n\n${pasteNote}\n\n${fence}text\n${body}\n${fence}` : ''),
    };
  } catch (_err) {
    return {
      title: '[Bug]: ',
      body: 'Unable to construct sanitized diagnostic.',
      issueUrl: GITHUB_BUG_REPORT_TEMPLATE_URL,
      pasteRequired: true,
      prompt:
        `An unexpected error occurred. You can submit a bug report here:\n\n` +
        `**[Submit Bug Report on GitHub](<${GITHUB_BUG_REPORT_TEMPLATE_URL}>)**`,
    };
  }
}
