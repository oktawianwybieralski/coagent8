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
import { cleanupClients } from '../../../src/integrations/cleanup.js';
import { removeVscodeRegistrations, type VscodeRemoval } from '../../../src/integrations/vscode-profile.js';
import { EXTENSION_ORIGIN } from '../../../src/integrations/setup-storage.js';
import { redactDiagnostic } from '../../../src/security/redaction.js';

/**
 * Longest wait for a lease another VS Code window or CoAgent8 process holds. VS Code kills
 * the hook after five seconds; the wait leaves time for Node to start and for the rest of
 * the cleanup, and a window holds the lease for well under a second.
 */
const LEASE_TIMEOUT_MS = 1500;

async function main(): Promise<void> {
  let profiles: VscodeRemoval[] = [], profileError: string | undefined;
  // This file is <extensions folder>/<extension>/dist/uninstall.cjs; other installations keep their entries.
  try { profiles = await removeVscodeRegistrations(os.homedir(), path.dirname(path.dirname(__dirname)), LEASE_TIMEOUT_MS); }
  catch (error) { profileError = redactDiagnostic(error instanceof Error ? error.message : 'VS Code MCP cleanup failed.'); }
  const preview = await cleanupClients({ origin: EXTENSION_ORIGIN, uninstall: true });
  const applied = await cleanupClients({ origin: EXTENSION_ORIGIN, uninstall: true, apply: preview.token });
  // VS Code writes the hook's output to its shared-process log.
  console.log(JSON.stringify({ ...applied, profiles, ...(profileError ? { profileError } : {}) }));
  if (profileError || applied.stateError || applied.results.some(result => result.action === 'blocked' || result.skills?.some(skill => skill.action === 'blocked'))) process.exitCode = 1;
}

main().catch(error => {
  console.error(redactDiagnostic(error instanceof Error ? error.message : 'CoAgent8 uninstall cleanup failed.'));
  process.exitCode = 1;
});
