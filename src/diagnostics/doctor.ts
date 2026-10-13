import { probeBackend, readModelCatalog } from '../backends/probe-cache.js';
import { loadConfigSnapshotForDiagnostics, recordDefaultModel, type ConfigSnapshot } from '../config.js';
import { PROVIDERS, ToolError, type ProviderId, type ModelCatalog } from '../contracts/index.js';
import { inspectQuotas } from '../backends/availability.js';
import { catalogNames, listModelCandidates, type ModelCandidate, type ModelSelection, type ModelSource } from '../models/selection.js';
import { selectModel } from '../execution/selection.js';
import { redactDiagnostic } from '../security/redaction.js';
import { isPriceListStale, readPrices, type PriceList } from '../models/prices.js';
import { decideConsent, type ConsentBasis, type GovernanceSettings } from '../models/governance.js';
import type { AdapterProbeResult, BackendQuota, CatalogModel, InheritedTools, QuotaReport } from '../backends/types.js';
import { adapterRegistry } from '../backends/registry.js';
import { createPhaseTracker, type PhaseTracker } from '../execution/runtime/timing.js';
import { createExecutionBudget } from '../execution/runtime/budget.js';
import { combineSignals } from '../storage/lock.js';
import { BRAND } from '../brand.js';
import { getRuntimePath } from '../paths.js';
import {
  DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
  type TimingObserver,
  type MonotonicClock,
  type ExecutionTrace,
  type ExecutionBudget,
  type BackendReadContext,
} from '../contracts/execution.js';

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
  /** The user denies the default: a call that names no model is refused until another is chosen. */
  denied?: boolean;
}

/** The price list governance uses: where and when it was read, and how many offered models it prices. */
export interface DoctorPrices {
  source: string;
  fetchedAt: string;
  models: number;
  /** Older than seven days and not read again: it still decides approval but meets no price limit. */
  stale: boolean;
}

/** Redacted configuration provenance and identity reported by diagnostics. */
export interface DoctorConfigProvenance {
  /** Path to configuration file, with user home directory redacted. */
  path: string;
  /** Whether the path came from `coagent8_CONFIG` environment override or default directory. */
  origin: 'custom-env' | 'default-path';
  /** Whether the configuration file existed on disk. */
  existed: boolean;
  /** Active VS Code editor settings keys applied as overrides. */
  overrides: string[];
  /** Editor settings present in environment but inactive due to configuration error. */
  attemptedOverrides?: string[];
  /** Deterministic non-secret SHA-256 change identity. */
  changeIdentity: string;
  /** Error message if the configuration file was malformed or invalid. */
  error?: string;
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
  backends: Partial<Record<ProviderId, Omit<AdapterProbeResult, 'quota'> & { models?: CatalogModel[]; acceptsUnlisted?: boolean }>>;
  quotas: Partial<Record<ProviderId, DoctorQuota>>;
  /** Default model per installed backend; absent when none is known. */
  defaultModels: Partial<Record<ProviderId, DoctorDefaultModel>>;
  /** Null when no price list could be read; every model not on `models.allow` is then asked for. */
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
  /** Running server version (`FEEDBACK-061a1`). */
  server_version: string;
  /** Active runtime path executing CoAgent8 (`FEEDBACK-061a1`). */
  runtime_path: string;
  /** Why the configuration file is unusable; the report then shows the defaults and execution is refused. */
  configError?: string;
  /** Provenance and change identity of the configuration snapshot used for diagnostics. */
  configProvenance?: DoctorConfigProvenance;
  /**
   * MCP servers and plugins of the user's CLI configuration that a backend's turns offer the
   * model and CoAgent8 cannot disable (agy, `CUR-002`); only backends that report any.
   */
  inheritedTools: Partial<Record<ProviderId, InheritedTools>>;
  /** Optional call-level execution trace measuring diagnostic phases. */
  trace?: ExecutionTrace;
}

