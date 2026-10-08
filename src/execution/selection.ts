/**
 * Effective model selection orchestration (`EXEC-001`).
 *
 * @remarks
 * Orchestrates native CLI observations, probe caching, and user configuration
 * using pure decision policy from `src/models/selection.ts`. Reused by both
 * task execution (`executeTask`) and diagnostics (`doctor`).
 *
 * @packageDocumentation
 */
import { ToolError, errorCodeOf, type ProviderId } from '../contracts/index.js';
import { loadConfig } from '../config.js';
import { adapterRegistry } from '../backends/registry.js';
import { readModelCatalog, readObservedModel } from '../backends/probe-cache.js';
import { findCatalogEntry } from '../models/catalog.js';
import { readPrices } from '../models/prices.js';
import {
  catalogDefault,
  catalogNames,
  choosePricedModel,
  type ModelSelection,
  type ModelSource,
  type PriceConstraint,
} from '../models/selection.js';
import type { AdapterProbeResult } from '../backends/types.js';

export type { ModelSelection, ModelSource, PriceConstraint };

/**
 * Selects the model of a turn: the call's, else the session's, else the configured default,
 * else the CLI's own default. A name the catalog lists, by id or alias, becomes the exact
 * listed model; an unlisted name the CLI resolves itself is replaced by the concrete model
 * the CLI reports for it, so consent, price checks and the turn name the same model.
 * @param id - Backend of the turn.
 * @param probe - Its current probe; `config.defaultModel` is the CLI's own configured default.
 * @param requested - The call's `model` and the session's model, if any.
 * @param options - `observeAfresh` asks the CLI again instead of reusing an observed model
 * (doctor, which has just read the catalogs afresh). `constraint` applies a price limit when
 * neither the call nor a session names a model, as {@link choosePricedModel} describes; a
 * named model is returned as is and checked by the caller.
 * @throws `MODEL_UNAVAILABLE` when no source names a model; `PRICE_LIMIT` when a constraint
 * applies and no model of this backend meets it.
 */
export async function selectModel(
  id: ProviderId,
  probe: AdapterProbeResult,
  requested: { model?: string; session?: string } = {},
  options: { observeAfresh?: boolean; constraint?: PriceConstraint } = {}
): Promise<ModelSelection> {
  const observe = { fresh: options.observeAfresh };
  const adapter = adapterRegistry[id];
  const configured = loadConfig().backends[id]?.defaultModel;
  const chosen: ModelSelection | undefined = requested.model ? { model: requested.model, source: 'request' }
    : requested.session ? { model: requested.session, source: 'session' }
    : configured ? { model: configured, source: 'config' }
    : probe.config?.defaultModel ? { model: probe.config.defaultModel, source: 'cli-config' }
    : undefined;
  async function resolve(): Promise<ModelSelection> {
    if (chosen) {
      // The session stores the model the CLI reported, which needs no second look.
      if (chosen.source === 'session') return chosen;
      // A listed name or alias becomes the exact form the CLI lists: `sonnet` the concrete
      // model it runs, `gpt-6-1-sol` the listed `gpt-6.1-sol`.
      const catalog = await readModelCatalog(id);
      const listed = catalog ? findCatalogEntry(catalog, chosen.model) : undefined;
      if (listed) return { model: listed.name, source: chosen.source };
      if (!adapter.observeModel) return chosen;
      // An alias can map to any model (Claude Code honors environment overrides), so a name the
      // CLI did not resolve is refused rather than governed by its spelling.
      const observed = await readObservedModel(id, chosen.model, observe);
      if (!observed) throw new ToolError('MODEL_UNAVAILABLE', `${id} did not report which model '${chosen.model}' runs, so it cannot be governed; check the CLI with doctor.`);
      return { model: observed, source: chosen.source };
    }
    const fromCatalog = catalogDefault(await readModelCatalog(id));
    if (fromCatalog) return fromCatalog;
    const observed = await readObservedModel(id, undefined, observe);
    if (observed) return { model: observed, source: 'observed' };
    throw new ToolError('MODEL_UNAVAILABLE', `No default model is known for ${id}: its CLI names none it can report without a model turn. Pass model, or set backends.${id}.defaultModel in the CoAgent8 config.json (doctor records one when the CLI reports it).`);
  }
  if (!options.constraint || chosen?.source === 'request' || chosen?.source === 'session') return resolve();
  // Without a known default the catalog may still offer a model below the limit.
  let fallback: ModelSelection | undefined;
  try { fallback = await resolve(); }
  catch (err) { if (errorCodeOf(err) !== 'MODEL_UNAVAILABLE') throw err; }
  const catalog = await readModelCatalog(id);
  // A limit needs current prices of every model it may choose from.
  const prices = await readPrices({ current: true, models: [...catalogNames(catalog), ...(fallback ? [fallback.model] : [])] });
  return choosePricedModel(id, catalog, fallback, options.constraint, prices);
}

