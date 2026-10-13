/**
 * `vscode:uninstall` hook. VS Code runs it with Node after the extension is uninstalled
 * and VS Code restarts, without the VS Code API and with a five-second limit; it then
 * deletes the extension's global storage itself. This removes the CoAgent8 entry the
 * extension keeps in each profile's `mcp.json`, the native-host registrations and skill
 * packages the extension wrote, when they are unchanged, and
 * runtime copies no registration references. Registrations made by the coagent8 CLI, manual or edited
 * entries and earlier records without an origin are preserved.
 * @packageDocumentation
 */
import os from 'node:os';
import path from 'node:path';
import { cleanupClients, type CleanupPreview } from '../../../src/integrations/cleanup.js';
import { removeVscodeRegistrations, type VscodeRemoval } from '../../../src/integrations/vscode-profile.js';
import { removePathIntegration, type PathRemovalResult } from '../../../src/integrations/vscode-path.js';
import { EXTENSION_ORIGIN } from '../../../src/integrations/setup-storage.js';
import { redactDiagnostic } from '../../../src/security/redaction.js';

/**
 * Longest wait for each of the two leases the hook takes: the profile lease a VS Code window
 * holds for well under a second, and the setup lease a running setup can hold much longer.
 * VS Code kills the hook after five seconds; both waits leave time for Node to start and for
 * the cleanup itself. What a lease still held protects stays and is reported.
 */
const LEASE_TIMEOUT_MS = 1500;
const START_TIME = Date.now();
const MAX_HOOK_DURATION_MS = 4000;

function remainingBudget(): number {
  const elapsed = Date.now() - START_TIME;
  return Math.max(300, Math.min(LEASE_TIMEOUT_MS, MAX_HOOK_DURATION_MS - elapsed));
}

async function main(): Promise<void> {
  let profiles: VscodeRemoval[] = [], profileError: string | undefined;
  // This file is <extensions folder>/<extension>/dist/uninstall.cjs; other installations keep their entries.
  try { profiles = await removeVscodeRegistrations(os.homedir(), path.dirname(path.dirname(__dirname)), remainingBudget()); }
  catch (error) { profileError = redactDiagnostic(error instanceof Error ? error.message : 'VS Code MCP cleanup failed.'); }
  let pathResult: PathRemovalResult | undefined, pathError: string | undefined;
  try { pathResult = await removePathIntegration(os.homedir(), path.dirname(path.dirname(__dirname)), remainingBudget()); }
  catch (error) { pathError = redactDiagnostic(error instanceof Error ? error.message : 'PATH cleanup failed.'); }
  let applied: CleanupPreview | undefined, cleanupError: string | undefined;
  try {
    const preview = await cleanupClients({ origin: EXTENSION_ORIGIN, uninstall: true });
    applied = await cleanupClients({ origin: EXTENSION_ORIGIN, uninstall: true, apply: preview.token, leaseTimeoutMs: remainingBudget() });
  }
  catch (error) { cleanupError = redactDiagnostic(error instanceof Error ? error.message : 'CoAgent8 registration cleanup failed.'); }
  // VS Code writes the hook's output to its shared-process log.
  console.log(JSON.stringify({ ...applied, profiles, ...(pathResult ? { path: pathResult } : {}), ...(profileError ? { profileError } : {}), ...(cleanupError ? { cleanupError } : {}), ...(pathError ? { pathError } : {}) }));
  if (profileError || pathError || pathResult?.action === 'blocked' || profiles.some(profile => profile.action === 'blocked') || !applied || applied.stateError || applied.results.some(result => result.action === 'blocked' || result.skills?.some(skill => skill.action === 'blocked'))) process.exitCode = 1;
}

main().catch(error => {
  console.error(redactDiagnostic(error instanceof Error ? error.message : 'CoAgent8 uninstall cleanup failed.'));
  process.exitCode = 1;
});
