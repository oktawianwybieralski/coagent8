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
 * CHECKS: typecheck=<PASS|FAIL>; tests=<PASS|FAIL>
 * END_REVIEW
 * ```
 *
 * In `enforceStateEnvelopeGate`, CoAgent8 programmatically validates the review verdict. If any P1/P2
 * blocker is reported, if coverage is PARTIAL, if the response was truncated, or if the envelope is
 * incomplete, `VERDICT` is automatically overridden to `BLOCKED`.
 *
 * @packageDocumentation
 */

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
