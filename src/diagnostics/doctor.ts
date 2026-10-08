import { probeBackend, readModelCatalog } from '../backends/probe-cache.js';
import { loadConfigForDiagnostics, recordDefaultModel } from '../config.js';
import { PROVIDERS, type ProviderId } from '../conversation.js';
import { inspectQuotas } from '../backends/availability.js';
import { catalogNames, listModelCandidates, selectModel, type ModelCandidate, type ModelSelection, type ModelSource } from '../backends/model-selection.js';
import { redactDiagnostic } from '../redaction.js';
import { isPriceListStale, readPrices } from '../backends/prices.js';
import { decideConsent, type ConsentBasis } from '../backends/governance.js';
import type { AdapterProbeResult, BackendQuota, CatalogModel, InheritedTools } from '../backends/types.js';
import { adapterRegistry } from '../backends/registry.js';

/** Native per-window quota details reused by the exported doctor report. */
export type ProbeQuotaBuckets = NonNullable<AdapterProbeResult['quota']>['buckets'];

/** Quota of one provider; `buckets` carries the per-window detail some probes report. */
export type DoctorQuota = BackendQuota & { buckets?: ProbeQuotaBuckets };

/** The model a turn runs when the call names none, where it came from, and whether doctor recorded it now. */
export interface DoctorDefaultModel {
  model: string;
  source: ModelSource;
  recorded?: boolean;
  /** The governance policy asks the user before each turn of the default itself. */
  asks?: boolean;
}

/** The price list governance uses: where and when it was read, and how many offered models it prices. */
export interface DoctorPrices {
  source: string;
  fetchedAt: string;
  models: number;
  /** Older than seven days and not read again: it still decides approval but meets no price limit. */
  stale: boolean;
}

/**
 * Byte bound of the summary: agy shows a result of up to about 3,950 bytes inline and saves
 * a larger one to a file its model must read (owner decision of 2026-10-08).
 */
