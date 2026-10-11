/**
 * VS Code editor setting overrides and precedence mapping (`EXEC-001-T03a`).
 *
 * @remarks
 * ## Precedence Rules
 * - Settings passed in `coagent8_EDITOR_SETTINGS` take precedence over file-level configuration.
 * - Scalar settings (`defaultBackend`, `routing.strategy`, backend defaults, approval thresholds)
 *   replace the corresponding values from `config.json`.
 * - Model list settings (`approval.allowModels`, `approval.askModels`, `approval.denyModels`)
 *   are appended to the file lists so that remembered approvals in `config.json` remain active.
 * - Provenance tracking distinguishes scalar replacements (`editor`) from list merges (`merged`).
 *
 * @packageDocumentation
 */

/** Environment variable through which the VS Code extension passes explicit user settings. */
export const EDITOR_SETTINGS_ENV = 'coagent8_EDITOR_SETTINGS';

/**
 * VS Code user settings (`coagent8.<key>`) and the configuration field each one sets.
 * A scalar setting replaces the file value; a list setting is added to the file list, so
 * an approval remembered in the configuration file stays effective.
 */
export const EDITOR_SETTINGS = {
  defaultBackend: { field: ['defaultBackend'], list: false },
  'routing.strategy': { field: ['routing', 'strategy'], list: false },
  'routing.allowedBackends': { field: ['routing', 'allowedBackends'], list: false },
  'codex.defaultModel': { field: ['backends', 'codex', 'defaultModel'], list: false },
  'claude.defaultModel': { field: ['backends', 'claude', 'defaultModel'], list: false },
  'agy.defaultModel': { field: ['backends', 'agy', 'defaultModel'], list: false },
  'approval.priceMultiplier': { field: ['governance', 'priceMultiplier'], list: false },
  'approval.askAbovePrice': { field: ['governance', 'askAbovePrice'], list: false },
  'approval.allowModels': { field: ['governance', 'models', 'allow'], list: true },
  'approval.askModels': { field: ['governance', 'models', 'ask'], list: true },
  'approval.denyModels': { field: ['governance', 'models', 'deny'], list: true },
} as const satisfies Record<string, { field: readonly string[]; list: boolean }>;

export type EditorSettingKey = keyof typeof EDITOR_SETTINGS;

/** The VS Code setting `coagent8.defaultBackend` names automatic selection `auto`; the file uses null. */
function settingValue(key: EditorSettingKey, value: unknown): unknown {
  return key === 'defaultBackend' && value === 'auto' ? null : value;
}

/**
 * Applies one VS Code user setting to a configuration object in place.
 * @param target - Unvalidated configuration; the caller validates the result.
 */
export function applyEditorSetting(target: Record<string, unknown>, key: EditorSettingKey, value: unknown): void {
  const { field, list } = EDITOR_SETTINGS[key];
  // A cleared model field in the Settings editor is stored as an empty string: no model chosen.
  if (key.endsWith('.defaultModel') && value === '') return;
  let node = target;
  for (const segment of field.slice(0, -1)) {
    const nested = node[segment];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  const leaf = field[field.length - 1]!;
  const current = node[leaf];
  node[leaf] = list && Array.isArray(current) && Array.isArray(value) ? [...current, ...value] : settingValue(key, value);
}

/**
 * Reads the explicit VS Code user settings passed by the extension.
 * @returns The settings by key, or an empty object when the server was not started by it.
 * @throws When the variable is not a JSON object of known settings.
 */
export function readEditorSettings(env: NodeJS.ProcessEnv = process.env): Partial<Record<EditorSettingKey, unknown>> {
  const raw = env[EDITOR_SETTINGS_ENV];
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (cause) { throw new Error(`${EDITOR_SETTINGS_ENV} is not valid JSON.`, { cause }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${EDITOR_SETTINGS_ENV} must be a JSON object.`);
  for (const key of Object.keys(parsed)) {
    if (!Object.hasOwn(EDITOR_SETTINGS, key)) throw new Error(`${EDITOR_SETTINGS_ENV} contains the unknown setting '${key}'.`);
  }
  return parsed as Partial<Record<EditorSettingKey, unknown>>;
}
