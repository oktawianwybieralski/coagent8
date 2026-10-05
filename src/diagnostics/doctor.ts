import { adapterRegistry } from '../backends/registry.js';
import { loadConfig } from '../config.js';
import { PROVIDERS } from '../types/conversation.types.js';
import { inspectQuotas } from '../backends/availability.js';
import type { AdapterProbeResult, ProviderId } from '../types/adapter.types.js';
import type { QuotaReport } from '../types/quota.types.js';

export interface DoctorReport {
  status: string;
  active_backends: ProviderId[];
  default_backend: string;
  configuredDefault: string | null;
  effectiveDefault: string | null;
  security_policy: { zero_silent_downloads: true; read_only_sandbox_guard: true; governed_models_require_confirmation: string[] };
  backends: Record<ProviderId, AdapterProbeResult>;
  quotas: QuotaReport;
  recommendations: string[];
  installed_backends: ProviderId[];
  ready_backends: ProviderId[];
}

export async function runDoctor(): Promise<DoctorReport> {
  const config = loadConfig();
  const backends = Object.fromEntries(await Promise.all(PROVIDERS.map(async id => [id, await adapterRegistry[id].probe()]))) as Record<ProviderId, AdapterProbeResult>;
  const quotas = await inspectQuotas(true, backends, { nativeQuota: true });

  const active = PROVIDERS.filter(id => backends[id].installed && config.routing.allowedBackends.includes(id));
  const ready = active.filter(id => {
    const b = backends[id];
    const q = quotas[id];
    const isExecutionReady = Boolean(b.executionSupported && b.capabilities?.readOnlyVerified && b.authStatus === 'authenticated');
    const isQuotaReady = q ? q.status !== 'rate_limited' && (q.headroomPercent === null || q.headroomPercent > 0) : true;
    return isExecutionReady && isQuotaReady;
  });

  const effective = config.routing.strategy === 'smart_quota' ? 'smart_quota' : config.defaultBackend || (active.length === 1 ? active[0] : null);

  const recommendations = PROVIDERS.flatMap(id => {
    if (!backends[id].installed) {
      return [`${id} CLI missing; install it explicitly and authenticate with the provider.`];
    }
    const q = quotas[id];
    if (q?.status === 'rate_limited' || (q?.headroomPercent !== null && q?.headroomPercent === 0)) {
      const resetTime = q.cooldownUntil || q.resetsAt;
      return [`${id}: usage limit reached or rate limited${resetTime ? ` (resets at ${resetTime})` : ''}; request will be routed to other providers.`];
    }
    if (!ready.includes(id)) {
      if (backends[id].authStatus === 'unauthenticated') {
        return [`${id}: unauthenticated; run '${backends[id].loginHint || id}' to sign in.`];
      }
      return [`${id}: installation detected; authentication/execution/read-only readiness has not been fully verified.`];
    }
    return [];
  });

  return {
    status: !active.length ? 'degraded_no_active_backends' : recommendations.length ? 'partially_configured' : 'operational',
    active_backends: active,
    installed_backends: PROVIDERS.filter(id => backends[id].installed),
    ready_backends: ready,
    configuredDefault: config.defaultBackend,
    effectiveDefault: effective,
    default_backend: effective || 'none',
    backends,
    quotas,
    recommendations,
    security_policy: {
      zero_silent_downloads: true,
      read_only_sandbox_guard: true,
      governed_models_require_confirmation: ['astra family', 'opus family'],
    },
  };
}
