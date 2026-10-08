/**
 * Chooses the model a turn runs (`EXEC-001`, owner decision of 2026-10-07: no model names in
 * the source). The model comes from the call, its session, the user's configuration, the
 * CLI's own configuration or what the CLI itself reports; the bridge never supplies one.
 *
 * @remarks
 * With a user's price limit (`AX-002`) and no model named, the backend's default runs when
 * its verified price is below the limit; otherwise the highest-priced catalog model below
 * it, as a proxy for capability (owner decision of 2026-10-08). The chosen model still
 * needs the user's approval where governance asks for one. The same owner lists a backend's
 * models with their prices and approval requirement ({@link listModelCandidates}) for doctor
 * and the planned CLI models command.
 *
 * @packageDocumentation
 */
import { ToolError, errorCodeOf, type ProviderId } from '../conversation.js';
import { loadConfig } from '../config.js';
import { adapterRegistry } from './registry.js';
import { readModelCatalog, readObservedModel } from './probe-cache.js';
import { findCatalogEntry } from './model-catalog.js';
import { checkPriceLimit, priceEvidence, type PriceEvidence, type PriceList } from './prices.js';
import { decideConsent, type ConsentBasis, type GovernanceSettings } from './governance.js';
import type { AdapterProbeResult, CatalogModel, ModelCatalog } from './types.js';

/**
 * Where a selected model came from: the call, its session, `config.json`, the CLI's own
 * configuration, the CLI catalog's declared default, the first model the catalog lists, the
 * model the CLI reports it runs without one, or the catalog model chosen for a price limit
 * the default does not meet.
 */
export type ModelSource = 'request' | 'session' | 'config' | 'cli-config' | 'catalog' | 'first-listed' | 'observed' | 'price-limit';

/** A selected model and its origin. */
export interface ModelSelection {
  /** The concrete model consent covers and the adapter runs. */
  model: string;
  source: ModelSource;
}

/**
 * Returns the model a catalog names as the CLI's default, else the first model it lists in
 * the form the CLI accepts (agy's `<id>-<effort>` when an effort is required).
 */
export function catalogDefault(catalog: ModelCatalog | undefined): { model: string; source: 'catalog' | 'first-listed' } | undefined {
  const declared = catalog?.models.find(model => model.isDefault);
  if (declared) return { model: declared.id, source: 'catalog' };
  const first = catalog?.models[0];
  if (!first) return undefined;
  return { model: first.effortRequired && first.efforts.length ? `${first.id}-${first.efforts[0]}` : first.id, source: 'first-listed' };
}

/** A user's price limit for a turn without a named model (`AX-002`). */
export interface PriceConstraint {
  /** Strict limit in USD per million output tokens: a model priced at exactly this does not meet it. */
  below: number;
  /** The price list the limit is checked against; undefined when none could be read. */
  prices: PriceList | undefined;
  /** The call's `reasoning_effort`; a catalog model that does not accept it is not chosen. */
  effort?: string;
}

/**
 * Selects the model of a turn: the call's, else the session's, else the configured default,
 * else the CLI's own default. A name the CLI resolves itself (Claude Code aliases) is
 * replaced by the concrete model the CLI reports for it, so consent and the turn agree.
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
export async function selectModel(id: ProviderId, probe: AdapterProbeResult, requested: { model?: string; session?: string } = {}, options: { observeAfresh?: boolean; constraint?: PriceConstraint } = {}): Promise<ModelSelection> {
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
      if (chosen.source === 'session' || !adapter.observeModel) return chosen;
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
  return choosePricedModel(id, await readModelCatalog(id), fallback, options.constraint);
}

/**
 * Chooses the model of a turn under a price limit: the default when its verified price is
 * below the limit, else the highest-priced catalog model below it, catalog order breaking
 * ties. Approval is not considered here: the controller asks for it as for any model.
 * @param id - Backend, for messages.
 * @param catalog - Its catalog, or undefined; without one only the default can be chosen.
 * @param fallback - The model the backend runs when none is named, if known.
 * @param constraint - The limit, the price list and the call's effort.
 * @throws `PRICE_LIMIT` stating why neither the default nor a catalog model meets the limit.
 */