export interface DoctorOptions {
  /** Diagnose one provider only; the others are neither probed nor reported. */
  backend?: ProviderId;
  /** `false` skips native quota reads that are not part of a probe. */
  quota?: boolean;
  /** Optional cancellation signal from caller or host. */
  signal?: AbortSignal;
  /** Optional execution budget bounding diagnostic reads. */
  budget?: ExecutionBudget;
  /** Optional existing phase tracker to compose spans into a single trace. */
  tracker?: PhaseTracker;
  /** Optional observer callback receiving the timing trace. */
  onTiming?: TimingObserver;
  /** Optional custom monotonic clock for timing. */
  clock?: MonotonicClock;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const isOwnedTracker = !options.tracker;
  const tracker = options.tracker ?? createPhaseTracker({ clock: options.clock });
  const isOwnedBudget = !options.budget;
  const budget = options.budget ?? createExecutionBudget({
    totalBudgetMs: DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
    parentSignal: options.signal,
    clock: options.clock,
  });

  const readContext: BackendReadContext = {
    abortSignal: combineSignals(options.signal, budget.executionSignal) ?? undefined,
    budget,
    timeoutMs: budget.remainingExecutionMs(),
  };

  const emitTimingOnEarlyExit = () => {
    if (options.onTiming) {
      try {
        const trace = tracker.getTrace();
        const ret: unknown = options.onTiming(trace);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Isolate observer failure
      }
    }
  };

