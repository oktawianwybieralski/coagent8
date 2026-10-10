import fs from 'node:fs';
import path from 'node:path';
import { adapterRegistry } from './registry.js';
import { probeBackend } from './probe-cache.js';
import { loadConfig } from '../config.js';
import { QuotaReport, QuotaCacheRecord } from './types.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock } from '../storage/lock.js';
import { PROVIDERS, ToolError, type ProviderId, type BackendReadContext } from '../contracts/index.js';
import { redactDiagnostic } from '../security/redaction.js';
import { readBoundedFileSync } from '../storage/read.js';
import type { AdapterProbeResult } from './types.js';
type ProbeMap = Partial<Record<ProviderId, AdapterProbeResult>>;
export interface AvailabilitySelectionOptions {
  config?: { routing: { allowedBackends: ProviderId[] } };
  probesOverride?: ProbeMap;
  quotasOverride?: QuotaReport;
  /** The calling client's own CLI; chosen only when no other provider is available. */
  callerProvider?: ProviderId | null;
  /** Receives a bounded warning when the quota cache cannot be updated; selection continues. */
  warnings?: string[];
  /** Optional cancellation and timeout context (`EXEC-001-T08f`). */
  context?: BackendReadContext;
}
export interface InspectQuotasOptions {
  nativeQuota?: boolean;
  only?: readonly ProviderId[];
  measuredNow?: Set<ProviderId>;
  onCacheError?: (error: Error) => void;
  /** Optional cancellation and timeout context (`EXEC-001-T08f`). */
  context?: BackendReadContext;
}
/** Headroom assumed for an unmeasured quota, so only measured headroom changes the preference order. */
const UNMEASURED_HEADROOM_PERCENT = 50;
function getQuotaCacheFile(): string { return process.env.coagent8_QUOTA_CACHE || path.join(getDataDir(), 'quota-cache.json'); }
export const QUOTA_CACHE_TTL_MS = 60000;
/** A native quota measurement older than this ranks like an unmeasured one (CUR-004). */
export const QUOTA_MEASUREMENT_MAX_AGE_MS = 15 * 60 * 1000;
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
    // A measurement without a recent measuredAt (including entries written before it existed)
    // is dropped, so a cache rewrite never keeps old headroom at full weight.
    const measuredTime = Date.parse(typeof entry.measuredAt === 'string' ? entry.measuredAt : '');
    const age = Date.now() - measuredTime;
    const fresh = Boolean(entry.measured) && Number.isFinite(measuredTime) && age < QUOTA_MEASUREMENT_MAX_AGE_MS && age > -QUOTA_CACHE_TTL_MS;
    const limited = entry.status === 'rate_limited';
    data[id] = {
      installed: entry.installed,
      executionSupported: typeof entry.executionSupported === 'boolean' ? entry.executionSupported : undefined,
      status: entry.status,
      window: fresh && typeof entry.window === 'string' ? entry.window : 'unknown',
      usedPercent: fresh && typeof entry.usedPercent === 'number' ? entry.usedPercent : null,
      headroomPercent: limited ? 0 : fresh && typeof entry.headroomPercent === 'number' ? entry.headroomPercent : null,
      measured: fresh,
      measuredAt: fresh ? new Date(measuredTime).toISOString() : null,
      resetsAt: (fresh || limited) && typeof entry.resetsAt === 'string' ? entry.resetsAt : null,
      cooldownUntil: entry.status === 'rate_limited' ? (entry.cooldownUntil || entry.resetsAt ? new Date(Date.parse(entry.cooldownUntil || entry.resetsAt!)).toISOString() : null) : null,
      cooldownReason: entry.status === 'rate_limited' ? redactDiagnostic(entry.cooldownReason || 'Observed rate limit (heuristic cooldown)', 512) : null,
      cooldownLevel: typeof entry.cooldownLevel === 'number' ? entry.cooldownLevel : undefined,
      lastCooldownAt: typeof entry.lastCooldownAt === 'string' ? entry.lastCooldownAt : null
    };
  }
  return data;
}
/**
 * Outcome of reading the quota cache file (`AUDIT-001-A02`). Invalid content (malformed JSON,
 * a missing timestamp or oversized data) holds no recoverable state; an I/O failure may hide
 * a valid file and therefore must not be treated as empty by a writer.
 */
type QuotaCacheRead =
  | { kind: 'missing' }
  | { kind: 'valid'; record: QuotaCacheRecord }
  | { kind: 'invalid' }
  | { kind: 'unreadable'; error: Error };
function readQuotaCacheClassified(): QuotaCacheRead {
  let text: string;
  try { text = readBoundedFileSync(getQuotaCacheFile()); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'BUFFER_LIMIT') return { kind: 'invalid' };
    const failure = new Error(`Quota cache could not be read (${code || 'unknown error'}); it was left unchanged.`, { cause: error });
    return { kind: 'unreadable', error: Object.assign(failure, { code }) };
  }
  try {
    const c = JSON.parse(text);
    if (!Number.isFinite(c?.timestamp)) return { kind: 'invalid' };
    return { kind: 'valid', record: { timestamp: c.timestamp, data: sanitizeCacheData(c.data) } };
  } catch { return { kind: 'invalid' }; }
}
/** Best-effort read: null when the cache is missing, invalid or unreadable. */
export function readQuotaCache(): QuotaCacheRecord | null {
  const read = readQuotaCacheClassified();
  return read.kind === 'valid' ? read.record : null;
}
/**
 * State a locked writer merges into. Missing or invalid content starts empty; a read failure
 * of an existing file throws before any write, so other providers' entries survive.
 */
