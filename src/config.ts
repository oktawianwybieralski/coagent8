import fs from 'fs';
import path from 'path';
import os from 'os';
import { BackendId, CoAgentConfig, RoutingStrategy, ToolProfile } from './types/config.types.js';
import { CONFIG_CONSTANTS } from './constants/index.js';
import { getDataDir } from './paths.js';
import crypto from 'node:crypto';
import { readBoundedFileSync } from './execution/stream.js';

export const DEFAULT_CONFIG_DIR =
  process.env[CONFIG_CONSTANTS.ENV_DIR] ||
  path.join(os.homedir(), CONFIG_CONSTANTS.DIR_NAME);
export const CONFIG_FILE =
  process.env[CONFIG_CONSTANTS.ENV_CONFIG] ||
  path.join(DEFAULT_CONFIG_DIR, CONFIG_CONSTANTS.FILE_NAME);
export function getConfigFile(): string {
  return process.env.coagent8_CONFIG || path.join(getDataDir(), 'config.json');
}

export const VALID_BACKENDS: BackendId[] = ['codex', 'claude', 'gemini', 'smart_quota'];
export const VALID_STRATEGIES: RoutingStrategy[] = ['fixed', 'smart_quota'];
export const VALID_TOOL_PROFILES: ToolProfile[] = ['canonical', 'compact'];

export const DEFAULT_CONFIG: CoAgentConfig = {
  schemaVersion: 1,
  defaultBackend: null, // null triggers onboarding if multiple backends detected
  routing: {
    strategy: 'fixed',
    allowedBackends: ['codex', 'claude', 'gemini'],
  },
  toolProfile: 'canonical',
};

export function ensureConfigDir(): void {
  const dir = path.dirname(getConfigFile());
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }
}

/**
 * Validates configuration from disk or an update before routing uses it.
 * @param value - Untrusted JSON value; schema version 1 is required when supplied.
 * @returns A normalized configuration with independent routing arrays and defaults.
 * @throws On invalid version, backend, strategy, allowed providers or tool profile.
 */
export function validateConfig(value: unknown): CoAgentConfig {
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

  const validated: CoAgentConfig = {
    schemaVersion,
    defaultBackend: defaultBackend as BackendId | null,
    routing: {
      strategy,
      allowedBackends,
    },
  };

  if (config.toolProfile !== undefined && config.toolProfile !== null) {
    if (typeof config.toolProfile !== 'string' || !VALID_TOOL_PROFILES.includes(config.toolProfile.toLowerCase() as ToolProfile)) {
      throw new Error(
        `Configuration Error: Invalid toolProfile: '${config.toolProfile}'. Supported: ${VALID_TOOL_PROFILES.join(', ')}`
      );
    }
    validated.toolProfile = config.toolProfile.toLowerCase() as ToolProfile;
  }

  return validated;
}

export function loadConfig(): CoAgentConfig {
  const configFile = getConfigFile();
  const targetFile = fs.existsSync(configFile) ? configFile : null;

  let cfg: CoAgentConfig;
  if (!targetFile) {
    cfg = {
      ...DEFAULT_CONFIG,
      routing: { ...DEFAULT_CONFIG.routing, allowedBackends: [...DEFAULT_CONFIG.routing.allowedBackends] },
    };
  } else {
    let raw: string;
    try {
      raw = readBoundedFileSync(targetFile);
    } catch {
      throw new Error('Configuration Error: Failed to read the configuration file.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Configuration Error: Malformed JSON in the configuration file.');
    }

    cfg = validateConfig(parsed);
  }

  // Environment variable overrides for testing and container runtime
  if (process.env.coagent8_TOOL_PROFILE && VALID_TOOL_PROFILES.includes(process.env.coagent8_TOOL_PROFILE.toLowerCase() as ToolProfile)) {
    cfg.toolProfile = process.env.coagent8_TOOL_PROFILE.toLowerCase() as ToolProfile;
  }

  return cfg;
}

export function saveConfig(updates: Partial<CoAgentConfig>): CoAgentConfig {
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

export function getToolProfile(): ToolProfile {
  return loadConfig().toolProfile || 'canonical';
}

export function getDefaultBackend(): BackendId | null {
  const config = loadConfig();
  return config.defaultBackend;
}

export function setDefaultBackend(backend: unknown): CoAgentConfig {
  if (typeof backend !== 'string' || !VALID_BACKENDS.includes(backend.toLowerCase() as BackendId)) {
    throw new Error(
      `Validation Error: backend must be one of: ${VALID_BACKENDS.join(', ')}. Received: '${backend}'`
    );
  }
  return saveConfig({ defaultBackend: backend.toLowerCase() as BackendId });
}
