import { probeBackend, readModelCatalog } from '../backends/probe-cache.js';
import { loadConfigForDiagnostics } from '../config.js';
import { PROVIDERS, type ProviderId } from '../conversation.js';
import { inspectQuotas } from '../backends/availability.js';
import { summarizeModels } from '../backends/model-catalog.js';
import type { AdapterProbeResult, BackendQuota, CatalogModel } from '../backends/types.js';

/** Native per-window quota details reused by the exported doctor report. */
export type ProbeQuotaBuckets = NonNullable<AdapterProbeResult['quota']>['buckets'];

/** Quota of one provider; `buckets` carries the per-window detail some probes report. */
export type DoctorQuota = BackendQuota & { buckets?: ProbeQuotaBuckets };

export interface DoctorReport {
  status: string;
  active_backends: ProviderId[];
  default_backend: string;
  configuredDefault: string | null;
  effectiveDefault: string | null;
  /**
   * Probe results without `quota`, which `quotas` reports once, and with `models`: the
   * models and efforts the CLI itself offers, when it lists them.
   */
  backends: Partial<Record<ProviderId, Omit<AdapterProbeResult, 'quota'> & { models?: CatalogModel[] }>>;
  quotas: Partial<Record<ProviderId, DoctorQuota>>;
  recommendations: string[];
  installed_backends: ProviderId[];
  ready_backends: ProviderId[];
  /** Why the configuration file is unusable; the report then shows the defaults and execution is refused. */
  configError?: string;
}

export interface DoctorOptions {
  /** Diagnose one provider only; the others are neither probed nor reported. */
  backend?: ProviderId;
  /** `false` skips native quota reads that are not part of a probe. */
  quota?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const { config, error: configError } = loadConfigForDiagnostics();
  const selected: readonly ProviderId[] = options.backend ? [options.backend] : PROVIDERS;
  const probes = Object.fromEntries(await Promise.all(selected.map(async id => [id, await probeBackend(id, { fresh: true })]))) as Partial<Record<ProviderId, AdapterProbeResult>>;
  const measuredNow = new Set<ProviderId>();
  const [cached, catalogs] = await Promise.all([
    inspectQuotas(true, probes, { nativeQuota: options.quota !== false, only: selected, measuredNow }),
    Promise.all(selected.map(id => readModelCatalog(id, { fresh: true }))),
  ]);

  const active = selected.filter(id => probes[id]!.installed && config.routing.allowedBackends.includes(id));
  const ready = active.filter(id => {
    const b = probes[id]!;
    const q = cached[id];
    // A quota the CLI measured in this run (agy and Claude `/usage`) also proves a signed-in CLI.
    const isExecutionReady = Boolean(b.executionSupported && b.capabilities?.readOnlyVerified && (b.authStatus === 'authenticated' || measuredNow.has(id)));
    const isQuotaReady = q ? q.status !== 'rate_limited' && (q.headroomPercent === null || q.headroomPercent > 0) : true;
    return isExecutionReady && isQuotaReady;
  });

  const effective = config.routing.strategy === 'smart_quota' ? 'smart_quota' : config.defaultBackend || (active.length === 1 ? active[0] : null);

  const recommendations = selected.flatMap(id => {
    const probe = probes[id]!;
    if (!probe.installed) {
      return [`${id} CLI missing; install it explicitly and authenticate with the provider.`];
    }
    const q = cached[id];
    if (q?.status === 'rate_limited' || (q?.headroomPercent !== null && q?.headroomPercent === 0)) {
      const resetTime = q.cooldownUntil || q.resetsAt;
      return [`${id}: usage limit reached or rate limited${resetTime ? ` (resets at ${resetTime})` : ''}; request will be routed to other providers.`];
    }
    if (!ready.includes(id)) {
      if (probe.authStatus === 'unauthenticated') {
        return [`${id}: unauthenticated; run '${probe.loginHint || id}' to sign in.`];
      }
      return [`${id}: installation detected; authentication/execution/read-only readiness has not been fully verified.`];
    }
    return [];
  });

  const backends: DoctorReport['backends'] = {};
  const quotas: DoctorReport['quotas'] = {};
  for (const id of selected) {
    const { quota, ...probe } = probes[id]!;
    const catalog = catalogs[selected.indexOf(id)];
    backends[id] = catalog ? { ...probe, models: catalog.models, modelSource: catalog.source } : probe;
    if (cached[id]) quotas[id] = quota?.buckets ? { ...cached[id], buckets: quota.buckets } : cached[id];
  }

  return {
    status: configError ? 'configuration_error' : !active.length ? 'degraded_no_active_backends' : recommendations.length ? 'partially_configured' : 'operational',
    active_backends: active,
    installed_backends: selected.filter(id => probes[id]!.installed),
    ready_backends: ready,
    configuredDefault: config.defaultBackend,
    effectiveDefault: effective,
    default_backend: effective || 'auto',
    backends,
    quotas,
    recommendations: configError ? [configError, ...recommendations] : recommendations,
    ...(configError ? { configError } : {}),
  };
}

function formatQuota(quota: DoctorQuota | undefined): string {
  if (!quota) return 'quota unknown';
  if (quota.status === 'rate_limited') return `rate limited${quota.cooldownUntil || quota.resetsAt ? ` until ${quota.cooldownUntil || quota.resetsAt}` : ''}`;
  if (!quota.measured || quota.headroomPercent === null) return 'quota not measured';
  return `${quota.window} ${quota.headroomPercent}% left${quota.resetsAt ? `, resets ${quota.resetsAt}` : ''}`;
}

/**
 * Renders a doctor report as a few lines: overall status, one line per backend and the recommendations.
 * @remarks The tool applies a 4,096-byte diagnostic bound to this summary. Catalog size
 * can grow, so this formatter alone does not guarantee an inline host result.
 */
export function formatDoctorSummary(report: DoctorReport): string {
  const lines = [`CoAgent8 doctor: ${report.status} · default backend: ${report.default_backend}`];
  for (const id of Object.keys(report.backends) as ProviderId[]) {
    const probe = report.backends[id]!;
    if (!probe.installed) { lines.push(`${id}: not installed`); continue; }
    const state = report.ready_backends.includes(id) ? 'ready' : !report.active_backends.includes(id) ? 'not allowed' : probe.authStatus === 'unauthenticated' ? 'signed out' : 'not ready';
    const model = probe.config && typeof (probe.config as { defaultModel?: unknown }).defaultModel === 'string' ? ` · model ${(probe.config as { defaultModel: string }).defaultModel}` : '';
    lines.push(`${id}: ${state} · ${probe.version || 'unknown version'}${model} · ${formatQuota(report.quotas[id])}`);
    // The discovery step before an explicit model: what the CLI offers, or the aliases it takes.
    if (probe.models?.length) lines.push(`  models: ${summarizeModels(probe.models)}`);
    else if (probe.availableModels?.length) lines.push(`  models: ${probe.availableModels.join(', ')}, or a full model id`);
  }
  if (report.recommendations.length) lines.push(...report.recommendations.map(text => `- ${text}`));
  return lines.join('\n');
}
