import * as vscode from 'vscode';
import { version } from '../../../package.json';
import { setupClients, SETUP_CLIENTS, resolveSetupClient, type SetupClient } from '../../../src/integrations/setup.js';
import { redactDiagnostic } from '../../../src/redaction.js';
import os from 'node:os';
import { hasManualVscodeRegistration } from '../../../src/integrations/vscode-profile.js';

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
      if (!command) throw new Error('CoAgent: configure coagent8.nodePath with a Node.js 20+ executable.');
      return [new vscode.McpStdioServerDefinition(
        'CoAgent', command, [context.asAbsolutePath('dist/index.cjs')], {}, version
      )];
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand('coagent8.setup', async () => {
    if (vscode.env.remoteName) {
      await vscode.window.showWarningMessage('CoAgent external-client setup supports the local default profile. Run coagent8 setup on the intended machine.');
      return;
    }
    try {
      const installed = SETUP_CLIENTS.filter(client => resolveSetupClient(client));
      const remembered = context.globalState.get<SetupClient[]>('setupClients');
      const selected = remembered ?? (await vscode.window.showQuickPick(installed.map(client => ({ label: client, client })), {
        canPickMany: true, title: 'Select installed chats to connect to CoAgent',
      }))?.map(item => item.client);
      if (!selected?.length) return;
      const nodePath = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
      if (!nodePath) throw new Error('Configure coagent8.nodePath with a Node.js 20+ executable.');
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length > 1) throw new Error('Run coagent8 setup from the intended workspace in a multi-root window.');
      const results = await setupClients({ clients: selected, runtimeSource: context.asAbsolutePath('dist/index.cjs'), nodePath, home: os.homedir(), cwd: folders[0]?.uri.fsPath || os.homedir() });
      await context.globalState.update('setupClients', selected);
      const output = vscode.window.createOutputChannel('CoAgent Setup');
      context.subscriptions.push(output);
      output.appendLine(JSON.stringify(results, null, 2));
      output.show();
    } catch (error) {
      await vscode.window.showErrorMessage(`CoAgent setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Setup failed.')}`);
    }
  }));
  if (!vscode.env.remoteName && !context.globalState.get<boolean>('setupOffered')) {
    void (async () => {
      await context.globalState.update('setupOffered', true);
      const choice = await vscode.window.showInformationMessage('CoAgent is available in VS Code. Connect standalone chat clients as well?', 'Set Up Clients');
      if (choice === 'Set Up Clients') await vscode.commands.executeCommand('coagent8.setup');
    })();
  }
}
