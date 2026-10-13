/**
 * Automated secret redaction for credentials, tokens, and sensitive diagnostics.
 *
 * @remarks
 * Preserves public Markdown answers and ordinary code while redacting high-confidence
 * secret formats, diagnostic keywords, and user home directory paths.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import os from 'node:os';
import { truncateToByteLength } from '../execution/runtime/stream.js';

/** Errors for which a home directory simply has no canonical path to add. */
const UNRESOLVABLE_HOME = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']);
let canonicalHome: { home: string; canonical: string } | undefined;

/**
 * The spellings of the home directory: as the environment gives it and its
 * canonical path. A short 8.3 name, junction or symlink in the home path gives a
 * different string than canonical paths such as resolved workspaces use.
 *
 * Redaction runs inside error handlers, so it never throws: when the canonical
 * path cannot be read, the literal spelling is still redacted. An unexpected
 * failure is reported by its code only, because its message names the home path.
 */
function homeSpellings(home: string): string[] {
  if (canonicalHome?.home !== home) {
    try {
      canonicalHome = { home, canonical: fs.realpathSync.native(home) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (!UNRESOLVABLE_HOME.has(code)) process.stderr.write(`Warning: canonical home directory not resolved for redaction: ${code}\n`);
      return [home];
    }
  }
  return canonicalHome.canonical === home ? [home] : [home, canonicalHome.canonical];
}

/**
 * Filters high-confidence credential formats in public Markdown and model answers
 * without rewriting ordinary code or keyword assignments.
 *
 * @param text - Input text to scan and redact.
 * @returns Redacted text with credentials replaced by placeholders.
 */
export function redactCredentialFormats(text: string): string {
  // PEM private keys
  text = text.replace(/-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 _-]*PRIVATE KEY-----|$)/gi, '-----BEGIN PRIVATE KEY-----\n***[REDACTED]***\n-----END PRIVATE KEY-----');

  // Authorization headers with specific scheme and high-entropy credential tokens (at least 16 chars with digits)
  text = text.replace(/\bAuthorization\s*:\s*(Bearer|Token)\s+(?=[A-Za-z0-9._~+/-]*\d)([A-Za-z0-9._~+/-]{16,}={0,2})(?![A-Za-z0-9._~+/=-])/gi, 'Authorization: $1 ***[REDACTED]***');

  // Standalone Bearer tokens (require digit or non-letter mixed in to avoid replacing ordinary prose/identifiers)
  text = text.replace(/\b(Bearer)\s+(?=[A-Za-z0-9._~+/-]*\d)([A-Za-z0-9._~+/-]{16,}={0,2})(?![A-Za-z0-9._~+/=-])/gi, '$1 ***[REDACTED]***');

  // Basic tokens (in Authorization: Basic or standalone, only when valid Base64 that decodes to printable user:password)
  text = text.replace(/\b(?:Authorization\s*:\s*)?(Basic)\s+([A-Za-z0-9+/]{6,}={0,2})(?![A-Za-z0-9+/=])/gi, (match, prefix, b64) => {
    // Buffer.from does not throw on malformed base64; it decodes what it can.
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    if (decoded.includes(':') && /^[\x20-\x7E]+$/.test(decoded)) {
      return match.startsWith('Authorization') ? `Authorization: ${prefix} ***[REDACTED]***` : `${prefix} ***[REDACTED]***`;
    }
    return match;
  });

  // OpenAI API keys
  text = text.replace(/\b(?:sk-[a-zA-Z0-9_-]{20,})\b/g, 'sk-***[REDACTED]***');

  // Stripe live secret keys (AUD-P2-13)
  text = text.replace(/\b(?:sk_live_[a-zA-Z0-9]{24,})\b/g, 'sk_live_***[REDACTED]***');

  // Google AI / Maps API keys
  text = text.replace(/(?:AIza[0-9A-Za-z-_]{35})/g, 'AIza***[REDACTED]***');

  // Google OAuth access tokens (AUD-P2-13)
  text = text.replace(/(?:ya29\.[0-9A-Za-z_\.-]{20,})/g, 'ya29.***[REDACTED]***');

  // GitHub access tokens (classic PAT, OAuth, user-to-server, server-to-server, fine-grained PAT)
  text = text.replace(/(?:(ghp|gho|ghu|ghs)_[a-zA-Z0-9]{36})/g, '$1_***[REDACTED]***');
  text = text.replace(/(?:github_pat_[a-zA-Z0-9_]{80,})/g, 'github_pat_***[REDACTED]***');

  // GitLab Personal Access Tokens (AUD-P2-13)
  text = text.replace(/(?:glpat-[a-zA-Z0-9_\-]{20,})/g, 'glpat-***[REDACTED]***');

  // npm access tokens (AUD-P2-13)
  text = text.replace(/(?:npm_[a-zA-Z0-9]{36})/g, 'npm_***[REDACTED]***');

  // Hugging Face user access tokens (AUD-P2-13)
  text = text.replace(/(?:hf_[a-zA-Z0-9]{34,})/g, 'hf_***[REDACTED]***');

  // Bare JWTs (AUD-P2-13)
  text = text.replace(/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, 'eyJ***[REDACTED]***');

  // AWS access key IDs (AKIA/ASIA/ABIA/ACCA followed by exactly 16 uppercase alphanumeric chars)
  text = text.replace(/\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, (_m, p) => p.slice(0, 4) + '***[REDACTED]***');

  // Slack tokens (xoxb, xoxa, xoxp, xoxr, xoxs followed by digits and token string)
  text = text.replace(/\b(xox[baprs])-[0-9]+-[A-Za-z0-9-]{8,}\b/g, 'xox-***[REDACTED]***');

  // The runner may already have bounded a diagnostic at a credential boundary.
  text = text.replace(/(?<![A-Za-z0-9_])(?:sk-|sk_live_|AIza|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|npm_|hf_|ya29\.|AKIA|ASIA|ABIA|ACCA|xox[baprs]-|eyJ)[a-zA-Z0-9_.-]{4,}(?=\s*\.\.\.\[truncated\])/g, '***[REDACTED]***');
  text = text.replace(/(?<![A-Za-z0-9_])(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}(?=\s*\.\.\.\[truncated\])/gi, '$1 ***[REDACTED]***');

  // Embedded credentials in URLs (any scheme with user:pass@ or :pass@, skipping whole-token template expressions and placeholders)
  const isUrlPlaceholder = (token: string) => /^\$\{[^}]*\}$|^<[^>]+>$|^\{[^}]+\}$/.test(token) || /%[sd](?![0-9A-Fa-f])|%\([A-Za-z_]\w*\)s/.test(token);
  text = text.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^:@\s\/?#]*):([^\s\/?#]+)@/gi, (match, scheme, user, pass) => {
    if (isUrlPlaceholder(pass)) {
      return match;
    }
    return `${scheme}://${user}:***[REDACTED]***@`;
  });

  return text;
}