export const DOCTOR_SUMMARY_MAX_BYTES = 3900;

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
  /** Default model per installed backend; absent when none is known. */
  defaultModels: Partial<Record<ProviderId, DoctorDefaultModel>>;
  /** Null when no price list could be read; every model not on `neverAsk` is then asked for. */
  prices: DoctorPrices | null;
  /**
   * Every model of the diagnosed installed backends with its output price, the price's match
   * and freshness, and whether governance asks before it runs (`AX-001`). The summary renders
   * the same rows.
   */
  selection: ModelCandidate[];
  recommendations: string[];
  installed_backends: ProviderId[];
  ready_backends: ProviderId[];
  /** Why the configuration file is unusable; the report then shows the defaults and execution is refused. */
  configError?: string;
  /**
   * MCP servers and plugins of the user's CLI configuration that a backend's turns offer the
   * model and CoAgent8 cannot disable (agy, `CUR-002`); only backends that report any.
   */
  inheritedTools: Partial<Record<ProviderId, InheritedTools>>;
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
  // An unwritable quota cache must not hide the rest of the diagnosis (CUR-004).
  const cacheNotes: string[] = [];
  const [cached, catalogs, inherited] = await Promise.all([
    inspectQuotas(true, probes, { nativeQuota: options.quota !== false, only: selected, measuredNow,
      onCacheError: error => cacheNotes.push(`Quota cache not updated: ${redactDiagnostic(error.message, 512)}`) }),
    Promise.all(selected.map(id => readModelCatalog(id, { fresh: true }))),
    Promise.all(selected.map(id => probes[id]!.installed ? adapterRegistry[id].inheritedTools?.() : undefined)),
  ]);
  // Prices of every listed and configured default model, read again when the list is a day old.
  const configuredDefaults = selected.flatMap(id => [config.backends[id]?.defaultModel, probes[id]!.config?.defaultModel]).filter((model): model is string => typeof model === 'string');
  const prices = await readPrices({ refresh: true, models: [...catalogs.flatMap(catalog => catalogNames(catalog)), ...configuredDefaults] });
  const inheritedTools: DoctorReport['inheritedTools'] = {};
  selected.forEach((id, index) => {
    const tools = inherited[index];
    if (tools && (tools.mcpServers.length || tools.plugins.length)) inheritedTools[id] = tools;
  });

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
  // A known limitation, not a configuration problem: it leaves the status unchanged.
  const inheritedNotes = (Object.entries(inheritedTools) as [ProviderId, InheritedTools][]).map(([id, tools]) => {
    const named = [tools.mcpServers.length ? `MCP servers ${tools.mcpServers.join(', ')}` : '', tools.plugins.length ? `plugins ${tools.plugins.join(', ')}` : ''].filter(Boolean).join(' and ');
    return `${id}: turns run in the CLI's sandbox but can use ${named} from your ${id} configuration; CoAgent8 cannot disable them. Keep only servers you trust there.`;
  });

  // The default model of each installed backend. One the CLI does not state itself (the first
  // model agy lists, the model Claude Code reports) is recorded in config.json once, so a later
  // catalog order or account change cannot switch it silently (owner decision of 2026-10-07).
  const defaultModels: DoctorReport['defaultModels'] = {};
  const defaults: Partial<Record<ProviderId, ModelSelection>> = {};
  if (!configError) {
    await Promise.all(selected.filter(id => probes[id]!.installed).map(async id => {
      let selection: ModelSelection;
      try { selection = await selectModel(id, probes[id]!, {}, { observeAfresh: true }); }
      catch (err) { recommendations.push(`${id}: ${redactDiagnostic((err as Error).message, 512)}`); return; }
      let recorded = false;
      if (selection.source === 'first-listed' || selection.source === 'observed') {
        try { recorded = await recordDefaultModel(id, selection.model); }
        catch (err) { recommendations.push(`${id}: default model ${selection.model} not recorded in config.json: ${redactDiagnostic((err as Error).message, 256)}`); }
      }
      defaults[id] = selection;
      const asks = decideConsent(selection.model, selection.model, prices, config.governance).ask;
      defaultModels[id] = { ...selection, ...(recorded ? { recorded } : {}), ...(asks ? { asks } : {}) };
    }));
  }

  const selection = selected.filter(id => probes[id]!.installed)
    .flatMap(id => listModelCandidates(id, catalogs[selected.indexOf(id)], defaults[id], prices, config.governance));
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
    defaultModels,
    prices: prices ? { source: prices.source, fetchedAt: new Date(prices.fetchedAt).toISOString(), models: Object.values(prices.models).filter(Boolean).length, stale: isPriceListStale(prices) } : null,
    selection,
    recommendations: [...(configError ? [configError] : []), ...recommendations, ...cacheNotes, ...inheritedNotes],
    ...(configError ? { configError } : {}),
    inheritedTools,
  };
}

/** How the summary names where a default model came from. */
const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  request: 'requested', session: 'session', config: 'config.json', 'cli-config': 'CLI config',
  catalog: 'CLI default', 'first-listed': 'first listed', observed: 'CLI reports', 'price-limit': 'price limit',
};

/** Why a model asks, as the summary names the rule; the full report carries the sentence. */
const APPROVAL_LABELS: Partial<Record<ConsentBasis, string>> = {
  'always-ask': 'alwaysAsk', 'no-price-list': 'no price list', unpriced: 'no price', approximate: 'approximate price',
  'above-limit': 'askAbovePrice', relative: 'priceMultiplier',
};

/**
 * One model as the summary lists it: name, efforts unless stated once for the backend,
 * price (`~` approximate, `?` unknown), and whether it is the default and asks.
 */
