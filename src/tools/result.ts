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
import type { ResolvedWorkspace } from '../paths.js';

/**
 * MCP JSON schema of structuredContent for every execution tool response.
 * @remarks Codex shows the model only this structured content, so fields with a default
 * value are omitted: `continuationAvailable` and `truncated` appear only when true,
 * `historyAvailable` only when false, and `sessionHandle`, `turn`, `model`, `reason`,
 * `error` and `warnings` only when they have a value.
 */
export const executionOutputSchema = {
  type: 'object', required: ['provider', 'status', 'output', 'verdict'],
  properties: {
    provider: { type: ['string', 'null'], enum: ['codex', 'gemini', 'claude', null] },
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled', 'timed_out'] }, output: { type: 'string' },
    model: { type: 'string' }, sessionHandle: { type: 'string' }, turn: { type: 'integer' },
    workspace: { type: 'string' }, workspaceSource: { type: 'string', enum: ['argument', 'client_root', 'server_directory'] },
    verdict: { type: 'string', enum: ['READY', 'BLOCKED', 'NOT_APPLICABLE'] }, reason: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    continuationAvailable: { type: 'boolean' }, truncated: { type: 'boolean' }, historyAvailable: { type: 'boolean' },
    error: { type: 'object', required: ['code', 'message', 'retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } } },
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
 * Separates footer lines with an empty quoted line: consecutive `>` lines form one
 * markdown paragraph, so renderers would otherwise join them into a single line.
 */
const FOOTER_LINE_BREAK = '\n>\n';

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
  const structuredContent = { provider, status: res.status, output,
    ...(res.model ? { model: res.model } : {}),
    ...(sessionHandle ? { sessionHandle, turn: meta.turn } : {}),
    verdict, ...(reason ? { reason } : {}),
    ...(res.continuationAvailable ? { continuationAvailable: true } : {}),
    ...(res.truncated ? { truncated: true } : {}),
    ...(sessionHandle && !meta.historyAvailable ? { historyAvailable: false } : {}),
    ...(error ? { error } : {}),
    ...(warnings.length ? { warnings } : {}) };
  const parts: string[] = [];
  if (error) {
    parts.push(`> Error [${error.code}]: ${error.message}`);
    if (output) parts.push(`Partial response:\n\n${output}`);
  } else {
    parts.push(output || (res.status === 'completed' ? 'CLI completed with no public text.' : 'No public response.'));
  }

  const durationSec = (meta.durationMs / 1000).toFixed(1);
  const ops = meta.toolCount > 0 ? ` · ${meta.toolCount} ${meta.toolCount === 1 ? 'op' : 'ops'}` : '';
  const turn = meta.turn > 1 ? `turn ${meta.turn}, ` : '';
  const session = sessionHandle ? ` · ${sessionHandle} (${turn}${res.continuationAvailable ? 'ready' : 'finished'})` : '';
  const footerLines: string[] = [
    `> CoAgent8: ${provider || 'CLI'} · ${res.model || 'provider default'} · ${durationSec}s${ops}${session}`,
  ];
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
  parts.push(footerLines.join(FOOTER_LINE_BREAK));

  return { isError: res.isError, content: [{ type: 'text' as const, text: parts.join('\n\n') }], structuredContent };
}

/**
 * Reports the workspace an execution used, so a fallback is never silent.
 * @remarks Structured content always names the workspace and its source. The text adds a
 * line only for the server-directory fallback, the one case the caller may need to correct.
 */
export function withWorkspace<T extends { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }>(result: T, workspace: ResolvedWorkspace): T {
  if (!result.structuredContent) return result;
  const shown = redactDiagnostic(workspace.path, 1024);
  const structuredContent = { ...result.structuredContent, workspace: shown, workspaceSource: workspace.source };
  if (workspace.source !== 'server_directory') return { ...result, structuredContent };
  const [first, ...rest] = result.content;
  const note = `> Workspace: ${shown} (server directory)`;
  const content = first?.type === 'text' ? [{ ...first, text: `${first.text}${FOOTER_LINE_BREAK}${note}` }, ...rest] : [...result.content, { type: 'text', text: note }];
  return { ...result, content, structuredContent };
}
