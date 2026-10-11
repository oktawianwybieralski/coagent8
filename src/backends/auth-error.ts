/** Recognition of authentication failures in CLI error text. @packageDocumentation */

/**
 * Anchored provider phrases for a missing or rejected login. A bare "auth", "login",
 * "401" or "403" also occurs in ordinary words, paths and line numbers ("author",
 * "line 401"), so only phrases and status forms are matched.
 */
const AUTH_PHRASES = new RegExp([
  String.raw`\bunauthori[sz]ed\b`,
  String.raw`\bauthentication (?:failed|required|error)\b`,
  String.raw`\bnot (?:logged|signed) in\b`,
  String.raw`\b(?:please )?log ?in (?:required|again)\b`,
  String.raw`\b(?:invalid|incorrect)[ _]api[ _]key\b`,
  String.raw`\bapi[ _.]?key (?:is )?(?:missing|required|invalid|not (?:set|valid))\b`,
  String.raw`\b(?:credentials?|token) (?:expired|missing|invalid|revoked)\b`,
  String.raw`\b(?:http|status)(?: code)?\s*[:=]?\s*40[13]\b`,
  String.raw`\b40[13] (?:unauthorized|forbidden)\b`,
  String.raw`\bineligibletiererror\b`,
].join('|'), 'i');

/** Returns whether error text reports a missing, expired or rejected login. */
export function isAuthError(text?: string | null): boolean {
  return typeof text === 'string' && AUTH_PHRASES.test(text);
}