  if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('TIMEOUT', `Diagnostic deadline exceeded (${budget.totalBudgetMs} ms).`);
  }
  if (budget.isCallerAborted() || options.signal?.aborted) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('ABORTED', 'Request cancelled before diagnostic execution.');
  }

  try {
    const snapshot = loadConfigSnapshotForDiagnostics();
    const { config, error: configError } = snapshot;
    const configProvenance: DoctorConfigProvenance = {
      path: redactDiagnostic(snapshot.provenance.configFile),
      origin: snapshot.provenance.configFileOrigin,
      existed: snapshot.provenance.fileExisted,
      overrides: snapshot.provenance.editorOverridesApplied,
      ...(snapshot.provenance.editorOverridesAttempted?.length ? { attemptedOverrides: snapshot.provenance.editorOverridesAttempted } : {}),
      changeIdentity: snapshot.changeIdentity,
      ...(configError ? { error: configError } : {}),
    };
    const configNotes: string[] = [];
    if (configProvenance.origin === 'custom-env') {
      configNotes.push(`configuration: custom path active from coagent8_CONFIG (${configProvenance.path})`);
    }
    if (configProvenance.overrides.length) {
      configNotes.push(`configuration: ${configProvenance.overrides.length} editor setting override(s) active (${configProvenance.overrides.join(', ')})`);
    }
    if (configProvenance.attemptedOverrides?.length) {
      configNotes.push(`configuration: ${configProvenance.attemptedOverrides.length} editor setting(s) present but inactive due to configuration error (${configProvenance.attemptedOverrides.join(', ')})`);
    }
    const selected: readonly ProviderId[] = options.backend ? [options.backend] : PROVIDERS;
    const probePromises = selected.map(async id => {
      const span = tracker.startPhase('health_probes');
      try {
        return [id, await probeBackend(id, { fresh: true, context: readContext })] as const;
      } finally {
        span.end();
      }
    });
    const probes = Object.fromEntries(await Promise.all(probePromises)) as Partial<Record<ProviderId, AdapterProbeResult>>;
    const measuredNow = new Set<ProviderId>();
    // An unwritable quota cache must not hide the rest of the diagnosis (CUR-004).
    const cacheNotes: string[] = [];
    const modelSpan = tracker.startPhase('model_report');
    let cached: QuotaReport;
    let catalogs: (ModelCatalog | undefined)[];
    let inherited: (InheritedTools | undefined)[];
    let prices: Awaited<ReturnType<typeof readPrices>>;
    try {
      const [c, cats, inh] = await Promise.all([
        inspectQuotas(true, probes, { nativeQuota: options.quota !== false, only: selected, measuredNow,
          context: readContext,
          onCacheError: error => cacheNotes.push(`Quota cache not updated: ${redactDiagnostic(error.message, 512)}`) }),
        Promise.all(selected.map(id => readModelCatalog(id, { fresh: true, context: readContext }))),
        Promise.all(selected.map(id => probes[id]!.installed ? adapterRegistry[id].inheritedTools?.(readContext) : undefined)),
      ]);
      cached = c;
      catalogs = cats;
      inherited = inh;
      // Prices of every listed and configured default model, read again when the list is a day old.
      const configuredDefaults = selected.flatMap(id => [config.backends[id]?.defaultModel, probes[id]!.config?.defaultModel]).filter((model): model is string => typeof model === 'string');
      prices = await readPrices({ refresh: true, models: [...catalogs.flatMap(catalog => catalogNames(catalog)), ...configuredDefaults], context: readContext });
    } finally {
      modelSpan.end();
    }
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
      try { selection = await selectModel(id, probes[id]!, {}, { observeAfresh: true, context: readContext }); }
      catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (code === 'ABORTED' || code === 'TIMEOUT') throw err;
        recommendations.push(`${id}: ${redactDiagnostic((err as Error).message, 512)}`);
        return;
      }
      let recorded = false;
      if (selection.source === 'first-listed' || selection.source === 'observed') {
        try { recorded = await recordDefaultModel(id, selection.model); }
        catch (err) {
          const code = (err as { code?: unknown })?.code;
          if (code === 'ABORTED' || code === 'TIMEOUT') throw err;
          recommendations.push(`${id}: default model ${selection.model} not recorded in config.json: ${redactDiagnostic((err as Error).message, 256)}`);
        }
      }
      defaults[id] = selection;
      defaultModels[id] = { ...selection, ...(recorded ? { recorded } : {}), ...defaultApproval(selection.model, prices, config.governance) };
    }));
  }

  const selection = selected.filter(id => probes[id]!.installed)
    .flatMap(id => listModelCandidates(id, catalogs[selected.indexOf(id)], defaults[id], prices, config.governance));
  const backends: DoctorReport['backends'] = {};
  const quotas: DoctorReport['quotas'] = {};
  for (const id of selected) {
    const { quota, ...probe } = probes[id]!;
    const catalog = catalogs[selected.indexOf(id)];
    backends[id] = catalog ? { ...probe, models: catalog.models, modelSource: catalog.source, ...(catalog.acceptsUnlisted ? { acceptsUnlisted: true } : {}) } : probe;
    if (cached[id]) quotas[id] = quota?.buckets ? { ...cached[id], buckets: quota.buckets } : cached[id];
  }

  const trace = isOwnedTracker ? tracker.complete() : tracker.getTrace();
  const observerNotes: string[] = [];
  if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('TIMEOUT', `Diagnostic deadline exceeded (${budget.totalBudgetMs} ms).`);
  }
  if (budget.isCallerAborted() || options.signal?.aborted) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('ABORTED', 'Request cancelled during diagnostic execution.');
  }

  if (options.onTiming) {
    const recordObserverError = (err: unknown) => {
      let msg = 'Unknown observer error.';
      try {
        if (err instanceof Error) msg = err.message;
        else if (typeof err === 'string') msg = err;
        else msg = String(err);
      } catch {
        msg = 'Unstringifiable error thrown.';
      }
      const note = `Timing observer failure: ${redactDiagnostic(msg, 256)}`;
      if (!observerNotes.includes(note)) observerNotes.push(note);
    };

    try {
      const ret: unknown = options.onTiming(trace);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        let timer: NodeJS.Timeout | undefined;
        let timedOut = false;
        await Promise.race([
          (ret as Promise<unknown>).catch(recordObserverError),
          new Promise<void>(resolve => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, 500);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
          observerNotes.push('Timing observer timed out after 500ms.');
        }
      }
    } catch (err: unknown) {
      recordObserverError(err);
    }
  }

  return {
    status: configError ? 'configuration_error' : !active.length ? 'degraded_no_active_backends' : recommendations.length ? 'partially_configured' : 'operational',
    active_backends: active,
    installed_backends: selected.filter(id => probes[id]!.installed),
    ready_backends: ready,
    server_version: BRAND.SERVER_VERSION,
    runtime_path: redactDiagnostic(getRuntimePath()),
    configuredDefault: config.defaultBackend,
    effectiveDefault: effective,
    default_backend: effective || 'auto',
    backends,
    quotas,
    defaultModels,
    prices: prices ? { source: prices.source, fetchedAt: new Date(prices.fetchedAt).toISOString(), models: Object.values(prices.models).filter(Boolean).length, stale: isPriceListStale(prices) } : null,
    selection,
    recommendations: [...(configError ? [configError] : []), ...recommendations, ...cacheNotes, ...inheritedNotes, ...configNotes, ...observerNotes],
    ...(configError ? { configError } : {}),
    configProvenance,
    inheritedTools,
    trace,
  };
  } finally {
    if (isOwnedBudget) {
      budget.dispose();
    }
  }
}

