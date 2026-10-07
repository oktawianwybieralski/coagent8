/**
 * Probe results reused across requests, so routing does not launch `--version` processes
 * on every call. @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { adapterRegistry } from './registry.js';
import { resolveCliCommand } from '../execution/cli-resolver.js';
import type { ProviderId } from '../conversation.js';
import type { AdapterProbeResult, CliAdapter, ModelCatalog } from './types.js';

/** Upper bound for reusing a probe; doctor always probes afresh. */
const PROBE_TTL_MS = 5 * 60 * 1000;
/** Selected environment inputs for the cache key; not a complete provider-settings fingerprint. */
const PROBE_ENVIRONMENT = ['PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'CODEX_PATH', 'CODEX_CONFIG_PATH', 'OPENAI_API_KEY',
  'CODEX_API_KEY', 'AGY_PATH', 'GEMINI_PATH', 'GEMINI_CLI_HOME', 'GEMINI_API_KEY', 'CLAUDE_PATH', 'ANTHROPIC_API_KEY'] as const;

interface CachedProbe { adapter: CliAdapter; probeFn: CliAdapter['probe']; probe: AdapterProbeResult; key: string; at: number }
const cache = new Map<ProviderId, CachedProbe>();

function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return `${file}:missing`;
    throw err;
  }
}

/**
 * Identifies what a probe observed: the resolved executable files, the configuration file
 * and selected environment variables. Changes outside these stamps are not detected.
 */
function probeKey(probe: AdapterProbeResult): string {
  const parts: string[] = PROBE_ENVIRONMENT.map(name => `${name}=${process.env[name] ?? ''}`);
  if (probe.command) {
    let files: string[];
    try {
      const resolved = resolveCliCommand(probe.command);
      files = [resolved.command, ...resolved.argsPrefix].filter(part => path.isAbsolute(part));
    } catch (err) {
      files = [`unresolved:${(err as Error).message}`];
    }
    parts.push(...files.map(file => file.startsWith('unresolved:') ? file : fileStamp(file)));
  }
  if (probe.configPath) parts.push(fileStamp(probe.configPath));
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Returns the backend's probe, reusing a cached result while its CLI, configuration and
 * selected environment stamps are unchanged and it is younger than the five-minute TTL.
 * Concurrent misses are not coalesced; the cache stores completed probes only.
 * @param id - Backend to probe.
 * @param options - `fresh` always probes and replaces the cached result (doctor).
 */
export async function probeBackend(id: ProviderId, options: { fresh?: boolean } = {}): Promise<AdapterProbeResult> {
  const adapter = adapterRegistry[id];
  const cached = cache.get(id);
  if (!options.fresh && cached && cached.adapter === adapter && cached.probeFn === adapter.probe && Date.now() - cached.at < PROBE_TTL_MS && cached.key === probeKey(cached.probe)) {
    return cached.probe;
  }
  const probe = await adapter.probe();
  cache.set(id, { adapter, probeFn: adapter.probe, probe, key: probeKey(probe), at: Date.now() });
  return probe;
}

interface CachedCatalog { listFn: CliAdapter['listModels']; catalog: ModelCatalog | undefined; key: string; at: number }
const catalogs = new Map<ProviderId, CachedCatalog>();

/**
 * Returns a completed CLI catalog cached for up to five minutes when its key matches.
 * Concurrent misses can perform duplicate reads; no catalog is persisted to disk.
 * @param id - Backend whose catalog to read.
 * @param options - `fresh` reads again (doctor).
 * @returns The catalog, or undefined when the CLI is not installed, has no catalog or
 * did not answer; an unanswered read is also kept, so a slow CLI is not asked on every call.
 */
export async function readModelCatalog(id: ProviderId, options: { fresh?: boolean } = {}): Promise<ModelCatalog | undefined> {
  const adapter = adapterRegistry[id];
  if (!adapter.listModels) return undefined;
  const probe = await probeBackend(id);
  if (!probe.installed) return undefined;
  const key = probeKey(probe);
  const cached = catalogs.get(id);
  if (!options.fresh && cached && cached.listFn === adapter.listModels && cached.key === key && Date.now() - cached.at < PROBE_TTL_MS) return cached.catalog;
  const catalog = await adapter.listModels();
  catalogs.set(id, { listFn: adapter.listModels, catalog, key, at: Date.now() });
  return catalog;
}
