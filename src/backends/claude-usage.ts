/** Parses the subscription limits printed by `claude -p /usage`. @packageDocumentation */
import { summarizeQuotaWindows, type NativeQuota, type QuotaWindow } from './quota.js';

/**
 * One limit line, e.g. `Current session: 67% used · resets Oct 5, 11:49pm (Europe/Warsaw)`
 * or `Current week (all models): 9% used · resets Oct 6, 3:59pm (Europe/Warsaw)`
 * (observed with Claude Code 2.1.289).
 */
const LIMIT_LINE = /^Current (session|week)(?: \(([^)\n]+)\))?: (\d{1,3})% used(?: · resets ([^(\n]+?) \(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?[ \t]*$/gm;
const RESET_TIME = /^(?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?(am|pm)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Week scopes that limit every model; model-specific weekly limits do not block the backend. */
const GENERAL_WEEK_SCOPES = new Set(['', 'all models']);

function zonedParts(epochMs: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(epochMs));
  return ['year', 'month', 'day', 'hour', 'minute'].map(type => Number(parts.find(part => part.type === type)?.value));
}
/** Converts a wall-clock time in an IANA time zone to epoch milliseconds. */
function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let epoch = wall;
  for (let i = 0; i < 2; i++) {
    const [y, mo, d, h, mi] = zonedParts(epoch, timeZone);
    epoch += wall - Date.UTC(y, mo - 1, d, h, mi);
  }
  return epoch;
}

/**
 * Resolves a `/usage` reset label to an ISO time.
 * @param label - `Oct 5, 11:49pm` or `11:49pm`; the CLI omits the year and, for today, the date.
 * @param timeZone - IANA zone printed by the CLI.
 * @param now - Reference time in epoch milliseconds.
 * @returns The next matching reset as ISO 8601, or `null` when the label or zone is not recognized.
 */
export function resolveUsageReset(label: string, timeZone: string, now = Date.now()): string | null {
  const match = RESET_TIME.exec(label.trim());
  if (!match) return null;
  try {
    const [year, month, day] = zonedParts(now, timeZone);
    const hour = (Number(match[3]) % 12) + (match[5].toLowerCase() === 'pm' ? 12 : 0);
    const minute = Number(match[4] ?? 0);
    if (hour > 23 || minute > 59) return null;
    if (match[1]) {
      const monthIndex = MONTHS.indexOf(match[1].toLowerCase());
      if (monthIndex < 0) return null;
      let epoch = zonedToEpoch(year, monthIndex, Number(match[2]), hour, minute, timeZone);
      // A reset label is never far in the past; one that is belongs to next year.
      if (epoch < now - 24 * 3600 * 1000) epoch = zonedToEpoch(year + 1, monthIndex, Number(match[2]), hour, minute, timeZone);
      return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
    }
    let epoch = zonedToEpoch(year, month - 1, day, hour, minute, timeZone);
    if (epoch < now) epoch = zonedToEpoch(year, month - 1, day + 1, hour, minute, timeZone);
    return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
  } catch {
    // Intl rejects an unknown time zone; the reset stays unknown rather than guessed.
    return null;
  }
}

/**
 * Extracts the session and general weekly limits from `/usage` text.
 * @param text - The `result` text of `claude -p /usage`.
 * @param now - Reference time for reset labels without a year.
 * @returns The bottleneck quota, or `undefined` when no limit line is present (for example API-key billing).
 */
export function parseClaudeUsage(text: string, now = Date.now()): NativeQuota | undefined {
  const windows: QuotaWindow[] = [];
  for (const match of text.matchAll(LIMIT_LINE)) {
    const [line, kind, scope = '', used, resetLabel, timeZone] = match;
    if (kind === 'week' && !GENERAL_WEEK_SCOPES.has(scope.toLowerCase())) continue;
    const usedPercent = Number(used);
    if (usedPercent > 100) continue;
    windows.push({ id: kind === 'session' ? 'session' : 'week', name: line.split(':')[0], window: kind === 'session' ? 'session' : 'weekly',
      remainingFraction: (100 - usedPercent) / 100, resetTime: resetLabel && timeZone ? resolveUsageReset(resetLabel, timeZone, now) ?? '' : '' });
  }
  return summarizeQuotaWindows(windows);
}
