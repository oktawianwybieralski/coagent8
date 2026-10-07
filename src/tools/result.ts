/**
 * Canonical MCP result envelope for execution tools.
 *
 * @remarks
 * The answer loses escape sequences (`stripAnsi`), is gated by the State Envelope verdict gate when the tool
 * requires it, and redacted before return. When an unrecoverable process/protocol failure occurs
 * (`PROCESS_ERROR`, `CLI_UNSUPPORTED`, `PROTOCOL_ERROR`), `formatExecutionResult` generates a
 * pre-filled GitHub issue URL in the response footer.
 *
 * @packageDocumentation
 */

import type { TerminalExecutionResult } from '../backends/types.js';
import { redactDiagnostic, redactCredentialFormats } from '../redaction.js';
import { generateBugReport } from '../diagnostics/issue.js';
import { stripAnsi } from '../execution/cli-output.js';
import { evaluateStateEnvelopeGate } from './review-gate.js';
import type { ResolvedWorkspace } from '../paths.js';

/**
 * Execution tool result: markdown text only.
 * @remarks No `structuredContent` and no `outputSchema` (CONTEXT-001, owner decision of
 * 2026-10-07): Claude Code shows the model only `structuredContent` when a result has one,
 * agy reads `content`, and Codex reads `content` when no structured content is present.
 * The footer therefore carries every field a caller acts on.
 */
export interface ExecutionToolResult {
  [key: string]: unknown;
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

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
 * - Appends blockquote footer lines: backend, model, duration, operations, session handle
 *   with its state, the review verdict, notices and warnings.
 * - Appends pre-filled GitHub issue report link on unrecoverable fatal system errors.
 *
 * @param provider - Backend provider identifier (e.g. 'codex', 'gemini', 'claude', or null).
 * @param res - TerminalExecutionResult from CLI adapter or controller.
 * @param defaultText - Fallback public text if output is empty.
 * @param sessionHandle - Active session handle or null.
 * @param meta - Execution metadata (turn, tool count, duration, history status).
 * @param options - Envelope formatting options.
 * @returns MCP CallToolResult with the markdown answer and footer as its only content.
 */
export async function formatExecutionResult(provider: string | null, res: TerminalExecutionResult, defaultText = '', sessionHandle: string | null = null,
  meta = { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false }, options: { requireEnvelope?: boolean; warnings?: string[] } = {}) {
  const error = res.error ? { ...res.error, message: redactDiagnostic(res.error.message) } : undefined;
  const warnings = (options.warnings || []).map(warning => redactDiagnostic(warning, 512));
  const rawOutput = res.output || defaultText;
  const cleaned = stripAnsi(rawOutput).trim();

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
  const parts: string[] = [];
  if (error) {
    parts.push(`> Error [${error.code}${error.retryable ? ', retryable' : ''}]: ${error.message}`);
    if (output) parts.push(`Partial response:\n\n${output}`);
  } else {
    parts.push(output || (res.status === 'completed' ? 'CLI completed with no public text.' : 'No public response.'));
  }

  const durationSec = (meta.durationMs / 1000).toFixed(1);
  const ops = meta.toolCount > 0 ? ` · ${meta.toolCount} ${meta.toolCount === 1 ? 'op' : 'ops'}` : '';
  const turn = meta.turn > 1 ? `turn ${meta.turn}, ` : '';
  const history = meta.historyAvailable ? '' : ', no history';
  const session = sessionHandle ? ` · ${sessionHandle} (${turn}${res.continuationAvailable ? 'ready' : 'finished'}${history})` : '';
  const footerLines: string[] = [
    `> CoAgent8: ${provider || 'CLI'} · ${res.model || 'provider default'} · ${durationSec}s${ops}${session}`,
  ];
  if (verdict !== 'NOT_APPLICABLE') {
    // A failed run states its reason in the error line already.
    footerLines.push(`> Verdict: ${verdict}${reason && !error ? ` (${reason})` : ''}`);
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
  parts.push(footerLines.join(FOOTER_LINE_BREAK));

  return { isError: res.isError, content: [{ type: 'text', text: parts.join('\n\n') }] } satisfies ExecutionToolResult;
}

/**
 * Reports the workspace an execution used when it is the server-directory fallback, the one
 * case the caller may need to correct, so a fallback is never silent. An explicit argument
 * or a client root is the workspace the caller already chose.
 */
export function withWorkspace<T extends { content: Array<{ type: string; text?: string }> }>(result: T, workspace: ResolvedWorkspace): T {
  if (workspace.source !== 'server_directory') return result;
  const [first, ...rest] = result.content;
  const note = `> Workspace: ${redactDiagnostic(workspace.path, 1024)} (server directory)`;
  const content = first?.type === 'text' ? [{ ...first, text: `${first.text}${FOOTER_LINE_BREAK}${note}` }, ...rest] : [...result.content, { type: 'text', text: note }];
  return { ...result, content };
}
