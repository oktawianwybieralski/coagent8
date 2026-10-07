/**
 * Chooses the model a turn runs (`EXEC-001`, owner decision of 2026-10-07: no model names in
 * the source). The model comes from the call, its session, the user's configuration, the
 * CLI's own configuration or what the CLI itself reports; the bridge never supplies one.
 *
 * @packageDocumentation
 */
import { ToolError, type ProviderId } from '../conversation.js';
import { loadConfig } from '../config.js';
import { adapterRegistry } from './registry.js';
import { readModelCatalog, readObservedModel } from './probe-cache.js';
import type { AdapterProbeResult, ModelCatalog } from './types.js';

/**
 * Where a selected model came from: the call, its session, `config.json`, the CLI's own
 * configuration, the CLI catalog's declared default, the first model the catalog lists, or
 * the model the CLI reports it runs without one.
 */
export type ModelSource = 'request' | 'session' | 'config' | 'cli-config' | 'catalog' | 'first-listed' | 'observed';

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

/**
 * Selects the model of a turn: the call's, else the session's, else the configured default,
 * else the CLI's own default. A name the CLI resolves itself (Claude Code aliases) is
 * replaced by the concrete model the CLI reports for it, so consent and the turn agree.
 * @param id - Backend of the turn.
 * @param probe - Its current probe; `config.defaultModel` is the CLI's own configured default.
 * @param requested - The call's `model` and the session's model, if any.
 * @param options - `observeAfresh` asks the CLI again instead of reusing an observed model
 * (doctor, which has just read the catalogs afresh).
 * @throws `MODEL_UNAVAILABLE` when no source names a model.
 */
export async function selectModel(id: ProviderId, probe: AdapterProbeResult, requested: { model?: string; session?: string } = {}, options: { observeAfresh?: boolean } = {}): Promise<ModelSelection> {
  const observe = { fresh: options.observeAfresh };
  const adapter = adapterRegistry[id];
  const named: ModelSelection | undefined = requested.model ? { model: requested.model, source: 'request' }
    : requested.session ? { model: requested.session, source: 'session' }
    : undefined;
  const configured = loadConfig().backends[id]?.defaultModel;
  const chosen = named ?? (configured ? { model: configured, source: 'config' as const }
    : probe.config?.defaultModel ? { model: probe.config.defaultModel, source: 'cli-config' as const }
    : undefined);
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