/** How the summary names where a default model came from. */
const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  request: 'requested', session: 'session', config: 'config.json', 'cli-config': 'CLI config',
  catalog: 'CLI default', 'first-listed': 'first listed', observed: 'CLI reports', 'price-limit': 'price limit',
};

/** Why a model asks, as the summary names the rule; the full report carries the sentence. */
const APPROVAL_LABELS: Partial<Record<ConsentBasis, string>> = {
  ask: 'user list', 'no-price-list': 'no price list', unpriced: 'no price', approximate: 'approximate price',
  'above-limit': 'askAbovePrice', relative: 'priceMultiplier',
};

/**
 * The governance tag of one model: `deny` (never runs), `ask: <rule>` (runs after the user
 * approves the server's form) or `allow` (the user's standing approval); none when its price
 * needs no approval.
 */
function approvalTag(approval: ModelCandidate['approval']): string {
  if (approval.denied) return 'deny';
  if (approval.required) return `ask: ${APPROVAL_LABELS[approval.basis] ?? approval.basis}`;
  return approval.basis === 'allow' ? 'allow' : '';
}

/** Whether the default model asks each turn or is denied, as doctor records it. */
function defaultApproval(model: string, prices: PriceList | undefined, governance: GovernanceSettings): Pick<DoctorDefaultModel, 'asks' | 'denied'> {
  const decision = decideConsent(model, model, prices, governance);
  return decision.deny ? { denied: true } : decision.ask ? { asks: true } : {};
}

/**
 * One model as the summary lists it: name, efforts unless stated once for the backend,
 * price (`~` approximate, `?` unknown), and whether it is the default and its governance tag.
 */
