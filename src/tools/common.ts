/**
 * Common execution output formatting, banner sanitization, and State Envelope validation.
 *
 * @remarks
 * ## State Envelope Architecture & Gate Evaluation
 * - **Output Sanitization**: CLI tools emit color codes, terminal cursor movement sequences, and
 *   npm update notifications. `stripAnsi` removes escape sequences, and `stripCliBanners` cleans
 *   box-drawing banners while carefully preserving Markdown tables (distinguished by ASCII `|` borders).
 * - **State Envelope Protocol**: AI-to-AI communication between Author (Antigravity) and Reviewer (Codex)
 *   uses structured envelopes:
 *
 * ```text
 * REVIEW: <turn>
 * SNAPSHOT: <sha>
 * COVERAGE: COMPLETE | PARTIAL
 * VERDICT: READY | BLOCKED
 * [P1/P2/P3] <file>:<line>
 * CHECKS: typecheck=<PASS|FAIL>; tests=<PASS|FAIL>
 * END_REVIEW
 * ```
 *
 * - **Programmatic Gate Enforcement**: In `enforceStateEnvelopeGate`, CoAgent programmatically validates
 *   the review verdict. If any P1/P2 blocker is reported, if coverage is PARTIAL, if the response was truncated,
 *   or if the envelope is incomplete, `VERDICT` is automatically overridden to `BLOCKED`.
 * - **Fatal Error Reporting**: When an unrecoverable process/protocol failure occurs (`PROCESS_ERROR`,
 *   `CLI_UNSUPPORTED`, `PROTOCOL_ERROR`), `formatExecutionResult` generates a pre-filled GitHub issue URL
 *   in the response footer.
 *
 * @packageDocumentation
 */

import type { TerminalExecutionResult } from '../types/adapter.types.js';
import { redactDiagnostic, redactSecrets } from '../redaction.js';
import { generateBugReport } from '../diagnostics/issue.js';
import { issueOutputSchema } from './issue.tool.js';

/**
 * Standard MCP JSON schema describing structuredContent for all execution tool responses.
 */
export const executionOutputSchema = {
  type: 'object', required: ['schemaVersion', 'provider', 'status', 'output', 'sessionHandle', 'continuationAvailable', 'truncated', 'activity', 'historyAvailable', 'verdict'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 }, provider: { type: ['string', 'null'], enum: ['codex', 'gemini', 'claude', null] },
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled', 'timed_out'] }, output: { type: 'string' },
    model: { type: 'string' }, sessionHandle: { type: ['string', 'null'] }, turn: { type: 'integer' },
    verdict: { type: 'string', enum: ['READY', 'BLOCKED', 'NOT_APPLICABLE'] }, reason: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    continuationAvailable: { type: 'boolean' }, truncated: { type: 'boolean' }, historyAvailable: { type: 'boolean' },
    error: { type: 'object', required: ['code', 'message', 'retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } } },
    activity: { type: 'object', required: ['toolCount', 'durationMs'], properties: { toolCount: { type: 'integer' }, durationMs: { type: 'number' } } },
  },
};

/**
 * Output schema union for the run gateway accommodating both standard execution results
 * and issue/bug-report structuredContent.
 */
export const runOutputSchema = {
  type: 'object',
  anyOf: [
    executionOutputSchema,
    issueOutputSchema,
  ],
};

/**
 * Deterministically strips ANSI escape sequences (colors, cursor movements, styles).
 *
 * @param text - Raw terminal text with ANSI codes.
 * @returns Clean text without ANSI sequences.
 */
export function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Strips CLI update banners, npm notices, and box-drawing update warnings.
 *
 * Preserves Markdown table rows (starting and ending with ASCII `|`) and State Envelope headers.
 *
 * @param text - Output text to filter.
 * @returns Filtered text with update banners removed.
 */
export function stripCliBanners(text: string): string {
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    // Preserve Markdown table rows (which start and end with ASCII '|')
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) return true;
    // Never strip lines containing finding markers or state envelope headers
    if (/\[P[123]\]/i.test(trimmed) || /^(?:REVIEW|SNAPSHOT|COVERAGE|VERDICT|CHECKS|END_REVIEW|Problem|Evidence|Fix):/i.test(trimmed)) return true;
    if (/^npm (notice|WARN update)/i.test(trimmed)) return false;
    if (/^[┌└╭╰][─═]+[┐┘╮╯]$/.test(trimmed)) return false;
    // Match only Unicode box-drawing side borders, NOT standard ASCII '|'
    if (/^[╭│╰┌└║][─\s\S]*[╮│╯┐┘║]$/.test(trimmed) && /(update|version|available|npm|new\s+release)/i.test(trimmed)) return false;
    if (/^Run `?npm (i|install) -g .*`? to update/i.test(trimmed)) return false;
    if (/^A new version of .* is available/i.test(trimmed)) return false;
    return true;
  });
  return filtered.join('\n');
}

