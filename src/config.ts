import fs from 'fs';
import path from 'path';
import { PROVIDERS, ToolError, type ProviderId } from './contracts/index.js';
import { getDataDir } from './paths.js';
import crypto from 'node:crypto';
import { readBoundedFileSync } from './storage/read.js';
import { withFileLock, isAbortSignal, type FileLockOptions } from './storage/lock.js';
import type { BackendReadContext } from './contracts/execution.js';
import { redactDiagnostic } from './security/redaction.js';
import { isValidModelIdentifier } from './contracts/models.js';
import type { GovernanceSettings } from './contracts/governance.js';
import { applyEditorSetting, readEditorSettings, type EditorSettingKey } from './config-overrides.js';

/** Compatibility alias: config defaults may select a strategy, sessions may not. */
export type BackendId = ProviderId | 'smart_quota';
export type RoutingStrategy = 'fixed' | 'smart_quota';

export interface RoutingConfig {
  strategy: RoutingStrategy;
  allowedBackends: ProviderId[];
}

/** User settings of one backend. */
export interface BackendSettings {
  /** Model a turn runs when neither the call nor its session names one. */
  defaultModel?: string;
  /**
   * The CLI to run: an absolute path, a path starting with `~/`, or `vscode-extension` for
   * the newest copy the vendor's VS Code extension provides. Omitted, the CLI is found on
   * PATH, then in the vendor's VS Code extension.
   */
  executable?: string;
}

export interface CoAgent8Config {
  /** Editor schema association, preserved across runtime configuration updates. */
  $schema?: string;
  schemaVersion: number;
  defaultBackend: BackendId | null;
  routing: RoutingConfig;
  /** Per-backend settings; doctor records a default model here when it finds none. */
  backends: Partial<Record<ProviderId, BackendSettings>>;
  /** When the user is asked before a model runs; an approval with "remember" adds to `neverAsk`. */
  governance: GovernanceSettings;
}

/** Longest `alwaysAsk` or `neverAsk` list. */
const MAX_GOVERNED_MODELS = 256;

/** Resolves the user's configuration path, honoring the runtime environment override. */
export function getConfigFile(): string {
  return process.env.coagent8_CONFIG || path.join(getDataDir(), 'config.json');
}

/**
 * Returns whether the configuration file path originates from a custom environment override
 * (`coagent8_CONFIG`) or the default directory.
 */
export function getConfigFileOrigin(): 'custom-env' | 'default-path' {
  return process.env.coagent8_CONFIG ? 'custom-env' : 'default-path';
}

/**
 * Origin of a configuration value: default, file on disk, VS Code editor setting, or merged lists.
 */
export type SettingSource = 'default' | 'file' | 'editor' | 'merged';

/**
 * Provenance tracking the file resolution, disk presence, and per-setting origin.
 */
export interface ConfigProvenance {
  /** Resolved path to the configuration file. */
  configFile: string;
  /** Whether the path originates from `coagent8_CONFIG` or the default data directory. */
  configFileOrigin: 'custom-env' | 'default-path';
  /** Whether the configuration file existed on disk when loaded. */
  fileExisted: boolean;
  /** File stats (mtime and size) when the file existed. */
  fileStat?: { mtimeMs: number; size: number };
  /** Explicit VS Code editor settings keys applied from `coagent8_EDITOR_SETTINGS`. */
  editorOverridesApplied: EditorSettingKey[];
  /** Editor settings present in environment but unapplied (e.g. diagnostic fallback on invalid file). */
  editorOverridesAttempted?: EditorSettingKey[];
  /** Provenance of individual configuration settings. */
  sources: Record<string, SettingSource>;
}

/**
 * Request-local configuration snapshot capturing validated effective settings, provenance,
 * and a non-secret deterministic change identity.
 */
export interface ConfigSnapshot {
  /** Validated effective configuration. */
  config: CoAgent8Config;
  /** Origin and provenance details for this configuration view. */
  provenance: ConfigProvenance;
  /** Deterministic SHA-256 hex digest representing this configuration state (contains no raw secrets). */
  changeIdentity: string;
  /** Error message if the configuration file was unreadable, malformed, or invalid (diagnostics only). */
  error?: string;
}

