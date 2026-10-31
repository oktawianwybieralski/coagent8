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
import { ToolError, isValidModelIdentifier, type ProviderId } from '../contracts/index.js';
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

interface CachedProbe {
  adapter: CliAdapter;
  probeFn: CliAdapter['probe'];
  probe: AdapterProbeResult;
  key: string;
  at: number;
}
const cache = new Map<ProviderId, CachedProbe>();

interface InflightWaiter<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
  active: boolean;
}

interface InflightEntry<T> {
  owner: unknown;
  abortController: AbortController;
  waiters: Set<InflightWaiter<T>>;
  settled: boolean;
  result?: { ok: true; value: T } | { ok: false; error: unknown };
}

/** Reads in progress, so concurrent misses share one CLI launch (CUR-006, EXEC-001-T08b). */
const inflight = new Map<string, InflightEntry<unknown>>();

function toAbortError(reason: unknown): ToolError {
  if (reason instanceof ToolError) return reason;
  if (reason instanceof Error) {
    return new ToolError('ABORTED', reason.message, { cause: reason });
  }
  if (typeof reason === 'string' && reason.length > 0) {
    return new ToolError('ABORTED', reason);
  }
  return new ToolError('ABORTED', 'Read operation was aborted by caller.');
}

function getPreAbortError(context?: BackendReadContext): ToolError | undefined {
  if (!context) return undefined;
  if (context.abortSignal?.aborted) {
    return toAbortError(context.abortSignal.reason);
  }
  if (context.budget) {
    if (context.budget.isCallerAborted()) {
      const reason = context.budget.abortReason();
      return reason instanceof ToolError ? reason : toAbortError(reason);
    }
    if (context.budget.isExecutionExpired() || context.budget.isTimedOut()) {
      const reason = context.budget.abortReason();
      return reason instanceof ToolError ? reason : new ToolError('TIMEOUT', 'Execution budget expired.');
    }
  }
  if (context.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs <= 0) {
    return new ToolError('TIMEOUT', 'Read operation timed out.');
  }
  return undefined;
}

/**
 * Checks whether the shared read matching `readContext` is still the active inflight entry for `key`.
 * Prevents evicted or replaced reads from poisoning persistent caches on late settlement (`EXEC-001-T08b`).
 */
function isCurrentInflight(key: string, readContext?: BackendReadContext): boolean {
  if (!readContext?.abortSignal) return false;
  const current = inflight.get(key);
  return current !== undefined && current.abortController.signal === readContext.abortSignal;
}

/**
 * Shares a read in progress under `key` while it belongs to the same adapter function (`EXEC-001-T08b`).
 * Enforces per-waiter cancellation/timeout isolation, last-waiter owned abort, and safe inflight removal.
 * @param key - Cache coalescence key.
 * @param owner - Function identity to detect replaced adapters.
 * @param join - False for a `fresh` read, which starts its own and is shared from then on.
 * @param start - Invokes the underlying observation task with a shared cancellation context.
 * @param context - Optional neutral read and cancellation context for the waiter.
 */
