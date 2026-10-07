/**
 * Model and effort validation against the catalog a backend CLI reports (`CONTEXT-001`).
 *
 * @remarks
 * A caller learned which models and efforts a backend accepts only by failing: Codex
 * rejected `luna` after a model call, agy rejected `gemini-3.8-flash` without an effort.
 * The controller checks an explicit `model` or `reasoning_effort` here before launch and
 * answers with the accepted values. Without a catalog nothing is rejected, so a model the
 * bridge does not know yet still reaches the CLI.
 *
 * @packageDocumentation
 */
import type { ExecutionError } from '../conversation.js';
import type { CatalogModel, ModelCatalog } from './types.js';

/** Longest model list quoted in an error; the rest is left to doctor. */
const LISTED_MODELS = 12;

/** Renders catalog entries as `id (low|medium|high)`, the form an error or doctor quotes. */
export function describeModels(models: CatalogModel[]): string {
  const shown = models.slice(0, LISTED_MODELS).map(model => model.efforts.length ? `${model.id} (${model.efforts.join('|')})` : model.id);
  return models.length > LISTED_MODELS ? `${shown.join(', ')}, and ${models.length - LISTED_MODELS} more (doctor lists all)` : shown.join(', ');
}

/** Finds the entry for `model`, also in agy's suffixed form `<id>-<effort>`. */
function findModel(catalog: ModelCatalog, model: string): { entry: CatalogModel; suffixEffort?: string } | undefined {
  const exact = catalog.models.find(entry => entry.id === model);
  if (exact) return { entry: exact };
  for (const entry of catalog.models) {
    const effort = entry.effortRequired && model.startsWith(`${entry.id}-`) ? model.slice(entry.id.length + 1) : undefined;
    if (effort && entry.efforts.includes(effort)) return { entry, suffixEffort: effort };
  }
  return undefined;
}

/**
 * Checks the model the backend would run and the requested effort against its catalog.
 * @param backend - Backend name used in messages.
 * @param catalog - The CLI's catalog, or undefined when it could not be read.
 * @param model - The model the backend would run (requested or default).
 * @param effort - The requested `reasoning_effort`, if any.
 * @returns An error that names the accepted values, or null when the selection is valid or
 * cannot be checked.
 */
export function checkModelSelection(backend: string, catalog: ModelCatalog | undefined, model: string | undefined, effort: string | undefined): ExecutionError | null {
  if (!catalog || !catalog.models.length || !model) return null;
  const found = findModel(catalog, model);
  if (!found) {
    return { code: 'MODEL_UNAVAILABLE', retryable: false,
      message: `Model '${model}' is not offered by ${backend}. Use one of: ${describeModels(catalog.models)}; or omit model for the default.` };
  }
  const { entry, suffixEffort } = found;
  const normalized = effort?.toLowerCase();
  if (normalized && !entry.efforts.includes(normalized)) {
    return { code: 'INPUT_LIMIT', retryable: false,
      message: entry.efforts.length
        ? `${backend} model '${entry.id}' accepts reasoning_effort ${entry.efforts.join(', ')}, not '${effort}'.`
        : `${backend} model '${entry.id}' takes no reasoning_effort; omit it.` };
  }
  if (entry.effortRequired && !normalized && !suffixEffort) {
    return { code: 'INPUT_LIMIT', retryable: false,
      message: `${backend} model '${entry.id}' needs reasoning_effort (${entry.efforts.join(', ')}), or name it with the effort, for example '${entry.id}-${entry.efforts[0]}'.` };
  }
  return null;
}
