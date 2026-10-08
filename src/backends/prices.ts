/**
 * Approximate public API prices of models (`EXEC-001`, owner decision of 2026-10-07). They
 * decide whether to ask the user before a model runs and whether a model meets a user's price
 * limit (`AX-002`); never billing, a request's cost or a model's safety.
 *
 * @remarks
 * The list comes from `coagent8_PRICES_URL` (an http(s) URL, or a local file for a mirror or
 * an offline copy), else OpenRouter's public `GET /api/v1/models`, which needs no key and
 * receives no user data. A read is bounded in time and size and validated. Only the prices of
 * models the backends offer are kept (`models.json`), matched when the list is read: output,
 * uncached and cached input per million tokens (owner decision of 2026-10-08).
 *
 * List prices change rarely, so a stored list is used as is and read again in the background
 * once it is a day old ({@link PRICE_REFRESH_MS}). A call waits for a read only when no list
 * is stored, when it needs a model the stored list has not checked, or, with a price limit,
 * when the list is older than a week ({@link PRICE_STALE_MS}). Reads are shared and a failed
 * one is retried after five minutes. Only an exact match from a list younger than a week
 * meets a limit ({@link checkPriceLimit}).
 *
 * @packageDocumentation
 */
import { readBoundedFileSync } from '../execution/stream.js';
import { redactDiagnostic } from '../redaction.js';
import { readObservedModelNames, readStoredPrices, recordPrices, type PriceRecord, type StoredPrices } from './model-store.js';

const DEFAULT_PRICES_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 10_000;
/** The OpenRouter list was 774 KB on 2026-10-07. */
const MAX_PRICE_LIST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5000;
/** Age after which a stored list is read again in the background. */
export const PRICE_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Age after which a list no longer shows that a model meets a user's price limit. */
export const PRICE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Suffixes that name a reasoning effort, not another model (agy `gemini-3.8-flash-high`). */
const EFFORT_SUFFIX = /-(?:none|minimal|low|medium|high|xhigh|max)$/;
/** A dated snapshot of a model (`-20251001`). */
const DATE_SUFFIX = /-\d{8}$/;

/** The prices of the models the backends offer, as last read. */
export type PriceList = StoredPrices;

/** The price found for a model: list prices in USD per million tokens and the matched entry. */
export type ModelPrice = PriceRecord;

/** One entry of a price list as read: list prices in USD per million tokens. */
export interface ListedPrice {
  id: string;
  output: number;
  input: number | null;
  cachedInput: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reads one per-token price. Number(null) and Number('') are 0, so only a number or a
 * non-blank string is a price: a missing price must not read as free (AX-002).
 * @returns USD per million tokens, rounded to four decimals, or null.
 */
function perMillion(raw: unknown): number | null {
  const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6 * 1e4) / 1e4 : null;
}

/**
 * Reads an OpenRouter-shaped `{ data: [{ id, pricing: { completion, prompt, input_cache_read } }] }`.
 * @returns The entries with an output price, or undefined when the payload has none.
 * Variants (`:batch`, `:free`) are left out.
 */
export function parsePriceList(payload: unknown): ListedPrice[] | undefined {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return undefined;
  const entries: ListedPrice[] = [];
  for (const item of data.slice(0, MAX_ENTRIES)) {
    const entry = record(item);
    const id = entry?.id, pricing = record(entry?.pricing);
    const output = perMillion(pricing?.completion);
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(id) || output === null) continue;
    entries.push({ id, output, input: perMillion(pricing?.prompt), cachedInput: perMillion(pricing?.input_cache_read) });
  }
  return entries.length ? entries : undefined;
}

function normalize(name: string): string {
  return (name.toLowerCase().split('/').pop() ?? '').replace(/\[[^\]]*\]$/, '').replace(/\./g, '-');
}

/** The key a model's price is stored under. */
export function priceKey(model: string): string {
  return model.toLowerCase();
}

/**
 * Matches models a CLI names to list entries: exactly, also without an effort or date suffix
 * (`gemini-3.8-flash-high`, `claude-haiku-4-5-20251001`), else approximately, when one name
 * extends the other (`claude-opus-4-6-thinking`, `gemini-3.1-pro-preview`). A context
 * variant (`[1m]`) is approximate. Among several entries the highest output price is taken.
 * @returns Per {@link priceKey}, the price or null when no entry matches.
 */
