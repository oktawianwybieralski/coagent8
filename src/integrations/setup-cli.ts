import path from 'node:path';
import { setupClients, SETUP_CLIENTS, type SetupClient } from './setup.js';

/** Handles explicit CLI setup commands; no arguments continue to start the MCP server. */
export async function runSetupCli(args: string[]): Promise<boolean> {
  if (!args.length) return false;
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('CoAgent: no arguments starts the stdio MCP server.\nUsage: coagent8 setup|repair|status [--clients=codex,claude,agy]\n');
    return true;
  }
  if (!['setup', 'repair', 'status'].includes(args[0])) throw new Error('Usage: coagent8 setup|repair|status [--clients=codex,claude,agy]');
  const selection = args.find(arg => arg.startsWith('--clients='));
  if (args.slice(1).some(arg => arg !== selection)) throw new Error('Usage: coagent8 setup|repair|status [--clients=codex,claude,agy]');
  const clients = selection?.slice('--clients='.length).split(',');
  if (clients && !clients.every(client => SETUP_CLIENTS.includes(client as SetupClient))) throw new Error('Unknown setup client.');
  const results = await setupClients({ clients: clients as SetupClient[] | undefined, statusOnly: args[0] === 'status', runtimeSource: path.resolve(__dirname, 'index.cjs') });
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  if (results.some(result => result.action === 'blocked' || result.action === 'missing')) process.exitCode = 1;
  return true;
}
