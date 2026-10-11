// Scripted replacement for src/integrations/setup.ts, bundled into the VS Code extension
// by tests/integrations/vscode-extension.test.js. `globalThis.setupFixture` holds the scripted
// machine: which CLIs are installed, their installations and the chat registrations.
const fs = require('node:fs');
const path = require('node:path');

export const SETUP_CLIENTS = ['codex', 'claude', 'agy'];
export const SETUP_PROVIDERS = { codex: 'codex', claude: 'claude', agy: 'agy' };
const scripted = () => globalThis.setupFixture;

/** A file inside a vendor extension's folder is that extension's copy. */
export function clientSource(client, cli) {
  return scripted().vendorRoots.some(root => cli.command.startsWith(root))
    ? { kind: 'vscode-extension', executable: 'vscode-extension' }
    : { kind: 'standalone', executable: path.resolve(cli.command) };
}
export function resolveSetupClient(client) {
  return scripted().found(client) ? { command: scripted().commands[client] ?? 'fixture-' + client, argsPrefix: [], source: 'native' } : null;
}
/** The installation in use, then the scripted others; one that `requires` an extension appears with it. */
export function listInstallations(client) {
  const cli = resolveSetupClient(client);
  const current = cli ? [{ ...clientSource(client, cli), file: cli.command }] : [];
  const others = (scripted().extraInstallations[client] ?? [])
    .filter(item => !item.requires || scripted().installedVendors().includes(item.requires))
    .map(({ requires, ...item }) => item)
    .filter(item => !current.some(used => used.kind === item.kind && used.executable === item.executable));
  return [...current, ...others];
}
/** Reads the configuration file the extension gives the runtime; a scripted value can be missing. */
export function configuredExecutable(client, home, env) {
  if (!fs.existsSync(env.coagent8_CONFIG)) return undefined;
  const value = JSON.parse(fs.readFileSync(env.coagent8_CONFIG, 'utf8')).backends?.[client]?.executable;
  return value === undefined ? undefined : { value, found: !scripted().missingConfigured.includes(client) && !scripted().removedFile(client, value) && !(value === 'vscode-extension' && scripted().vendorGone(client)) };
}
export async function checkExecutable(client, file) {
  scripted().recordEvent('check-executable');
  const failure = scripted().executableChecks[file];
  if (failure) throw new Error(failure);
  return { source: { kind: 'standalone', executable: path.resolve(file) }, readiness: { version: '9.9.9', compatibility: 'supported', authentication: 'authenticated', ready: true, diagnostic: '' } };
}
export function readRegistrations(options) {
  scripted().recordEvent('registrations');
  if (!options.runtimeSource) throw new Error('missing runtime');
  return SETUP_CLIENTS.map(client => {
    const state = scripted().registrationStates[client];
    return { client, state: state === 'outdated' ? 'owned' : state ?? 'absent', current: state !== 'outdated', message: state === 'blocked' ? 'Malformed fixture configuration.' : 'fixture' };
  });
}
export async function setupClients(options) {
  scripted().recordEvent(options.statusOnly ? 'status' : 'setup');
  if (options.origin !== 'vscode-extension') throw new Error('missing extension origin');
  if (options.statusOnly) return options.clients.map(client => scripted().statusOf(client));
  scripted().recordClients(options.clients);
  return options.clients.map(client => ({ ...scripted().statusOf(client), action: scripted().registrationStates[client] === 'outdated' ? 'updated' : 'installed' }));
}
