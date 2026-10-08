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

/** Model identifier pattern from the audit; rejects option-like and whitespace values. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;

/** Returns whether a requested or backend-reported model identifier is safe to pass on and record. */
export function isValidModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

