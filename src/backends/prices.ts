/**
 * Approximate public API prices of models (`EXEC-001`, owner decision of 2026-10-07). They
 * decide whether to ask the user before a model runs and whether a model meets a user's price
 * limit (`AX-002`); never billing, a request's cost or a model's safety.
 *
 * @remarks
 * The list comes from `coagent8_PRICES_URL` (an http(s) URL, or a local file for a mirror or
 * an offline copy), else OpenRouter's public `GET /api/v1/models`, which needs no key and
 * receives no user data. A read is bounded in time and size and validated, and the output
 * price per million tokens of each model is kept in `models.json`. Doctor reads a list older
 * than a week again; a turn reads one when none is stored, or, with a price limit, when the
 * stored one is older than a week, sharing the read and retrying a failure after five minutes.
 * Only an exact match from a list younger than a week meets a limit ({@link checkPriceLimit}).
 *
 * @packageDocumentation
 */
import { readBoundedFileSync } from '../execution/stream.js';
import { redactDiagnostic } from '../redaction.js';
import { readStoredPrices, recordPrices, type StoredPrices } from './model-store.js';

const DEFAULT_PRICES_URL = 'https://openrouter.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 10_000;
/** The OpenRouter list was 774 KB on 2026-10-07. */
const MAX_PRICE_LIST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 5000;
/** Age after which doctor reads the list again. */
export const PRICE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Suffixes that name a reasoning effort, not another model (agy `gemini-3.8-flash-high`). */
const EFFORT_SUFFIX = /-(?:none|minimal|low|medium|high|xhigh|max)$/;
/** A dated snapshot of a model (`-20251001`). */
const DATE_SUFFIX = /-\d{8}$/;

/** Prices of the models a list names, as read. */
export type PriceList = StoredPrices;

/** The price found for a model. */
export interface ModelPrice {
  /** USD per million output tokens. */
  output: number;
  /** The list entry the price belongs to. */
  matched: string;
  /** False when the entry was found only by a looser name comparison. */
  exact: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reads the output price of each model from an OpenRouter-shaped `{ data: [{ id, pricing }] }`.
 * @returns The entries, or undefined when the payload has none. Variants (`:batch`, `:free`)
 * and entries without a fixed price are left out.
 */
export function parsePriceList(payload: unknown): Array<[string, number]> | undefined {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const item of data.slice(0, MAX_ENTRIES)) {
    const entry = record(item);
    const id = entry?.id;
    // Number(null) and Number('') are 0: a missing price must not read as a free model (AX-002).
    const raw = record(entry?.pricing)?.completion;
    const completion = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(id) || !Number.isFinite(completion) || completion < 0) continue;
    entries.push([id, Math.round(completion * 1e6 * 1e4) / 1e4]);
  }
  return entries.length ? entries : undefined;
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
 * Reads the price list from its source and stores it.
 * @returns The list, or undefined when the source is unreachable, too slow, too large or
 * malformed; the reason goes to stderr.
 */
export async function refreshPrices(): Promise<PriceList | undefined> {
  const source = process.env.coagent8_PRICES_URL || DEFAULT_PRICES_URL;
  let entries: Array<[string, number]> | undefined;
  try { entries = parsePriceList(JSON.parse(await readSource(source))); }
  catch (err) {
    process.stderr.write(`Warning: model prices not read: ${redactDiagnostic((err as Error).message, 256)}\n`);
    return undefined;
  }
  if (!entries) {
    process.stderr.write('Warning: model prices not read: the price list names no priced model.\n');
    return undefined;
  }
  const list: PriceList = { fetchedAt: Date.now(), source: source === DEFAULT_PRICES_URL ? 'openrouter' : 'coagent8_PRICES_URL', entries };
  await recordPrices(list);
  return list;
}

/** Wait before a turn tries an unreachable price source again. */
const RETRY_MS = 5 * 60 * 1000;
let lastRead: { at: number; result: Promise<PriceList | undefined> } | undefined;

/**
 * Whether a list is too old to show that a model meets a user's price limit (`AX-002`).
 * @param now - Milliseconds since the epoch.
 */
export function isPriceListStale(list: PriceList, now = Date.now()): boolean {
  return now - list.fetchedAt >= PRICE_REFRESH_MS;
}