function readQuotaCacheForUpdate(): QuotaReport {
  const read = readQuotaCacheClassified();
  if (read.kind === 'unreadable') throw read.error;
  return read.kind === 'valid' ? read.record.data : {};
}
async function store(data: QuotaReport): Promise<void> { await atomicWrite(getQuotaCacheFile(), JSON.stringify({timestamp:Date.now(),data})); }
export async function writeQuotaCache(data: QuotaReport): Promise<void> { await withFileLock(getQuotaCacheFile(), () => store(data)); }
/**
 * Builds a provider quota report and writes it under the cache lock.
 * @param forceRefresh - Bypass the 60-second complete-cache reuse path.
 * @param probesOverride - Existing probes; their presence bypasses cache reuse.
 * @param options - Native quota reads default on only without supplied probes. A provider
 * filter preserves other cached entries; measuredNow distinguishes newly measured quota.
 * `onCacheError` makes the cache optional: a lock/read/write failure is reported to it and
 * the report is built from an unlocked read instead, without writing. An existing cache that
 * cannot be read is never replaced by a partial report.
 * @returns The report, including fresh carried-over native measurements and observed cooldowns.
 * @throws On cache lock/read/write failure when no `onCacheError` is given.
 */
export async function inspectQuotas(forceRefresh=false, probesOverride: ProbeMap | null=null, options: InspectQuotasOptions = {}): Promise<QuotaReport> {
  if (options.context?.abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Quota inspection aborted by caller.');
  }
  if (options.context?.budget && (options.context.budget.isExecutionExpired() || options.context.budget.isTimedOut())) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before quota inspection.');
  }
  const cache=readQuotaCache();
  if (!forceRefresh && !probesOverride && cache && Date.now()-cache.timestamp<QUOTA_CACHE_TTL_MS && PROVIDERS.every(id=>cache.data[id])) return cache.data;
  const probes=probesOverride || Object.fromEntries(await Promise.all(PROVIDERS.map(async id=>[id,await probeBackend(id, { fresh: forceRefresh, context: options.context })])));
  const readNative = options.nativeQuota ?? !probesOverride;
  const native = Object.fromEntries(await Promise.all(PROVIDERS.map(async id => {
    const probe = probes[id];
    if (probe?.quota || !probe?.installed || !readNative) return [id, probe?.quota];
    return [id, await adapterRegistry[id].inspectQuota?.(probe, options.context)];
  }))) as Partial<Record<ProviderId, AdapterProbeResult['quota']>>;
  for (const id of PROVIDERS) if (native[id]?.measured) options.measuredNow?.add(id);
  if (options.context?.abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Quota inspection aborted.');
  }
  if (options.context?.budget && (options.context.budget.isExecutionExpired() || options.context.budget.isTimedOut())) {
    throw new ToolError('TIMEOUT', 'Execution budget expired during quota inspection.');
  }
  const measuredAt = new Date().toISOString();
  const merge = (latest: QuotaReport): QuotaReport => {
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
        measuredAt: nativeQuota?.measured ? measuredAt : latest[id]?.measuredAt ?? null,
        resetsAt: nativeQuota?.resetsAt || latest[id]?.resetsAt || null,
        cooldownUntil: null,
      };
      if (latest[id]?.status === 'rate_limited') {
        result[id] = { ...result[id], status: 'rate_limited', cooldownUntil: latest[id].cooldownUntil, cooldownReason: latest[id].cooldownReason, cooldownLevel: latest[id].cooldownLevel, lastCooldownAt: latest[id].lastCooldownAt };
      } else if (latest[id]?.lastCooldownAt) {
        result[id] = { ...result[id], cooldownLevel: latest[id].cooldownLevel, lastCooldownAt: latest[id].lastCooldownAt };
      }
    }
    return result;
  };
  try {
    return await withFileLock(getQuotaCacheFile(), async()=>{
      const result = merge(readQuotaCacheForUpdate());
      await store(result); return result;
    });
  } catch (error) {
    if (!options.onCacheError) throw error;
    options.onCacheError(error instanceof Error ? error : new Error(String(error)));
    return merge(readQuotaCache()?.data || {});
  }
}
export async function recordQuotaCooldown(id: string, cooldownMs?: number, reason='Observed rate limit (heuristic cooldown)'): Promise<void> {
  if (!PROVIDERS.includes(id as typeof PROVIDERS[number])) throw new Error('Invalid cooldown provider.');
  if (cooldownMs !== undefined && (!Number.isFinite(cooldownMs) || Math.abs(cooldownMs)>7*24*3600*1000)) throw new Error('Invalid cooldown duration.');
  await withFileLock(getQuotaCacheFile(), async()=>{
    const current=readQuotaCacheForUpdate();
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
    const current = readQuotaCacheForUpdate();
    if (!current[id]) return;
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
 * @throws When no provider is executable or all eligible providers have observed limits.
 * A quota cache that cannot be updated adds a warning to `options.warnings` instead.
 * @remarks Measured headroom sorts descending; unknown quota uses 50 as a ranking
 * heuristic, not account telemetry. A measurement older than
 * {@link QUOTA_MEASUREMENT_MAX_AGE_MS} counts as unknown.
 */
export async function selectSmartQuotaBackend(candidates: ProviderId[] | null = null, options: AvailabilitySelectionOptions = {}): Promise<ProviderId> {
  const config = options.config || loadConfig();
  const onCacheError = (error: Error) => options.warnings?.push(`Quota cache not updated; routing used the last readable data: ${redactDiagnostic(error.message, 512)}`);
  const quotas = options.quotasOverride || await inspectQuotas(false, options.probesOverride, { onCacheError, context: options.context });
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
