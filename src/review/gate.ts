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
 * CoAgent8 evaluates the review verdict programmatically: any P1/P2 blocker, PARTIAL coverage,
 * truncation or an incomplete envelope makes the server verdict `BLOCKED`. The reviewer's text is
 * never rewritten; the server verdict and its causes are reported beside it.
 *
 * @packageDocumentation
 */

/** Server verdict after evaluating envelope structure and severity markers. */
export interface StateEnvelopeEvaluation {
  verdict: 'READY' | 'BLOCKED' | 'NOT_APPLICABLE';
  reason?: string;
}

/** Bound for the reviewer's own `Blocked:` reason quoted in the verdict line. */
const MAX_BLOCKED_REASON_CHARS = 300;

/** Server-collected review input and scope-based requirements, never caller approval. */
export interface ReviewGateContext {
  expectedSnapshot: string;
  inputComplete: boolean;
  requiredChecks: readonly ('typecheck' | 'tests')[];
  invalidatedReason?: string;
}

/**
 * Gates reported review text on unique nonempty envelope fields and coverage/verdict.
 * @param output - Model-written review text.
 * @param truncated - Public output truncation.
 * @param requireEnvelope - Require an envelope even when none is detected in the answer.
 * @param context - Server-collected snapshot, input completeness and required checks.
 * @returns The server verdict and, when blocked, every cause; a reviewer READY it overrides is named.
 * @remarks Literal P1/P2 markers, partial coverage and malformed/truncated output block.
 * With context, SNAPSHOT must match and input must be complete and unchanged. Failed
 * checks always block; required checks must report PASS. A reviewer's BLOCKED without a
 * P1/P2 finding quotes its `Blocked:` line. The reason lists every cause. This does not
 * execute tests, verify a reported PASS or bind a release artifact.
 */
export function evaluateStateEnvelopeGate(output: string, truncated: boolean, requireEnvelope = false, context?: ReviewGateContext): StateEnvelopeEvaluation {
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

    const checks = /^typecheck=(PASS|FAIL|NOT_RUN);\s*tests=(PASS|FAIL|NOT_RUN)$/i.exec(checksVal);
    const checkValues = checks ? { typecheck: checks[1].toUpperCase(), tests: checks[2].toUpperCase() } : undefined;
    const failedChecks = checkValues && Object.values(checkValues).includes('FAIL');
    const missingChecks = context?.requiredChecks.some(check => checkValues?.[check] !== 'PASS');
    const wrongSnapshot = context && snapshotVal !== context.expectedSnapshot;
    const incompleteInput = context && !context.inputComplete;
    const shouldBlock = !isCompleteEnvelope || !checks || failedChecks || missingChecks || wrongSnapshot || incompleteInput || context?.invalidatedReason
      || truncated || hasBlockers || coverageVal === 'PARTIAL' || verdictVal !== 'READY';

    if (shouldBlock) {
      // Every cause is reported: a blocked verdict without its causes gives the caller nothing to act on.
      const checkList = (keep: (name: 'typecheck' | 'tests', value: string) => boolean) => checkValues
        ? (['typecheck', 'tests'] as const).filter(name => keep(name, checkValues[name])).map(name => `${name}=${checkValues[name]}`).join(', ')
        : '';
      const reasons: string[] = [];
      if (hasBlockers) reasons.push('Blocker issue [P1/P2] reported');
      if (coverageVal === 'PARTIAL') reasons.push('Review coverage is partial');
      if (truncated) reasons.push('Output was truncated');
      // Without an answer or an envelope, its field checks would only restate that absence.
      if (nonEmptyLines.length === 0) reasons.push('Reviewer returned no answer');
      else if (!isEnveloped) reasons.push('Answer has no State Envelope');
      else if (!isCompleteEnvelope) reasons.push('Incomplete State Envelope');
      if (context?.invalidatedReason) reasons.push(context.invalidatedReason);
      if (incompleteInput) reasons.push('Review input is incomplete');
      if (isEnveloped && wrongSnapshot) reasons.push('Review snapshot does not match the collected input');
      if (isEnveloped && !checks) reasons.push('Invalid CHECKS outcomes');
      if (failedChecks) reasons.push(`A reported check failed (${checkList((_, value) => value === 'FAIL')})`);
      const notRun = checkList((name, value) => !!context?.requiredChecks.includes(name) && value === 'NOT_RUN');
      if (notRun) reasons.push(`Required checks were not run (${notRun})`);
      if (verdictVal === 'BLOCKED' && !hasBlockers) {
        reasons.push(blockedVal
          ? `Reviewer reported BLOCKED: ${blockedVal.slice(0, MAX_BLOCKED_REASON_CHARS)}`
          : 'Reviewer reported BLOCKED without a [P1/P2] finding or a Blocked reason');
      }
      // The answer still reads READY; the caller must see that the server overrides it.
      if (verdictVal === 'READY' && verdictCount === 1 && !hasBogusVerdict) reasons.push('the reviewer answered READY');
      return { verdict: 'BLOCKED', reason: reasons.length > 0 ? reasons.join('; ') : 'Review requirements not satisfied' };
    }
    return { verdict: 'READY' };
  }

  return { verdict: 'NOT_APPLICABLE' };
}

