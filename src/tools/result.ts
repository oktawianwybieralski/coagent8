/**
 * Canonical MCP result envelope for execution tools.
 *
 * @remarks
 * Raw output is normalized by `cleanCliOutput`, gated by the State Envelope verdict gate when the tool
 * requires it, and redacted before return. When an unrecoverable process/protocol failure occurs
 * (`PROCESS_ERROR`, `CLI_UNSUPPORTED`, `PROTOCOL_ERROR`), `formatExecutionResult` generates a
 * pre-filled GitHub issue URL in the response footer.
 *
 * @packageDocumentation
 */

import type { TerminalExecutionResult } from '../backends/types.js';
import { redactDiagnostic, redactCredentialFormats } from '../redaction.js';
import { generateBugReport } from '../diagnostics/issue.js';
import { issueOutputSchema } from './issue.tool.js';
import { cleanCliOutput } from '../execution/cli-output.js';
import { evaluateStateEnvelopeGate } from './review-gate.js';

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

  const output = redactCredentialFormats(gated);
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
    `> CoAgent8: ${provider || 'CLI'} (${res.model || 'default'}) · ${durationSec}s · ${meta.toolCount} ${opLabel}`,
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
