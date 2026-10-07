import * as vscode from 'vscode';
import { version } from '../../../package.json';
import { setupClients, SETUP_CLIENTS, resolveSetupClient, type SetupClient, type SetupStatus } from '../../../src/integrations/setup.js';
import { cleanupClients } from '../../../src/integrations/cleanup.js';
import { redactDiagnostic } from '../../../src/redaction.js';
import os from 'node:os';
import { hasManualVscodeRegistration } from '../../../src/integrations/vscode-profile.js';
import { clearCliResolverCache } from '../../../src/execution/cli-resolver.js';

const LABELS: Record<SetupClient, string> = { codex: 'Codex CLI', claude: 'Claude Code CLI', agy: 'Antigravity CLI' };
const EXTENSIONS = { codex: 'openai.chatgpt', claude: 'anthropic.claude-code' };

/** Supplies actual installed paths to the independent runtime, never durable overrides. */
function discoveryEnvironment(): NodeJS.ProcessEnv {
  const locations: Record<string, string> = {};
  for (const [client, id] of Object.entries(EXTENSIONS)) {
    const extension = vscode.extensions.getExtension(id);
    if (extension?.extensionUri.scheme === 'file') locations[client] = extension.extensionPath;
  }
  return { ...process.env, coagent8_EXTENSION_PATHS: JSON.stringify(locations) };
}
function quote(value: string): string {
  return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}
