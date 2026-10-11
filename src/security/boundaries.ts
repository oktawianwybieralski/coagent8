/**
 * Safe credential fragment boundaries for streaming text.
 *
 * @remarks
 * Computes safe commit boundaries holding back incomplete secret tokens
 * or open PEM certificate blocks until fully arrived or finalized.
 *
 * @packageDocumentation
 */

/**
 * Detects whether a trailing non-whitespace token could be the start of a credential.
 *
 * @param word - Trailing token to test.
 * @returns True if word is a potential credential prefix.
 */
export function isPotentialSecretPrefix(word: string): boolean {
  if (!word) return false;
  const w = word.toLowerCase();
  if ('-----begin'.startsWith(w) || w.startsWith('-----begin')) return true;
  if ('authorization'.startsWith(w) || w.startsWith('authorization')) return true;
  if ('bearer'.startsWith(w) || w.startsWith('bearer')) return true;
  if ('basic'.startsWith(w) || w.startsWith('basic')) return true;
  if ('https://'.startsWith(w) || 'http://'.startsWith(w) || w.includes('://')) return true;
  if ('sk-'.startsWith(w) || 'sk_live_'.startsWith(w) || w.includes('sk-') || w.includes('sk_live_')) return true;
  if ('aiza'.startsWith(w) || w.includes('aiza')) return true;
  if ('ya29.'.startsWith(w) || w.includes('ya29.')) return true;
  if (
    'ghp_'.startsWith(w) || 'gho_'.startsWith(w) || 'ghu_'.startsWith(w) || 'ghs_'.startsWith(w) ||
    'github_pat_'.startsWith(w) || 'glpat-'.startsWith(w) ||
    w.includes('ghp_') || w.includes('gho_') || w.includes('ghu_') || w.includes('ghs_') ||
    w.includes('github_pat_') || w.includes('glpat-')
  ) return true;
  if ('npm_'.startsWith(w) || w.includes('npm_')) return true;
  if ('hf_'.startsWith(w) || w.includes('hf_')) return true;
  if ('eyj'.startsWith(w) || w.includes('eyj')) return true;
  if ('xox'.startsWith(w) || w.includes('xox')) return true;
  if (
    w.includes('akia') || w.includes('asia') || w.includes('abia') || w.includes('acca') ||
    /^a(?:k(?:i(?:a)?)?|s(?:i(?:a)?)?|b(?:i(?:a)?)?|c(?:c(?:a)?)?)?$/i.test(w)
  ) return true;
  return false;
}

/**
 * Computes the safe byte/character commit boundary for streaming text,
 * holding back any incomplete credentials (e.g. split across deltas) or open PEM blocks.
 *
 * @param text - Cumulative streamed text.
 * @param isFinished - Whether the turn has concluded and trailing text may be flushed.
 * @returns Index up to which text is safe to commit and redact.
 */
export function computeSafeCommitPoint(text: string, isFinished = false): number {
  if (isFinished || text.length === 0) return text.length;

  // 1. Open PEM block check: hold back from -----BEGIN if no matching -----END
  const lower = text.toLowerCase();
  const lastBegin = lower.lastIndexOf('-----begin');
  if (lastBegin !== -1) {
    const lastEnd = lower.lastIndexOf('-----end');
    if (lastEnd < lastBegin) {
      return lastBegin;
    }
  }

  // 2. Keyword check in trailing 256 characters for auth headers
  const windowStart = Math.max(0, text.length - 256);
  const tail = text.slice(windowStart);
  const tailLower = tail.toLowerCase();
  const keywords = ['authorization', 'bearer', 'basic'];
  for (const kw of keywords) {
    const idx = tailLower.indexOf(kw);
    if (idx !== -1) {
      return windowStart + idx;
    }
  }

  // 3. Trailing non-whitespace token check
  let tokenRunStart = text.length;
  while (tokenRunStart > 0 && !/\s/.test(text[tokenRunStart - 1])) {
    tokenRunStart--;
  }

  const trailingWord = text.slice(tokenRunStart);
  if (trailingWord && isPotentialSecretPrefix(trailingWord)) {
    return tokenRunStart;
  }

  return text.length;
}

