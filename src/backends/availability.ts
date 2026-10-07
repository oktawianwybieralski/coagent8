import fs from 'node:fs';
import path from 'node:path';
import { adapterRegistry } from './registry.js';
import { loadConfig } from '../config.js';
import { QuotaReport, QuotaCacheRecord } from './types.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock } from '../sessions/lock.js';
import { PROVIDERS, ToolError, type ProviderId } from '../conversation.js';
import { redactDiagnostic } from '../redaction.js';
import { readBoundedFileSync } from '../execution/stream.js';
import type { AdapterProbeResult } from './types.js';
type ProbeMap = Partial<Record<ProviderId, AdapterProbeResult>>;
export interface AvailabilitySelectionOptions {
  config?: { routing: { allowedBackends: ProviderId[] } };
  probesOverride?: ProbeMap;
  quotasOverride?: QuotaReport;
  /** The calling client's own CLI; chosen only when no other provider is available. */
  callerProvider?: ProviderId | null;
}
/** Headroom assumed for an unmeasured quota, so only measured headroom changes the preference order. */
const UNMEASURED_HEADROOM_PERCENT = 50;
function getQuotaCacheFile(): string { return process.env.coagent8_QUOTA_CACHE || path.join(getDataDir(), 'quota-cache.json'); }
export const QUOTA_CACHE_TTL_MS = 60000;
const BACKOFF_DELAYS_MS = [15 * 1000, 45 * 1000, 180 * 1000] as const;

function sanitizeCacheData(raw: unknown): QuotaReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const data = raw as QuotaReport;
  for (const id of Object.keys(data)) {
    if (!PROVIDERS.includes(id as typeof PROVIDERS[number])) { delete data[id]; continue; }
    const entry = data[id]; if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.installed !== 'boolean' || !['operational','uninstalled','rate_limited'].includes(entry.status)) { delete data[id]; continue; }
    if (entry.status === 'rate_limited') {
      const time = Date.parse(entry.cooldownUntil || entry.resetsAt || '');
      if (!Number.isFinite(time) || time <= Date.now()) { entry.status='operational'; entry.cooldownUntil=null; entry.resetsAt=null; entry.cooldownReason=null; }
    }
    data[id] = {
      installed: entry.installed,
      executionSupported: typeof entry.executionSupported === 'boolean' ? entry.executionSupported : undefined,
      status: entry.status,
      window: typeof entry.window === 'string' ? entry.window : 'unknown',
      usedPercent: typeof entry.usedPercent === 'number' ? entry.usedPercent : null,
      headroomPercent: typeof entry.headroomPercent === 'number' ? entry.headroomPercent : null,
      measured: Boolean(entry.measured),
      resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : null,
      cooldownUntil: entry.status === 'rate_limited' ? (entry.cooldownUntil || entry.resetsAt ? new Date(Date.parse(entry.cooldownUntil || entry.resetsAt!)).toISOString() : null) : null,
      cooldownReason: entry.status === 'rate_limited' ? redactDiagnostic(entry.cooldownReason || 'Observed rate limit (heuristic cooldown)', 512) : null,
      cooldownLevel: typeof entry.cooldownLevel === 'number' ? entry.cooldownLevel : undefined,
      lastCooldownAt: typeof entry.lastCooldownAt === 'string' ? entry.lastCooldownAt : null
    };
  }
  return data;
}
export function readQuotaCache(): QuotaCacheRecord | null {
  const file = getQuotaCacheFile();
  try { const c=JSON.parse(readBoundedFileSync(file)); if (!Number.isFinite(c.timestamp)) return null; return { timestamp:c.timestamp, data:sanitizeCacheData(c.data) }; } catch { return null; }
}
async function store(data: QuotaReport): Promise<void> { await atomicWrite(getQuotaCacheFile(), JSON.stringify({timestamp:Date.now(),data})); }
export async function writeQuotaCache(data: QuotaReport): Promise<void> { await withFileLock(getQuotaCacheFile(), () => store(data)); }
/**
 * Builds a provider quota report and writes it under the cache lock.
 * @param forceRefresh - Bypass the 60-second complete-cache reuse path.
 * @param probesOverride - Existing probes; their presence bypasses cache reuse.
 * @param options - Native quota reads default on only without supplied probes. A provider
 * filter preserves other cached entries; measuredNow distinguishes newly measured quota.
 * @returns The report, including carried-over native measurements and observed cooldowns.
 * @throws On cache write/lock failure; automatic routing currently inherits that failure.
 */