/**
 * Returns the stored price list, of any age; without one, reads it, shared by concurrent
 * turns and tried again at most every five minutes after a failure.
 * @param options - `refresh` reads a list older than {@link PRICE_REFRESH_MS} again (doctor);
 * `current` does so for a turn with a price limit, shared and backed off like a missing
 * list, and returns the stale list when the read fails.
 */
export async function readPrices(options: { refresh?: boolean; current?: boolean } = {}): Promise<PriceList | undefined> {
  const stored = readStoredPrices();
  if (stored && !((options.refresh || options.current) && isPriceListStale(stored))) return stored;
  if (options.refresh) return (await refreshPrices()) ?? stored;
  const usable = async (read: Promise<PriceList | undefined>) => { const list = await read; return list !== undefined && !isPriceListStale(list); };
  if (!lastRead || (Date.now() - lastRead.at >= RETRY_MS && !(await usable(lastRead.result)))) lastRead = { at: Date.now(), result: refreshPrices() };
  return (await lastRead.result) ?? stored;
}

function normalize(name: string): string {
  return (name.toLowerCase().split('/').pop() ?? '').replace(/\[[^\]]*\]$/, '').replace(/\./g, '-');
}

/**
 * Finds the price of a model a CLI names: exactly, also without an effort or date suffix
 * (`gemini-3.8-flash-high`, `claude-haiku-4-5-20251001`), else approximately, when one name
 * extends the other (`claude-opus-4-6-thinking`, `gemini-3.1-pro-preview`). A context
 * variant (`[1m]`) is approximate. Among several entries the highest price is taken.
 */
export function findPrice(list: PriceList, model: string): ModelPrice | undefined {
  const variant = /\[[^\]]*\]$/.test(model);
  const base = normalize(model);
  const named = new Map<string, Array<[string, number]>>();
  for (const entry of list.entries) {
    const key = normalize(entry[0]);
    named.set(key, [...(named.get(key) ?? []), entry]);
  }
  const highest = (entries: Array<[string, number]>, exact: boolean): ModelPrice => {
    const [matched, output] = entries.reduce((top, entry) => entry[1] > top[1] ? entry : top);
    return { output, matched, exact };
  };
  for (const candidate of [base, base.replace(EFFORT_SUFFIX, ''), base.replace(DATE_SUFFIX, '')]) {
    const entries = named.get(candidate);
    if (entries) return highest(entries, !variant);
  }
  const stem = base.replace(EFFORT_SUFFIX, '');
  const loose = [...named].filter(([key]) => key.startsWith(`${stem}-`) || stem.startsWith(`${key}-`)).flatMap(([, entries]) => entries);
  return loose.length ? highest(loose, false) : undefined;
}

/** How a model's price was found: by its name, only by a looser comparison, or not at all. */
export type PriceMatch = 'exact' | 'approximate' | 'unknown';

/**
 * What the price list says about one concrete model (`AX-001`): a public list price per
 * million output tokens, not a request estimate, measured usage or a bill.
 */
export interface PriceEvidence {
  /** USD per million output tokens; null when unknown. */
  outputUsdPerMTok: number | null;
  /** The list entry the price belongs to; null when unknown. */
  matched: string | null;
  match: PriceMatch;
  /** Where the list came from (`openrouter` or `coagent8_PRICES_URL`); null without a list. */
  source: string | null;
  /** When the list was read, as an ISO timestamp; null without a list. */
  fetchedAt: string | null;
  /** The list is older than {@link PRICE_REFRESH_MS}, so it cannot satisfy a price limit. */
  stale: boolean;
}

/**
 * Looks up a concrete model in a price list.
 * @param list - The price list, or undefined when none could be read.
 * @param model - The model the backend runs, aliases already resolved.
 * @param now - Milliseconds since the epoch, for staleness.
 */
export function priceEvidence(list: PriceList | undefined, model: string, now = Date.now()): PriceEvidence {
  if (!list) return { outputUsdPerMTok: null, matched: null, match: 'unknown', source: null, fetchedAt: null, stale: false };
  const price = findPrice(list, model);
  return {
    outputUsdPerMTok: price?.output ?? null,
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
