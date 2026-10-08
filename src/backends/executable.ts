/**
 * The executable of each backend CLI.
 * @remarks Order: an environment override (`CODEX_PATH`, `CLAUDE_PATH`, `AGY_PATH`, kept for
 * tests, CI and scripted launches), then `backends.<id>.executable` from the configuration,
 * then the CLI name, which the resolver finds on PATH and then in the vendor's VS Code
 * extension. A configured executable that cannot be found fails for that backend only; it
 * never falls back to another installation.
 * @packageDocumentation
 */
import os from 'node:os';
import path from 'node:path';
import type { ProviderId } from '../conversation.js';
import { loadConfigForDiagnostics } from '../config.js';
import { CliResolutionError, resolveBundledClaude, resolveBundledCodex, resolveManagedAgy } from '../execution/cli-resolver.js';
import type { AdapterProbeResult } from './types.js';

/** `backends.<id>.executable` value for the newest copy the vendor's VS Code extension provides. */
export const VSCODE_EXTENSION_EXECUTABLE = 'vscode-extension';
const NAMES: Record<ProviderId, string> = { codex: 'codex', claude: 'claude', agy: 'agy' };

/** The environment override of a backend's executable, if any. */
export function environmentOverride(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (id === 'codex' ? env.CODEX_PATH : id === 'claude' ? env.CLAUDE_PATH : env.AGY_PATH) || undefined;
}

/**
 * Resolves the command that runs a backend's CLI.
 * @param configured - A validated `backends.<id>.executable`, or undefined for automatic discovery.
 * @param home - Profile root for `~/` and the vendor extensions' copies.
 * @returns An absolute path, or the CLI name for automatic discovery.
 * @throws `CliResolutionError` (`CLI_NOT_FOUND`) when `vscode-extension` is configured and the
 * vendor's VS Code extension provides no usable copy.
 */
export function backendCommand(id: ProviderId, configured: string | undefined, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const override = environmentOverride(id, env);
  if (override) return override;
  if (configured === VSCODE_EXTENSION_EXECUTABLE) {
    const bundled = id === 'codex' ? resolveBundledCodex(home, env) : id === 'claude' ? resolveBundledClaude(home, env) : resolveManagedAgy(home, env);
    if (!bundled) throw new CliResolutionError('CLI_NOT_FOUND', `backends.${id}.executable is "${VSCODE_EXTENSION_EXECUTABLE}", but the vendor's VS Code extension provides no ${NAMES[id]} executable.`);
    return bundled.command;
  }
  if (configured) return /^~[\\/]/.test(configured) ? path.join(home, configured.slice(2)) : configured;
  return NAMES[id];
}

/** The command for this runtime, from its configuration file and VS Code settings. */
export function configuredBackendCommand(id: ProviderId): string {
  return backendCommand(id, loadConfigForDiagnostics().config.backends[id]?.executable);
}

/**
 * Resolves the command for a probe, which must report rather than throw.
 * @returns The command, or the probe result of a backend whose configured executable is missing.
 */
export function probeCommand(id: ProviderId, name: string): { command: string } | { unresolved: AdapterProbeResult } {
  try { return { command: configuredBackendCommand(id) }; }
  catch (error) {
    if (!(error instanceof CliResolutionError)) throw error;
    return { unresolved: { id, name, installed: false, executionSupported: false, authStatus: 'unknown', authEvidence: [(error as CliResolutionError).message] } };
  }
}