/** Longest accepted `backends.<id>.executable`. */
const MAX_EXECUTABLE_LENGTH = 1024;
function isValidExecutable(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.length > MAX_EXECUTABLE_LENGTH || value.includes('\0')) return false;
  return value === 'vscode-extension' || /^~[\\/]./.test(value) || path.isAbsolute(value);
}

const VALID_BACKENDS: BackendId[] = ['codex', 'claude', 'agy', 'smart_quota'];
const VALID_STRATEGIES: RoutingStrategy[] = ['fixed', 'smart_quota'];

const DEFAULT_CONFIG: CoAgent8Config = {
  schemaVersion: 1,
  defaultBackend: null, // null lets auto choose among several backends
  routing: {
    strategy: 'fixed',
    allowedBackends: ['codex', 'claude', 'agy'],
  },
  backends: {},
  // Owner decision of 2026-10-07: twice the default's price, and 20 USD per million output
  // tokens for any model, the default included, unless the user relaxes either.
  governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
};

function ensureConfigDir(file = getConfigFile()): void {
  // A directory that cannot be created is reported here rather than as a later write failure.
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Validates configuration from disk or an update before routing uses it.
 * @param value - Untrusted JSON value; schema version 1 is required when supplied.
 * @returns A normalized configuration with independent routing arrays and defaults.
 * @throws On invalid version, backend, strategy, allowed providers or backend settings.
 * @remarks The legacy toolProfile and other unrecognized properties are ignored;
 * the returned object contains only the supported configuration fields.
 */
export function validateConfig(value: unknown): CoAgent8Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Configuration Error: configuration must be a valid JSON object.');
  }
  const config = value as Record<string, unknown>;
  const schema = config.$schema;
  if (schema !== undefined && (typeof schema !== 'string' || schema.length > 2048)) {
    throw new Error('Configuration Error: $schema must be a string of at most 2048 characters.');
  }

  const schemaVersion = config.schemaVersion ?? DEFAULT_CONFIG.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error(`Configuration Error: Invalid schemaVersion: expected positive number, got ${schemaVersion}`);
  }

  let defaultBackend = config.defaultBackend;
  if (defaultBackend !== null && defaultBackend !== undefined) {
    if (typeof defaultBackend !== 'string' || !VALID_BACKENDS.includes(defaultBackend.toLowerCase() as BackendId)) {
      throw new Error(
        `Configuration Error: Invalid defaultBackend: '${defaultBackend}'. Supported: ${VALID_BACKENDS.join(', ')} or null.`
      );
    }
    defaultBackend = defaultBackend.toLowerCase() as BackendId;
  } else {
    defaultBackend = null;
  }

  const routing = config.routing;
  let strategy = DEFAULT_CONFIG.routing.strategy;
  let allowedBackends = [...DEFAULT_CONFIG.routing.allowedBackends];

  if (routing !== undefined && routing !== null) {
    if (typeof routing !== 'object' || Array.isArray(routing)) {
      throw new Error('Configuration Error: routing must be a valid object.');
    }
    const fields = routing as Record<string, unknown>;

    if (fields.strategy !== undefined) {
      if (typeof fields.strategy !== 'string' || !VALID_STRATEGIES.includes(fields.strategy as RoutingStrategy)) {
        throw new Error(
          `Configuration Error: Invalid routing strategy. Supported: ${VALID_STRATEGIES.join(', ')}`
        );
      }
      strategy = fields.strategy as RoutingStrategy;
    }

    if (fields.allowedBackends !== undefined) {
      if (!Array.isArray(fields.allowedBackends)) {
        throw new Error(
          'Configuration Error: Invalid allowedBackends: expected an array of strings.'
        );
      }
      for (const b of fields.allowedBackends) {
        if (typeof b !== 'string' || !['codex', 'claude', 'agy'].includes(b.toLowerCase())) {
          throw new Error(
            `Configuration Error: Invalid entry in allowedBackends: '${b}'. Supported: 'codex', 'claude', 'agy'.`
          );
        }
      }
      allowedBackends = fields.allowedBackends.map((b: string) => b.toLowerCase() as Exclude<BackendId, 'smart_quota'>);
    }
  }

  const backends: CoAgent8Config['backends'] = {};
  if (config.backends !== undefined && config.backends !== null) {
    if (typeof config.backends !== 'object' || Array.isArray(config.backends)) {
      throw new Error('Configuration Error: backends must be an object keyed by backend.');
    }
    for (const [id, value] of Object.entries(config.backends as Record<string, unknown>)) {
      if (!(PROVIDERS as readonly string[]).includes(id)) {
        throw new Error(`Configuration Error: Invalid backends entry '${id}'. Supported: ${PROVIDERS.join(', ')}.`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Configuration Error: backends.${id} must be an object.`);
      }
      const { defaultModel, executable } = value as Record<string, unknown>;
      if (defaultModel !== undefined && !isValidModelIdentifier(defaultModel)) {
        throw new Error(`Configuration Error: backends.${id}.defaultModel is not a valid model identifier.`);
      }
      if (executable !== undefined && !isValidExecutable(executable)) {
        throw new Error(`Configuration Error: backends.${id}.executable must be an absolute path, a path starting with ~/, or "vscode-extension".`);
      }
      backends[id as ProviderId] = { ...(defaultModel === undefined ? {} : { defaultModel: defaultModel as string }), ...(executable === undefined ? {} : { executable: executable as string }) };
    }
  }

  const governance: GovernanceSettings = { ...DEFAULT_CONFIG.governance, alwaysAsk: [], neverAsk: [] };
  if (config.governance !== undefined && config.governance !== null) {
    if (typeof config.governance !== 'object' || Array.isArray(config.governance)) {
      throw new Error('Configuration Error: governance must be an object.');
    }
    const fields = config.governance as Record<string, unknown>;
    if (fields.priceMultiplier !== undefined) {
      if (typeof fields.priceMultiplier !== 'number' || !Number.isFinite(fields.priceMultiplier) || fields.priceMultiplier <= 1) {
        throw new Error('Configuration Error: governance.priceMultiplier must be a number greater than 1.');
      }
      governance.priceMultiplier = fields.priceMultiplier;
    }
    if (fields.askAbovePrice !== undefined) {
      if (fields.askAbovePrice !== null && (typeof fields.askAbovePrice !== 'number' || !Number.isFinite(fields.askAbovePrice) || fields.askAbovePrice < 0)) {
        throw new Error('Configuration Error: governance.askAbovePrice must be a price in USD per million output tokens, or null.');
      }
      governance.askAbovePrice = fields.askAbovePrice;
    }
    for (const list of ['alwaysAsk', 'neverAsk'] as const) {
      const value = fields[list];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.length > MAX_GOVERNED_MODELS || !value.every(isValidModelIdentifier)) {
        throw new Error(`Configuration Error: governance.${list} must be a list of at most ${MAX_GOVERNED_MODELS} model identifiers.`);
      }
      governance[list] = [...new Set(value)];
    }
  }

  const validated: CoAgent8Config = {
    ...(schema === undefined ? {} : { $schema: schema }),
    schemaVersion,
    defaultBackend: defaultBackend as BackendId | null,
    routing: {
      strategy,
      allowedBackends,
    },
    backends,
    governance,
  };

  // A legacy `toolProfile` key is ignored: one tool list now serves every client.
  return validated;
}

function defaultConfig(): CoAgent8Config {
  return { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, allowedBackends: [...DEFAULT_CONFIG.routing.allowedBackends] }, backends: {},
    governance: { ...DEFAULT_CONFIG.governance, alwaysAsk: [], neverAsk: [] } };
}

/**
 * Loads and validates the configuration file, or the defaults when there is none. Writes
 * start from this value, so VS Code settings are never copied into the file.
 * @throws `ToolError` (`POLICY_DENIED`) when the file exists but cannot be read, parsed or
 * validated: its routing policy (for example `allowedBackends`) cannot be applied, and
 * executing with the defaults instead could run a backend the user disabled.
 */
function loadFileConfig(configFile = getConfigFile()): CoAgent8Config {
  if (!fs.existsSync(configFile)) return defaultConfig();
  const unusable = (reason: string, cause: unknown) =>
    new ToolError('POLICY_DENIED', `Configuration Error: ${reason} (${configFile}); fix or delete the file. Its routing policy cannot be applied until then.`, { cause });
  let raw: string;
  try { raw = readBoundedFileSync(configFile); }
  catch (err) { throw unusable(`the file cannot be read: ${(err as Error).message}`, err); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw unusable('Malformed JSON in the configuration file', err); }
  try { return validateConfig(parsed); }
  catch (err) { throw unusable((err as Error).message.replace(/^Configuration Error:\s*/, ''), err); }
}

function collectSources(
  rawFile: Record<string, unknown> | null,
  editorSettings: Partial<Record<EditorSettingKey, unknown>>
): Record<string, SettingSource> {
  const sources: Record<string, SettingSource> = {
    defaultBackend: 'default',
    'routing.strategy': 'default',
    'routing.allowedBackends': 'default',
    'governance.priceMultiplier': 'default',
    'governance.askAbovePrice': 'default',
    'governance.alwaysAsk': 'default',
    'governance.neverAsk': 'default',
  };

  if (rawFile) {
    if (rawFile.defaultBackend !== undefined) sources.defaultBackend = 'file';
    if (rawFile.routing && typeof rawFile.routing === 'object' && !Array.isArray(rawFile.routing)) {
      const r = rawFile.routing as Record<string, unknown>;
      if (r.strategy !== undefined) sources['routing.strategy'] = 'file';
      if (r.allowedBackends !== undefined) sources['routing.allowedBackends'] = 'file';
    }
    if (rawFile.backends && typeof rawFile.backends === 'object' && !Array.isArray(rawFile.backends)) {
      for (const [id, val] of Object.entries(rawFile.backends as Record<string, unknown>)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const b = val as Record<string, unknown>;
          if (b.defaultModel !== undefined) sources[`backends.${id}.defaultModel`] = 'file';
          if (b.executable !== undefined) sources[`backends.${id}.executable`] = 'file';
        }
      }
    }
    if (rawFile.governance && typeof rawFile.governance === 'object' && !Array.isArray(rawFile.governance)) {
      const g = rawFile.governance as Record<string, unknown>;
      if (g.priceMultiplier !== undefined) sources['governance.priceMultiplier'] = 'file';
      if (g.askAbovePrice !== undefined) sources['governance.askAbovePrice'] = 'file';
      if (g.alwaysAsk !== undefined) sources['governance.alwaysAsk'] = 'file';
      if (g.neverAsk !== undefined) sources['governance.neverAsk'] = 'file';
    }
  }

  for (const key of Object.keys(editorSettings) as EditorSettingKey[]) {
    if (key === 'defaultBackend') sources.defaultBackend = 'editor';
    else if (key === 'routing.strategy') sources['routing.strategy'] = 'editor';
    else if (key === 'routing.allowedBackends') sources['routing.allowedBackends'] = 'editor';
    else if (key === 'codex.defaultModel') sources['backends.codex.defaultModel'] = 'editor';
    else if (key === 'claude.defaultModel') sources['backends.claude.defaultModel'] = 'editor';
    else if (key === 'agy.defaultModel') sources['backends.agy.defaultModel'] = 'editor';
    else if (key === 'approval.priceMultiplier') sources['governance.priceMultiplier'] = 'editor';
    else if (key === 'approval.askAbovePrice') sources['governance.askAbovePrice'] = 'editor';
    else if (key === 'approval.alwaysAskModels') {
      sources['governance.alwaysAsk'] = sources['governance.alwaysAsk'] === 'file' ? 'merged' : 'editor';
    } else if (key === 'approval.neverAskModels') {
      sources['governance.neverAsk'] = sources['governance.neverAsk'] === 'file' ? 'merged' : 'editor';
    }
  }

  return sources;
}

function computeChangeIdentity(config: CoAgent8Config, provenance: ConfigProvenance): string {
  const payload = JSON.stringify({
    schemaVersion: config.schemaVersion,
    defaultBackend: config.defaultBackend,
    routing: config.routing,
    backends: config.backends,
    governance: config.governance,
    origin: provenance.configFileOrigin,
    overrides: provenance.editorOverridesApplied,
    existed: provenance.fileExisted,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Loads a point-in-time configuration snapshot combining the validated effective settings,
 * disk provenance, and deterministic non-secret change identity.
 *
 * @param configFile - Path to configuration file (defaults to `getConfigFile()`).
 * @returns Immutable request-local `ConfigSnapshot`.
 * @throws `ToolError` (`POLICY_DENIED`) when the file exists but cannot be read or validated.
 */
export function loadConfigSnapshot(configFile = getConfigFile()): ConfigSnapshot {
  const configFileOrigin = getConfigFileOrigin();
  const fileExisted = fs.existsSync(configFile);
  let fileStat: { mtimeMs: number; size: number } | undefined;
  let parsedRaw: Record<string, unknown> | null = null;
  let base: CoAgent8Config;

  if (fileExisted) {
    try {
      const stat = fs.statSync(configFile);
      fileStat = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      // Best-effort stat
    }
    const unusable = (reason: string, cause: unknown) =>
      new ToolError('POLICY_DENIED', `Configuration Error: ${reason} (${configFile}); fix or delete the file. Its routing policy cannot be applied until then.`, { cause });
    let raw: string;
    try { raw = readBoundedFileSync(configFile); }
    catch (err) { throw unusable(`the file cannot be read: ${(err as Error).message}`, err); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (err) { throw unusable('Malformed JSON in the configuration file', err); }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsedRaw = parsed as Record<string, unknown>;
    }
    try { base = validateConfig(parsed); }
    catch (err) { throw unusable((err as Error).message.replace(/^Configuration Error:\s*/, ''), err); }
  } else {
    base = defaultConfig();
  }

  const unusableEditor = (reason: string, cause: unknown) =>
    new ToolError('POLICY_DENIED', `Configuration Error: ${reason}; fix it in the VS Code user settings. Its routing policy cannot be applied until then.`, { cause });
  let settings: Partial<Record<EditorSettingKey, unknown>>;
  try { settings = readEditorSettings(); }
  catch (err) { throw unusableEditor((err as Error).message, err); }

  const editorOverridesApplied = Object.keys(settings) as EditorSettingKey[];
  const combined = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings) as [EditorSettingKey, unknown][]) {
    // Each setting is validated alone first, so the error names the one to fix.
    const single = structuredClone(base) as unknown as Record<string, unknown>;
    applyEditorSetting(single, key, value);
    try { validateConfig(single); }
    catch (err) { throw unusableEditor(`VS Code setting coagent8.${key}: ${(err as Error).message.replace(/^Configuration Error:\s*/, '')}`, err); }
    applyEditorSetting(combined, key, value);
  }
  let effective: CoAgent8Config;
  try { effective = validateConfig(combined); }
  catch (err) { throw unusableEditor(`VS Code settings coagent8.*: ${(err as Error).message.replace(/^Configuration Error:\s*/, '')}`, err); }

  const sources = collectSources(parsedRaw, settings);
  const provenance: ConfigProvenance = {
    configFile,
    configFileOrigin,
    fileExisted,
    ...(fileStat ? { fileStat } : {}),
    editorOverridesApplied,
    sources,
  };
  const changeIdentity = computeChangeIdentity(effective, provenance);

  const snapshot: ConfigSnapshot = {
    config: effective,
    provenance,
    changeIdentity,
  };
  configLoadObserver?.(snapshot);
  return snapshot;
}

let configLoadObserver: ((snapshot: ConfigSnapshot) => void) | null = null;

/** Sets an observer callback invoked whenever a configuration snapshot is loaded. */
export function setConfigLoadObserver(observer: ((snapshot: ConfigSnapshot) => void) | null): void {
  configLoadObserver = observer;
}

/**
 * Loads the effective configuration: the file, then the explicit VS Code user settings the
 * extension passed in `coagent8_EDITOR_SETTINGS`.
 * @throws `ToolError` (`POLICY_DENIED`) when the file or a setting is unusable; the message
 * names the file or the setting.
 */
export function loadConfig(): CoAgent8Config {
  return loadConfigSnapshot().config;
}

/**
 * Loads configuration snapshot for diagnostics: an unusable file yields defaults with error details.
 */
export function loadConfigSnapshotForDiagnostics(configFile = getConfigFile()): ConfigSnapshot {
  try {
    return loadConfigSnapshot(configFile);
  } catch (err) {
    if (err instanceof ToolError && err.message.startsWith('Configuration Error:')) {
      const configFileOrigin = getConfigFileOrigin();
      const fileExisted = fs.existsSync(configFile);
      const effective = defaultConfig();
      let editorSettings: Partial<Record<EditorSettingKey, unknown>> = {};
      try { editorSettings = readEditorSettings(); } catch { /* ignore for fallback */ }
      const editorOverridesAttempted = Object.keys(editorSettings) as EditorSettingKey[];
      const sources = collectSources(null, {});
      const provenance: ConfigProvenance = {
        configFile,
        configFileOrigin,
        fileExisted,
        editorOverridesApplied: [],
        ...(editorOverridesAttempted.length ? { editorOverridesAttempted } : {}),
        sources,
      };
      const changeIdentity = computeChangeIdentity(effective, provenance);
      const snapshot: ConfigSnapshot = {
        config: effective,
        provenance,
        changeIdentity,
        error: err.message,
      };
      configLoadObserver?.(snapshot);
      return snapshot;
    }
    throw err;
  }
}

/**
 * Loads the configuration for diagnostics: an unusable file yields the defaults and the
 * error, so doctor can still report the backends.
 */
export function loadConfigForDiagnostics(): { config: CoAgent8Config; error?: string } {
  const snapshot = loadConfigSnapshotForDiagnostics();
  return { config: snapshot.config, ...(snapshot.error ? { error: snapshot.error } : {}) };
}

function writeConfig(config: CoAgent8Config, configFile = getConfigFile()): void {
  ensureConfigDir(configFile);
  const tmpPath = `${configFile}.tmp.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, configFile);
  } finally { fs.rmSync(tmpPath, { force: true }); }
}

export function saveConfig(updates: Partial<CoAgent8Config>): CoAgent8Config {
  const current = loadFileConfig();
  const merged = validateConfig({
    ...current,
    ...updates,
    routing: {
      ...current.routing,
      ...(updates.routing || {}),
    },
    backends: { ...current.backends, ...(updates.backends || {}) },
    governance: { ...current.governance, ...(updates.governance || {}) },
  });
  writeConfig(merged);
  return merged;
}

const REMEMBER_ABORTED_MESSAGE = 'Request cancelled before recording remembered approval.';

/**
 * Adds a model the user approved with "remember" to `governance.neverAsk` of the file; the
 * VS Code list `coagent8.approval.neverAskModels` is added to it, never replaced by it.
 * @param model - Model identifier to remember.
 * @param options - Optional file lock options, read context, or cancellation signal.
 * @returns Whether the list changed.
 * @throws `ToolError` on invalid model identifier, cancellation, or expired budget.
 * @throws When the configuration cannot be locked, read, validated or written.
 */
export async function rememberApprovedModel(
  model: string,
  options?: FileLockOptions | BackendReadContext | AbortSignal
): Promise<boolean> {
  if (!isValidModelIdentifier(model)) {
    throw new ToolError('INPUT_LIMIT', `Invalid model identifier: '${redactDiagnostic(model, 64)}'`);
  }
  ensureConfigDir();
  return withFileLock(getConfigFile(), async () => {
    if (isAbortSignal(options)) {
      if (options.aborted) {
        throw new ToolError('ABORTED', REMEMBER_ABORTED_MESSAGE);
      }
    } else if (options) {
      const nestedContext = 'context' in options ? options.context : undefined;
      const callerSignal = options.abortSignal ?? nestedContext?.abortSignal;
      const budget = options.budget ?? nestedContext?.budget;

      if (callerSignal?.aborted || budget?.isCallerAborted()) {
        throw new ToolError('ABORTED', REMEMBER_ABORTED_MESSAGE);
      }
      if (budget && (budget.isExecutionExpired() || budget.isTimedOut())) {
        throw new ToolError('TIMEOUT', 'Execution budget expired before recording remembered approval.');
      }
    }
    const file = getConfigFile();
    const current = loadFileConfig(file);
    if (current.governance.neverAsk.includes(model)) return false;
    writeConfig(validateConfig({ ...current, governance: { ...current.governance, neverAsk: [...current.governance.neverAsk, model] } }), file);
    return true;
  }, options);
}

/**
 * Records a backend's default model in the file unless the file or a VS Code setting
 * already names one.
 * @param id - Backend.
 * @param model - The model to record.
 * @returns Whether the model was written.
 * @throws When the configuration cannot be locked, read, validated or written.
 */
export async function recordDefaultModel(id: ProviderId, model: string): Promise<boolean> {
  ensureConfigDir();
  return withFileLock(getConfigFile(), async () => {
    if (loadConfig().backends[id]?.defaultModel) return false;
    const current = loadFileConfig();
    writeConfig(validateConfig({ ...current, backends: { ...current.backends, [id]: { ...current.backends[id], defaultModel: model } } }));
    return true;
  });
}

/**
 * Reads `backends.<id>.executable` from one configuration file, without VS Code settings.
 * @throws `ToolError` (`POLICY_DENIED`) when the file is unusable.
 */
export function readBackendExecutable(id: ProviderId, file = getConfigFile()): string | undefined {
  return loadFileConfig(file).backends[id]?.executable;
}

/**
 * Records the CLI a backend runs, unless the file already names one; the user may change it
 * at any time afterwards.
 * @param file - The configuration file; the VS Code extension passes the one it gives the runtime.
 * @returns Whether the value was written.
 * @throws When the configuration cannot be locked, read, validated or written.
 */
export async function recordBackendExecutable(id: ProviderId, executable: string, file = getConfigFile()): Promise<boolean> {
  ensureConfigDir(file);
  return withFileLock(file, async () => {
    const current = loadFileConfig(file);
    if (current.backends[id]?.executable) return false;
    writeConfig(validateConfig({ ...current, backends: { ...current.backends, [id]: { ...current.backends[id], executable } } }), file);
    return true;
  });
}

/**
 * Sets the CLI a backend runs, replacing any earlier choice; undefined restores automatic discovery.
 * @param file - The configuration file; the VS Code extension passes the one it gives the runtime.
 * @throws When the configuration cannot be locked, read, validated or written.
 */
export async function setBackendExecutable(id: ProviderId, executable: string | undefined, file = getConfigFile()): Promise<void> {
  ensureConfigDir(file);
  await withFileLock(file, async () => {
    const current = loadFileConfig(file);
    const { executable: _previous, ...rest } = current.backends[id] ?? {};
    writeConfig(validateConfig({ ...current, backends: { ...current.backends, [id]: executable === undefined ? rest : { ...rest, executable } } }), file);
  });
}

export function setDefaultBackend(backend: unknown): CoAgent8Config {
  if (typeof backend !== 'string' || !VALID_BACKENDS.includes(backend.toLowerCase() as BackendId)) {
    throw new ToolError(
      'INPUT_LIMIT',
      `Validation Error: backend must be one of: ${VALID_BACKENDS.join(', ')}. Received: '${backend}'`
    );
  }
  return saveConfig({ defaultBackend: backend.toLowerCase() as BackendId });
}