function formatCandidate(row: ModelCandidate, sharedEfforts: boolean): string {
  const efforts = !sharedEfforts && row.efforts.length ? ` (${row.efforts.join('|')}${row.effortRequired ? ' required' : ''})` : '';
  const { outputUsdPerMTok: output, match } = row.price;
  const price = output === null ? '?' : `${match === 'approximate' ? '~' : ''}${Number(output.toFixed(4))}`;
  const tags = [row.defaultSource ? 'default' : '', row.approval.required ? `asks: ${APPROVAL_LABELS[row.approval.basis] ?? row.approval.basis}` : ''].filter(Boolean);
  return `${row.model}${efforts} ${price}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
}

/**
 * Renders the model line of one backend with at most `limit` rows; the rest are counted.
 * @remarks Efforts shared by every model and required by none (Codex) are stated once.
 */
function formatCandidates(rows: ModelCandidate[], limit: number): string {
  const efforts = rows[0]?.efforts.join('|') ?? '';
  const shared = rows.length > 1 && efforts !== '' && rows.every(row => row.efforts.join('|') === efforts && !row.effortRequired);
  const shown = rows.slice(0, limit).map(row => formatCandidate(row, shared));
  const more = rows.length > limit ? `, +${rows.length - limit} more (detail: full)` : '';
  return `  models, USD per million output tokens: ${shown.join(', ')}${more}${shared ? `; reasoning_effort ${efforts}` : ''}`;
}

function formatQuota(quota: DoctorQuota | undefined): string {
  if (!quota) return 'quota unknown';
  if (quota.status === 'rate_limited') return `rate limited${quota.cooldownUntil || quota.resetsAt ? ` until ${quota.cooldownUntil || quota.resetsAt}` : ''}`;
  if (!quota.measured || quota.headroomPercent === null) return 'quota not measured';
  return `${quota.window} ${quota.headroomPercent}% left${quota.resetsAt ? `, resets ${quota.resetsAt}` : ''}`;
}

/**
 * Renders a doctor report as a few lines: overall status and price list, one line per
 * backend, its models with their prices, and the recommendations.
 * @remarks Model rows are dropped whole, from the longest list first, until the summary
 * fits {@link DOCTOR_SUMMARY_MAX_BYTES}: a cut row would misstate a price. The tool still
 * applies the byte bound for recommendations that alone exceed it.
 */
export function formatDoctorSummary(report: DoctorReport): string {
  const list = report.prices;
  const prices = list ? `prices ${list.source} ${list.fetchedAt.slice(0, 10)} (${list.models} models priced${list.stale ? ', stale: meets no price limit' : ''})`
    : 'no price list: every model asks, none meets a price limit';
  const ids = Object.keys(report.backends) as ProviderId[];
  const rows = Object.fromEntries(ids.map(id => [id, report.selection.filter(row => row.backend === id)])) as Record<ProviderId, ModelCandidate[]>;
  const limits = Object.fromEntries(ids.map(id => [id, rows[id].length])) as Record<ProviderId, number>;
  const render = () => {
    const lines = [`CoAgent8 doctor: ${report.status} · default backend: ${report.default_backend} · ${prices}`];
    for (const id of ids) {
      const probe = report.backends[id]!;
      if (!probe.installed) { lines.push(`${id}: not installed`); continue; }
      const state = report.ready_backends.includes(id) ? 'ready' : !report.active_backends.includes(id) ? 'not allowed' : probe.authStatus === 'unauthenticated' ? 'signed out' : 'not ready';
      const selected = report.defaultModels?.[id];
      const model = selected ? ` · model ${selected.model} (${MODEL_SOURCE_LABELS[selected.source]}${selected.recorded ? ', recorded in config.json' : ''}${selected.asks ? ', asks each turn' : ''})` : '';
      lines.push(`${id}: ${state} · ${probe.version || 'unknown version'}${model} · ${formatQuota(report.quotas[id])}`);
      // The discovery step before an explicit model or a price limit: what the CLI offers and what it costs.
      if (rows[id].length) lines.push(formatCandidates(rows[id], limits[id]));
      if (!probe.models?.length) lines.push(probe.availableModels?.length ? `  also accepted: ${probe.availableModels.join(', ')}, or a full model id` : '  also accepted: any model name the CLI accepts');
    }
    if (report.recommendations.length) lines.push(...report.recommendations.map(text => `- ${text}`));
    return lines.join('\n');
  };
  let text = render();
  while (Buffer.byteLength(text) > DOCTOR_SUMMARY_MAX_BYTES) {
    const longest = ids.reduce((top, id) => limits[id] > limits[top] ? id : top, ids[0]);
    if (!longest || limits[longest] <= 1) break;
    limits[longest]--;
    text = render();
  }
  return text;
}
