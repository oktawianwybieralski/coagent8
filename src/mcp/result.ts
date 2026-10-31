/**
 * Canonical MCP result envelope for execution tools.
 *
 * @remarks
 * The answer loses escape sequences (`stripAnsi`), is redacted and is shown verbatim, followed by
 * the footer lines (`CoAgent8:`, `Verdict:`, ...). Codex gets both as raw text; other clients get
 * each in its own plaintext block. When the tool requires a State Envelope, the server verdict
 * with its causes goes to the footer. When an unrecoverable process/protocol failure occurs
 * (`PROCESS_ERROR`, `CLI_UNSUPPORTED`, `PROTOCOL_ERROR`), `formatExecutionResult` generates a
 * link to the bug report form in the response footer and names the issue tool for the report.
 *
 * @packageDocumentation
 */

import type { TaskExecutionResult, ExecutionMeta, TerminalExecutionResult, ListPrice, WorkspaceChanges } from '../contracts/execution.js';
import type { TokenUsage } from '../contracts/conversation.js';
import { redactDiagnostic, redactCredentialFormats } from '../security/redaction.js';
import { GITHUB_BUG_REPORT_TEMPLATE_URL } from '../diagnostics/issue.js';
import { stripAnsi } from '../execution/cli-output.js';
import {
  evaluateStateEnvelopeGate,
  alignEnvelopeReviewTurn,
  appendEnvelopeTerminator,
  type ReviewGateContext,
  type StateEnvelopeEvaluation,
} from '../review/index.js';
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

/**
 * The block of changes the server observed around a `workspace-write` turn (`DELEGATE-001w`),
 * kept apart from the worker's own report. Paths come from the workspace and are redacted
 * like every diagnostic.
 */
export function formatObservedChanges(changes: WorkspaceChanges): string {
  const p = (file: string) => redactDiagnostic(file, 512);
  const lines = ['Observed by CoAgent8 (Git, before and after the turn):'];
  if (changes.unavailable) {
    lines.push(`Changes could not be read: ${redactDiagnostic(changes.unavailable, 256)}. Check git status yourself.`);
    return lines.join('\n');
  }
  if (!changes.changed.length) lines.push('No file changed.');
  for (const change of changes.changed)
    lines.push(`${change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'} ${p(change.path)}`);
  if (changes.truncated) lines.push('More paths changed than are listed.');
  if (changes.outsideScope.length) lines.push(`Warning: changed outside scope: ${changes.outsideScope.map(p).join(', ')}`);
  if (changes.dirtyBefore.length)
    lines.push(`Warning: already had uncommitted changes before the turn: ${changes.dirtyBefore.map(p).join(', ')}`);
  const moved = changes.headMoved;
  if (moved) {
    const name = (branch: string | null) => (branch === null ? '(detached)' : redactDiagnostic(branch, 256));
    const branch = moved.branchBefore !== moved.branchAfter ? `; branch ${name(moved.branchBefore)} -> ${name(moved.branchAfter)}` : '';
    lines.push(
      `Warning: HEAD moved ${moved.before?.slice(0, 12) ?? '(none)'} -> ${moved.after?.slice(0, 12) ?? '(none)'} (${moved.commits} new ${moved.commits === 1 ? 'commit' : 'commits'})${branch}.`,
    );
  }
  // The stat repeats paths, so it gets the same diagnostic redaction as the path list.
  if (changes.diffStat)
    lines.push(
      'Diff against HEAD of the changed tracked files (includes earlier uncommitted changes):',
      redactDiagnostic(changes.diffStat, 16 * 1024),
    );
  return lines.join('\n');
}

export interface FormatExecutionOptions {
  requireEnvelope?: boolean;
  warnings?: string[];
  reviewContext?: ReviewGateContext;
  price?: string;
}

/**
 * The footer line with a turn's token counts and, when it can be computed without guessing,
 * their list-price equivalent (`AX-001g`).
 * @remarks Reasoning is part of output, and cache reads and writes are parts of input, so none
 * is counted twice. An amount needs known input, cache-read, cache-write and output counts and
 * a price for each part used. Writes kept for an hour have their own price: when the list
 * names one and the backend did not split its writes, no amount is shown. A turn whose input
 * reached the size from which the list prices prompts differently shows none either, since a
 * turn's total does not say how large each request was. Unknown is never taken as zero. It is
 * a list-price equivalent, not billing: a subscription CLI may charge nothing per token.
 * @returns The line, or undefined when the backend reported no counts.
 */
