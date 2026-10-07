import fs from 'fs';
import path from 'path';
import { PROVIDERS, ToolError, type ProviderId } from './conversation.js';
import { getDataDir } from './paths.js';
import crypto from 'node:crypto';
import { readBoundedFileSync } from './execution/stream.js';
import { withFileLock } from './sessions/lock.js';
import { isValidModelIdentifier } from './backends/model-identifier.js';
import type { GovernanceSettings } from './backends/governance.js';

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
}

export interface CoAgent8Config {
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

function getConfigFile(): string {
  return process.env.coagent8_CONFIG || path.join(getDataDir(), 'config.json');
}

const VALID_BACKENDS: BackendId[] = ['codex', 'claude', 'gemini', 'smart_quota'];
const VALID_STRATEGIES: RoutingStrategy[] = ['fixed', 'smart_quota'];

const DEFAULT_CONFIG: CoAgent8Config = {
  schemaVersion: 1,
  defaultBackend: null, // null lets auto choose among several backends
  routing: {
    strategy: 'fixed',
    allowedBackends: ['codex', 'claude', 'gemini'],
  },
  backends: {},
  // Owner decision of 2026-10-07: twice the default's price, and 20 USD per million output
  // tokens for any model, the default included, unless the user relaxes either.
  governance: { priceMultiplier: 2, askAbovePrice: 20, alwaysAsk: [], neverAsk: [] },
};

function ensureConfigDir(): void {
  // A directory that cannot be created is reported here rather than as a later write failure.
  fs.mkdirSync(path.dirname(getConfigFile()), { recursive: true });
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
        if (typeof b !== 'string' || !['codex', 'claude', 'gemini'].includes(b.toLowerCase())) {
          throw new Error(
            `Configuration Error: Invalid entry in allowedBackends: '${b}'. Supported: 'codex', 'claude', 'gemini'.`
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
      const { defaultModel } = value as Record<string, unknown>;
      if (defaultModel !== undefined && !isValidModelIdentifier(defaultModel)) {
        throw new Error(`Configuration Error: backends.${id}.defaultModel is not a valid model identifier.`);
      }
      backends[id as ProviderId] = defaultModel === undefined ? {} : { defaultModel };
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
 * Loads and validates the configuration file, or the defaults when there is none.
 * @throws `ToolError` (`POLICY_DENIED`) when the file exists but cannot be read, parsed or
 * validated: its routing policy (for example `allowedBackends`) cannot be applied, and
 * executing with the defaults instead could run a backend the user disabled.
 */
export function loadConfig(): CoAgent8Config {
  const configFile = getConfigFile();
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

/**
 * Loads the configuration for diagnostics: an unusable file yields the defaults and the
 * error, so doctor can still report the backends.
 */
export function loadConfigForDiagnostics(): { config: CoAgent8Config; error?: string } {
  try { return { config: loadConfig() }; }
  catch (err) {
    if (err instanceof ToolError && err.message.startsWith('Configuration Error:')) return { config: defaultConfig(), error: err.message };
    throw err;
  }
}

function writeConfig(config: CoAgent8Config): void {
  const configFile = getConfigFile();
  ensureConfigDir();
  const tmpPath = `${configFile}.tmp.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, configFile);
  } finally { fs.rmSync(tmpPath, { force: true }); }
}

export function saveConfig(updates: Partial<CoAgent8Config>): CoAgent8Config {
  const current = loadConfig();
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

/**
 * Adds a model the user approved with "remember" to `governance.neverAsk`.
 * @returns Whether the list changed.
 * @throws When the configuration cannot be locked, read, validated or written.
 */
export async function rememberApprovedModel(model: string): Promise<boolean> {
  ensureConfigDir();
  return withFileLock(getConfigFile(), async () => {
    const current = loadConfig();
    if (current.governance.neverAsk.includes(model)) return false;
    writeConfig(validateConfig({ ...current, governance: { ...current.governance, neverAsk: [...current.governance.neverAsk, model] } }));
    return true;
  });
}

/**
 * Records a backend's default model unless the configuration already names one.
 * @param id - Backend.
 * @param model - The model to record.
 * @returns Whether the model was written.
 * @throws When the configuration cannot be locked, read, validated or written.
 */
export async function recordDefaultModel(id: ProviderId, model: string): Promise<boolean> {
  ensureConfigDir();
  return withFileLock(getConfigFile(), async () => {
    const current = loadConfig();
    if (current.backends[id]?.defaultModel) return false;
    writeConfig(validateConfig({ ...current, backends: { ...current.backends, [id]: { ...current.backends[id], defaultModel: model } } }));
    return true;
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