/**
 * Strips ANSI codes, banners, and trims whitespace deterministically.
 *
 * @param text - Raw output string from subprocess.
 * @returns Normalized output.
 */
export function cleanCliOutput(text: string): string {
  if (!text) return '';
  return stripCliBanners(stripAnsi(text)).trim();
}

/**
 * Programmatically enforces the State Envelope VERDICT gate:
 * - Parses individual lines using horizontal whitespace only to ensure non-empty field values.
 * - Validates unique required headers: REVIEW, SNAPSHOT, COVERAGE (COMPLETE|PARTIAL), CHECKS, and END_REVIEW as the final non-empty line.
 * - Validates exactly one unique VERDICT line with exact values (READY|BLOCKED); rejects malformed values like READY_BOGUS or READY BLOCKED.
 * - Forces VERDICT: BLOCKED for missing, malformed, incomplete, or truncated responses, or if COVERAGE is PARTIAL, or if P1/P2 blockers exist.
 *
 * @param output - Raw review or consult output text.
 * @param truncated - True if execution was cut short by output buffer limits.
 * @param requireEnvelope - True if State Envelope format is mandatory for this tool.
 * @returns Processed output with gate-enforced VERDICT.
 */
export interface StateEnvelopeEvaluation {
  output: string;
  verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
  reason?: string;
}