export async function inspectQuotas(forceRefresh=false, probesOverride: ProbeMap | null=null, options: { nativeQuota?: boolean; only?: readonly ProviderId[]; measuredNow?: Set<ProviderId> } = {}): Promise<QuotaReport> {
  const cache=readQuotaCache();
  if (!forceRefresh && !probesOverride && cache && Date.now()-cache.timestamp<QUOTA_CACHE_TTL_MS && PROVIDERS.every(id=>cache.data[id])) return cache.data;
  const probes=probesOverride || Object.fromEntries(await Promise.all(PROVIDERS.map(async id=>[id,await adapterRegistry[id].probe()])));
  const readNative = options.nativeQuota ?? !probesOverride;
  const native = Object.fromEntries(await Promise.all(PROVIDERS.map(async id => {
    const probe = probes[id];
    if (probe?.quota || !probe?.installed || !readNative) return [id, probe?.quota];
    return [id, await adapterRegistry[id].inspectQuota?.(probe)];
  }))) as Partial<Record<ProviderId, AdapterProbeResult['quota']>>;
  for (const id of PROVIDERS) if (native[id]?.measured) options.measuredNow?.add(id);
  return withFileLock(getQuotaCacheFile(), async()=>{
    const latest=readQuotaCache()?.data || {};
    const result: QuotaReport={};
    for (const id of PROVIDERS) {
      if (options.only && !options.only.includes(id)) {
        if (latest[id]) result[id] = latest[id];
        continue;
      }
      const probe = probes[id];
      const nativeQuota = native[id];
      const isInstalled = !!probe?.installed;
      const isRateLimited = latest[id]?.status === 'rate_limited' || (nativeQuota?.measured && nativeQuota.headroomPercent === 0);
      result[id] = {
        installed: isInstalled,
        executionSupported: probe?.executionSupported,
        status: !isInstalled ? 'uninstalled' : isRateLimited ? 'rate_limited' : 'operational',
        window: nativeQuota?.window || latest[id]?.window || 'unknown',
        usedPercent: nativeQuota?.usedPercent ?? latest[id]?.usedPercent ?? null,
        headroomPercent: isRateLimited ? 0 : (nativeQuota?.headroomPercent ?? latest[id]?.headroomPercent ?? null),
        measured: Boolean(nativeQuota?.measured || latest[id]?.measured),
        resetsAt: nativeQuota?.resetsAt || latest[id]?.resetsAt || null,
        cooldownUntil: null,
      };
      if (latest[id]?.status === 'rate_limited') {
        result[id] = { ...result[id], status: 'rate_limited', cooldownUntil: latest[id].cooldownUntil, cooldownReason: latest[id].cooldownReason, cooldownLevel: latest[id].cooldownLevel, lastCooldownAt: latest[id].lastCooldownAt };
      } else if (latest[id]?.lastCooldownAt) {
        result[id] = { ...result[id], cooldownLevel: latest[id].cooldownLevel, lastCooldownAt: latest[id].lastCooldownAt };
      }
    }
    await store(result); return result;
  });
}
export async function recordQuotaCooldown(id: string, cooldownMs?: number, reason='Observed rate limit (heuristic cooldown)'): Promise<void> {
  if (!PROVIDERS.includes(id as typeof PROVIDERS[number])) throw new Error('Invalid cooldown provider.');
  if (cooldownMs !== undefined && (!Number.isFinite(cooldownMs) || Math.abs(cooldownMs)>7*24*3600*1000)) throw new Error('Invalid cooldown duration.');
  await withFileLock(getQuotaCacheFile(), async()=>{
    const current=readQuotaCache()?.data || {};
    const existing = current[id];
    let effectiveMs: number;
    let nextLevel = 0;
    if (cooldownMs !== undefined) {
      effectiveMs = cooldownMs;
      nextLevel = typeof existing?.cooldownLevel === 'number' ? existing.cooldownLevel : 0;
    } else {
      const prevLevel = typeof existing?.cooldownLevel === 'number' ? existing.cooldownLevel : -1;
      const lastCooldownTime = existing?.lastCooldownAt
        ? Date.parse(existing.lastCooldownAt)
        : (existing?.cooldownUntil ? Date.parse(existing.cooldownUntil) : 0);
      if (prevLevel >= 0 && (Date.now() - lastCooldownTime < 15 * 60 * 1000)) {
        nextLevel = Math.min(prevLevel + 1, BACKOFF_DELAYS_MS.length - 1);
      } else {
        nextLevel = 0;
      }
      effectiveMs = BACKOFF_DELAYS_MS[nextLevel];
    }
    const nowIso = new Date().toISOString();
    const cooldownUntil = new Date(Date.now() + effectiveMs).toISOString();
    current[id] = {
      ...existing,
      installed: existing?.installed ?? true,
      status: 'rate_limited',
      window: existing?.window || 'unknown',
      usedPercent: existing?.usedPercent ?? null,
      headroomPercent: 0,
      measured: existing?.measured ?? false,
      resetsAt: cooldownUntil,
      cooldownUntil,
      cooldownReason: redactDiagnostic(reason, 512),
      cooldownLevel: nextLevel,
      lastCooldownAt: nowIso
    };
    await store(current);
  });
}
export async function resetQuotaCooldown(id: string): Promise<void> {
  if (!PROVIDERS.includes(id as typeof PROVIDERS[number])) return;
  await withFileLock(getQuotaCacheFile(), async()=>{
    const current = readQuotaCache()?.data;
    if (!current || !current[id]) return;
    const entry = current[id];
    if (entry.status === 'rate_limited') {
      const cooldownTime = entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : 0;
      if (Number.isFinite(cooldownTime) && cooldownTime > Date.now()) {
        return;
      }
    }
    if (entry.cooldownLevel !== undefined || entry.lastCooldownAt !== null) {
      current[id] = { ...entry, status: 'operational', cooldownUntil: null, cooldownReason: null, cooldownLevel: 0, lastCooldownAt: null };
      await store(current);
    }
  });
}
/**
 * Selects an installed permitted provider using cooldowns and cached headroom.
 * @param candidates - Stable tie-break order; defaults to the provider registry.
 * @param options - Configuration, probes, quota report and optional caller identity.
 * @returns An eligible different CLI when possible, otherwise the caller's own provider.
 * @throws When no provider is executable, all eligible providers have observed limits,
 * or the quota report cannot be cached.
 * @remarks Measured headroom sorts descending; unknown quota uses 50 as a ranking
 * heuristic, not account telemetry. Measurement freshness is not independently enforced.
 */
