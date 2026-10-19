/**
 * State Envelope verdict gate for review responses.
 *
 * @remarks
 * AI-to-AI communication between Author (Antigravity) and Reviewer (Codex) uses structured envelopes:
 *
 * ```text
 * REVIEW: <turn>
 * SNAPSHOT: <sha>
 * COVERAGE: COMPLETE | PARTIAL
 * VERDICT: READY | BLOCKED
 * [P1/P2/P3] <file>:<line>
 * CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>
 * END_REVIEW
 * ```
 *
 * The terminator belongs to the server (owner decision 2026-10-18, `ENVELOPE-001`): the prompt
 * ends the envelope with `CHECKS`, and an envelope without `END_REVIEW` is complete only when
 * `CHECKS` is its last line and the turn's own completion evidence says the answer was not
 * cut off; the formatter then appends the terminator. A model-written `END_REVIEW` is still
 * accepted, and an observed length stop blocks either way.
 *
 * CoAgent8 evaluates the review verdict programmatically: any P1/P2 blocker, PARTIAL coverage,
 * truncation or an incomplete envelope makes the server verdict `BLOCKED`. The reviewer's text is
 * never rewritten; the server verdict and its causes are reported beside it. A read-only
 * reviewer cannot run checks, so a required check reported `NOT_RUN` does not block: READY then
 * says which checks did not run, and the author and CI run them (rule 03).
 *
 * @packageDocumentation
 */

/** Server verdict after evaluating envelope structure and severity markers. */
export interface StateEnvelopeEvaluation {
  verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
  reason?: string;
  /**
   * The reviewer returned a complete, untruncated envelope with valid checks for the expected
   * snapshot: a judgement that repeating the same request would not change (`AX-007c`).
   */
  judged?: boolean;
  /** Evaluated coverage reported in the state envelope. */
  coverage?: 'COMPLETE' | 'PARTIAL';
  /**
   * The envelope is complete without a model-written `END_REVIEW`: the formatter appends it.
   * Set only after completeness was established, for a BLOCKED review as well.
   */
  appendTerminator?: boolean;
}

/**
 * How the review turn ended, from the backend's protocol rather than the model's text.
 * @remarks `lengthLimited` is `true` only when the backend reported a stop at the output
 * length limit, and `undefined` when it reports no stop reason (Codex and agy today).
 */
export interface TurnCompletion {
  /** The turn ended with a normal terminal event: not interrupted, timed out or failed. */
  completed: boolean;
  lengthLimited?: boolean;
}

/**
 * A P1 or P2 finding header without brackets: after an optional Markdown list, quote or
 * heading marker and emphasis, the line starts with the severity and names a `<file>:<line>`
 * anywhere, as in `P2 sum.js:4`, `+ **P1:** src/a.ts:10` or `P2 a.ts:3: text`. It errs
 * towards blocking: a line that opens with P1 or P2 and cites a location is a finding.
 */