/** Inserts an explicitly chosen action for review; the user presses Enter to run it. */
async function offerTerminal(command: string, name: string, context: vscode.ExtensionContext): Promise<void> {
  const windows = process.platform === 'win32';
  const terminal = vscode.window.createTerminal({ name, shellPath: windows ? 'powershell.exe' : '/bin/bash', shellArgs: windows ? ['-NoProfile'] : [] });
  context.subscriptions.push(terminal);
  terminal.show();
  terminal.sendText(command, false);
  await vscode.window.showInformationMessage('Press Enter to run the command. When it finishes, use CoAgent8: Refresh CLI Status. If PATH is stale, reload VS Code first; terminal completion alone does not verify installation.');
}
/** Offers a vendor extension or standalone CLI; installation never authorizes MCP registration. */
async function offerCliInstallation(client: SetupClient, context: vscode.ExtensionContext): Promise<void> {
  const windows = process.platform === 'win32';
  const command = client === 'codex' ? 'npm install -g @openai/codex'
    : client === 'claude' ? (windows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash')
      : (windows ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
  const actions = client === 'agy' ? ['Open Install Command'] : ['Install Vendor Extension', 'Open Install Command'];
  const choice = await vscode.window.showInformationMessage(`${LABELS[client]} is missing. Choose an installation method.`, ...actions);
  if (choice === 'Install Vendor Extension' && client !== 'agy') {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', EXTENSIONS[client]);
    clearCliResolverCache();
    await vscode.window.showInformationMessage('Extension installation finished. Refresh CLI Status to verify its bundled CLI; reload the window if the extension is not yet visible.');
  } else if (choice === 'Open Install Command') await offerTerminal(command, `Install ${LABELS[client]}`, context);
}
/** Registers the independent MCP provider and explicit onboarding/registration/cleanup actions. */
export function activate(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('coagent8.nodePath')) { clearCliResolverCache(); changed.fire(); }
  }));
  context.subscriptions.push(vscode.extensions.onDidChange(() => { clearCliResolverCache(); changed.fire(); }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('coagent8', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions() {
      if (hasManualVscodeRegistration(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [])) return [];
      const command = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
      if (!command) throw new Error('CoAgent8: configure coagent8.nodePath with a Node.js 24+ executable.');
      return [new vscode.McpStdioServerDefinition('CoAgent8', command, [context.asAbsolutePath('dist/index.cjs')], {
        coagent8_EXTENSION_PATHS: discoveryEnvironment().coagent8_EXTENSION_PATHS!,
      }, version)];
    },
  }));
  let output: vscode.OutputChannel | undefined;
  function report(value: unknown): void {
    if (!output) { output = vscode.window.createOutputChannel('CoAgent8 Setup'); context.subscriptions.push(output); }
    output.appendLine(redactDiagnostic(JSON.stringify(value, null, 2)));
    output.show();
  }
  function options() {
    const nodePath = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
    if (!nodePath) throw new Error('Configure coagent8.nodePath with a Node.js 24+ executable.');
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 1) throw new Error('Run coagent8 setup from the intended workspace in a multi-root window.');
    clearCliResolverCache();
    return { runtimeSource: context.asAbsolutePath('dist/index.cjs'), nodePath, home: os.homedir(), cwd: folders[0]?.uri.fsPath || os.homedir(), env: discoveryEnvironment() };
  }
  async function status(): Promise<SetupStatus[]> {
    const results = await setupClients({ ...options(), clients: [...SETUP_CLIENTS], statusOnly: true });
    report(results);
    return results;
  }
  async function summarize(results: SetupStatus[]): Promise<void> {
    await vscode.window.showInformationMessage(results.some(result => result.ready)
      ? 'At least one CLI has compatible controls and local sign-in. The VS Code MCP provider is available independently of native-host registration.'
      : 'No CLI has verified compatibility and sign-in yet. Inspect CoAgent8 Setup, install/update or sign in, then refresh. Antigravity sign-in requires separate native acceptance.');
  }
  function register(name: string, action: () => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      if (vscode.env.remoteName) { await vscode.window.showWarningMessage('CoAgent8 setup supports the local default profile. Run coagent8 status/setup/cleanup on the intended machine.'); return; }
      try { await action(); }
      catch (error) { await vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Action failed or was cancelled; refresh and retry.')}`); }
    }));
  }
  register('coagent8.refreshCliStatus', async () => { await summarize(await status()); });
  register('coagent8.setup', async () => {
    const results = await status();
    const remembered = context.globalState.get<SetupClient[]>('setupClients');
    const picked = await vscode.window.showQuickPick(results.map(result => ({
      label: LABELS[result.client], client: result.client, picked: remembered?.includes(result.client) ?? false,
      description: result.installed ? `Available - ${result.compatibility}; sign-in ${result.authentication}` : `${result.action === 'blocked' ? 'Blocked' : 'Missing'} - ${result.message}`,
    })), { canPickMany: true, title: 'Choose CLIs to install or check (native-host registration is separate)' });
    if (!picked?.length) return;
    const selected = picked.map(item => item.client);
    await context.globalState.update('setupClients', selected);
    for (const client of selected) {
      const result = results.find(item => item.client === client)!;
      // An override error is not absence: do not install around an authoritative setting.
      try {
        if (!result.installed && result.action !== 'blocked') await offerCliInstallation(client, context);
        else if (result.installed && result.compatibility === 'supported' && result.authentication !== 'authenticated') {
          const choice = await vscode.window.showInformationMessage(`${LABELS[client]} sign-in is ${result.authentication}. Open a sign-in command?`, 'Open Sign-in Command');
          if (choice === 'Open Sign-in Command') {
            const opts = options(), cli = resolveSetupClient(client, opts.home, opts.env, opts.nodePath);
            if (!cli) throw new Error('CLI disappeared; refresh discovery.');
            const args = client === 'codex' ? ['login'] : client === 'claude' ? ['auth', 'login'] : [];
            await offerTerminal(`${process.platform === 'win32' ? '& ' : ''}${[cli.command, ...cli.argsPrefix, ...args].map(quote).join(' ')}`, `Sign in to ${LABELS[client]}`, context);
          }
        }
      } catch (error) {
        await vscode.window.showErrorMessage(`${LABELS[client]}: ${redactDiagnostic(error instanceof Error ? error.message : 'Installation failed or was cancelled.')} Refresh CLI Status to retry.`);
      }
    }
    await summarize(await status());
  });
  register('coagent8.registerNativeHosts', async () => {
    const results = await status();
    const picked = await vscode.window.showQuickPick(results.filter(result => result.installed && result.compatibility === 'supported').map(result => ({
      label: LABELS[result.client], client: result.client, description: result.registered ? 'Inspect or repair existing registration' : 'Add external MCP registration',
    })), { canPickMany: true, title: 'Optional: register CoAgent8 in native chat hosts' });
    if (!picked?.length) return;
    const choice = await vscode.window.showWarningMessage(`Write CoAgent8 MCP registrations in ${picked.map(item => item.label).join(', ')} configuration? This is separate from CLI installation and the VS Code provider.`, { modal: true }, 'Register Selected Hosts');
    if (choice !== 'Register Selected Hosts') return;
    report(await setupClients({ ...options(), clients: picked.map(item => item.client) }));
  });
  register('coagent8.cleanup', async () => {
    const preview = await cleanupClients({ home: os.homedir(), env: process.env });
    report(preview.results);
    const count = preview.results.filter(result => result.action === 'remove').length;
    if (!count) { await vscode.window.showInformationMessage('No unchanged owned registrations to remove. Manual/edited entries and VS Code profile data are preserved.'); return; }
    const choice = await vscode.window.showWarningMessage(`Remove ${count} unchanged CoAgent8-owned external registrations? Preview is in CoAgent8 Setup. Private backups and runtime files will be retained.`, { modal: true }, 'Remove Owned Registrations');
    if (choice !== 'Remove Owned Registrations') return;
    const result = await cleanupClients({ home: os.homedir(), env: process.env, apply: preview.token });
    report(result);
    if (!result.stateError && !result.results.some(item => item.action === 'blocked' || item.action === 'preserved')) await context.globalState.update('setupClients', []);
    await vscode.window.showInformationMessage('Cleanup results are in CoAgent8 Setup. Restart native hosts to refresh cached catalogs. Uninstall the VSIX separately to remove its provider; profile databases and other extensions are retained.');
  });
  if (!vscode.env.remoteName && !context.globalState.get<boolean>('setupOffered')) {
    void (async () => {
      await context.globalState.update('setupOffered', true);
      const choice = await vscode.window.showInformationMessage('CoAgent8 needs one compatible signed-in coding CLI. Check existing CLIs or choose an installation.', 'Set Up CLIs');
      if (choice === 'Set Up CLIs') await vscode.commands.executeCommand('coagent8.setup');
    })().catch(error => { void vscode.window.showErrorMessage(`CoAgent8 onboarding: ${redactDiagnostic(error instanceof Error ? error.message : 'Onboarding failed.')}`); });
  }
}
