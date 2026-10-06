import os from 'node:os';
import { truncateToByteLength } from './execution/stream.js';
/** Preserves public Markdown and code while filtering known credential formats. */
export function redactSecrets(text: string): string {
  text = text.replace(/-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 _-]*PRIVATE KEY-----|$)/gi, '-----BEGIN PRIVATE KEY-----\n***[REDACTED]***\n-----END PRIVATE KEY-----');

  text = text.replace(/Authorization\s*:\s*(Bearer|Basic|Token)\s+[^\s,;]+/gi, 'Authorization: $1 ***[REDACTED]***');
  text = text.replace(/Authorization\s*:\s*(?!Bearer|Basic|Token)[^\s,;]+/gi, 'Authorization: ***[REDACTED]***');
  text = text.replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer ***[REDACTED]***');
  text = text.replace(/\bBasic\s+[a-zA-Z0-9+/=]{16,}/gi, 'Basic ***[REDACTED]***');

  text = text.replace(/(?:sk-[a-zA-Z0-9_-]{20,})/g, 'sk-***[REDACTED]***');
  text = text.replace(/(?:AIza[0-9A-Za-z-_]{35})/g, 'AIza***[REDACTED]***');
  text = text.replace(/(?:ghp_[a-zA-Z0-9]{36})/g, 'ghp_***[REDACTED]***');
  text = text.replace(/(?:github_pat_[a-zA-Z0-9_]{80,})/g, 'github_pat_***[REDACTED]***');
  // The runner may already have bounded a diagnostic at a credential boundary.
  text = text.replace(/(?:sk-|AIza|ghp_|github_pat_|AKIA|ASIA|ABIA|ACCA)[a-zA-Z0-9_-]*(?=\.\.\.\[truncated\])/g, '***[REDACTED]***');
  text = text.replace(/\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16,20})\b/g, (_m, p) => p.slice(0, 4) + '***[REDACTED]***');
  text = text.replace(/\b(xox[baprs]-[a-zA-Z0-9-]+)\b/g, 'xox-***[REDACTED]***');

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

  text = text.replace(/\b(https?|ftp|ssh|git):\/\/([^@\s\/?#]+)@/gi, '$1://***[REDACTED]***@');

  return text;
}
export function redactDiagnostic(value: unknown, budget = 4096): string {
  let input: string;
  if (typeof value === 'string') input = value;
  else if (value instanceof Error) input = value.message;
  else {
    try { input = JSON.stringify(value) ?? 'Unknown execution error.'; }
    catch { input = 'Unserializable execution error.'; }
  }
  const home = os.homedir();
  const variants = new Set([home, home.replace(/\\/g, '/')]);
  // Serialized diagnostics can contain JSON inside JSON, doubling backslashes
  // at each boundary. Replace longer encodings first so no private prefix survives.
  for (let level = 0; level < 4; level++) {
    for (const variant of [...variants]) variants.add(JSON.stringify(variant).slice(1, -1));
  }
  let text = redactSecrets(input);
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped + '(?=$|[\\\\/\\s"\'`,;:}\\]])', process.platform === 'win32' ? 'gi' : 'g'), '~');
  }
  return truncateToByteLength(text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), budget);
}
