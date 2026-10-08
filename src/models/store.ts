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
import { PROVIDERS, type ProviderId } from '../contracts/provider.js';
import { redactDiagnostic } from '../security/redaction.js';
import { readBoundedFileSync } from '../storage/read.js';
import { atomicWrite, withFileLock } from '../storage/lock.js';
import { isValidModelIdentifier } from './identifier.js';
import type { CatalogModel, ModelCatalog } from '../contracts/models.js';

/** Version 2 (2026-10-08) keeps per-model prices instead of the whole price list. */
const STORE_VERSION = 2;
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

/** The list price of one model, in USD per million tokens. */
export interface PriceRecord {
  output: number;
  /** Uncached input; null when the list states none. */
  input: number | null;
  /** Cached input read; null when the list states none. */
  cachedInput: number | null;
  /** The list entry the prices belong to. */
  matched: string;
  /** False when the entry was found only by a looser name comparison. */
  exact: boolean;
}

/**
 * Prices of the models the backends offer, matched once when the list was read: only these
 * are kept, not the whole list. A model checked without a match maps to null, so it is not
 * looked up again before the next read.
 */
export interface StoredPrices {
  /** Milliseconds since the epoch. */
  fetchedAt: number;
  /** Where the list came from: `openrouter` or `coagent8_PRICES_URL`. */
  source: string;
  /** Keyed by the model name in lower case. */
  models: Record<string, PriceRecord | null>;
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
  const aliases = entry.aliases;
  if (aliases !== undefined && !(Array.isArray(aliases) && aliases.every(isValidModelIdentifier))) return null;
  return { id: entry.id, efforts: entry.efforts as string[], ...(entry.effortRequired === true ? { effortRequired: true } : {}), ...(entry.isDefault === true ? { isDefault: true } : {}),
    ...(aliases?.length ? { aliases: aliases as string[] } : {}) };
}

function parseEntry(value: unknown): ObservedModels | null {
  const entry = record(value);
  if (!entry || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key)) return null;
  const parsed: ObservedModels = { key: entry.key };
  const catalog = record(entry.catalog);
  if (catalog) {
    const models = Array.isArray(catalog.models) ? catalog.models.map(parseCatalogModel) : [];
    if (!models.length || models.includes(null) || typeof catalog.source !== 'string' || !isTime(catalog.observedAt)) return null;
    parsed.catalog = { models: models as CatalogModel[], source: catalog.source.slice(0, 128), observedAt: catalog.observedAt, ...(catalog.acceptsUnlisted === true ? { acceptsUnlisted: true } : {}) };
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

const isPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parsePriceRecord(value: unknown): PriceRecord | null | undefined {
  if (value === null) return null;
  const price = record(value);
  if (!price || !isPrice(price.output) || !(price.input === null || isPrice(price.input)) || !(price.cachedInput === null || isPrice(price.cachedInput))
    || typeof price.matched !== 'string' || price.matched.length > 128 || typeof price.exact !== 'boolean') return undefined;
  return { output: price.output, input: price.input, cachedInput: price.cachedInput, matched: price.matched, exact: price.exact };
}

/** Validates stored prices; any invalid model entry discards them all, so a damaged file is read again. */
function parsePrices(value: unknown): StoredPrices | undefined {
  const prices = record(value);
  const models = record(prices?.models);
  if (!prices || !models || !isTime(prices.fetchedAt) || typeof prices.source !== 'string') return undefined;
  const parsed: Record<string, PriceRecord | null> = {};
  for (const [name, entry] of Object.entries(models)) {
    const price = parsePriceRecord(entry);
    if (price === undefined || !isValidModelIdentifier(name)) return undefined;
    parsed[name] = price;
  }
  return { fetchedAt: prices.fetchedAt, source: prices.source.slice(0, 64), models: parsed };
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
  // An older version is replaced quietly: it holds only observations the CLIs repeat.
  if (typeof parsed?.schemaVersion === 'number' && parsed.schemaVersion < STORE_VERSION) return { backends: {} };
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

/**
 * Names every model the stored observations mention: catalog ids, agy's `<id>-<effort>`
 * forms and the concrete models names resolved to. Prices are matched for these.
 */
export function readObservedModelNames(): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(readStore().backends)) {
    for (const model of entry?.catalog?.models ?? []) {
      names.add(model.id);
      if (model.effortRequired) for (const effort of model.efforts) names.add(`${model.id}-${effort}`);
    }
    for (const observed of Object.values(entry?.resolved ?? {})) names.add(observed.model);
  }
  return [...names];
}

