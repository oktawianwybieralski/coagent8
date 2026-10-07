/**
 * Observed model state in `~/.coagent8/models.json` (`EXEC-001`): the catalogs the backend
 * CLIs listed, the concrete models they reported for a requested name, and the public model
 * prices last read, so a new server process does not read them again.
 *
 * @remarks
 * This is observed state, not user intent, so it stays out of `config.json`. Each backend
 * entry carries the key of the CLI installation that produced it (a hash of its executable,
 * configuration and environment stamps) and each observation its time; another key, an
 * older observation or an unreadable file is a miss, and the next observation replaces it.
 * A failed write is reported and never fails the call that observed the models.
 *
 * @packageDocumentation
 */
import path from 'node:path';
import { getDataDir } from '../paths.js';
import { PROVIDERS, type ProviderId } from '../conversation.js';
import { redactDiagnostic } from '../redaction.js';
import { readBoundedFileSync } from '../execution/stream.js';
import { atomicWrite, withFileLock } from '../sessions/lock.js';
import { isValidModelIdentifier } from './model-identifier.js';
import type { CatalogModel, ModelCatalog } from './types.js';

const STORE_VERSION = 1;
/** Upper bound for reading the store; catalogs and a price list are a few dozen kilobytes. */
const STORE_MAX_BYTES = 1024 * 1024;

/** A catalog with the time the CLI listed it. */
export interface ObservedCatalog extends ModelCatalog {
  /** Milliseconds since the epoch. */
  observedAt: number;
}

/** A concrete model the CLI reported for a requested name, with the time it did. */
export interface ObservedModel {
  model: string;
  /** Milliseconds since the epoch. */
  observedAt: number;
}

/** What one backend CLI reported, and for which installation. */
export interface ObservedModels {
  /** Key of the CLI installation the observations belong to. */
  key: string;
  catalog?: ObservedCatalog;
  /** Per requested name; `''` is the request without a model. */
  resolved?: Record<string, ObservedModel>;
}

/** A price list as read: the output price in USD per million tokens of each listed model. */
export interface StoredPrices {
  /** Milliseconds since the epoch. */
  fetchedAt: number;
  /** Where the list came from: `openrouter` or `coagent8_PRICES_URL`. */
  source: string;
  entries: Array<[string, number]>;
}

type Store = Partial<Record<ProviderId, ObservedModels>>;
interface StoreFile { backends: Store; prices?: StoredPrices }

function getModelStoreFile(): string {
  return path.join(getDataDir(), 'models.json');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function parseCatalogModel(value: unknown): CatalogModel | null {
  const entry = record(value);
  if (!entry || !isValidModelIdentifier(entry.id) || !Array.isArray(entry.efforts) || !entry.efforts.every(effort => typeof effort === 'string' && effort.length <= 32)) return null;
  return { id: entry.id, efforts: entry.efforts as string[], ...(entry.effortRequired === true ? { effortRequired: true } : {}), ...(entry.isDefault === true ? { isDefault: true } : {}) };
}

function parseEntry(value: unknown): ObservedModels | null {
  const entry = record(value);
  if (!entry || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key)) return null;
  const parsed: ObservedModels = { key: entry.key };
  const catalog = record(entry.catalog);
  if (catalog) {
    const models = Array.isArray(catalog.models) ? catalog.models.map(parseCatalogModel) : [];
    if (!models.length || models.includes(null) || typeof catalog.source !== 'string' || !isTime(catalog.observedAt)) return null;
    parsed.catalog = { models: models as CatalogModel[], source: catalog.source.slice(0, 128), observedAt: catalog.observedAt };
  }
  const resolved = record(entry.resolved);
  if (resolved) {
    parsed.resolved = {};
    for (const [name, observed] of Object.entries(resolved)) {
      const item = record(observed);
      if ((name !== '' && !isValidModelIdentifier(name)) || !item || !isValidModelIdentifier(item.model) || !isTime(item.observedAt)) return null;
      parsed.resolved[name] = { model: item.model, observedAt: item.observedAt };
    }
  }
  return parsed;
}

