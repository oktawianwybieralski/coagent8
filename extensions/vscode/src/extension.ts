import * as vscode from 'vscode';
import { version } from '../../../package.json';
import { setupClients, SETUP_CLIENTS, resolveSetupClient, type SetupClient } from '../../../src/integrations/setup.js';
import { redactDiagnostic } from '../../../src/redaction.js';
import os from 'node:os';
import { hasManualVscodeRegistration } from '../../../src/integrations/vscode-profile.js';
import { clearCliResolverCache } from '../../../src/execution/cli-resolver.js';

const SETUP_CLIENT_LABELS: Record<SetupClient, string> = {
  codex: 'Codex CLI',
  claude: 'Claude Code CLI',
  agy: 'Antigravity CLI',
};

/** Opens an explicit installation action in a visible terminal, with the command ready for review. */
async function offerCliInstallation(client: SetupClient, context: vscode.ExtensionContext): Promise<void> {
  const windows = process.platform === 'win32';
  const command = client === 'codex' ? 'npm install -g @openai/codex'
    : client === 'claude' ? (windows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash')
      : (windows ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
  const choice = await vscode.window.showInformationMessage(
    `${SETUP_CLIENT_LABELS[client]} is missing. Open its install command in a terminal?`, 'Open Install Command');
  if (choice !== 'Open Install Command') return;
  const terminal = vscode.window.createTerminal({
    name: `Install ${SETUP_CLIENT_LABELS[client]}`,
    shellPath: windows ? 'powershell.exe' : '/bin/bash', shellArgs: windows ? ['-NoProfile'] : [],
  });
  context.subscriptions.push(terminal);
  terminal.show();
  terminal.sendText(command, false);
  await vscode.window.showInformationMessage('Press Enter in the terminal to install. After installation and CLI sign-in, reload VS Code and run CoAgent8 setup again.');
}

/** Registers server definitions; VS Code owns the MCP subprocess lifecycle. */
export function activate(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('coagent8.nodePath')) changed.fire();
  }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('coagent8', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions() {
      if (hasManualVscodeRegistration(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [])) return [];
      const command = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
      if (!command) throw new Error('CoAgent8: configure coagent8.nodePath with a Node.js 24+ executable.');
      return [new vscode.McpStdioServerDefinition(
        'CoAgent8', command, [context.asAbsolutePath('dist/index.cjs')], {}, version
      )];
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand('coagent8.setup', async () => {
    if (vscode.env.remoteName) {
      await vscode.window.showWarningMessage('CoAgent8 external-client setup supports the local default profile. Run coagent8 setup on the intended machine.');
      return;
    }
    try {
      clearCliResolverCache();
      const installed = SETUP_CLIENTS.filter(client => resolveSetupClient(client));
      const remembered = context.globalState.get<SetupClient[]>('setupClients');
      const selected = (await vscode.window.showQuickPick(SETUP_CLIENTS.map(client => ({
        label: SETUP_CLIENT_LABELS[client], client, picked: remembered?.includes(client) ?? false,
        description: installed.includes(client) ? 'Available — connect or repair' : 'Missing — open install command',
      })), {
        canPickMany: true, title: 'Select coding CLIs to connect or install',
      }))?.map(item => item.client);
      if (!selected?.length) return;
      for (const client of selected.filter(client => !installed.includes(client))) await offerCliInstallation(client, context);
      const available = selected.filter(client => installed.includes(client));
      if (!available.length) return;
      const nodePath = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
      if (!nodePath) throw new Error('Configure coagent8.nodePath with a Node.js 24+ executable.');
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length > 1) throw new Error('Run coagent8 setup from the intended workspace in a multi-root window.');
      const results = await setupClients({ clients: available, runtimeSource: context.asAbsolutePath('dist/index.cjs'), nodePath, home: os.homedir(), cwd: folders[0]?.uri.fsPath || os.homedir() });
      await context.globalState.update('setupClients', available);
      const output = vscode.window.createOutputChannel('CoAgent8 Setup');
      context.subscriptions.push(output);
      output.appendLine(JSON.stringify(results, null, 2));
      output.show();
    } catch (error) {
      await vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Setup failed.')}`);
    }
  }));
  if (!vscode.env.remoteName && !context.globalState.get<boolean>('setupOffered')) {
    void (async () => {
      await context.globalState.update('setupOffered', true);
      const choice = await vscode.window.showInformationMessage('Set up coding CLIs for CoAgent8? Use available CLIs or install missing ones.', 'Set Up Clients');
      if (choice === 'Set Up Clients') await vscode.commands.executeCommand('coagent8.setup');
    })();
  }
}
