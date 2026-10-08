import { adapterRegistry } from './registry.js';
import { probeBackend } from './probe-cache.js';
import { loadConfig } from '../config.js';
import { selectSmartQuotaBackend } from './availability.js';
import type { AdapterProbeResult, CliAdapter } from './types.js';
import { PROVIDERS, ToolError, type ProviderId } from '../conversation.js';
export interface ResolvedBackend { id: ProviderId; adapter: CliAdapter; probe: AdapterProbeResult; isSmartQuota?: boolean; warnings?: string[] }

/** CLI of the connected MCP client; a stdio server process serves exactly one client. */
let callerProvider: ProviderId | null = null;

/**
 * Maps an MCP `clientInfo.name` to the provider whose CLI the client is.
 * @remarks A routing preference only, never a security decision: the name is self-reported.
 */
export function providerForClient(clientName: string | undefined): ProviderId | null {
  const name = (clientName || '').toLowerCase();
  if (name.includes('claude')) return 'claude';
  if (name.includes('codex')) return 'codex';
  if (/antigravity|jetski|gemini|\bagy\b/.test(name)) return 'agy';
  return null;
}

/** Records the connected client's own CLI so `auto` prefers a different one. */
export function setCallerProvider(provider: ProviderId | null): void {
  callerProvider = provider;
}
export async function resolveBackend(requested?: string | null): Promise<ResolvedBackend> {
  const config = loadConfig(), allowed = config.routing.allowedBackends;
  const raw = requested || 'auto';
  let target = raw === 'auto' ? (config.routing.strategy === 'smart_quota' ? 'smart_quota' : config.defaultBackend) : raw;
  const candidates = PROVIDERS.filter(id => allowed.includes(id));
  const probes = new Map<ProviderId, AdapterProbeResult>();
  async function selected(id: ProviderId, smart = false): Promise<ResolvedBackend> {
    if (!candidates.includes(id)) throw new ToolError('POLICY_DENIED', `Provider '${id}' is disabled by routing.allowedBackends.`);
    const probe = probes.get(id) || await probeBackend(id);
    if (!probe.installed) throw new ToolError('CLI_NOT_FOUND', `Provider '${id}' is not installed; run doctor.`);
    if (probe.executionSupported === false) throw new ToolError('CLI_UNSUPPORTED', `Provider '${id}' version/profile is unsupported; run doctor.`);
    return { id, adapter: adapterRegistry[id], probe, isSmartQuota: smart };
  }
  if (target && PROVIDERS.includes(target as ProviderId)) return selected(target as ProviderId);
  if (target && target !== 'smart_quota') throw new ToolError('INPUT_LIMIT', `Invalid routing target '${target}'.`);
  const results = await Promise.all(candidates.map(async id => [id, await probeBackend(id)] as const));
  for (const [id, probe] of results) probes.set(id, probe);
  const installed = candidates.filter(id => probes.get(id)?.installed && probes.get(id)?.executionSupported !== false);
  if (!installed.length) throw candidates.some(id=>probes.get(id)?.installed) ? new ToolError('CLI_UNSUPPORTED', 'No installed permitted CLI supports execution; run doctor.') : new ToolError('CLI_NOT_FOUND', 'No permitted CLI installed; run doctor.');
  if (target === 'smart_quota' || installed.length > 1) {
    // Without a configured default, auto chooses like smart_quota: another CLI than the caller's, most headroom first.
    const warnings: string[] = [];
    const id = await selectSmartQuotaBackend(installed, { probesOverride: Object.fromEntries(probes), config, callerProvider, warnings });
    return { ...await selected(id as ProviderId, true), ...(warnings.length ? { warnings } : {}) };
  }
  return selected(installed[0]);
}
