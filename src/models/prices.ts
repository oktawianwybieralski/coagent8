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
import { readBoundedFileSync } from '../storage/read.js';
import { redactDiagnostic } from '../security/redaction.js';
import { readObservedModelNames, readStoredPrices, recordPrices, type PriceRecord, type StoredPrices } from './store.js';
import { ToolError, type BackendReadContext } from '../contracts/index.js';

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

/**
 * Caps caller timeout to the operation's default bound (`EXEC-001-T08f`).
 */
export function boundReadTimeout(context: BackendReadContext | undefined, defaultMs: number): number {
  if (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0) {
    return Math.min(context.timeoutMs, defaultMs);
  }
  return defaultMs;
}

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

async function readSource(source: string, context?: BackendReadContext): Promise<string> {
  const preAbort = getPreAbortError(context);
  if (preAbort) throw preAbort;

  if (!/^https?:\/\//i.test(source)) return readBoundedFileSync(source, MAX_PRICE_LIST_BYTES);

  const timeoutMs = boundReadTimeout(context, FETCH_TIMEOUT_MS);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  const effectiveSignal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(source, { signal: effectiveSignal, headers: { accept: 'application/json' } });
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

interface PriceWaiter {
  resolve: (value: PriceList | undefined) => void;
  reject: (reason?: unknown) => void;
  cleanup: () => void;
  active: boolean;
}

interface PriceInflightEntry {
  id: number;
  abortController: AbortController;
  waiters: Set<PriceWaiter>;
  models: Set<string>;
  settled: boolean;
  result?: { ok: true; value: PriceList | undefined } | { ok: false; error: unknown };
}

let nextInflightId = 0;
let latestInflightId = 0;
let activeInflight: PriceInflightEntry | undefined;
const runningPromises = new Set<Promise<unknown>>();
let failedAt = 0;

function isCurrentPriceInflight(entry: PriceInflightEntry, readContext?: BackendReadContext): boolean {
  if (!readContext?.abortSignal) return false;
  return activeInflight === entry && activeInflight.abortController.signal === readContext.abortSignal;
}

const covers = (list: PriceList | undefined, models: readonly string[]) => list !== undefined && models.every(model => priceKey(model) in list.models);

/** Wait before an unreachable price source is tried again. */
const RETRY_MS = 5 * 60 * 1000;

/**
 * Reads the list once at a time: concurrent callers join a read in progress (`EXEC-001-T08f`).
 * Enforces per-waiter cancellation/timeout isolation, last-waiter abort, and late settlement safety.
 */
async function sharedRefresh(
  models: readonly string[],
  context?: BackendReadContext,
  fresh = false
): Promise<PriceList | undefined> {
  const preAbort = getPreAbortError(context);
  if (preAbort) {
    return Promise.reject(preAbort);
  }

  let isJoiner = false;
  let entry: PriceInflightEntry | undefined;
  if (!fresh && activeInflight && !activeInflight.settled && !activeInflight.abortController.signal.aborted) {
    entry = activeInflight;
    isJoiner = true;
    for (const m of models) entry.models.add(m);
  }

  if (!entry) {
    if (!fresh && Date.now() - failedAt < RETRY_MS) {
      return undefined;
    }

    const newEntry: PriceInflightEntry = {
      id: ++nextInflightId,
      abortController: new AbortController(),
      waiters: new Set(),
      models: new Set(models),
      settled: false,
    };
    latestInflightId = newEntry.id;
    entry = newEntry;
    activeInflight = newEntry;

    const sharedContext: BackendReadContext = {
      abortSignal: newEntry.abortController.signal,
    };

    const executionPromise = (async () => {
      let list: PriceList | undefined;
      let fetchError: unknown;
      try {
        const source = process.env.coagent8_PRICES_URL || DEFAULT_PRICES_URL;
        let entries: ListedPrice[] | undefined;
        try {
          entries = parsePriceList(JSON.parse(await readSource(source, sharedContext)));
        } catch (err) {
          if (sharedContext.abortSignal?.aborted) {
            throw toAbortError(sharedContext.abortSignal.reason);
          }
          if (err instanceof ToolError && (err.code === 'ABORTED' || err.code === 'TIMEOUT')) {
            throw err;
          }
          process.stderr.write(`Warning: model prices not read: ${redactDiagnostic((err as Error).message, 256)}\n`);
          return undefined;
        }
        if (!entries) {
          process.stderr.write('Warning: model prices not read: the price list names no priced model.\n');
          return undefined;
        }
        const names = new Set([...readObservedModelNames(), ...Object.keys(readStoredPrices()?.models ?? {}), ...newEntry.models]);
        list = {
          fetchedAt: Date.now(),
          source: source === DEFAULT_PRICES_URL ? 'openrouter' : 'coagent8_PRICES_URL',
          models: matchPrices(entries, names),
        };
        if (!sharedContext.abortSignal?.aborted && isCurrentPriceInflight(newEntry, sharedContext)) {
          await recordPrices(list);
        }
        return list;
      } catch (err) {
        fetchError = err;
        throw err;
      } finally {
        newEntry.settled = true;
        if (fetchError !== undefined) {
          newEntry.result = { ok: false, error: fetchError };
          const isAbortOrTimeout = Boolean(
            sharedContext.abortSignal?.aborted ||
            (fetchError instanceof ToolError && (fetchError.code === 'ABORTED' || fetchError.code === 'TIMEOUT')) ||
            (fetchError instanceof Error && fetchError.name === 'AbortError')
          );
          if (!isAbortOrTimeout && (newEntry.id === latestInflightId || activeInflight === newEntry)) {
            failedAt = Date.now();
          }
          for (const waiter of newEntry.waiters) {
            if (waiter.active) {
              waiter.active = false;
              try { waiter.cleanup(); } catch { /* ignore */ }
              waiter.reject(fetchError);
            }
          }
        } else {
          newEntry.result = { ok: true, value: list };
          if (!sharedContext.abortSignal?.aborted && (newEntry.id === latestInflightId || activeInflight === newEntry)) {
            failedAt = list ? 0 : Date.now();
          }
          for (const waiter of newEntry.waiters) {
            if (waiter.active) {
              waiter.active = false;
              try { waiter.cleanup(); } catch { /* ignore */ }
              waiter.resolve(list);
            }
          }
        }
        newEntry.waiters.clear();
        if (activeInflight === newEntry) {
          activeInflight = undefined;
        }
      }
    })();

    runningPromises.add(executionPromise);
    executionPromise.finally(() => {
      runningPromises.delete(executionPromise);
    }).catch(() => {});
  }

  const targetEntry = entry;
  const list = await new Promise<PriceList | undefined>((resolve, reject) => {
    if (targetEntry.settled && targetEntry.result) {
      if (targetEntry.result.ok) {
        resolve(targetEntry.result.value);
      } else {
        reject(targetEntry.result.error);
      }
      return;
    }

    const waiter: PriceWaiter = {
      resolve,
      reject,
      cleanup: () => {},
      active: true,
    };

    function detachWaiter(error: unknown): void {
      if (!waiter.active) return;
      waiter.active = false;
      try { waiter.cleanup(); } catch { /* ignore */ }
      targetEntry.waiters.delete(waiter);
      waiter.reject(error);

      if (targetEntry.waiters.size === 0 && !targetEntry.settled) {
        targetEntry.abortController.abort(error);
        if (activeInflight === targetEntry) {
          activeInflight = undefined;
        }
      }
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const onAbort = () => {
      detachWaiter(toAbortError(context?.abortSignal?.reason));
    };
    const onBudgetAbort = () => {
      const budgetReason = context?.budget?.abortReason();
      const reason = budgetReason instanceof ToolError
        ? budgetReason
        : (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired())
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

    targetEntry.waiters.add(waiter);

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

  if (isJoiner && !covers(list, models)) {
    if (Date.now() - failedAt < RETRY_MS) {
      return undefined;
    }
    return sharedRefresh(models, context, false);
  }

  return list;
}

/**
 * Reads the price list from its source and stores the prices of the models the backends
 * offer, those checked before and `models`.
 * @param models - Further models to match, such as the one a call names.
 * @param context - Optional cancellation and timeout context (`EXEC-001-T08f`).
 * @returns The prices, or undefined when the source is unreachable, too slow, too large or
 * malformed; the reason goes to stderr.
 */
export async function refreshPrices(models: readonly string[] = [], context?: BackendReadContext): Promise<PriceList | undefined> {
  return sharedRefresh(models, context, true);
}

/**
 * Waits for price reads in progress, such as a background one, to store their results.
 * @remarks For graceful shutdown; reads are bounded by their fetch timeout and report their own failure.
 */
export async function settlePriceReads(): Promise<void> {
  if (runningPromises.size > 0) {
    await Promise.allSettled([...runningPromises]);
  }
}

/**
 * Whether a list is too old to show that a model meets a user's price limit (`AX-002`).
 * @param now - Milliseconds since the epoch.
 */
export function isPriceListStale(list: PriceList, now = Date.now()): boolean {
  return now - list.fetchedAt >= PRICE_STALE_MS;
}

/**
 * Options for reading model prices (`EXEC-001-T08f`).
 */
export interface ReadPricesOptions {
  /** Models the call needs priced. */
  models?: readonly string[];
  /** When true, a list older than a week waits for a read (for calls with a price limit). */
  current?: boolean;
  /** When true, a list older than a day waits for a read (doctor). */
  refresh?: boolean;
  /** When true, always fetches afresh bypassing cache and inflight sharing (`EXEC-001-T08f`). */
  fresh?: boolean;
  /** Optional cancellation and deadline context for this read (`EXEC-001-T08f`). */
  context?: BackendReadContext;
}

/**
 * Returns the stored prices, reading the list when needed (see the module remarks).
 * @param options - `models` the call needs priced; `current` for a call with a price limit;
 * `refresh` (doctor) waits for a read of a list older than a day; `fresh` always reads afresh;
 * `context` supplies cancellation and timeout budget.
 * @returns The prices, or the stored ones when a read fails; undefined when none exist.
 */
export async function readPrices(options: ReadPricesOptions = {}): Promise<PriceList | undefined> {
  const context = options.context;
  const preAbort = getPreAbortError(context);
  if (preAbort) throw preAbort;

  const models = options.models ?? [];
  const stored = readStoredPrices();
  const age = stored ? Date.now() - stored.fetchedAt : Infinity;
  const wait = Boolean(options.fresh) || !covers(stored, models) || (options.current && age >= PRICE_STALE_MS) || (options.refresh && age >= PRICE_REFRESH_MS);
  if (wait) {
    const list = await sharedRefresh(models, context, Boolean(options.fresh));
    return list ?? stored;
  }
  // A day-old list stays in use while a background read replaces it; that read reports its own failure.
  if (age >= PRICE_REFRESH_MS && !activeInflight) {
    void sharedRefresh([], undefined, false).catch(() => {});
  }
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
 * Checks a user's price limit (`AX-002`). Separate from consent: neither `models.allow` nor an
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

