import path from 'node:path';
import { setupClients, SETUP_CLIENTS, type SetupClient } from './setup.js';
import { cleanupClients } from './cleanup.js';

/** Handles explicit CLI setup commands; no arguments continue to start the MCP server. */
export async function runSetupCli(args: string[]): Promise<boolean> {
  if (!args.length) return false;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('CoAgent8: no arguments starts the stdio MCP server.\nUsage: coagent8 setup|repair|status|cleanup [--clients=codex,claude,agy]\nSetup/repair explicitly authorize native-host MCP registration and install the CoAgent8 skills with it. Status checks CLI readiness.\nCleanup previews owned removals of registrations and skills; apply with cleanup --apply=<preview token>.\nnpm uninstall runs no cleanup: run cleanup first.\n');
    return true;
  }
  if (!['setup', 'repair', 'status', 'cleanup'].includes(args[0])) throw new Error('Unknown setup command.');
  const selection = args.find(arg => arg.startsWith('--clients='));
  const apply = args.find(arg => arg.startsWith('--apply='));
  if (args.slice(1).some(arg => arg !== selection && (args[0] !== 'cleanup' || arg !== apply)) || args.filter(arg => arg.startsWith('--clients=')).length > 1 || args.filter(arg => arg.startsWith('--apply=')).length > 1) throw new Error('Invalid setup arguments.');
  const clients = selection?.slice('--clients='.length).split(',');
  if (clients && !clients.every(client => SETUP_CLIENTS.includes(client as SetupClient))) throw new Error('Unknown setup client.');
  if (args[0] === 'cleanup') {
    const preview = await cleanupClients({ clients: clients as SetupClient[] | undefined, apply: apply?.slice('--apply='.length) });
    process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
    const kept = (action: string) => action === 'blocked' || action === 'preserved';
    if (preview.stateError || preview.results.some(result => kept(result.action) || result.skills?.some(skill => kept(skill.action)))) process.exitCode = 1;
    return true;
  }
  // The bundle lives in the package's dist/; the skill catalog ships beside it.
  const results = await setupClients({ clients: clients as SetupClient[] | undefined, statusOnly: args[0] === 'status', runtimeSource: path.resolve(__dirname, 'index.cjs'), skillsSource: path.resolve(__dirname, '..', 'skills') });
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  if (args[0] === 'status' ? !results.some(result => result.ready) : results.some(result => result.action === 'blocked' || result.action === 'missing' || result.skills?.some(skill => skill.action === 'blocked'))) process.exitCode = 1;
  return true;
}
