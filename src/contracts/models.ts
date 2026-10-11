/**
 * Shared model catalog, catalog model, and model identifier syntax contracts.
 *
 * @packageDocumentation
 */

/** One model a CLI offers. */
export interface CatalogModel {
  /** Identifier the caller passes as `model`. */
  id: string;
  /** Accepted `reasoning_effort` values; empty when the model takes none. */
  efforts: string[];
  /**
   * The CLI needs an effort with this identifier: agy lists `gemini-3.8-flash-high`
   * and rejects `gemini-3.8-flash` without `--effort`.
   */
  effortRequired?: boolean;
  /** The CLI's default model. */
  isDefault?: boolean;
  /**
   * Other names the CLI accepts for this model, such as Claude Code's `sonnet` alias for the
   * concrete model it currently resolves to; `id` is always the concrete model.
   */
  aliases?: string[];
}

/** Models offered by one backend CLI, read from the CLI itself. */
export interface ModelCatalog {
  models: CatalogModel[];
  /** Where the list comes from, for example `codex app-server model/list`. */
  source: string;
  /**
   * The CLI also accepts models it does not list (Claude Code lists a curated set), so an
   * unlisted name is not rejected; its concrete model is observed instead.
   */
  acceptsUnlisted?: boolean;
}

/** Bridge schema union; catalog checks or adapter warnings determine per-model/provider support. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Returns whether `model` is `listed` itself or one of its effort variants (`<id>-<effort>`),
 * the name agy runs for a model doctor lists by its id.
 */
export function namesModelOrVariant(listed: string, model: string): boolean {
  if (model === listed) return true;
  if (!model.startsWith(`${listed}-`)) return false;
  return (REASONING_EFFORTS as readonly string[]).includes(model.slice(listed.length + 1).toLowerCase());
}

/** How a turn runs its model with a reasoning effort passed separately, as the user's rules see it. */
export interface EffortRun {
  /** The reasoning effort passed separately from the model. */
  effort?: string;
  /**
   * The CLI drops an effort suffix of the model and runs the variant of `effort`: agy runs
   * `gemini-3.8-flash-low` with `high` as `gemini-3.8-flash-high`. Other CLIs run the model
   * as named, with the effort beside it.
   */
  replacesSuffix?: boolean;
}

/**
 * Returns whether `listed` names what a turn of `model` runs: the model itself, or, with an
 * effort passed separately, the variant of that effort. When the CLI replaces the model's
 * effort suffix, only the variant it runs counts.
 */
export function namesModelRun(listed: string, model: string, run: EffortRun = {}): boolean {
  const effort = run.effort?.toLowerCase();
  if (effort === undefined) return namesModelOrVariant(listed, model);
  if (!run.replacesSuffix) return namesModelOrVariant(listed, model) || namesModelOrVariant(listed, `${model}-${effort}`);
  return namesModelOrVariant(listed, effortVariant(model, effort));
}

/** The variant of `effort` a CLI that replaces effort suffixes runs for `model`: `<id>-<effort>`. */
export function effortVariant(model: string, effort: string): string {
  const suffix = model.lastIndexOf('-');
  const id = suffix > 0 && (REASONING_EFFORTS as readonly string[]).includes(model.slice(suffix + 1).toLowerCase()) ? model.slice(0, suffix) : model;
  return `${id}-${effort.toLowerCase()}`;
}

/** Model identifier pattern from the audit; rejects option-like and whitespace values. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;

/** Returns whether a requested or backend-reported model identifier is safe to pass on and record. */
export function isValidModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