/**
 * Preserves public Markdown and code while filtering known credential formats.
 * @deprecated Use redactCredentialFormats instead.
 */
export const redactSecrets = redactCredentialFormats;

/**
 * Diagnostic, stderr, error, and bug report redaction.
 * In addition to high-confidence credential formats, filters keyword=value rules
 * (token=, password:, auth=) and redacts the local user home directory.
 *
 * @param value - Diagnostic message, Error, or structured object to redact.
 * @param budget - Maximum byte length for the returned diagnostic string (default 4096).
 * @returns Bounded, redacted diagnostic string.
 */
export function redactDiagnostic(value: unknown, budget = 4096): string {
  let input: string;
  if (typeof value === 'string') input = value;
  else if (value instanceof Error) input = value.message;
  else {
    try { input = JSON.stringify(value) ?? 'Unknown execution error.'; }
    catch { input = 'Unserializable execution error.'; }
  }

  // 1. High-confidence credential formats
  let text = redactCredentialFormats(input);

  // Diagnostic Authorization headers (catch-all for diagnostic/issue reporting)
  text = text.replace(/Authorization\s*:\s*(Bearer|Basic|Token)\s+[^\s,;]+/gi, 'Authorization: $1 ***[REDACTED]***');
  text = text.replace(/Authorization\s*:\s*(?!Bearer|Basic|Token)[^\s,;]+/gi, 'Authorization: ***[REDACTED]***');

  // Diagnostic URL userinfo stripping (strips any user/token in URLs in issue/error reports across any scheme)
  text = text.replace(/\b([a-z][a-z0-9+.-]*):\/\/([^\s\/?#]+)@/gi, '$1://***[REDACTED]***@');

  // 2. Keyword=value rules for diagnostic contexts
  text = text.replace(/(aws_access_key_id|aws_secret_access_key|aws_session_token|aws_security_token)\s*[:=]\s*[^\s,;]+/gi, '$1=***[REDACTED]***');

  text = text.replace(
    /(["']?(?:api[_-]?key|token|secret|password|passwd|auth|access[_-]?key|aws_access_key_id|aws_secret_access_key|aws_session_token|aws_security_token)["']?\s*[:=]\s*)(["'])(?:\\[\s\S]|(?!\2)[^\\])*(?:\2|\\?$)/gi,
    '$1$2***[REDACTED]***$2'
  );

  text = text.replace(
    /(["']?(?:api[_-]?key|token|secret|password|passwd|auth|access[_-]?key|aws_access_key_id|aws_secret_access_key|aws_session_token|aws_security_token)["']?\s*[:=]\s*)(?!["'])([^"'\s,\r\n}{]+)/gi,
    '$1***[REDACTED]***'
  );

  text = text.replace(/([?&](?:token|key|secret|apiKey)=)[^&\s]+/gi, '$1***[REDACTED]***');

  // 3. User home directory redaction
  text = redactHomePath(text);

  return truncateToByteLength(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), budget);
}

/**
 * Redacts occurrences of the user's home directory path to `~`
 * across different casing and path separator variations, without
 * truncating or rewriting keyword assignments.
 *
 * @param text - Text potentially containing local home directory paths.
 * @returns Text with home directory paths replaced by `~`.
 */
export function redactHomePath(text: string): string {
  if (!text) return text;
  const variants = new Set(homeSpellings(os.homedir()).flatMap(home => [home, home.replace(/\\/g, '/')]));
  // Serialized diagnostics can contain JSON inside JSON, doubling backslashes
  // at each boundary. Replace longer encodings first so no private prefix survives.
  for (let level = 0; level < 4; level++) {
    for (const variant of [...variants]) variants.add(JSON.stringify(variant).slice(1, -1));
  }
  let result = text;
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped + '(?=$|[\\\\/\\s"\'`,;:}\\]])', process.platform === 'win32' ? 'gi' : 'g'), '~');
  }
  return result;
}

/**
 * Redacts high-confidence credential formats and user home directory paths
 * for public conversation content, model answers, and session records,
 * preserving ordinary code and keyword assignments without truncation.
 *
 * @param text - Public text or Markdown to sanitize.
 * @returns Sanitized public text.
 */
export function redactPublicContent(text: string): string {
  return redactHomePath(redactCredentialFormats(text));
}

/**
 * Recursively sanitizes strings in an object, array, or primitive for public output.
 * Redacts high-confidence credential formats and user home paths without keyword
 * rewriting or byte truncation.
 *
 * @param value - Value to recursively sanitize.
 * @returns Sanitized value of the same structure.
 */
export function redactPublicData<T>(value: T): T {
  if (typeof value === 'string') return redactPublicContent(value) as unknown as T;
  if (Array.isArray(value)) return value.map(v => redactPublicData(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactPublicData(v)])
    ) as unknown as T;
  }
  return value;
}

/**
 * Recursively redacts strings in an object, array, or primitive for diagnostic output.
 * Replaces credentials, tokens, sensitive keywords, and user home directory paths.
 *
 * @param value - Value to recursively redact.
 * @param budget - Max byte length per string (default 2048).
 * @returns Redacted value of the same structure.
 */
export function redactDiagnosticData<T>(value: T, budget = 2048): T {
  if (typeof value === 'string') return redactDiagnostic(value, budget) as unknown as T;
  if (Array.isArray(value)) return value.map(v => redactDiagnosticData(v, budget)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDiagnosticData(v, budget)])
    ) as unknown as T;
  }
  return value;
}
