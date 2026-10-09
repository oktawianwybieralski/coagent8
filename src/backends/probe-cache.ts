/**
 * Probe results and model observations reused across requests, so routing does not launch
 * `--version`, catalog or model-name processes on every call. Catalogs and observed models
 * are also kept in `models.json` for later server processes. @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { adapterRegistry } from './registry.js';
import { resolveCliCommand } from '../execution/cli-resolver.js';
import type { ProviderId } from '../contracts/index.js';
import { readObservedModels, recordObservedModels } from '../models/store.js';
import type { AdapterProbeResult, CliAdapter, ModelCatalog, BackendReadContext } from './types.js';

/** Upper bound for reusing a probe; doctor always probes afresh. */
const PROBE_TTL_MS = 5 * 60 * 1000;
/** Upper bound for reusing a catalog or an observed model from `models.json`; doctor reads afresh. */
const STORED_TTL_MS = 24 * 60 * 60 * 1000;
/** Environment that locates an executable or its home. */
const PROBE_ENVIRONMENT = ['PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE'] as const;
/**
 * Prefixes of the variables the CLIs read: executables, homes, credentials and model
 * overrides such as Claude Code's alias variables. Only a hash of their values is kept.
 */
const PROVIDER_ENVIRONMENT_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'GEMINI_', 'AGY_'] as const;

interface CachedProbe { adapter: CliAdapter; probeFn: CliAdapter['probe']; probe: AdapterProbeResult; key: string; at: number }
const cache = new Map<ProviderId, CachedProbe>();

/** Reads in progress, so concurrent misses share one CLI launch (CUR-006). */
const inflight = new Map<string, { owner: unknown; promise: Promise<unknown> }>();

/**
 * Shares a read in progress under `key` while it belongs to the same adapter function.
 * A failure is not cached: every waiter receives it and the next call starts a new read.
 * @param join - False for a `fresh` read, which starts its own and is shared from then on.
 * @param context - Optional neutral read and cancellation context for the waiter.
 */
function coalesce<T>(
  key: string,
  owner: unknown,
  join: boolean,
  start: (context?: BackendReadContext) => Promise<T>,
  context?: BackendReadContext
): Promise<T> {
  const running = inflight.get(key);
  if (join && running && running.owner === owner) return running.promise as Promise<T>;
  const promise: Promise<T> = start(context).finally(() => {
    if (inflight.get(key)?.promise === promise) inflight.delete(key);
  });
  inflight.set(key, { owner, promise });
  return promise;
}

