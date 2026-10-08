/**
 * Provider routing composition (`EXEC-001`).
 *
 * @remarks
 * Composes configured routing strategies, adapter probes, smart quota ranking,
 * and model catalog matching to select a backend for a turn.
 *
 * @packageDocumentation
 */
import { adapterRegistry } from '../backends/registry.js';
import { probeBackend, readModelCatalog } from '../backends/probe-cache.js';
import { loadConfig } from '../config.js';
import { selectSmartQuotaBackend } from '../backends/availability.js';
import { findCatalogEntry } from '../models/catalog.js';
import type { AdapterProbeResult, CliAdapter } from '../backends/types.js';
import { PROVIDERS, ToolError, type ProviderId } from '../contracts/index.js';

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

/**
 * Resolves the backend of a turn: an explicit backend, else the configured default, else one
 * chosen like smart_quota among the permitted installed CLIs.
 * @param requested - The call's or session's backend; `auto` or absent for the configured route.
 * @param options - `eligible` narrows an `auto` route: it returns why a backend cannot run the
 * turn, such as not listing the named model or having none below a user's price limit
 * (`AX-002`), or undefined. The configured default is kept when eligible; otherwise the
 * route chooses among the eligible backends. An explicit backend is never replaced.
 * @throws The reasons of every backend `eligible` rejected, with the first one's code, when none remains.
 */
export async function resolveBackend(requested?: string | null, options: { eligible?: (id: ProviderId, probe: AdapterProbeResult) => Promise<ToolError | undefined> } = {}): Promise<ResolvedBackend> {
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
  const preferred = target && PROVIDERS.includes(target as ProviderId) ? target as ProviderId : undefined;
  if (preferred && !(raw === 'auto' && options.eligible)) return selected(preferred);
  if (target && !preferred && target !== 'smart_quota') throw new ToolError('INPUT_LIMIT', `Invalid routing target '${target}'.`);
  const results = await Promise.all(candidates.map(async id => [id, await probeBackend(id)] as const));
  for (const [id, probe] of results) probes.set(id, probe);
  const installed = candidates.filter(id => probes.get(id)?.installed && probes.get(id)?.executionSupported !== false);
  if (!installed.length) throw candidates.some(id=>probes.get(id)?.installed) ? new ToolError('CLI_UNSUPPORTED', 'No installed permitted CLI supports execution; run doctor.') : new ToolError('CLI_NOT_FOUND', 'No permitted CLI installed; run doctor.');
  let pool = installed;
  if (options.eligible) {
    const rejected = await Promise.all(installed.map(id => options.eligible!(id, probes.get(id)!)));
    pool = installed.filter((_, index) => !rejected[index]);
    if (!pool.length) throw new ToolError(rejected[0]!.code, installed.map((id, index) => `${id}: ${rejected[index]!.message}`).join(' '));
  }
  if (preferred && pool.includes(preferred)) return selected(preferred);
  if (target === 'smart_quota' || pool.length > 1) {
    // Without a configured default, auto chooses like smart_quota: another CLI than the caller's, most headroom first.
    const warnings: string[] = [];
    const id = await selectSmartQuotaBackend(pool, { probesOverride: Object.fromEntries(probes), config, callerProvider, warnings });
    return { ...await selected(id as ProviderId, true), ...(warnings.length ? { warnings } : {}) };
  }
  return selected(pool[0]);
}

/**
 * Resolves the backend for a named model. `auto` routes to a backend whose CLI lists the
 * model, by id or alias; when none lists it, to one whose CLI decides itself: it runs
 * unlisted models (Claude Code) or lists none. An explicit backend is kept and its catalog
 * check reports a model it does not offer.
 * @throws `MODEL_UNAVAILABLE` naming each permitted backend that does not offer the model.
 */
export async function resolveBackendForModel(requested: string | undefined, model: string): Promise<ResolvedBackend> {
  const offers = (acceptUnlisted: boolean) => async (id: ProviderId) => {
    const catalog = await readModelCatalog(id);
    if (catalog && findCatalogEntry(catalog, model)) return undefined;
    if (acceptUnlisted && (!catalog || catalog.acceptsUnlisted)) return undefined;
    return new ToolError('MODEL_UNAVAILABLE', `does not list '${model}'; doctor lists its models.`);
  };
  try { return await resolveBackend(requested, { eligible: offers(false) }); }
  catch (err) {
    if (!(err instanceof ToolError) || err.code !== 'MODEL_UNAVAILABLE') throw err;
    return resolveBackend(requested, { eligible: offers(true) });
  }
}

