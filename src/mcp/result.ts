/**
 * Canonical MCP result envelope for execution tools.
 *
 * @remarks
 * The answer loses escape sequences (`stripAnsi`), is redacted and is shown verbatim, followed by
 * the footer lines (`CoAgent8:`, `Verdict:`, ...). Codex gets both as raw text; other clients get
 * each in its own plaintext block. When the tool requires a State Envelope, the server verdict
 * with its causes goes to the footer. When an unrecoverable process/protocol failure occurs
 * (`PROCESS_ERROR`, `CLI_UNSUPPORTED`, `PROTOCOL_ERROR`), `formatExecutionResult` generates a
 * pre-filled GitHub issue URL in the response footer.
 *
 * @packageDocumentation
 */

import type { TaskExecutionResult, ExecutionMeta, TerminalExecutionResult } from '../contracts/execution.js';
import { redactDiagnostic, redactCredentialFormats } from '../security/redaction.js';
import { generateBugReport } from '../diagnostics/issue.js';
import { stripAnsi } from '../execution/cli-output.js';
import { evaluateStateEnvelopeGate, type ReviewGateContext, type StateEnvelopeEvaluation } from '../review/index.js';
import type { ResolvedWorkspace } from '../workspace/workspace.js';
import { providerForClient } from '../execution/routing.js';

/**
 * Execution tool result: markdown text only.
 * @remarks No `structuredContent` and no `outputSchema` (CONTEXT-001, owner decision of
 * 2026-10-07): Claude Code shows the model only `structuredContent` when a result has one,
 * agy reads `content`, and Codex reads `content` when no structured content is present.
 * The footer carries backend/model, duration, continuation handle/state and warnings;
 * it does not expose every internal execution field.
 */