export function evaluateStateEnvelopeGate(output: string, truncated: boolean, requireEnvelope = false): StateEnvelopeEvaluation {
  const rawLines = output.split(/\r?\n/);
  const nonEmptyLines = rawLines.map(l => l.trim()).filter(l => l.length > 0);

  let reviewCount = 0, reviewVal = '';
  let snapshotCount = 0, snapshotVal = '';
  let coverageCount = 0, coverageVal: 'COMPLETE' | 'PARTIAL' | undefined = undefined;
  let verdictCount = 0, verdictVal: 'READY' | 'BLOCKED' | undefined = undefined;
  let checksCount = 0, checksVal = '';
  let endReviewCount = 0;
  let hasBogusVerdict = false;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const reviewMatch = trimmed.match(/^REVIEW:[^\S\r\n]+(\S.*)$/i);
    if (reviewMatch) {
      reviewCount++;
      reviewVal = reviewMatch[1].trim();
    } else if (/^REVIEW:\s*$/i.test(trimmed)) {
      reviewCount++;
    }

    const snapshotMatch = trimmed.match(/^SNAPSHOT:[^\S\r\n]+(\S.*)$/i);
    if (snapshotMatch) {
      snapshotCount++;
      snapshotVal = snapshotMatch[1].trim();
    } else if (/^SNAPSHOT:\s*$/i.test(trimmed)) {
      snapshotCount++;
    }

    const covMatch = trimmed.match(/^COVERAGE:[^\S\r\n]+(COMPLETE|PARTIAL)$/i);
    if (covMatch) {
      coverageCount++;
      coverageVal = covMatch[1].toUpperCase() as 'COMPLETE' | 'PARTIAL';
    } else if (/^COVERAGE:/i.test(trimmed)) {
      coverageCount++;
    }

    const verdMatch = trimmed.match(/^VERDICT:[^\S\r\n]+(READY|BLOCKED)$/i);
    if (verdMatch) {
      verdictCount++;
      verdictVal = verdMatch[1].toUpperCase() as 'READY' | 'BLOCKED';
    } else if (/^VERDICT:/i.test(trimmed)) {
      verdictCount++;
      hasBogusVerdict = true;
    }

    const checksMatch = trimmed.match(/^CHECKS:[^\S\r\n]+(\S.*)$/i);
    if (checksMatch) {
      checksCount++;
      checksVal = checksMatch[1].trim();
    } else if (/^CHECKS:\s*$/i.test(trimmed)) {
      checksCount++;
    }

    if (/^END_REVIEW$/i.test(trimmed)) {
      endReviewCount++;
    }
  }

  const hasBlockers = /\[P[12]\]/i.test(output);
  const isEnveloped = reviewCount > 0 || snapshotCount > 0 || coverageCount > 0 || verdictCount > 0 || checksCount > 0 || endReviewCount > 0;
  const isEndReviewLast = nonEmptyLines.length > 0 && /^END_REVIEW$/i.test(nonEmptyLines[nonEmptyLines.length - 1]);

  if (requireEnvelope || isEnveloped || hasBlockers) {
    const isCompleteEnvelope = isEnveloped
      && reviewCount === 1 && reviewVal.length > 0
      && snapshotCount === 1 && snapshotVal.length > 0
      && coverageCount === 1 && coverageVal !== undefined
      && verdictCount === 1 && verdictVal !== undefined && !hasBogusVerdict
      && checksCount === 1 && checksVal.length > 0
      && endReviewCount === 1 && isEndReviewLast;

    const shouldBlock = !isCompleteEnvelope || truncated || hasBlockers || coverageVal === 'PARTIAL' || verdictVal !== 'READY';

    if (shouldBlock) {
      let reason = 'Review requirements not satisfied';
      if (hasBlockers) reason = 'Blocker issue [P1/P2] reported';
      else if (coverageVal === 'PARTIAL') reason = 'Review coverage is partial';
      else if (truncated) reason = 'Output was truncated';
      else if (!isCompleteEnvelope) reason = 'Incomplete State Envelope';

      if (verdictCount > 0) {
        let replaced = false;
        const out = rawLines.map(line => {
          if (/^[^\S\r\n]*VERDICT:/i.test(line)) {
            if (!replaced) {
              replaced = true;
              return 'VERDICT: BLOCKED';
            }
            return '';
          }
          return line;
        }).filter(l => l.length > 0 || l === '').join('\n');
        return { output: out, verdict: 'BLOCKED', reason };
      }
      return { output: output.trimEnd() + '\n\nVERDICT: BLOCKED', verdict: 'BLOCKED', reason };
    } else {
      const out = rawLines.map(line => {
        if (/^[^\S\r\n]*VERDICT:/i.test(line)) {
          return 'VERDICT: READY';
        }
        return line;
      }).join('\n');
      return { output: out, verdict: 'READY' };
    }
  }

  return { output, verdict: 'NOT_APPLICABLE' };
}

export function enforceStateEnvelopeGate(output: string, truncated: boolean, requireEnvelope = false): string {
  return evaluateStateEnvelopeGate(output, truncated, requireEnvelope).output;
}