function formatCandidate(row: ModelCandidate, sharedEfforts: boolean): string {
  const efforts = !sharedEfforts && row.efforts.length ? ` (${row.efforts.join('|')}${row.effortRequired ? ' required' : ''})` : '';
  const { outputUsdPerMTok: output, match } = row.price;
  const price = output === null ? '?' : `${match === 'approximate' ? '~' : ''}${Number(output.toFixed(4))}`;
  const tags = [row.defaultSource ? 'default' : '', approvalTag(row.approval)].filter(Boolean);
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

function formatPrices(list: DoctorPrices | null): string {
  return list ? `prices ${list.source} ${list.fetchedAt.slice(0, 10)} (${list.models} models priced${list.stale ? ', stale: meets no price limit' : ''})`
    : 'no price list: every model asks, none meets a price limit';
}

/** Names the default model and where it came from. */
function formatDefault(selected: DoctorDefaultModel | undefined): string {
  return selected ? ` · model ${selected.model} (${MODEL_SOURCE_LABELS[selected.source]}${selected.recorded ? ', recorded in config.json' : ''}${selected.asks ? ', asks each turn' : ''}${selected.denied ? ', denied by the user' : ''})` : '';
}

/** What a backend accepts beyond the listed models: unlisted names, the probe's aliases, or any name. */
function formatUnlisted(catalog: { listed: boolean; acceptsUnlisted?: boolean; availableModels?: string[] }): string | undefined {
  if (catalog.listed) return catalog.acceptsUnlisted ? '  also accepted: unlisted names the CLI resolves itself' : undefined;
  return catalog.availableModels?.length ? `  also accepted: ${catalog.availableModels.join(', ')}, or a full model id` : '  also accepted: any model name the CLI accepts';
}

/**
 * Renders a summary whose model lines fit {@link DOCTOR_SUMMARY_MAX_BYTES}: model rows are
 * dropped whole, from the longest list first, because a cut row would misstate a price.
 * @param render - Renders the summary with at most the given number of rows per backend.
 */
function fitSummary(selection: ModelCandidate[], render: (rows: (id: ProviderId) => ModelCandidate[], limits: Partial<Record<ProviderId, number>>) => string): string {
  const ids = [...new Set(selection.map(row => row.backend))];
  const rows = (id: ProviderId) => selection.filter(row => row.backend === id);
  const limits: Partial<Record<ProviderId, number>> = Object.fromEntries(ids.map(id => [id, rows(id).length]));
  let text = render(rows, limits);
  while (Buffer.byteLength(text) > DOCTOR_SUMMARY_MAX_BYTES) {
    const longest = ids.reduce<ProviderId | undefined>((top, id) => top === undefined || limits[id]! > limits[top]! ? id : top, undefined);
    if (!longest || limits[longest]! <= 1) break;
    limits[longest]!--;
    text = render(rows, limits);
  }
  return text;
}

/**
 * Renders a health report as a few lines: overall status and price list, one line per
 * backend with its readiness and quota, its models with their prices, and the recommendations.
 * @remarks The tool still applies the byte bound for recommendations that alone exceed it.
 */
export function formatDoctorSummary(report: DoctorReport): string {
  const ids = Object.keys(report.backends) as ProviderId[];
  const versionPart = report.server_version ? ` · v${report.server_version}` : '';
  const runtimePart = report.runtime_path ? ` · runtime: ${report.runtime_path}` : '';
  return fitSummary(report.selection, (rows, limits) => {
    const lines = [`CoAgent8 doctor: ${report.status}${versionPart}${runtimePart} · default backend: ${report.default_backend} · ${formatPrices(report.prices)}`];
    for (const id of ids) {
      const probe = report.backends[id]!;
      if (!probe.installed) { lines.push(`${id}: not installed`); continue; }
      const state = report.ready_backends.includes(id) ? 'ready' : !report.active_backends.includes(id) ? 'not allowed' : probe.authStatus === 'unauthenticated' ? 'signed out' : 'not ready';
      lines.push(`${id}: ${state} · ${probe.version || 'unknown version'}${formatDefault(report.defaultModels?.[id])} · ${formatQuota(report.quotas[id])}`);
      if (rows(id).length) lines.push(formatCandidates(rows(id), limits[id]!));
      const unlisted = formatUnlisted({ listed: Boolean(probe.models?.length), acceptsUnlisted: probe.acceptsUnlisted, availableModels: probe.availableModels });
      if (unlisted) lines.push(unlisted);
    }
    if (report.recommendations.length) lines.push(...report.recommendations.map(text => `- ${text}`));
    return lines.join('\n');
  });
}

/** One backend in the model report: whether it can run, its version, default and catalog source. */
export interface ModelReportBackend {
  installed: boolean;
  /** Permitted by `routing.allowedBackends`. */
  allowed: boolean;
  version?: string;
  defaultModel?: DoctorDefaultModel;
  /** Where the model list comes from; absent when the CLI lists none. */
  catalogSource?: string;
  /** The CLI also runs names it does not list (Claude Code). */
  acceptsUnlisted?: boolean;
  /** Names the probe knows when the CLI lists no catalog. */
  availableModels?: string[];
}

/**
 * The model view of doctor (`AX-001`): which models each backend offers, their efforts,
 * output prices and approval need, from cached probes, catalogs and prices. It reads no
 * quota and records nothing; `scope: "health"` diagnoses installation, sign-in and quota.
 */
export interface ModelReport {
  scope: 'models';
  prices: DoctorPrices | null;
  backends: Partial<Record<ProviderId, ModelReportBackend>>;
  selection: ModelCandidate[];
  recommendations: string[];
  /** Provenance and change identity of the configuration snapshot used for diagnostics. */
  configProvenance?: DoctorConfigProvenance;
  trace?: ExecutionTrace;
}

/**
 * Builds the model view from cached data: probes and catalogs younger than their TTLs are
 * reused, prices are read only when none are stored or a listed model is unchecked.
 * @param options - `backend` narrows the view to one backend.
 */
export async function runModelReport(options: DoctorOptions = {}): Promise<ModelReport> {
  const isOwnedTracker = !options.tracker;
  const tracker = options.tracker ?? createPhaseTracker({ clock: options.clock });
  const isOwnedBudget = !options.budget;
  const budget = options.budget ?? createExecutionBudget({
    totalBudgetMs: DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
    parentSignal: options.signal,
    clock: options.clock,
  });

  const readContext: BackendReadContext = {
    abortSignal: combineSignals(options.signal, budget.executionSignal) ?? undefined,
    budget,
    timeoutMs: budget.remainingExecutionMs(),
  };

  const emitTimingOnEarlyExit = () => {
    if (options.onTiming) {
      try {
        const trace = tracker.getTrace();
        const ret: unknown = options.onTiming(trace);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Isolate observer failure
      }
    }
  };

  if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('TIMEOUT', `Diagnostic deadline exceeded (${budget.totalBudgetMs} ms).`);
  }
  if (budget.isCallerAborted() || options.signal?.aborted) {
    if (isOwnedBudget) budget.dispose();
    emitTimingOnEarlyExit();
    throw new ToolError('ABORTED', 'Request cancelled before diagnostic execution.');
  }

  try {
    const snapshot = loadConfigSnapshotForDiagnostics();
    const { config, error: configError } = snapshot;
    const configProvenance: DoctorConfigProvenance = {
      path: redactDiagnostic(snapshot.provenance.configFile),
      origin: snapshot.provenance.configFileOrigin,
      existed: snapshot.provenance.fileExisted,
      overrides: snapshot.provenance.editorOverridesApplied,
      ...(snapshot.provenance.editorOverridesAttempted?.length ? { attemptedOverrides: snapshot.provenance.editorOverridesAttempted } : {}),
      changeIdentity: snapshot.changeIdentity,
      ...(configError ? { error: configError } : {}),
    };
    const configNotes: string[] = [];
    if (configProvenance.origin === 'custom-env') {
      configNotes.push(`configuration: custom path active from coagent8_CONFIG (${configProvenance.path})`);
    }
    if (configProvenance.overrides.length) {
      configNotes.push(`configuration: ${configProvenance.overrides.length} editor setting override(s) active (${configProvenance.overrides.join(', ')})`);
    }
    if (configProvenance.attemptedOverrides?.length) {
      configNotes.push(`configuration: ${configProvenance.attemptedOverrides.length} editor setting(s) present but inactive due to configuration error (${configProvenance.attemptedOverrides.join(', ')})`);
    }
    const selected: readonly ProviderId[] = options.backend ? [options.backend] : PROVIDERS;
    const probes = await Promise.all(selected.map(async id => {
      const span = tracker.startPhase('health_probes');
      try {
        return await probeBackend(id, { context: readContext });
      } finally {
        span.end();
      }
    }));
    const modelSpan = tracker.startPhase('model_report');
    let catalogs: (ModelCatalog | undefined)[];
    let defaults: (ModelSelection | undefined)[];
    let prices: Awaited<ReturnType<typeof readPrices>>;
    const recommendations: string[] = configError ? [configError] : [];
    try {
      catalogs = await Promise.all(selected.map((id, index) => probes[index].installed ? readModelCatalog(id, { context: readContext }) : undefined));
      defaults = await Promise.all(selected.map(async (id, index): Promise<ModelSelection | undefined> => {
        if (!probes[index].installed || configError) return undefined;
        try { return await selectModel(id, probes[index], {}, { context: readContext }); }
        catch (err) {
          const code = (err as { code?: unknown })?.code;
          if (code === 'ABORTED' || code === 'TIMEOUT') throw err;
          recommendations.push(`${id}: ${redactDiagnostic((err as Error).message, 512)}`);
          return undefined;
        }
      }));
      prices = await readPrices({ models: [...catalogs.flatMap(catalog => catalogNames(catalog)), ...defaults.flatMap(selection => selection ? [selection.model] : [])], context: readContext });
      if (!prices) recommendations.push('No price list could be read: every model asks for approval and none meets a price limit.');
    } finally {
      modelSpan.end();
    }
    const backends: ModelReport['backends'] = {};
    selected.forEach((id, index) => {
      const probe = probes[index], catalog = catalogs[index], fallback = defaults[index];
      backends[id] = { installed: probe.installed, allowed: config.routing.allowedBackends.includes(id),
        ...(probe.version ? { version: probe.version } : {}),
        ...(fallback ? { defaultModel: { ...fallback, ...defaultApproval(fallback.model, prices, config.governance) } } : {}),
        ...(catalog ? { catalogSource: catalog.source, ...(catalog.acceptsUnlisted ? { acceptsUnlisted: true } : {}) } : {}),
        ...(!catalog && probe.availableModels?.length ? { availableModels: probe.availableModels } : {}) };
    });

    const trace = isOwnedTracker ? tracker.complete() : tracker.getTrace();
    const observerNotes: string[] = [];
    if (budget.isTimedOut() || budget.isExecutionExpired() || budget.remainingExecutionMs() <= 0) {
      if (isOwnedBudget) budget.dispose();
      emitTimingOnEarlyExit();
      throw new ToolError('TIMEOUT', `Diagnostic deadline exceeded (${budget.totalBudgetMs} ms).`);
    }
    if (budget.isCallerAborted() || options.signal?.aborted) {
      if (isOwnedBudget) budget.dispose();
      emitTimingOnEarlyExit();
      throw new ToolError('ABORTED', 'Request cancelled during diagnostic execution.');
    }

    if (options.onTiming) {
      const recordObserverError = (err: unknown) => {
        let msg = 'Unknown observer error.';
        try {
          if (err instanceof Error) msg = err.message;
          else if (typeof err === 'string') msg = err;
          else msg = String(err);
        } catch {
          msg = 'Unstringifiable error thrown.';
        }
        const note = `Timing observer failure: ${redactDiagnostic(msg, 256)}`;
        if (!observerNotes.includes(note)) observerNotes.push(note);
      };

      try {
        const ret: unknown = options.onTiming(trace);
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          let timer: NodeJS.Timeout | undefined;
          let timedOut = false;
          await Promise.race([
            (ret as Promise<unknown>).catch(recordObserverError),
            new Promise<void>(resolve => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve();
              }, 500);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (timedOut) {
            observerNotes.push('Timing observer timed out after 500ms.');
          }
        }
      } catch (err: unknown) {
        recordObserverError(err);
      }
    }

    return {
      scope: 'models',
      prices: prices ? { source: prices.source, fetchedAt: new Date(prices.fetchedAt).toISOString(), models: Object.values(prices.models).filter(Boolean).length, stale: isPriceListStale(prices) } : null,
      backends,
      selection: selected.flatMap((id, index) => probes[index].installed ? listModelCandidates(id, catalogs[index], defaults[index], prices, config.governance) : []),
      recommendations: [...recommendations, ...configNotes, ...observerNotes],
      configProvenance,
      trace,
    };
  } finally {
    if (isOwnedBudget) {
      budget.dispose();
    }
  }
}