function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${file}:missing`;
    throw err;
  }
}

/**
 * Identifies what a probe observed: the resolved executable files, the configuration file
 * and the provider environment. Changes outside these stamps are not detected.
 * @returns A SHA-256 hash, so a key never holds a credential.
 */
function probeKey(probe: AdapterProbeResult): string {
  const providerVariables = Object.keys(process.env).filter(name => PROVIDER_ENVIRONMENT_PREFIXES.some(prefix => name.startsWith(prefix))).sort();
  const parts: string[] = [...PROBE_ENVIRONMENT, ...providerVariables].map(name => `${name}=${process.env[name] ?? ''}`);
  if (probe.command) {
    let files: string[];
    try {
      const resolved = resolveCliCommand(probe.command);
      files = [resolved.command, ...resolved.argsPrefix].filter(part => path.isAbsolute(part));
    } catch (err) {
      files = [`unresolved:${(err as Error).message}`];
    }
    parts.push(...files.map(file => file.startsWith('unresolved:') ? file : fileStamp(file)));
  }
  if (probe.configPath) parts.push(fileStamp(probe.configPath));
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Options for probing a backend CLI (`EXEC-001-T08`).
 */
export interface ProbeBackendOptions {
  /** If true, always probes afresh and replaces the cached result (doctor). */
  fresh?: boolean;
  /** Optional cancellation and deadline context for this read (`EXEC-001-T08`). */
  context?: BackendReadContext;
}

/**
 * Returns the backend's probe, reusing a cached result while its CLI, configuration and
 * selected environment stamps are unchanged and it is younger than the five-minute TTL.
 * Concurrent misses share one probe; a failed probe is not cached.
 * @param id - Backend to probe.
 * @param options - `fresh` always probes and replaces the cached result (doctor); `context` supplies read budget/signal.
 */
export async function probeBackend(id: ProviderId, options: ProbeBackendOptions = {}): Promise<AdapterProbeResult> {
  const adapter = adapterRegistry[id];
  const cached = cache.get(id);
  if (!options.fresh && cached && cached.adapter === adapter && cached.probeFn === adapter.probe && Date.now() - cached.at < PROBE_TTL_MS && cached.key === probeKey(cached.probe)) {
    return cached.probe;
  }
  const probeFn = adapter.probe;
  return coalesce(`probe:${id}`, probeFn, !options.fresh, async (readContext) => {
    const probe = await probeFn.call(adapter, readContext);
    cache.set(id, { adapter, probeFn, probe, key: probeKey(probe), at: Date.now() });
    return probe;
  }, options.context);
}

/**
 * Options for reading or validating model catalog observations (`EXEC-001-T05a`).
 */
export interface ReadModelCatalogOptions {
  /** If true, reads afresh from the CLI adapter and bypasses existing cache/observations (doctor). */
  fresh?: boolean;
  /** Existing probe result if already available, avoiding redundant probe lookup and key calculation. */
  probe?: AdapterProbeResult;
  /** Existing catalog observation obtained for this backend to validate and reuse. */
  catalog?: ModelCatalog;
  /** Optional cancellation and deadline context for this read (`EXEC-001-T08`). */
  context?: BackendReadContext;
}

/**
 * Options for observing concrete models from native CLIs.
 */
export interface ReadObservedModelOptions {
  /** If true, asks the CLI again and bypasses cached observations. */
  fresh?: boolean;
  /** Existing probe result if already available, avoiding redundant probe lookup. */
  probe?: AdapterProbeResult;
  /** Optional cancellation and deadline context for this read (`EXEC-001-T08`). */
  context?: BackendReadContext;
}

interface CachedCatalog { listFn: CliAdapter['listModels']; catalog: ModelCatalog | undefined; key: string; at: number }
const catalogs = new Map<ProviderId, CachedCatalog>();

/**
 * Returns the CLI's catalog: from memory for up to five minutes, else from `models.json`
 * for up to a day, else read from the CLI and recorded in both. Keys must match the
 * current installation. Concurrent misses share one read.
 * @param id - Backend whose catalog to read.
 * @param options - `fresh` reads the CLI again (doctor); `probe` and `catalog` reuse pre-read evidence; `context` supplies read budget/signal.
 * @returns The catalog, or undefined when the CLI is not installed, has no catalog or
 * did not answer; an unanswered read is kept in memory only, so a slow CLI is not asked on
 * every call and a later process asks again.
 */
export async function readModelCatalog(id: ProviderId, options: ReadModelCatalogOptions = {}): Promise<ModelCatalog | undefined> {
  const adapter = adapterRegistry[id];
  if (!adapter.listModels) return undefined;
  const probe = options.probe ?? await probeBackend(id, { context: options.context });
  if (!probe.installed) return undefined;
  const key = probeKey(probe);
  const cached = catalogs.get(id);

  if (!options.fresh) {
    if (options.catalog && cached && cached.catalog === options.catalog && cached.key === key && cached.listFn === adapter.listModels && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.catalog;
    }
    if (cached && cached.listFn === adapter.listModels && cached.key === key && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.catalog;
    }
  }

  const stored = options.fresh ? undefined : readObservedModels(id, key)?.catalog;
  if (stored && Date.now() - stored.observedAt < STORED_TTL_MS) {
    const catalog: ModelCatalog = { models: stored.models, source: stored.source, ...(stored.acceptsUnlisted ? { acceptsUnlisted: true } : {}) };
    catalogs.set(id, { listFn: adapter.listModels, catalog, key, at: Date.now() });
    return catalog;
  }
  const listFn = adapter.listModels;
  return coalesce(`catalog:${id}:${key}`, listFn, !options.fresh, async (readContext) => {
    const catalog = await listFn.call(adapter, probe, readContext);
    catalogs.set(id, { listFn, catalog, key, at: Date.now() });
    if (catalog) await recordObservedModels(id, key, { catalog });
    return catalog;
  }, options.context);
}

interface CachedObservation { observeFn: CliAdapter['observeModel']; model: string | undefined; key: string; at: number }
const observations = new Map<string, CachedObservation>();

/**
 * Returns the concrete model the CLI reports for a requested name, or for no name: from
 * memory for up to five minutes, else from `models.json` for up to a day, else asked from
 * the CLI (`observeModel`) and recorded in both. Concurrent misses share one request.
 * @param id - Backend to ask.
 * @param requested - The requested name; omitted for the model the CLI runs without one.
 * @param options - `fresh` asks the CLI again (doctor); `probe` reuses pre-probed evidence; `context` supplies read budget/signal.
 * @returns The model, or undefined when the adapter cannot observe one or the CLI did not say.
 */
export async function readObservedModel(
  id: ProviderId,
  requested?: string,
  options: ReadObservedModelOptions = {}
): Promise<string | undefined> {
  const adapter = adapterRegistry[id];
  if (!adapter.observeModel) return undefined;
  const probe = options.probe ?? await probeBackend(id, { context: options.context });
  if (!probe.installed) return undefined;
  const key = probeKey(probe);
  const name = requested ?? '';
  const memoryKey = `${id}:${name}`;
  const cached = observations.get(memoryKey);
  if (!options.fresh && cached && cached.observeFn === adapter.observeModel && cached.key === key && Date.now() - cached.at < PROBE_TTL_MS) return cached.model;
  const stored = options.fresh ? undefined : readObservedModels(id, key)?.resolved?.[name];
  if (stored && Date.now() - stored.observedAt < STORED_TTL_MS) {
    observations.set(memoryKey, { observeFn: adapter.observeModel, model: stored.model, key, at: Date.now() });
    return stored.model;
  }
  const observeFn = adapter.observeModel;
  return coalesce(`observe:${memoryKey}:${key}`, observeFn, !options.fresh, async (readContext) => {
    const model = await observeFn.call(adapter, requested, probe, readContext);
    observations.set(memoryKey, { observeFn, model, key, at: Date.now() });
    if (model) await recordObservedModels(id, key, { resolved: { [name]: model } });
    return model;
  }, options.context);
}