/**
 * Formats a terminal execution result into the canonical MCP response envelope.
 *
 * - Sanitizes ANSI escape codes and update banners from output.
 * - Evaluates State Envelope gates when applicable.
 * - Redacts secrets and credentials before public return.
 * - Includes execution-owned cooldown warnings without writing persistent state.
 * - Appends non-whimsical metadata blockquote footer lines (turn, duration, session).
 * - Appends pre-filled GitHub issue report link on unrecoverable fatal system errors.
 *
 * @param provider - Backend provider identifier (e.g. 'codex', 'gemini', 'claude', or null).
 * @param res - TerminalExecutionResult from CLI adapter or controller.
 * @param defaultText - Fallback public text if output is empty.
 * @param sessionHandle - Active session handle or null.
 * @param meta - Execution metadata (turn, tool count, duration, history status).
 * @param options - Envelope formatting options.
 * @returns Standard MCP CallToolResult with content array and structuredContent metadata.
 */
export async function formatExecutionResult(provider: string | null, res: TerminalExecutionResult, defaultText = '', sessionHandle: string | null = null,
  meta = { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false }, options: { requireEnvelope?: boolean; warnings?: string[] } = {}) {
  const error = res.error ? { ...res.error, message: redactDiagnostic(res.error.message) } : undefined;
  const warnings = (options.warnings || []).map(warning => redactDiagnostic(warning, 512));
  const rawOutput = res.output || defaultText;
  const cleaned = cleanCliOutput(rawOutput);

  let gated: string;
  let verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
  let reason: string | undefined;

  if (options.requireEnvelope) {
    if (res.isError || error) {
      gated = cleaned;
      verdict = 'BLOCKED';
      reason = error?.message || 'Execution error';
    } else {
      const evalResult = evaluateStateEnvelopeGate(cleaned, res.truncated, true);
      gated = evalResult.output;
      verdict = evalResult.verdict;
      reason = evalResult.reason;
    }
  } else {
    gated = cleaned;
    verdict = 'NOT_APPLICABLE';
  }

  const output = redactSecrets(gated);
  const structuredContent = { schemaVersion: 1, provider, status: res.status, output, model: res.model, sessionHandle, turn: meta.turn,
    verdict, ...(reason ? { reason } : {}),
    continuationAvailable: res.continuationAvailable, truncated: res.truncated, historyAvailable: meta.historyAvailable,
    error, warnings, activity: { toolCount: meta.toolCount, durationMs: meta.durationMs } };
  const parts: string[] = [];
  if (error) {
    parts.push(`> Error [${error.code}]: ${error.message}`);
    if (output) parts.push(`Partial response:\n\n${output}`);
  } else {
    parts.push(output || (res.status === 'completed' ? 'CLI completed with no public text.' : 'No public response.'));
  }

  const durationSec = (meta.durationMs / 1000).toFixed(1);
  const opLabel = meta.toolCount === 1 ? 'op' : 'ops';
  const footerLines: string[] = [
    `> CoAgent: ${provider || 'CLI'} (${res.model || 'default'}) · ${durationSec}s · ${meta.toolCount} ${opLabel}`,
  ];
  if (sessionHandle) {
    footerLines.push(`> Session: ${sessionHandle} (turn ${meta.turn} · ${res.continuationAvailable ? 'ready' : 'finished'})`);
  }
  if (res.truncated) {
    footerLines.push('> Notice: Output reached buffer limit.');
  }
  for (const warning of warnings) {
    footerLines.push(`> Warning: ${warning}`);
  }
  if (error && (['PROCESS_ERROR', 'CLI_UNSUPPORTED', 'PROTOCOL_ERROR'] as string[]).includes(error.code)) {
    const bug = generateBugReport({
      errorMessage: `[${error.code}]: ${error.message}`,
      context: `Fatal unrecoverable error in ${provider || 'CLI'} during turn ${meta.turn}`,
    });
    footerLines.push(`> Report this issue: [Open pre-filled GitHub Issue](${bug.issueUrl})`);
  }
  parts.push(footerLines.join('\n'));

  return { isError: res.isError, content: [{ type: 'text' as const, text: parts.join('\n\n') }], structuredContent };
}