export function formatUsage(usage: TokenUsage | undefined, price: ListPrice | undefined): string | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  const n = (value: number) => value.toLocaleString('en-US');
  const parts: string[] = [];
  if (usage.inputTokens !== undefined)
    parts.push(`${n(usage.inputTokens)} input${usage.cachedInputTokens ? ` (${n(usage.cachedInputTokens)} cached)` : ''}`);
  if (usage.outputTokens !== undefined)
    parts.push(`${n(usage.outputTokens)} output${usage.reasoningTokens ? ` (${n(usage.reasoningTokens)} reasoning)` : ''}`);
  let line = `Usage: ${parts.join(' - ')} tokens`;
  const cost = listPriceEquivalent(usage, price);
  if (cost !== undefined && price) line += ` - list price ~${formatUsd(cost)} USD (${price.source})`;
  return line;
}

/** Cents from 1 USD up; two significant digits below, down to a millionth of a dollar. */
function formatUsd(amount: number): string {
  if (amount >= 1) return amount.toFixed(2);
  if (amount < 0.000001) return amount === 0 ? '0' : '<0.000001';
  return String(Number(amount.toFixed(Math.min(6, 1 - Math.floor(Math.log10(amount))))));
}

/** USD at list price, or undefined when a needed count or price is unknown. */
function listPriceEquivalent(usage: TokenUsage, price: ListPrice | undefined): number | undefined {
  const { inputTokens, cachedInputTokens: cached, cacheWriteInputTokens: written, outputTokens } = usage;
  if (!price || inputTokens === undefined || outputTokens === undefined || cached === undefined || written === undefined) return undefined;
  if (price.inputUsdPerMTok === null || price.outputUsdPerMTok === null) return undefined;
  if (price.tieredFromInputTokens !== null && inputTokens >= price.tieredFromInputTokens) return undefined;
  const regular = inputTokens - cached - written;
  if (regular < 0 || (cached > 0 && price.cachedInputUsdPerMTok === null)) return undefined;
  let long = usage.cacheWriteLongInputTokens;
  // Without a split, the writes are of one kind only when the list prices one kind.
  if (long === undefined) {
    const shortListed = price.cacheWriteUsdPerMTok !== null,
      longListed = price.cacheWriteLongUsdPerMTok !== null;
    if (written > 0 && shortListed && longListed) return undefined;
    long = longListed && !shortListed ? written : 0;
  }
  const short = written - long;
  if (short < 0 || (short > 0 && price.cacheWriteUsdPerMTok === null) || (long > 0 && price.cacheWriteLongUsdPerMTok === null))
    return undefined;
  return (
    (regular * price.inputUsdPerMTok +
      cached * (price.cachedInputUsdPerMTok ?? 0) +
      short * (price.cacheWriteUsdPerMTok ?? 0) +
      long * (price.cacheWriteLongUsdPerMTok ?? 0) +
      outputTokens * price.outputUsdPerMTok) /
    1_000_000
  );
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
 * - Appends the bug report form link and the issue tool on unrecoverable fatal system errors.
 */
export function formatExecutionResult(outcome: TaskExecutionResult, defaultText?: string): ExecutionToolResult;
export function formatExecutionResult(
  provider: string | null,
  res: TerminalExecutionResult,
  defaultText?: string,
  sessionHandle?: string | null,
  meta?: ExecutionMeta,
  options?: FormatExecutionOptions,
): ExecutionToolResult;
export function formatExecutionResult(
  outcomeOrProvider: TaskExecutionResult | string | null,
  resOrDefaultText?: TerminalExecutionResult | string,
  defaultText = '',
  sessionHandle: string | null = null,
  meta: ExecutionMeta = { turn: 1, toolCount: 0, durationMs: 0, historyAvailable: false },
  options: FormatExecutionOptions = {},
): ExecutionToolResult {
  let provider: string | null;
  let res: TerminalExecutionResult;
  let activeHandle: string | null;
  let executionMeta: ExecutionMeta;
  let rawWarnings: string[];
  let priceNote: string | undefined;
  let listPrice: ListPrice | undefined;
  let preEvaluatedReview: StateEnvelopeEvaluation | undefined;
  let observedChanges: WorkspaceChanges | undefined;
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
    listPrice = outcome.listPrice;
    preEvaluatedReview = outcome.review;
    observedChanges = outcome.changes;
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
  // Whether the server appends the terminator it owns (ENVELOPE-001).
  let evaluation: StateEnvelopeEvaluation | undefined;

  if (preEvaluatedReview) {
    verdict = preEvaluatedReview.verdict;
    reason = preEvaluatedReview.reason;
    evaluation = preEvaluatedReview;
  } else if (formatOpts.requireEnvelope) {
    if (res.isError || error) {
      verdict = 'BLOCKED';
      reason = error?.message || 'Execution error';
    } else {
      const reviewCtx = res.denials?.length ? { ...formatOpts.reviewContext, observedDenials: res.denials } : formatOpts.reviewContext;
      evaluation = evaluateStateEnvelopeGate(cleaned, res.truncated, true, reviewCtx, {
        completed: res.status === 'completed',
        lengthLimited: res.lengthLimited,
      });
      ({ verdict, reason } = evaluation);
    }
  } else {
    verdict = 'NOT_APPLICABLE';
  }

  let output = redactCredentialFormats(cleaned);
  if (verdict !== 'NOT_APPLICABLE' && executionMeta.turn > 0) {
    output = alignEnvelopeReviewTurn(output, executionMeta.turn);
  }
  if (verdict !== 'NOT_APPLICABLE' && !error) output = appendEnvelopeTerminator(output, evaluation);
  const parts: string[] = [];
  if (error) {
    parts.push(`Error [${error.code}${error.retryable ? ', retryable' : ''}]: ${error.message}`);
    if (output) parts.push('Partial response:', present(output));
  } else {
    parts.push(output ? present(output) : res.status === 'completed' ? 'CLI completed with no public text.' : 'No public response.');
  }
  // A failed or cancelled worker may still have changed files, so the block follows every outcome.
  if (observedChanges) parts.push(present(formatObservedChanges(observedChanges)));

  const durationMs = Math.max(
    0,
    typeof executionMeta.totalMs === 'number' && Number.isFinite(executionMeta.totalMs)
      ? executionMeta.totalMs
      : executionMeta.durationMs || 0,
  );
  const durationSec = (durationMs / 1000).toFixed(1);
  const ops = executionMeta.toolCount > 0 ? ` - ${executionMeta.toolCount} ${executionMeta.toolCount === 1 ? 'op' : 'ops'}` : '';
  const turn = executionMeta.turn > 1 ? `turn ${executionMeta.turn}, ` : '';
  // A call that started no turn wrote nothing, which says nothing about the session's history;
  // an unchanged repeat review still retains a valid workspace session_handle in the footer (FEEDBACK-060f4).
  const history = executionMeta.historyAvailable || executionMeta.turn === 0 ? '' : ', no history';
  // Labelled with its parameter name, so a caller passes it back as `session_handle` (AX-007b).
  const session = activeHandle
    ? ` - session_handle=${activeHandle} (${turn}${res.continuationAvailable ? 'ready' : 'finished'}${history})`
    : '';

  const footerLines: string[] = [`CoAgent8: ${provider || 'CLI'} - ${res.model || 'provider default'} - ${durationSec}s${ops}${session}`];
  if (verdict !== 'NOT_APPLICABLE') {
    // A failed run states its reason in the error line already.
    // The reason may quote the reviewer's own Blocked line.
    footerLines.push(`Verdict: ${verdict}${reason && !error ? ` (${redactCredentialFormats(reason)})` : ''}`);
  }
  if (res.denials && res.denials.length > 0) {
    for (const denial of res.denials) {
      const op = denial.operation ? `${denial.operation} ` : '';
      const target = denial.path ? `${redactDiagnostic(denial.path)} ` : '';
      const why = denial.reason ? `(${denial.reason})` : '';
      footerLines.push(`Denied (observed from tool events): ${op}${target}${why}`.trim());
    }
  }
  if (priceNote) footerLines.push(`Price: ${priceNote}`);
  const usageLine = formatUsage(res.usage, listPrice);
  if (usageLine) footerLines.push(usageLine);
  if (res.truncated) {
    footerLines.push('Notice: Output reached buffer limit.');
  }
  for (const warning of warnings) {
    footerLines.push(`Warning: ${warning}`);
  }
  if (error && (['PROCESS_ERROR', 'CLI_UNSUPPORTED', 'PROTOCOL_ERROR'] as string[]).includes(error.code)) {
    footerLines.push(`Report this issue: ${GITHUB_BUG_REPORT_TEMPLATE_URL} (the issue tool prepares the sanitized report to paste)`);
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
  const content =
    first?.type === 'text'
      ? [{ ...first, text: withFooterLine(first.text ?? '', note) }, ...rest]
      : [...result.content, { type: 'text', text: present(note) }];
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