export function matchPrices(entries: readonly ListedPrice[], models: Iterable<string>): Record<string, PriceRecord | null> {
  const named = new Map<string, ListedPrice[]>();
  for (const entry of entries) {
    const key = normalize(entry.id);
    named.set(key, [...(named.get(key) ?? []), entry]);
  }
  const highest = (found: ListedPrice[], exact: boolean): PriceRecord => {
    const top = found.reduce((best, entry) => entry.output > best.output ? entry : best);
    return { output: top.output, input: top.input, cachedInput: top.cachedInput, matched: top.id, exact };
  };
  const match = (model: string): PriceRecord | null => {
    const variant = /\[[^\]]*\]$/.test(model);
    const base = normalize(model);
    for (const candidate of [base, base.replace(EFFORT_SUFFIX, ''), base.replace(DATE_SUFFIX, '')]) {
      const found = named.get(candidate);
      if (found) return highest(found, !variant);
    }
    const stem = base.replace(EFFORT_SUFFIX, '');
    const loose = [...named].filter(([key]) => key.startsWith(`${stem}-`) || stem.startsWith(`${key}-`)).flatMap(([, found]) => found);
    return loose.length ? highest(loose, false) : null;
  };
  const prices: Record<string, PriceRecord | null> = {};
  for (const model of models) prices[priceKey(model)] = match(model);
  return prices;
}

/** Returns the price of a model the list has checked; undefined when it has none or was not checked. */
export function findPrice(list: PriceList, model: string): ModelPrice | undefined {
  return list.models[priceKey(model)] ?? undefined;
}

