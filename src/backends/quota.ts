/** Provider-neutral summary of native usage windows. @packageDocumentation */
import type { AdapterProbeResult } from '../types/adapter.types.js';

/** Measured native quota, as stored in probe results and the quota cache. */
export type NativeQuota = NonNullable<AdapterProbeResult['quota']>;

/** One provider usage window, such as a five-hour session or a weekly limit. */
export interface QuotaWindow {
  id: string;
  name: string;
  /** Window label, e.g. `5h` or `weekly`. */
  window: string;
  /** Remaining share of the window, 0 to 1. */
  remainingFraction: number;
  /** ISO 8601 reset time, or an empty string when unknown. */
  resetTime: string;
}

/**
 * Summarizes usage windows by their bottleneck: the window with the least headroom.
 * @param windows - Windows measured by one provider.
 * @returns The measured quota, or `undefined` when no window was measured.
 */
export function summarizeQuotaWindows(windows: readonly QuotaWindow[]): NativeQuota | undefined {
  const buckets = windows.filter(window => Number.isFinite(window.remainingFraction));
  if (!buckets.length) return undefined;
  const bottleneck = buckets.reduce((min, window) => window.remainingFraction < min.remainingFraction ? window : min);
  const headroomPercent = Math.max(0, Math.min(100, Math.round(bottleneck.remainingFraction * 100)));
  return { measured: true, headroomPercent, usedPercent: 100 - headroomPercent, resetsAt: bottleneck.resetTime || null,
    window: bottleneck.window, buckets: buckets.map(window => ({ ...window })) };
}