function parsePrices(value: unknown): StoredPrices | undefined {
  const prices = record(value);
  if (!prices || !isTime(prices.fetchedAt) || typeof prices.source !== 'string' || !Array.isArray(prices.entries)) return undefined;
  const entries = prices.entries.filter((entry): entry is [string, number] => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && entry[0].length <= 128 && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0);
  return entries.length && entries.length === prices.entries.length ? { fetchedAt: prices.fetchedAt, source: prices.source.slice(0, 64), entries } : undefined;
}

/** Reads the store; a missing file is empty, an unreadable or invalid one is reported and treated as empty. */
function readStore(): StoreFile {
  const file = getModelStoreFile();
  let raw: string;
  try { raw = readBoundedFileSync(file, STORE_MAX_BYTES); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`Warning: model store not read: ${redactDiagnostic((err as Error).message, 256)}\n`);
    return { backends: {} };
  }
  let parsed: Record<string, unknown> | null;
  try { parsed = record(JSON.parse(raw)); }
  catch { parsed = null; }
  const backends = parsed?.schemaVersion === STORE_VERSION ? record(parsed.backends) : null;
  if (!parsed || !backends) {
    process.stderr.write(`Warning: model store ${redactDiagnostic(file, 256)} is not valid; it is rebuilt from the CLIs.\n`);
    return { backends: {} };
  }
  const store: Store = {};
  for (const id of PROVIDERS) {
    const entry = parseEntry(backends[id]);
    if (entry) store[id] = entry;
  }
  const prices = parsePrices(parsed.prices);
  return prices ? { backends: store, prices } : { backends: store };
}

/** Applies a change to the store under its lock; a failure is reported on stderr, never thrown. */
async function updateStore(change: (store: StoreFile) => void): Promise<void> {
  const file = getModelStoreFile();
  try {
    await withFileLock(file, async () => {
      const store = readStore();
      change(store);
      await atomicWrite(file, JSON.stringify({ schemaVersion: STORE_VERSION, ...store }, null, 2));
    });
  } catch (err) {
    process.stderr.write(`Warning: model store not written: ${redactDiagnostic((err as Error).message, 256)}\n`);
  }
}

/**
 * Returns what the backend's CLI reported for this installation.
 * @param id - Backend.
 * @param key - Key of the current CLI installation; an entry with another key is not returned.
 */
export function readObservedModels(id: ProviderId, key: string): ObservedModels | undefined {
  const entry = readStore().backends[id];
  return entry?.key === key ? entry : undefined;
}

/**
 * Records an observation for the backend. A catalog replaces the previous one; a resolved
 * name is added to those already observed for the same installation.
 * @remarks Best-effort: a lock or write failure is reported on stderr, never thrown.
 */
export async function recordObservedModels(id: ProviderId, key: string, observation: { catalog?: ModelCatalog; resolved?: Record<string, string> }): Promise<void> {
  await updateStore(({ backends }) => {
    const previous = backends[id]?.key === key ? backends[id] : undefined;
    const now = Date.now();
    const catalog = observation.catalog ? { ...observation.catalog, observedAt: now } : previous?.catalog;
    const added = Object.fromEntries(Object.entries(observation.resolved ?? {}).map(([name, model]) => [name, { model, observedAt: now }]));
    const resolved = previous?.resolved || observation.resolved ? { ...previous?.resolved, ...added } : undefined;
    backends[id] = { key, ...(catalog ? { catalog } : {}), ...(resolved ? { resolved } : {}) };
  });
}

/** Returns the price list last stored, of any age. */
export function readStoredPrices(): StoredPrices | undefined {
  return readStore().prices;
}

/**
 * Stores a price list in place of the previous one.
 * @remarks Best-effort: a lock or write failure is reported on stderr, never thrown.
 */
export async function recordPrices(prices: StoredPrices): Promise<void> {
  await updateStore(store => { store.prices = prices; });
}
