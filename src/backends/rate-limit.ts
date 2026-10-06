export function isRateLimitError(text?: string | null): boolean {
  if (!text || typeof text !== 'string') return false;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Partial output:') || trimmed.startsWith('Partial review:')) {
      break; // Stop parsing before generated model responses
    }

    if (/["'](?:status|code|statusCode)["']\s*:\s*(?:429(?!\d)|["']rate_limit_exceeded["'])/i.test(trimmed)) {
      return true;
    }

    if (/\b(?:http\s*status\s*[:=]?\s*|status\s*(?:code)?\s*[:=]?\s*|api\s*error\s*[:=]?\s*|http[\s/]+(?:1\.[01]|2(?:\.0)?)?\s*)429(?!\.[a-zA-Z0-9])(?:\s|$|[:,\r\n"]|too\s+many\s+requests)/i.test(trimmed)) {
      return true;
    }

    if (/\b429\s+too\s+many\s+requests\b/i.test(trimmed)) {
      return true;
    }

    if (/\b(?:rate[\s_-]?limit\s*(?:exceeded|reached)|usage\s*limit\s*(?:exceeded|reached)?|hit\s*(?:your\s*)?usage\s*limit|spend\s*cap)\b/i.test(trimmed)) {
      return true;
    }
    if (/\b(?:exceeded\s*your\s*(?:current\s*)?quota|insufficient_quota)\b/i.test(trimmed)) {
      return true;
    }
    if (/\b(?:credit\s*balance\s*is\s*too\s*low|organization\s*has\s*run\s*out\s*of\s*credits)\b/i.test(trimmed)) {
      return true;
    }
    if (/\brate_limit_error\b/i.test(trimmed)) {
      return true;
    }
  }

  return false;
}

export interface ParsedResetTime {
  resetDate: Date;
  cooldownMs: number;
}

export function parseResetTimestamp(text?: string | null): ParsedResetTime | null {
  if (!text || typeof text !== 'string') return null;

  const MAX_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

  // Exact timestamp matches: "try again at <timestamp>", "resets at <timestamp>"
  const dateMatch = /(?:try again at|resets? at)\s+([^\r\n]+?)(?:\.\s|\.\n|\.$|\r|\n|$)/i.exec(text);
  if (dateMatch) {
    const rawDate = dateMatch[1].trim().replace(/\.$/, '').replace(/(\d+)(st|nd|rd|th)/gi, '$1');
    const parsedMs = Date.parse(rawDate);
    if (Number.isFinite(parsedMs)) {
      const now = Date.now();
      const diffMs = parsedMs - now;
      if (diffMs > 0) {
        const effectiveMs = Math.min(diffMs, MAX_COOLDOWN_MS);
        return { resetDate: new Date(parsedMs), cooldownMs: effectiveMs };
      }
    }
  }

  // Relative duration matches: "try again in 3 hours, 14 minutes"
  const relativeMatch = /try again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)[,\s]*)+)/i.exec(text);
  if (relativeMatch) {
    const durationStr = relativeMatch[1];
    let totalMs = 0;
    const partRegex = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
    let m: RegExpExecArray | null;
    while ((m = partRegex.exec(durationStr)) !== null) {
      const val = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      if (unit.startsWith('d')) totalMs += val * 24 * 3600 * 1000;
      else if (unit.startsWith('h')) totalMs += val * 3600 * 1000;
      else if (unit.startsWith('m')) totalMs += val * 60 * 1000;
      else if (unit.startsWith('s')) totalMs += val * 1000;
    }
    if (totalMs > 0) {
      const effectiveMs = Math.min(totalMs, MAX_COOLDOWN_MS);
      return { resetDate: new Date(Date.now() + effectiveMs), cooldownMs: effectiveMs };
    }
  }

  return null;
}
