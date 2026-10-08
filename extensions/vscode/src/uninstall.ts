/**
 * `vscode:uninstall` hook. VS Code runs it with Node after the extension is uninstalled
 * and VS Code restarts, without the VS Code API and with a five-second limit; it then
 * deletes the extension's global storage itself. This removes the native-host
 * registrations the extension wrote, when they are unchanged, and runtime copies no
 * registration references. Registrations made by the coagent8 CLI, manual or edited
 * entries and earlier records without an origin are preserved.
 * @packageDocumentation
 */
import { cleanupClients } from '../../../src/integrations/cleanup.js';
import { EXTENSION_ORIGIN } from '../../../src/integrations/setup-storage.js';
import { redactDiagnostic } from '../../../src/redaction.js';

async function main(): Promise<void> {
  const preview = await cleanupClients({ origin: EXTENSION_ORIGIN, uninstall: true });
  const applied = await cleanupClients({ origin: EXTENSION_ORIGIN, uninstall: true, apply: preview.token });
  // VS Code writes the hook's output to its shared-process log.
  console.log(JSON.stringify(applied));
  if (applied.stateError || applied.results.some(result => result.action === 'blocked')) process.exitCode = 1;
}

main().catch(error => {
  console.error(redactDiagnostic(error instanceof Error ? error.message : 'CoAgent8 uninstall cleanup failed.'));
  process.exitCode = 1;
});
