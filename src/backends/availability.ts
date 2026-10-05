import { isRateLimitError, parseResetTimestamp } from './rate-limit.js';
export { isRateLimitError, parseResetTimestamp } from './rate-limit.js';
import fs from 'node:fs';
import path from 'node:path';
import { adapterRegistry } from './registry.js';
import { loadConfig } from '../config.js';
import { QuotaReport, QuotaCacheRecord } from '../types/quota.types.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock } from '../sessions/lock.js';
import { PROVIDERS } from '../types/conversation.types.js';
import { redactDiagnostic } from '../redaction.js';
import { readBoundedFileSync } from '../execution/stream.js';
import type { AdapterProbeResult, ProviderId } from '../types/adapter.types.js';
type ProbeMap = Partial<Record<ProviderId, AdapterProbeResult>>;
export interface AvailabilitySelectionOptions {
  config?: { routing: { allowedBackends: ProviderId[] } };
  probesOverride?: ProbeMap;
  quotasOverride?: QuotaReport;
}
export function getQuotaCacheFile(): string { return process.env.coagent8_QUOTA_CACHE || path.join(getDataDir(), 'quota-cache.json'); }
export const QUOTA_CACHE_TTL_MS = 60000;
export const BACKOFF_DELAYS_MS = [15 * 1000, 45 * 1000, 180 * 1000] as const;

export function sanitizeCacheData(raw: unknown): QuotaReport {
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
 * Inspects installation, native measured quota (when available), and observed cooldowns.
 * @param forceRefresh - Bypass the cache, which is otherwise reused for {@link QUOTA_CACHE_TTL_MS}.
 * @param probesOverride - Probe results already gathered by the caller.
 * @param options - `nativeQuota` reads quota through each adapter's `inspectQuota` when its probe has none;
 * it defaults to true only when this function runs the probes itself.
 * @returns The quota report, also written to the cache.
 */
export async function inspectQuotas(forceRefresh=false, probesOverride: ProbeMap | null=null, options: { nativeQuota?: boolean } = {}): Promise<QuotaReport> {
  const cache=readQuotaCache();
  if (!forceRefresh && !probesOverride && cache && Date.now()-cache.timestamp<QUOTA_CACHE_TTL_MS && PROVIDERS.every(id=>cache.data[id])) return cache.data;
  const probes=probesOverride || Object.fromEntries(await Promise.all(PROVIDERS.map(async id=>[id,await adapterRegistry[id].probe()])));
  const readNative = options.nativeQuota ?? !probesOverride;
  const native = Object.fromEntries(await Promise.all(PROVIDERS.map(async id => {
    const probe = probes[id];
    if (probe?.quota || !probe?.installed || !readNative) return [id, probe?.quota];
    return [id, await adapterRegistry[id].inspectQuota?.(probe)];
  }))) as Partial<Record<ProviderId, AdapterProbeResult['quota']>>;
  return withFileLock(getQuotaCacheFile(), async()=>{
    const latest=readQuotaCache()?.data || {};
    const result: QuotaReport={};
    for (const id of PROVIDERS) {
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
export async function checkAndRecordRateLimit(id:string, output?:string|null):Promise<boolean> {
  if(!isRateLimitError(output)) return false;
  const parsed = output ? parseResetTimestamp(output) : null;
  const cooldownMs = parsed?.cooldownMs;
  const reason = output ? redactDiagnostic(output.slice(0, 200), 512) : 'Observed rate limit (heuristic cooldown)';
  await recordQuotaCooldown(id, cooldownMs, reason);
  return true;
}
/**
 * Selects the first permitted executable provider without an observed cooldown.
 * @param candidates - Stable preference order; defaults to the concrete registry order.
 * @param options - Configuration and observed probe/cache records, optionally supplied by routing.
 * @returns A permitted installed provider with supported execution and no active cooldown.
 * @throws When no provider is executable or all candidates have observed rate limits.
 * @remarks
 * `smart_quota` remains the configuration/MCP compatibility name. Selection now
 * uses observed availability and cooldowns; synthetic account percentages do not
 * change ranking. Existing caches retain null percentages and measured=false.
 */
export async function selectSmartQuotaBackend(candidates: ProviderId[] | null = null, options: AvailabilitySelectionOptions = {}): Promise<ProviderId> {
  const config = options.config || loadConfig();
  const quotas = options.quotasOverride || await inspectQuotas(false, options.probesOverride);
  const installed = (candidates || PROVIDERS).filter(id =>
    config.routing.allowedBackends.includes(id) && quotas[id]?.installed &&
    quotas[id].executionSupported !== false && options.probesOverride?.[id]?.executionSupported !== false);
  if (!installed.length) throw new Error('No active permitted CLI installed for smart_quota.');
  const ready = installed.find(id => quotas[id].status !== 'rate_limited');
  if (ready) return ready;
  const times = installed.map(id => quotas[id].cooldownUntil || quotas[id].resetsAt).filter(Boolean).sort();
  throw new Error('All permitted providers have observed rate limits.' + (times.length ? ' Earliest recovery cooldown resets at: ' + times[0] : ''));
}