async function readSource(source: string): Promise<string> {
  if (!/^https?:\/\//i.test(source)) return readBoundedFileSync(source, MAX_PRICE_LIST_BYTES);
  const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok || !response.body) throw new Error(`price list answered HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_PRICE_LIST_BYTES) throw new Error('price list exceeds the size limit');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_PRICE_LIST_BYTES) throw new Error('price list exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the price list from its source and stores the prices of the models the backends
 * offer, those checked before and `models`.
 * @param models - Further models to match, such as the one a call names.
 * @returns The prices, or undefined when the source is unreachable, too slow, too large or
 * malformed; the reason goes to stderr.
 */
export async function refreshPrices(models: readonly string[] = []): Promise<PriceList | undefined> {
  const source = process.env.coagent8_PRICES_URL || DEFAULT_PRICES_URL;
  let entries: ListedPrice[] | undefined;
  try { entries = parsePriceList(JSON.parse(await readSource(source))); }
  catch (err) {
    process.stderr.write(`Warning: model prices not read: ${redactDiagnostic((err as Error).message, 256)}\n`);
    return undefined;
  }
  if (!entries) {
    process.stderr.write('Warning: model prices not read: the price list names no priced model.\n');
    return undefined;
  }
  const names = new Set([...readObservedModelNames(), ...Object.keys(readStoredPrices()?.models ?? {}), ...models]);
  const list: PriceList = { fetchedAt: Date.now(), source: source === DEFAULT_PRICES_URL ? 'openrouter' : 'coagent8_PRICES_URL', models: matchPrices(entries, names) };
  await recordPrices(list);
  return list;
}

/** Wait before an unreachable price source is tried again. */
const RETRY_MS = 5 * 60 * 1000;
let running: Promise<PriceList | undefined> | undefined;
let failedAt = 0;

const covers = (list: PriceList | undefined, models: readonly string[]) => list !== undefined && models.every(model => priceKey(model) in list.models);

/**
 * Reads the list once at a time: a caller joins a read in progress that covers its models,
 * and none starts within five minutes of a failure.
 */
async function sharedRefresh(models: readonly string[]): Promise<PriceList | undefined> {
  if (running) {
    const joined = await running;
    if (covers(joined, models)) return joined;
  }
  if (Date.now() - failedAt < RETRY_MS) return undefined;
  const read = running = refreshPrices(models).finally(() => { if (running === read) running = undefined; });
  const list = await read;
  if (!list) failedAt = Date.now();
  return list;
}

/**
 * Whether a list is too old to show that a model meets a user's price limit (`AX-002`).
 * @param now - Milliseconds since the epoch.
 */
export function isPriceListStale(list: PriceList, now = Date.now()): boolean {
  return now - list.fetchedAt >= PRICE_STALE_MS;
}

/**
 * Returns the stored prices, reading the list when needed (see the module remarks).
 * @param options - `models` the call needs priced; `current` for a call with a price limit,
 * which waits for a read of a list older than a week; `refresh` (doctor) waits for a read of
 * a list older than a day instead of leaving it to the background.
 * @returns The prices, or the stored ones when a read fails; undefined when none exist.
 */
export async function readPrices(options: { models?: readonly string[]; current?: boolean; refresh?: boolean } = {}): Promise<PriceList | undefined> {
  const models = options.models ?? [];
  const stored = readStoredPrices();
  const age = stored ? Date.now() - stored.fetchedAt : Infinity;
  const wait = !covers(stored, models) || (options.current && age >= PRICE_STALE_MS) || (options.refresh && age >= PRICE_REFRESH_MS);
  if (wait) return (await sharedRefresh(models)) ?? stored;
  // A day-old list stays in use while a background read replaces it; that read reports its own failure.
  if (age >= PRICE_REFRESH_MS && !running) void sharedRefresh([]);
  return stored;
}

/** How a model's price was found: by its name, only by a looser comparison, or not at all. */
export type PriceMatch = 'exact' | 'approximate' | 'unknown';

/**
 * What the price list says about one concrete model (`AX-001`): public list prices per
 * million tokens, not a request estimate, measured usage or a bill.
 */
export interface PriceEvidence {
  /** USD per million output tokens; null when unknown. */
  outputUsdPerMTok: number | null;
  /** USD per million uncached input tokens; null when unknown. */
  inputUsdPerMTok: number | null;
  /** USD per million cached input tokens read; null when unknown. */
  cachedInputUsdPerMTok: number | null;
  /** The list entry the price belongs to; null when unknown. */
  matched: string | null;
  match: PriceMatch;
  /** Where the list came from (`openrouter` or `coagent8_PRICES_URL`); null without a list. */
  source: string | null;
  /** When the list was read, as an ISO timestamp; null without a list. */
  fetchedAt: string | null;
  /** The list is older than {@link PRICE_STALE_MS}, so it cannot satisfy a price limit. */
  stale: boolean;
}

/**
 * Looks up a concrete model in a price list.
 * @param list - The price list, or undefined when none could be read.
 * @param model - The model the backend runs, aliases already resolved.
 * @param now - Milliseconds since the epoch, for staleness.
 */
export function priceEvidence(list: PriceList | undefined, model: string, now = Date.now()): PriceEvidence {
  if (!list) return { outputUsdPerMTok: null, inputUsdPerMTok: null, cachedInputUsdPerMTok: null, matched: null, match: 'unknown', source: null, fetchedAt: null, stale: false };
  const price = findPrice(list, model);
  return {
    outputUsdPerMTok: price?.output ?? null,
    inputUsdPerMTok: price?.input ?? null,
    cachedInputUsdPerMTok: price?.cachedInput ?? null,
    matched: price?.matched ?? null,
    match: !price ? 'unknown' : price.exact ? 'exact' : 'approximate',
    source: list.source,
    fetchedAt: new Date(list.fetchedAt).toISOString(),
    stale: isPriceListStale(list, now),
  };
}

const usd = (value: number) => `${Number(value.toFixed(4))} USD`;

/**
 * Checks a user's price limit (`AX-002`). Separate from consent: neither `neverAsk` nor an
 * approval makes a model meet a limit, and only an exact price from a current list does.
 * @param model - The concrete model, for the message.
 * @param evidence - Its {@link priceEvidence}.
 * @param below - The limit in USD per million output tokens; strict, so a model priced at
 * exactly the limit does not meet it.
 * @returns Why the model does not meet the limit, or undefined when it does.
 */
export function checkPriceLimit(model: string, evidence: PriceEvidence, below: number): string | undefined {
  const limit = `below ${usd(below)} per million output tokens`;
  if (!evidence.source) return `No price list is available, so '${model}' cannot be shown to cost ${limit}.`;
  const list = `${evidence.source} list of ${evidence.fetchedAt!.slice(0, 10)}`;
  if (evidence.stale) return `The ${list} is older than seven days and could not be read again, so '${model}' cannot be shown to cost ${limit}.`;
  if (evidence.match === 'unknown') return `The ${list} has no price for '${model}', so it cannot be shown to cost ${limit}.`;
  if (evidence.match === 'approximate') return `The ${list} prices '${model}' only approximately, as ${evidence.matched} at ${usd(evidence.outputUsdPerMTok!)}, so it cannot be shown to cost ${limit}.`;
  if (evidence.outputUsdPerMTok! >= below) return `'${model}' costs ${usd(evidence.outputUsdPerMTok!)} per million output tokens (${list}), not ${limit}.`;
  return undefined;
}