function coalesce<T>(
  key: string,
  owner: unknown,
  join: boolean,
  start: (context?: BackendReadContext) => Promise<T>,
  context?: BackendReadContext,
): Promise<T> {
  const preAbort = getPreAbortError(context);
  if (preAbort) {
    return Promise.reject(preAbort);
  }

  let entry: InflightEntry<T> | undefined;
  const running = inflight.get(key) as InflightEntry<T> | undefined;
  if (join && running && running.owner === owner && !running.abortController.signal.aborted) {
    entry = running;
  }

  if (!entry) {
    const newEntry: InflightEntry<T> = {
      owner,
      abortController: new AbortController(),
      waiters: new Set(),
      settled: false,
    };
    entry = newEntry;
    inflight.set(key, newEntry as InflightEntry<unknown>);

    const sharedContext: BackendReadContext = {
      abortSignal: newEntry.abortController.signal,
    };

    let startPromise: Promise<T>;
    try {
      startPromise = start(sharedContext);
    } catch (err) {
      startPromise = Promise.reject(err);
    }

    startPromise
      .then(
        value => {
          newEntry.settled = true;
          newEntry.result = { ok: true, value };
          for (const waiter of newEntry.waiters) {
            if (waiter.active) {
              waiter.active = false;
              try {
                waiter.cleanup();
              } catch {
                /* ignore */
              }
              waiter.resolve(value);
            }
          }
          newEntry.waiters.clear();
        },
        error => {
          newEntry.settled = true;
          newEntry.result = { ok: false, error };
          for (const waiter of newEntry.waiters) {
            if (waiter.active) {
              waiter.active = false;
              try {
                waiter.cleanup();
              } catch {
                /* ignore */
              }
              waiter.reject(error);
            }
          }
          newEntry.waiters.clear();
        },
      )
      .finally(() => {
        if (inflight.get(key) === (newEntry as InflightEntry<unknown>)) {
          inflight.delete(key);
        }
      })
      .catch(() => {});
  }

  const currentEntry = entry;
  return new Promise<T>((resolve, reject) => {
    if (currentEntry.settled && currentEntry.result) {
      if (currentEntry.result.ok) {
        resolve(currentEntry.result.value);
      } else {
        reject(currentEntry.result.error);
      }
      return;
    }

    const waiter: InflightWaiter<T> = {
      resolve,
      reject,
      cleanup: () => {},
      active: true,
    };

    function detachWaiter(error: unknown): void {
      if (!waiter.active) return;
      waiter.active = false;
      try {
        waiter.cleanup();
      } catch {
        /* ignore */
      }
      currentEntry.waiters.delete(waiter);
      waiter.reject(error);

      if (currentEntry.waiters.size === 0 && !currentEntry.settled) {
        currentEntry.abortController.abort(error);
        if (inflight.get(key) === (currentEntry as InflightEntry<unknown>)) {
          inflight.delete(key);
        }
      }
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const onAbort = () => {
      detachWaiter(toAbortError(context?.abortSignal?.reason));
    };
    const onBudgetAbort = () => {
      const budgetReason = context?.budget?.abortReason();
      const reason =
        budgetReason instanceof ToolError
          ? budgetReason
          : context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()
            ? new ToolError('TIMEOUT', 'Execution budget expired.')
            : toAbortError(budgetReason);
      detachWaiter(reason);
    };

    waiter.cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (context?.abortSignal) {
        context.abortSignal.removeEventListener('abort', onAbort);
      }
      if (context?.budget) {
        context.budget.executionSignal.removeEventListener('abort', onBudgetAbort);
      }
    };

    currentEntry.waiters.add(waiter);

    if (context?.abortSignal) {
      if (context.abortSignal.aborted) {
        detachWaiter(toAbortError(context.abortSignal.reason));
        return;
      }
      context.abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    if (context?.budget) {
      if (context.budget.isCallerAborted()) {
        detachWaiter(toAbortError(context.budget.abortReason()));
        return;
      }
      if (context.budget.isExecutionExpired() || context.budget.isTimedOut()) {
        const reason = context.budget.abortReason();
        detachWaiter(reason instanceof ToolError ? reason : new ToolError('TIMEOUT', 'Execution budget expired.'));
        return;
      }
      context.budget.executionSignal.addEventListener('abort', onBudgetAbort, { once: true });
    }

    if (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        detachWaiter(new ToolError('TIMEOUT', `Read operation timed out after ${context.timeoutMs} ms.`));
      }, context.timeoutMs);
    }
  });
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
  const providerVariables = Object.keys(process.env)
    .filter(name => PROVIDER_ENVIRONMENT_PREFIXES.some(prefix => name.startsWith(prefix)))
    .sort();
  const parts: string[] = [...PROBE_ENVIRONMENT, ...providerVariables].map(name => `${name}=${process.env[name] ?? ''}`);
  if (probe.command) {
    let files: string[];
    try {
      const resolved = resolveCliCommand(probe.command);
      files = [resolved.command, ...resolved.argsPrefix].filter(part => path.isAbsolute(part));
    } catch (err) {
      files = [`unresolved:${(err as Error).message}`];
    }
    parts.push(...files.map(file => (file.startsWith('unresolved:') ? file : fileStamp(file))));
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
 * Concurrent misses share one probe; a failed probe, and an uninstalled probe without a
 * command (a configured executable that does not exist yet), is not cached.
 * @param id - Backend to probe.
 * @param options - `fresh` always probes and replaces the cached result (doctor); `context` supplies read budget/signal.
 */
export async function probeBackend(id: ProviderId, options: ProbeBackendOptions = {}): Promise<AdapterProbeResult> {
  const adapter = adapterRegistry[id];
  const cached = cache.get(id);
  if (
    !options.fresh &&
    cached &&
    cached.adapter === adapter &&
    cached.probeFn === adapter.probe &&
    Date.now() - cached.at < PROBE_TTL_MS &&
    cached.key === probeKey(cached.probe)
  ) {
    return cached.probe;
  }
  const probeFn = adapter.probe;
  const inflightKey = `probe:${id}`;
  return coalesce(
    inflightKey,
    probeFn,
    !options.fresh,
    async readContext => {
      const probe = await probeFn.call(adapter, readContext);
      // An uninstalled probe without a command reports a configured executable that is not there
      // yet (for example a vendor extension still installing its CLI). Its key cannot see the
      // file appear, and repeating that check launches nothing, so it is never reused.
      if (!readContext?.abortSignal?.aborted && isCurrentInflight(inflightKey, readContext)) {
        if (probe.installed || probe.command) cache.set(id, { adapter, probeFn, probe, key: probeKey(probe), at: Date.now() });
        else cache.delete(id);
      }
      return probe;
    },
    options.context,
  );
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

interface CachedCatalog {
  listFn: CliAdapter['listModels'];
  catalog: ModelCatalog | undefined;
  key: string;
  at: number;
}
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
  const probe = options.probe ?? (await probeBackend(id, { context: options.context }));
  if (!probe.installed) return undefined;
  const key = probeKey(probe);
  const cached = catalogs.get(id);

  if (!options.fresh) {
    if (
      options.catalog &&
      cached &&
      cached.catalog === options.catalog &&
      cached.key === key &&
      cached.listFn === adapter.listModels &&
      Date.now() - cached.at < PROBE_TTL_MS
    ) {
      return cached.catalog;
    }
    if (cached && cached.listFn === adapter.listModels && cached.key === key && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.catalog;
    }
  }

  const stored = options.fresh ? undefined : readObservedModels(id, key)?.catalog;
  if (stored && Date.now() - stored.observedAt < STORED_TTL_MS) {
    const catalog: ModelCatalog = {
      models: stored.models,
      source: stored.source,
      ...(stored.acceptsUnlisted ? { acceptsUnlisted: true } : {}),
    };
    catalogs.set(id, { listFn: adapter.listModels, catalog, key, at: Date.now() });
    return catalog;
  }
  const listFn = adapter.listModels;
  const inflightKey = `catalog:${id}:${key}`;
  return coalesce(
    inflightKey,
    listFn,
    !options.fresh,
    async readContext => {
      const catalog = await listFn.call(adapter, probe, readContext);
      if (!readContext?.abortSignal?.aborted && isCurrentInflight(inflightKey, readContext)) {
        catalogs.set(id, { listFn, catalog, key, at: Date.now() });
        if (catalog) await recordObservedModels(id, key, { catalog });
      }
      return catalog;
    },
    options.context,
  );
}

interface CachedObservation {
  observeFn: CliAdapter['observeModel'];
  model: string | undefined;
  key: string;
  at: number;
}
/**
 * Most observations kept in memory (AUDIT-001-A14). A requested name is any string a caller
 * passes (Claude Code accepts unlisted names), so a long-running server would otherwise keep
 * one entry per distinct name forever. The least recently used entry goes first; an evicted
 * name is read again from `models.json` or the CLI. In-flight reads live in `inflight`.
 */
export const MAX_OBSERVATIONS = 100;
const observations = new Map<string, CachedObservation>();

/** Keeps an observation as the most recently used one, evicting beyond {@link MAX_OBSERVATIONS}. */
function rememberObservation(memoryKey: string, entry: CachedObservation): void {
  observations.delete(memoryKey);
  observations.set(memoryKey, entry);
  while (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
}

/** Number of observations held in memory; for diagnostics and tests. */
export function observationCacheSize(): number {
  return observations.size;
}

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
  options: ReadObservedModelOptions = {},
): Promise<string | undefined> {
  const adapter = adapterRegistry[id];
  if (!adapter.observeModel) return undefined;
  const probe = options.probe ?? (await probeBackend(id, { context: options.context }));
  if (!probe.installed) return undefined;
  const key = probeKey(probe);
  const name = requested ?? '';
  const memoryKey = `${id}:${name}`;
  const cached = observations.get(memoryKey);
  if (
    !options.fresh &&
    cached &&
    cached.observeFn === adapter.observeModel &&
    cached.key === key &&
    Date.now() - cached.at < PROBE_TTL_MS
  ) {
    rememberObservation(memoryKey, cached);
    return cached.model;
  }
  // A stale entry (expired, another executable, configuration or adapter) is dropped when met.
  if (cached) observations.delete(memoryKey);
  const stored = options.fresh ? undefined : readObservedModels(id, key)?.resolved?.[name];
  if (stored && Date.now() - stored.observedAt < STORED_TTL_MS) {
    rememberObservation(memoryKey, { observeFn: adapter.observeModel, model: stored.model, key, at: Date.now() });
    return stored.model;
  }
  const observeFn = adapter.observeModel;
  const observeInflightKey = `observe:${memoryKey}:${key}`;
  return coalesce(
    observeInflightKey,
    observeFn,
    !options.fresh,
    async readContext => {
      const model = await observeFn.call(adapter, requested, probe, readContext);
      if (!readContext?.abortSignal?.aborted && isCurrentInflight(observeInflightKey, readContext)) {
        rememberObservation(memoryKey, { observeFn, model, key, at: Date.now() });
        if (model) await recordObservedModels(id, key, { resolved: { [name]: model } });
      }
      return model;
    },
    options.context,
  );
}

/**
 * Records that a turn completed on this backend with `model` (`AX-005b`).
 * @remarks Bound to the current CLI installation's key, so an update of the CLI, its
 * configuration or its environment starts without the evidence. Reuses the cached probe
 * (no process starts when it is fresh). Best-effort: a store failure is not thrown.
 */
export async function recordTurnSuccess(id: ProviderId, model: string, context?: BackendReadContext): Promise<void> {
  // Without a valid model name there is nothing to attribute the evidence to.
  if (!isValidModelIdentifier(model)) return;
  const probe = await probeBackend(id, { context });
  if (!probe.installed) return;
  await recordObservedModels(id, probeKey(probe), { success: model });
}

/** The last completed turn of the current installation, or undefined. */
export function readTurnSuccess(id: ProviderId, probe: AdapterProbeResult): { model: string; observedAt: number } | undefined {
  return probe.installed ? readObservedModels(id, probeKey(probe))?.lastSuccess : undefined;
}
