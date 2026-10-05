import { adapterRegistry } from './registry.js';
import { loadConfig } from '../config.js';
import { selectSmartQuotaBackend } from './availability.js';
import type { AdapterProbeResult, CliAdapter, ProviderId } from '../types/adapter.types.js';
import { PROVIDERS } from '../types/conversation.types.js';
export interface ResolvedBackend { id: ProviderId; adapter: CliAdapter; probe: AdapterProbeResult; isSmartQuota?: boolean }
export async function resolveBackend(requested?: string | null): Promise<ResolvedBackend> {
  const config = loadConfig(), allowed = config.routing.allowedBackends;
  const raw = requested || 'auto';
  let target = raw === 'auto' ? (config.routing.strategy === 'smart_quota' ? 'smart_quota' : config.defaultBackend) : raw;
  const candidates = PROVIDERS.filter(id => allowed.includes(id));
  const probes = new Map<ProviderId, AdapterProbeResult>();
  async function selected(id: ProviderId, smart = false): Promise<ResolvedBackend> {
    if (!candidates.includes(id)) throw new Error(`POLICY_DENIED: Provider '${id}' is disabled by routing.allowedBackends.`);
    const probe = probes.get(id) || await adapterRegistry[id].probe();
    if (!probe.installed) throw new Error(`CLI_NOT_FOUND: Provider '${id}' is not installed; run doctor.`);
    if (probe.executionSupported === false) throw new Error(`CLI_UNSUPPORTED: Provider '${id}' version/profile is unsupported; run doctor.`);
    return { id, adapter: adapterRegistry[id], probe, isSmartQuota: smart };
  }
  if (target && PROVIDERS.includes(target as ProviderId)) return selected(target as ProviderId);
  if (target && target !== 'smart_quota') throw new Error(`Invalid routing target '${target}'.`);
  const results = await Promise.all(candidates.map(async id => [id, await adapterRegistry[id].probe()] as const));
  for (const [id, probe] of results) probes.set(id, probe);
  const installed = candidates.filter(id => probes.get(id)?.installed && probes.get(id)?.executionSupported !== false);
  if (!installed.length) throw new Error(candidates.some(id=>probes.get(id)?.installed) ? 'CLI_UNSUPPORTED: No installed permitted CLI supports execution; run doctor.' : 'CLI_NOT_FOUND: No permitted CLI installed; run doctor.');
  if (target === 'smart_quota') {
    const id = await selectSmartQuotaBackend(installed, { probesOverride: Object.fromEntries(probes), config });
    return selected(id as ProviderId, true);
  }
  if (installed.length > 1) throw new Error(`ONBOARDING_REQUIRED: Choose a provider (${installed.join(', ')}) using config defaultBackend or backend parameter.`);
  return selected(installed[0]);
}