export interface ExecutionToolResult {
  [key: string]: unknown;
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * How the connected client shows a tool result: `raw` lines for Codex, which frames a tool
 * result as plain text itself, `framed` plaintext blocks for clients that render markdown,
 * where unframed text blends into the panel and joins lines.
 */
export type ResultStyle = 'framed' | 'raw';
/** Style of the connected client; a stdio server process serves exactly one client. */
let resultStyle: ResultStyle = 'framed';

/**
 * Chooses the result style from the MCP `clientInfo.name`.
 * @remarks Presentation only, never a security decision: the name is self-reported
 * (owner decision 2026-10-09). An unknown client gets frames.
 */
export function setResultStyle(clientName: string | undefined): void {
  resultStyle = providerForClient(clientName) === 'codex' ? 'raw' : 'framed';
}

/** Fences text with more backticks than any run inside it, so its own fences cannot close the block. */
function frame(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}plaintext\n${text}\n${fence}`;
}

/** Shows a block of the result in the connected client's style. */
function present(text: string): string {
  return resultStyle === 'framed' ? frame(text) : text;
}

/** One footer line: line breaks inside a field would split it into other footer lines. */
function footerLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ');
}

export interface FormatExecutionOptions {
  requireEnvelope?: boolean;
  warnings?: string[];
  reviewContext?: ReviewGateContext;
  price?: string;
}

/**
 * Formats a terminal execution result into the canonical MCP response envelope.
 *
 * - Strips ANSI escape codes and outer whitespace; preserves quoted update banners.
 * - Evaluates State Envelope gates when applicable.
 * - Redacts secrets and credentials before public return.
 * - Includes execution-owned cooldown warnings without writing persistent state.
 * - Appends blockquote footer lines: backend, model, duration, operations, session handle
 *   with its state, the review verdict, the price evidence of a price limit, notices and warnings.
 * - Appends pre-filled GitHub issue report link on unrecoverable fatal system errors.
 */
export function formatExecutionResult(
  outcome: TaskExecutionResult,
  defaultText?: string
): ExecutionToolResult;
export function formatExecutionResult(
  provider: string | null,
  res: TerminalExecutionResult,
  defaultText?: string,
  sessionHandle?: string | null,
  meta?: ExecutionMeta,
  options?: FormatExecutionOptions
): ExecutionToolResult;
export function formatExecutionResult(
  outcomeOrProvider: TaskExecutionResult | string | null,
  resOrDefaultText?: TerminalExecutionResult | string,
  defaultText = '',
  sessionHandle: string | null = null,
  meta: ExecutionMeta = { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false },
  options: FormatExecutionOptions = {}
): ExecutionToolResult {
  let provider: string | null;
  let res: TerminalExecutionResult;
  let activeHandle: string | null;
  let executionMeta: ExecutionMeta;
  let rawWarnings: string[];
  let priceNote: string | undefined;
  let preEvaluatedReview: StateEnvelopeEvaluation | undefined;
  let fallbackText = '';
  let formatOpts = options;

  if (outcomeOrProvider && typeof outcomeOrProvider === 'object' && 'result' in outcomeOrProvider) {
    const outcome = outcomeOrProvider as TaskExecutionResult;
    provider = outcome.provider;
    res = outcome.result;
    activeHandle = outcome.sessionHandle;
    executionMeta = outcome.meta;
    rawWarnings = outcome.warnings || [];
    priceNote = outcome.price;
    preEvaluatedReview = outcome.review;
    fallbackText = typeof resOrDefaultText === 'string' ? resOrDefaultText : '';
  } else {
    provider = outcomeOrProvider as string | null;
    res = resOrDefaultText as TerminalExecutionResult;
    activeHandle = sessionHandle;
    executionMeta = meta;
    rawWarnings = formatOpts.warnings || [];
    priceNote = formatOpts.price;
    fallbackText = defaultText;
  }

  const error = res.error ? { ...res.error, message: redactDiagnostic(res.error.message) } : undefined;
  const warnings = rawWarnings.map(warning => redactDiagnostic(warning, 512));
  const rawOutput = res.output || fallbackText;
  const cleaned = stripAnsi(rawOutput).trim();

  let verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
  let reason: string | undefined;

  if (preEvaluatedReview) {
    verdict = preEvaluatedReview.verdict;
    reason = preEvaluatedReview.reason;
  } else if (formatOpts.requireEnvelope) {
    if (res.isError || error) {
      verdict = 'BLOCKED';
      reason = error?.message || 'Execution error';
    } else {
      ({ verdict, reason } = evaluateStateEnvelopeGate(cleaned, res.truncated, true, formatOpts.reviewContext));
    }
  } else {
    verdict = 'NOT_APPLICABLE';
  }

  const output = redactCredentialFormats(cleaned);
  const parts: string[] = [];
  if (error) {
    parts.push(`Error [${error.code}${error.retryable ? ', retryable' : ''}]: ${error.message}`);
    if (output) parts.push('Partial response:', present(output));
  } else {
    parts.push(output ? present(output) : res.status === 'completed' ? 'CLI completed with no public text.' : 'No public response.');
  }

  const durationMs = Math.max(0, typeof executionMeta.totalMs === 'number' && Number.isFinite(executionMeta.totalMs)
    ? executionMeta.totalMs
    : (executionMeta.durationMs || 0));
  const durationSec = (durationMs / 1000).toFixed(1);
  const ops = executionMeta.toolCount > 0 ? ` \u{b7} ${executionMeta.toolCount} ${executionMeta.toolCount === 1 ? 'op' : 'ops'}` : '';
  const turn = executionMeta.turn > 1 ? `turn ${executionMeta.turn}, ` : '';
  const history = executionMeta.historyAvailable ? '' : ', no history';
  // Labelled with its parameter name, so a caller passes it back as `session_handle` (AX-007b).
  const session = activeHandle ? ` \u{b7} session_handle=${activeHandle} (${turn}${res.continuationAvailable ? 'ready' : 'finished'}${history})` : '';

  const footerLines: string[] = [
    `CoAgent8: ${provider || 'CLI'} \u{b7} ${res.model || 'provider default'} \u{b7} ${durationSec}s${ops}${session}`,
  ];
  if (verdict !== 'NOT_APPLICABLE') {
    // A failed run states its reason in the error line already.
    // The reason may quote the reviewer's own Blocked line.
    footerLines.push(`Verdict: ${verdict}${reason && !error ? ` (${redactCredentialFormats(reason)})` : ''}`);
  }
  if (priceNote) footerLines.push(`Price: ${priceNote}`);
  if (res.truncated) {
    footerLines.push('Notice: Output reached buffer limit.');
  }
  for (const warning of warnings) {
    footerLines.push(`Warning: ${warning}`);
  }
  if (error && (['PROCESS_ERROR', 'CLI_UNSUPPORTED', 'PROTOCOL_ERROR'] as string[]).includes(error.code)) {
    const bug = generateBugReport({
      errorMessage: `[${error.code}]: ${error.message}`,
      context: `Fatal unrecoverable error in ${provider || 'CLI'} during turn ${executionMeta.turn}`,
    });
    footerLines.push(`Report this issue: ${bug.issueUrl}`);
  }
  parts.push(present(footerLines.map(footerLine).join('\n')));

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
  const note = footerLine(`Workspace: ${redactDiagnostic(workspace.path, 1024)} (server directory)`);
  const content = first?.type === 'text' ? [{ ...first, text: withFooterLine(first.text ?? '', note) }, ...rest] : [...result.content, { type: 'text', text: present(note) }];
  return { ...result, content };
}

/** Adds a line to the footer, the last block of an execution result. */
function withFooterLine(text: string, line: string): string {
  if (resultStyle === 'raw') return `${text}\n${line}`;
  // The footer's fence is the longest run in it, so its opening is the last one of that length.
  const fence = /`{3,}$/.exec(text)?.[0];
  const opening = fence === undefined ? -1 : text.lastIndexOf(`${fence}plaintext\n`);
  if (fence === undefined || opening < 0) return `${text}\n\n${frame(line)}`;
  const footer = text.slice(opening + fence.length + 'plaintext\n'.length, text.length - fence.length - 1);
  return text.slice(0, opening) + frame(`${footer}\n${line}`);
}