/**
 * Renders the model view: the price list, then per backend its default and its models with
 * efforts, output prices, default and approval tags, within {@link DOCTOR_SUMMARY_MAX_BYTES}.
 */
export function formatModelSummary(report: ModelReport): string {
  const ids = Object.keys(report.backends) as ProviderId[];
  return fitSummary(report.selection, (rows, limits) => {
    const lines = [`CoAgent8 models · ${formatPrices(report.prices)} · scope "health" diagnoses sign-in and quota`];
    for (const id of ids) {
      const backend = report.backends[id]!;
      if (!backend.installed) { lines.push(`${id}: not installed`); continue; }
      lines.push(`${id}${backend.allowed ? '' : ' (not allowed by routing.allowedBackends)'} · ${backend.version || 'unknown version'}${formatDefault(backend.defaultModel)}`);
      if (rows(id).length) lines.push(formatCandidates(rows(id), limits[id]!));
      const unlisted = formatUnlisted({ listed: Boolean(backend.catalogSource), acceptsUnlisted: backend.acceptsUnlisted, availableModels: backend.availableModels });
      if (unlisted) lines.push(unlisted);
    }
    if (report.recommendations.length) lines.push(...report.recommendations.map(text => `- ${text}`));
    return lines.join('\n');
  });
}