export async function selectSmartQuotaBackend(candidates: ProviderId[] | null = null, options: AvailabilitySelectionOptions = {}): Promise<ProviderId> {
  const config = options.config || loadConfig();
  const quotas = options.quotasOverride || await inspectQuotas(false, options.probesOverride);
  const installed = (candidates || PROVIDERS).filter(id =>
    config.routing.allowedBackends.includes(id) && quotas[id]?.installed &&
    quotas[id].executionSupported !== false && options.probesOverride?.[id]?.executionSupported !== false);
  if (!installed.length) throw new ToolError('CLI_NOT_FOUND', 'No active permitted CLI installed for smart_quota.');
  // A second opinion comes from another CLI than the caller's own when one is available.
  const others = installed.filter(id => id !== options.callerProvider);
  const headroom = (id: ProviderId) => quotas[id].measured && quotas[id].headroomPercent !== null ? quotas[id].headroomPercent as number : UNMEASURED_HEADROOM_PERCENT;
  for (const pool of [others, installed]) {
    // Stable sort: equal headroom keeps the provider preference order.
    const ready = pool.filter(id => quotas[id].status !== 'rate_limited').sort((a, b) => headroom(b) - headroom(a));
    if (ready.length) return ready[0];
  }
  const times = installed.map(id => quotas[id].cooldownUntil || quotas[id].resetsAt).filter(Boolean).sort();
  throw new ToolError('RATE_LIMITED', 'All permitted providers have observed rate limits.' + (times.length ? ' Earliest recovery cooldown resets at: ' + times[0] : ''));
}
