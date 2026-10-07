import fs from 'fs';
import path from 'path';
import { ToolError, type ProviderId } from './conversation.js';
import { getDataDir } from './paths.js';
import crypto from 'node:crypto';
import { readBoundedFileSync } from './execution/stream.js';

/** Compatibility alias: config defaults may select a strategy, sessions may not. */
export type BackendId = ProviderId | 'smart_quota';
export type RoutingStrategy = 'fixed' | 'smart_quota';

export interface RoutingConfig {
  strategy: RoutingStrategy;
  allowedBackends: ProviderId[];
}

export interface CoAgent8Config {
  schemaVersion: number;
  defaultBackend: BackendId | null;
  routing: RoutingConfig;
}

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
};

function ensureConfigDir(): void {
  // A directory that cannot be created is reported here rather than as a later write failure.
  fs.mkdirSync(path.dirname(getConfigFile()), { recursive: true });
}

/**
 * Validates configuration from disk or an update before routing uses it.
 * @param value - Untrusted JSON value; schema version 1 is required when supplied.
 * @returns A normalized configuration with independent routing arrays and defaults.
 * @throws On invalid version, backend, strategy, allowed providers or tool profile.
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

  const validated: CoAgent8Config = {
    schemaVersion,
    defaultBackend: defaultBackend as BackendId | null,
    routing: {
      strategy,
      allowedBackends,
    },
  };

  // A legacy `toolProfile` key is ignored: one tool list now serves every client.
  return validated;
}

function defaultConfig(): CoAgent8Config {
  return { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, allowedBackends: [...DEFAULT_CONFIG.routing.allowedBackends] } };
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

export function saveConfig(updates: Partial<CoAgent8Config>): CoAgent8Config {
  const configFile = getConfigFile();
  ensureConfigDir();
  const current = loadConfig();
  const merged = validateConfig({
    ...current,
    ...updates,
    routing: {
      ...current.routing,
      ...(updates.routing || {}),
    },
  });

  const tmpPath = `${configFile}.tmp.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmpPath, configFile);
  } finally { fs.rmSync(tmpPath, { force: true }); }
  return merged;
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