export function choosePricedModel(id: ProviderId, catalog: ModelCatalog | undefined, fallback: ModelSelection | undefined, constraint: PriceConstraint): ModelSelection {
  const { below, prices } = constraint;
  const effort = constraint.effort?.toLowerCase();
  const accepts = (entry: CatalogModel | undefined) => !effort || !entry || entry.efforts.includes(effort);
  const defaultReason = fallback ? checkPriceLimit(fallback.model, priceEvidence(prices, fallback.model), below) : undefined;
  const defaultEntry = fallback && catalog ? findCatalogEntry(catalog, fallback.model)?.entry : undefined;
  if (fallback && !defaultReason && accepts(defaultEntry)) return fallback;
  let best: { entry: CatalogModel; price: number } | undefined;
  for (const entry of catalog?.models ?? []) {
    if (!accepts(entry)) continue;
    const evidence = priceEvidence(prices, entry.id);
    if (checkPriceLimit(entry.id, evidence, below) === undefined && (!best || evidence.outputUsdPerMTok! > best.price)) best = { entry, price: evidence.outputUsdPerMTok! };
  }
  if (best) {
    const { entry } = best;
    return { model: entry.effortRequired && !effort && entry.efforts.length ? `${entry.id}-${entry.efforts[0]}` : entry.id, source: 'price-limit' };
  }
  const reasons = [
    fallback ? `Default: ${defaultReason ?? `'${fallback.model}' does not accept reasoning_effort '${effort}'.`}` : 'No default model is known.',
    catalog?.models.length
      ? `None of its ${catalog.models.length} listed models${effort ? ` accepting reasoning_effort '${effort}'` : ''} has a verified price below the limit; doctor lists their prices.`
      : `${id} lists no models, so only its default or a named model can be checked.`,
  ];
  throw new ToolError('PRICE_LIMIT', `No ${id} model has a verified price below ${Number(below.toFixed(4))} USD per million output tokens. ${reasons.join(' ')}`);
}

/** One model a backend offers, as doctor and the planned CLI models command list it (`AX-001`). */
export interface ModelCandidate {
  backend: ProviderId;
  /** The name to pass as `model`; a model listed with `effortRequired` also needs an effort. */
  model: string;
  /** Accepted `reasoning_effort` values; empty when the model takes none or the CLI lists no catalog. */
  efforts: string[];
  effortRequired?: boolean;
  /** Where the backend's default came from; set on the default model's row only. */
  defaultSource?: ModelSource;
  price: PriceEvidence;
  /** Whether governance asks the user before a turn of this model, and why. */
  approval: { required: boolean; basis: ConsentBasis; reason: string; rememberable: boolean };
}

/**
 * Lists the models of one backend with their prices and approval requirement: each catalog
 * entry, and the default first when the catalog does not contain it (Claude Code lists none).
 * @param id - Backend.
 * @param catalog - Its catalog, or undefined.
 * @param fallback - Its default model, if known.
 * @param prices - The price list, or undefined.
 * @param settings - The user's governance settings.
 * @remarks Approval is evaluated for the listed name (for the default, the name it runs as);
 * a governance list entry naming one effort variant (`<id>-<effort>`) applies when it runs.
 */
export function listModelCandidates(id: ProviderId, catalog: ModelCatalog | undefined, fallback: ModelSelection | undefined, prices: PriceList | undefined, settings: GovernanceSettings): ModelCandidate[] {
  const now = Date.now();
  const defaultEntry = fallback && catalog ? findCatalogEntry(catalog, fallback.model)?.entry : undefined;
  const row = (model: string, efforts: string[], effortRequired: boolean, isDefault: boolean): ModelCandidate => {
    const consent = decideConsent(isDefault && fallback ? fallback.model : model, fallback?.model, prices, settings);
    return {
      backend: id, model, efforts, ...(effortRequired ? { effortRequired } : {}),
      ...(isDefault && fallback ? { defaultSource: fallback.source } : {}),
      price: priceEvidence(prices, model, now),
      approval: { required: consent.ask, basis: consent.basis, reason: consent.reason, rememberable: consent.offerRemember },
    };
  };
  const rows = (catalog?.models ?? []).map(entry => row(entry.id, entry.efforts, entry.effortRequired === true, entry === defaultEntry));
  if (fallback && !defaultEntry) rows.unshift(row(fallback.model, [], false, true));
  return rows;
}
