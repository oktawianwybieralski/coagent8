/**
 * Pure model selection decisions, candidate listing, and price constraint evaluation (`EXEC-001`, `AX-001`, `AX-002`).
 *
 * @remarks
 * Contains pure decision algorithms independent of CLI execution, backend registries, or probe caching.
 * Observation orchestration (probing CLIs and loading configs) belongs to application operations (`src/execution/selection.ts`).
 *
 * @packageDocumentation
 */
import { ToolError } from '../contracts/error.js';
import type { ProviderId } from '../contracts/provider.js';
import { namesModelRun, type CatalogModel, type ModelCatalog } from '../contracts/models.js';
import { findCatalogEntry } from './catalog.js';
import { checkPriceLimit, priceEvidence, type PriceEvidence, type PriceList } from './prices.js';
import { decideConsent, findModelRuleEntry, type ConsentBasis, type GovernanceSettings } from './governance.js';

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
  /** The call's `reasoning_effort`; a catalog model that does not accept it is not chosen. */
  effort?: string;
}

/** Names a catalog's models as a turn may run them: each id and agy's `<id>-<effort>` forms. */
export function catalogNames(catalog: ModelCatalog | undefined): string[] {
  return (catalog?.models ?? []).flatMap(model => [model.id, ...(model.effortRequired ? model.efforts.map(effort => `${model.id}-${effort}`) : [])]);
}

/**
 * Chooses the model of a turn under a price limit: the default when its verified price is
 * below the limit, else the highest-priced catalog model below it, catalog order breaking
 * ties. Approval is not considered here: the controller asks for it as for any model. A
 * model the user denies, the default included, is never chosen.
 * @param id - Backend, for messages.
 * @param catalog - Its catalog, or undefined; without one only the default can be chosen.
 * @param fallback - The model the backend runs when none is named, if known.
 * @param constraint - The limit and the call's effort.
 * @param prices - The price list the limit is checked against; undefined when none could be read.
 * @param denied - The user's `governance.models.deny` list.
 * @param replacesSuffix - The CLI replaces a model's effort suffix with the call's effort (`EffortRun`).
 * @throws `PRICE_LIMIT` stating why neither the default nor a catalog model meets the limit.
 */
export function choosePricedModel(id: ProviderId, catalog: ModelCatalog | undefined, fallback: ModelSelection | undefined, constraint: PriceConstraint, prices: PriceList | undefined, denied: readonly string[] = [], replacesSuffix = false): ModelSelection {
  const { below } = constraint;
  const effort = constraint.effort?.toLowerCase();
  const accepts = (entry: CatalogModel | undefined) => !effort || !entry || entry.efforts.includes(effort);
  // The turn passes the call's effort separately, so a denied variant of that effort is denied too.
  const isDenied = (model: string) => denied.some(listed => namesModelRun(listed, model, { effort, replacesSuffix }));
  const defaultReason = fallback ? checkPriceLimit(fallback.model, priceEvidence(prices, fallback.model), below) : undefined;
  const defaultEntry = fallback && catalog ? findCatalogEntry(catalog, fallback.model)?.entry : undefined;
  if (fallback && !defaultReason && accepts(defaultEntry) && !isDenied(fallback.model)) return fallback;
  let best: { model: string; price: number } | undefined;
  for (const entry of catalog?.models ?? []) {
    // The name the turn would run: agy's first permitted `<id>-<effort>` when an effort is required
    // and none is passed.
    const names = entry.effortRequired && !effort && entry.efforts.length ? entry.efforts.map(variant => `${entry.id}-${variant}`) : [entry.id];
    const model = names.find(name => !isDenied(name));
    if (!accepts(entry) || isDenied(entry.id) || model === undefined) continue;
    const evidence = priceEvidence(prices, entry.id);
    if (checkPriceLimit(entry.id, evidence, below) === undefined && (!best || evidence.outputUsdPerMTok! > best.price)) best = { model, price: evidence.outputUsdPerMTok! };
  }
  if (best) return { model: best.model, source: 'price-limit' };
  const reasons = [
    fallback ? `Default: ${defaultReason ?? (isDenied(fallback.model) ? `'${fallback.model}' is denied by the user.` : `'${fallback.model}' does not accept reasoning_effort '${effort}'.`)}` : 'No default model is known.',
    catalog?.models.length
      ? `None of its ${catalog.models.length} listed models${effort ? ` accepting reasoning_effort '${effort}'` : ''}${denied.length ? ' and not denied by the user' : ''} has a verified price below the limit; doctor lists their prices.`
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
  /**
   * Whether governance asks the user before a turn of this model or never runs it, and why;
   * `ruleEntry` is the user's `governance.models` entry that decides it, which may name the
   * effort variant a default model runs as rather than `model`.
   */
  approval: { required: boolean; denied: boolean; basis: ConsentBasis; reason: string; rememberable: boolean; ruleEntry?: string };
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
 * an entry naming the id covers its effort variants, and one naming a single variant
 * (`<id>-<effort>`) applies when that variant runs.
 */
export function listModelCandidates(id: ProviderId, catalog: ModelCatalog | undefined, fallback: ModelSelection | undefined, prices: PriceList | undefined, settings: GovernanceSettings): ModelCandidate[] {
  const now = Date.now();
  const defaultEntry = fallback && catalog ? findCatalogEntry(catalog, fallback.model)?.entry : undefined;
  const row = (model: string, efforts: string[], effortRequired: boolean, isDefault: boolean): ModelCandidate => {
    const governed = isDefault && fallback ? fallback.model : model;
    const consent = decideConsent(governed, fallback?.model, prices, settings);
    const ruleEntry = findModelRuleEntry(governed, settings.models)?.entry;
    return {
      backend: id, model, efforts, ...(effortRequired ? { effortRequired } : {}),
      ...(isDefault && fallback ? { defaultSource: fallback.source } : {}),
      price: priceEvidence(prices, model, now),
      approval: { required: consent.ask, denied: consent.deny, basis: consent.basis, reason: consent.reason, rememberable: consent.offerRemember, ...(ruleEntry ? { ruleEntry } : {}) },
    };
  };
  const rows = (catalog?.models ?? []).map(entry => row(entry.id, entry.efforts, entry.effortRequired === true, entry === defaultEntry));
  if (fallback && !defaultEntry) rows.unshift(row(fallback.model, [], false, true));
  return rows;
}