const UNBRACKETED_BLOCKER = /^(?:[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+)?[*_`]*P[12](?![0-9])[*_`:]*\s.*?[^\s:]*[a-z.][^\s:]*:\d+/i;

/** Bound for the reviewer's own `Blocked:` reason quoted in the verdict line. */
const MAX_BLOCKED_REASON_CHARS = 300;

/** Server-collected review input and scope-based requirements, never caller approval. */
export interface ReviewGateContext {
  expectedSnapshot?: string;
  inputComplete?: boolean;
  requiredChecks?: readonly ('typecheck' | 'tests')[];
  invalidatedReason?: string;
  requiredFiles?: readonly string[];
  observedDenials?: readonly { path?: string; operation?: string; reason?: string }[];
  workspaceRoot?: string;
}

/**
 * Gates reported review text on unique nonempty envelope fields and coverage/verdict.
 * @param output - Model-written review text.
 * @param truncated - Public output truncation.
 * @param requireEnvelope - Require an envelope even when none is detected in the answer.
 * @param context - Server-collected snapshot, input completeness and required checks.
 * @param completion - The turn's completion evidence; without it only a model-written
 * `END_REVIEW` terminates the envelope.
 * @returns The server verdict and, when blocked, every cause; a reviewer READY it overrides is
 * named, and a READY names the required checks that did not run.
 * @remarks Literal P1/P2 markers, P1/P2 finding headers without brackets, partial coverage
 * and malformed/truncated output block.
 * With context, SNAPSHOT must match and input must be complete and unchanged. Failed
 * checks always block. A required check reported NOT_RUN does not: a reported PASS is not
 * evidence either, since this does not execute tests, verify a reported PASS or bind a
 * release artifact. A reviewer's BLOCKED without a P1/P2 finding quotes its `Blocked:` line.
 */
export function evaluateStateEnvelopeGate(output: string, truncated: boolean, requireEnvelope = false, context?: ReviewGateContext, completion?: TurnCompletion): StateEnvelopeEvaluation {
  const rawLines = output.split(/\r?\n/);
  const nonEmptyLines = rawLines.map(l => l.trim()).filter(l => l.length > 0);

  let reviewCount = 0, reviewVal = '';
  let snapshotCount = 0, snapshotVal = '';
  let coverageCount = 0, coverageVal: 'COMPLETE' | 'PARTIAL' | undefined = undefined;
  let verdictCount = 0, verdictVal: 'READY' | 'BLOCKED' | undefined = undefined;
  let checksCount = 0, checksVal = '';
  let endReviewCount = 0;
  let hasBogusVerdict = false;
  let blockedVal = '';

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

    const blockedMatch = trimmed.match(/^Blocked:[^\S\r\n]+(\S.*)$/i);
    if (blockedMatch && !blockedVal) blockedVal = blockedMatch[1].trim();
  }

  // A model may drop the brackets of a finding header (`P2 sum.js:4`); only a line shaped
  // like a header counts then, so prose that mentions P1 or P2 does not block.
  const hasBlockers = /\[P[12]\]/i.test(output) || rawLines.some(line => UNBRACKETED_BLOCKER.test(line.trim()));
  const isEnveloped = reviewCount > 0 || snapshotCount > 0 || coverageCount > 0 || verdictCount > 0 || checksCount > 0 || endReviewCount > 0;
  const isEndReviewLast = nonEmptyLines.length > 0 && /^END_REVIEW$/i.test(nonEmptyLines[nonEmptyLines.length - 1]);
  const isChecksLast = nonEmptyLines.length > 0 && /^CHECKS:/i.test(nonEmptyLines[nonEmptyLines.length - 1]);
  const lengthLimited = completion?.lengthLimited === true;
  // CHECKS follows every finding, so a cut-off answer ends before it; the turn's terminal
  // event, not the model's text, says that the answer ended there.
  const serverTerminated = endReviewCount === 0 && isChecksLast && completion?.completed === true && !lengthLimited && !truncated;

  const normalizePath = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const normWs = context?.workspaceRoot ? normalizePath(context.workspaceRoot) : undefined;
  const deniedRequiredFiles: string[] = [];
  const pathlessDenials: string[] = [];
  let policyBlocked = false;

  if (context?.observedDenials && context.observedDenials.length > 0) {
    for (const denial of context.observedDenials) {
      if (denial.reason === 'Blocked by policy' || (!denial.path && /blocked\s+by\s+policy/i.test(denial.operation || ''))) {
        policyBlocked = true;
      } else if (!denial.path) {
        const op = denial.operation ? `${denial.operation}` : 'Filesystem access';
        const reason = denial.reason ? ` (${denial.reason})` : '';
        const desc = `${op}${reason}`;
        if (!pathlessDenials.includes(desc)) pathlessDenials.push(desc);
      }
      if (!denial.path || !context.requiredFiles) continue;
      let normDenial = normalizePath(denial.path);
      if (normWs && (normDenial.includes(':') || normDenial.startsWith('/'))) {
        if (normDenial.startsWith(normWs + '/')) {
          normDenial = normDenial.slice(normWs.length + 1);
        } else if (normDenial === normWs) {
          normDenial = '';
        } else {
          continue;
        }
      }
      for (const req of context.requiredFiles) {
        const normReq = normalizePath(req);
        const matches = normReq === normDenial
          || normReq.endsWith('/' + normDenial)
          || normDenial.endsWith('/' + normReq)
          || (normDenial.length > 0 && normReq.startsWith(normDenial + '/'))
          || (normDenial === '');
        if (matches && !deniedRequiredFiles.includes(req)) {
          deniedRequiredFiles.push(req);
        }
      }
    }
  }
  const deniedRequiredScope = (deniedRequiredFiles.length > 0) || ((policyBlocked || pathlessDenials.length > 0) && (context?.requiredFiles?.length ?? 0) > 0);
  if (deniedRequiredScope) {
    coverageVal = 'PARTIAL';
  }

  if (requireEnvelope || isEnveloped || hasBlockers) {
    const isCompleteEnvelope = isEnveloped
      && reviewCount === 1 && reviewVal.length > 0
      && snapshotCount === 1 && snapshotVal.length > 0
      && coverageCount === 1 && coverageVal !== undefined
      && verdictCount === 1 && verdictVal !== undefined && !hasBogusVerdict
      && checksCount === 1 && checksVal.length > 0
      && ((endReviewCount === 1 && isEndReviewLast) || serverTerminated);

    const checks = /^typecheck=(PASS|FAIL|NOT_RUN);\s*tests=(PASS|FAIL|NOT_RUN)$/i.exec(checksVal);
    const checkValues = checks ? { typecheck: checks[1].toUpperCase(), tests: checks[2].toUpperCase() } : undefined;
    const failedChecks = checkValues && Object.values(checkValues).includes('FAIL');
    // Unrun required checks are named on READY; the author and CI run them.
    const notRunChecks = checkValues ? (context?.requiredChecks ?? []).filter(check => checkValues[check] === 'NOT_RUN') : [];
    const wrongSnapshot = Boolean(context?.expectedSnapshot && snapshotVal !== context.expectedSnapshot);
    const incompleteInput = Boolean(context && context.inputComplete === false);
    const judged = Boolean(isCompleteEnvelope && checks && !truncated && !lengthLimited && !wrongSnapshot && !deniedRequiredScope);
    const appendTerminator = Boolean(isCompleteEnvelope && serverTerminated);
    const shouldBlock = !isCompleteEnvelope || !checks || failedChecks || wrongSnapshot || incompleteInput || context?.invalidatedReason
      || truncated || lengthLimited || hasBlockers || coverageVal === 'PARTIAL' || verdictVal !== 'READY' || deniedRequiredScope;

    if (shouldBlock) {
      // Every cause is reported: a blocked verdict without its causes gives the caller nothing to act on.
      const checkList = (keep: (name: 'typecheck' | 'tests', value: string) => boolean) => checkValues
        ? (['typecheck', 'tests'] as const).filter(name => keep(name, checkValues[name])).map(name => `${name}=${checkValues[name]}`).join(', ')
        : '';
      const reasons: string[] = [];
      if (hasBlockers) reasons.push('Blocker issue [P1/P2] reported');
      if (deniedRequiredScope) {
        if (policyBlocked) reasons.push('Tool execution was blocked by policy');
        if (pathlessDenials.length > 0) reasons.push(`Tool execution access was denied: ${pathlessDenials.join(', ')}`);
        if (deniedRequiredFiles.length > 0) reasons.push(`Filesystem access to required review scope was denied: ${deniedRequiredFiles.join(', ')}`);
      }
      if (coverageVal === 'PARTIAL') reasons.push('Review coverage is partial');
      if (truncated) reasons.push('Output was truncated');
      if (lengthLimited) reasons.push('The model stopped at its output length limit');
      // Without an answer or an envelope, its field checks would only restate that absence.
      if (nonEmptyLines.length === 0) reasons.push('Reviewer returned no answer');
      else if (!isEnveloped) reasons.push('Answer has no State Envelope');
      else if (!isCompleteEnvelope) reasons.push('Incomplete State Envelope');
      if (context?.invalidatedReason) reasons.push(context.invalidatedReason);
      if (incompleteInput) reasons.push('Review input is incomplete');
      if (isEnveloped && wrongSnapshot) reasons.push('Review snapshot does not match the collected input');
      if (isEnveloped && !checks) reasons.push('Invalid CHECKS outcomes');
      if (failedChecks) reasons.push(`A reported check failed (${checkList((_, value) => value === 'FAIL')})`);
      if (verdictVal === 'BLOCKED' && !hasBlockers) {
        reasons.push(blockedVal
          ? `Reviewer reported BLOCKED: ${blockedVal.slice(0, MAX_BLOCKED_REASON_CHARS)}`
          : 'Reviewer reported BLOCKED without a [P1/P2] finding or a Blocked reason');
      }
      // The answer still reads READY; the caller must see that the server overrides it.
      if (verdictVal === 'READY' && verdictCount === 1 && !hasBogusVerdict) reasons.push('the reviewer answered READY');
      return {
        verdict: 'BLOCKED',
        judged,
        ...(coverageVal ? { coverage: coverageVal } : {}),
        ...(appendTerminator ? { appendTerminator } : {}),
        reason: reasons.length > 0 ? reasons.join('; ') : 'Review requirements not satisfied',
      };
    }
    return notRunChecks.length
      ? { verdict: 'READY', judged, ...(coverageVal ? { coverage: coverageVal } : {}), ...(appendTerminator ? { appendTerminator } : {}), reason: `${notRunChecks.join(' and ')} not run` }
      : { verdict: 'READY', judged, ...(coverageVal ? { coverage: coverageVal } : {}), ...(appendTerminator ? { appendTerminator } : {}) };
  }

  return { verdict: 'NOT_APPLICABLE' };
}

