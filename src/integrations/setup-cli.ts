import path from 'node:path';
import { setupClients, SETUP_CLIENTS, type SetupClient } from './setup.js';
import { cleanupClients } from './cleanup.js';
import { manageSkills, skillSelectionForAction } from './skill-management.js';
import { redactDiagnostic } from '../security/redaction.js';

async function runSkillsCli(args: string[]): Promise<void> {
  const [action, ...flags] = args;
  if (!['status', 'install', 'uninstall', 'enable', 'disable'].includes(action))
    throw new Error(
      'Usage: coagent8 skills status|install|uninstall|enable|disable --clients=agy [--skills=coagent8-review,...] [--apply=<preview token>].',
    );
  const allowed = ['--clients=', '--skills=', '--apply='];
  if (
    flags.some(flag => !allowed.some(prefix => flag.startsWith(prefix))) ||
    allowed.some(prefix => flags.filter(flag => flag.startsWith(prefix)).length > 1)
  )
    throw new Error('Invalid skill arguments.');
  const clients = flags
    .find(flag => flag.startsWith('--clients='))
    ?.slice(10)
    .split(',') ?? [...SETUP_CLIENTS];
  const names = flags
    .find(flag => flag.startsWith('--skills='))
    ?.slice(9)
    .split(',');
  const apply = flags.find(flag => flag.startsWith('--apply='))?.slice(8);
  if (
    !clients.length ||
    !clients.every(client => SETUP_CLIENTS.includes(client as SetupClient)) ||
    new Set(clients).size !== clients.length ||
    (apply !== undefined && clients.length !== 1)
  )
    throw new Error('Choose known clients; apply one client preview at a time.');
  if (action === 'status' && (names || apply !== undefined)) throw new Error('Skill status takes only --clients.');
  const results = [];
  for (const client of clients as SetupClient[]) {
    const options = { client, skillsSource: path.resolve(__dirname, '..', 'skills') };
    const current = await manageSkills(options);
    if (action === 'status') {
      results.push(current);
      continue;
    }
    const selected =
      names ?? (action === 'enable' || action === 'disable' ? current.selection.installed : current.skills.map(item => item.name));
    if (
      !selected.length ||
      new Set(selected).size !== selected.length ||
      selected.some(name => !current.skills.some(item => item.name === name))
    )
      throw new Error('Choose unique catalog skill names.');
    const selection = skillSelectionForAction(current.selection, selected, action as 'install' | 'uninstall' | 'enable' | 'disable');
    results.push(await manageSkills({ ...options, selection, apply }));
  }
  const publicResults = results.map(result => ({
    ...result,
    root: redactDiagnostic(result.root),
    disabledRoot: redactDiagnostic(result.disabledRoot),
    skills: result.skills.map(skill => ({ ...skill, message: redactDiagnostic(skill.message) })),
  }));
  process.stdout.write(JSON.stringify(publicResults, null, 2) + '\n');
  if (results.some(result => result.skills.some(skill => skill.state === 'conflict'))) process.exitCode = 1;
}

/** Handles explicit CLI setup commands; no arguments continue to start the MCP server. */
export async function runSetupCli(args: string[]): Promise<boolean> {
  if (!args.length) return false;
  if (args[0] === 'skills') {
    await runSkillsCli(args.slice(1));
    return true;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(
      'CoAgent8: no arguments starts the stdio MCP server.\nUsage: coagent8 setup|repair|status|cleanup [--clients=codex,claude,agy]\nSetup/repair explicitly authorize native-host MCP registration and reconcile the selected CoAgent8 skills. Status checks CLI readiness.\nCleanup previews owned removals of registrations and skills; apply with cleanup --apply=<preview token>.\nSkills: coagent8 skills status|install|uninstall|enable|disable [--clients=agy] [--skills=coagent8-review,...]\nModels: coagent8 models [--backend codex|claude|agy] [--json] lists models, prices and approval tags.\nChanges are previews; apply one client with the same arguments and --apply=<preview token>. Start a new client chat to refresh skills.\nnpm uninstall runs no cleanup: run cleanup first.\n',
    );
    return true;
  }
  if (!['setup', 'repair', 'status', 'cleanup'].includes(args[0])) throw new Error('Unknown setup command.');
  const selection = args.find(arg => arg.startsWith('--clients='));
  const apply = args.find(arg => arg.startsWith('--apply='));
  if (
    args.slice(1).some(arg => arg !== selection && (args[0] !== 'cleanup' || arg !== apply)) ||
    args.filter(arg => arg.startsWith('--clients=')).length > 1 ||
    args.filter(arg => arg.startsWith('--apply=')).length > 1
  )
    throw new Error('Invalid setup arguments.');
  const clients = selection?.slice('--clients='.length).split(',');
  if (clients && !clients.every(client => SETUP_CLIENTS.includes(client as SetupClient))) throw new Error('Unknown setup client.');
  if (args[0] === 'cleanup') {
    const preview = await cleanupClients({ clients: clients as SetupClient[] | undefined, apply: apply?.slice('--apply='.length) });
    process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
    const kept = (action: string) => action === 'blocked' || action === 'preserved';
    if (preview.stateError || preview.results.some(result => kept(result.action) || result.skills?.some(skill => kept(skill.action))))
      process.exitCode = 1;
    return true;
  }
  // The bundle lives in the package's dist/; the skill catalog ships beside it.
  const results = await setupClients({
    clients: clients as SetupClient[] | undefined,
    statusOnly: args[0] === 'status',
    runtimeSource: path.resolve(__dirname, 'index.cjs'),
    skillsSource: path.resolve(__dirname, '..', 'skills'),
  });
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  if (
    args[0] === 'status'
      ? !results.some(result => result.ready)
      : results.some(
          result => result.action === 'blocked' || result.action === 'missing' || result.skills?.some(skill => skill.action === 'blocked'),
        )
  )
    process.exitCode = 1;
  return true;
}