/**
 * Appends the server-owned terminator to an envelope the gate found complete without one.
 * @param output - The reviewer's text after redaction.
 * @param evaluation - The gate's evaluation of that text.
 */
export function appendEnvelopeTerminator(output: string, evaluation: Pick<StateEnvelopeEvaluation, 'appendTerminator'> | undefined): string {
  return evaluation?.appendTerminator ? `${output.replace(/\s+$/, '')}\nEND_REVIEW` : output;
}

/**
 * Replaces the model's `REVIEW: <turn>` counter in an envelope with the server's turn number.
 *
 * @remarks
 * A reviewer model may guess or repeat a stale turn number (e.g. `REVIEW: 1` during turn 2).
 * The server owns the conversation turn count (`FEEDBACK-061e`), so the returned envelope
 * reflects the server's turn counter while keeping the rest of the envelope intact.
 *
 * @param output - Output containing a review envelope.
 * @param turn - Server turn number.
 * @returns Output with `REVIEW: <turn>` updated to the server's turn number.
 */
export function alignEnvelopeReviewTurn(output: string, turn: number): string {
  if (turn <= 0 || !Number.isFinite(turn)) return output;
  return output.replace(/^([^\S\r\n]*REVIEW:)[^\S\r\n]+\S.*$/im, `$1 ${Math.floor(turn)}`);
}

