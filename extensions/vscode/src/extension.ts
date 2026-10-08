import * as vscode from 'vscode';
import { version } from '../../../package.json';
import { setupClients, SETUP_CLIENTS, resolveSetupClient, type SetupClient, type SetupStatus } from '../../../src/integrations/setup.js';
import { cleanupClients } from '../../../src/integrations/cleanup.js';
import { redactDiagnostic } from '../../../src/redaction.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfig } from '../../../src/config.js';
import { hasManualVscodeRegistration } from '../../../src/integrations/vscode-profile.js';
import { clearCliResolverCache } from '../../../src/execution/cli-resolver.js';
import { EDITOR_SETTINGS, EDITOR_SETTINGS_ENV } from '../../../src/config-overrides.js';
import { readSetupState, resetConfigurationFile, updateSetupState } from './configuration.js';
import { EXTENSION_ORIGIN } from '../../../src/integrations/setup-storage.js';

const LABELS: Record<SetupClient, string> = { codex: 'Codex CLI', claude: 'Claude Code CLI', agy: 'Antigravity CLI' };
/** Extensions whose bundled CLI paths the runtime receives through `coagent8_EXTENSION_PATHS`. */
const EXTENSIONS = { codex: 'openai.chatgpt', claude: 'anthropic.claude-code' };
/** Vendor extensions offered as an installation method; Antigravity's downloads agy to `~/.gemini/bin`. */
const VENDOR_EXTENSIONS: Record<SetupClient, { id: string; name: string }> = {
  codex: { id: 'openai.chatgpt', name: 'Codex (OpenAI)' },
  claude: { id: 'anthropic.claude-code', name: 'Claude Code (Anthropic)' },
  agy: { id: 'google.google-antigravity', name: 'Google Antigravity' },
};
/** A new vendor extension can take minutes to appear or, for Antigravity, to download its CLI. */
const CLI_WAIT_MS = 180_000;
const CLI_POLL_MS = 2_000;

/**
 * Supplies actual installed paths to the independent runtime, never durable overrides.
 * @param storage - The extension's global storage, which VS Code deletes on uninstall; the
 * runtime keeps its sessions, history and caches there.
 */
function discoveryEnvironment(storage: string): NodeJS.ProcessEnv {
  const locations: Record<string, string> = {};
  for (const [client, id] of Object.entries(EXTENSIONS)) {
    const extension = vscode.extensions.getExtension(id);
    if (extension?.extensionUri.scheme === 'file') locations[client] = extension.extensionPath;
  }
  return { ...process.env, coagent8_EXTENSION_PATHS: JSON.stringify(locations), coagent8_DIR: storage, coagent8_CONFIG: configurationFile(storage), [EDITOR_SETTINGS_ENV]: editorSettings() };
}
/**
 * Serializes the backend, model and approval settings the user set explicitly. Only the user
 * value counts: defaults leave config.json in effect, and a workspace cannot change approval.
 */
function editorSettings(): string {
  const configuration = vscode.workspace.getConfiguration('coagent8');
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(EDITOR_SETTINGS)) {
    const value = configuration.inspect(key)?.globalValue;
    if (value !== undefined) values[key] = value;
  }
  return JSON.stringify(values);
}
/**
 * Resolves the configuration file: the machine-scoped user setting (never a workspace
 * value), then `coagent8_CONFIG`, then config.json in the extension's global storage.
 */
function configurationFile(storage: string): string {
  const selected = vscode.workspace.getConfiguration('coagent8').get<string>('configPath', '').trim();
  if (!selected) return path.resolve(process.env.coagent8_CONFIG || path.join(storage, 'config.json'));
  const expanded = selected.startsWith('~/') || selected.startsWith('~\\') ? path.join(os.homedir(), selected.slice(2)) : selected;
  if (!path.isAbsolute(expanded)) throw new Error('CoAgent8: coagent8.configPath must be an absolute path or start with ~/; leave it empty to use the default.');
  return path.normalize(expanded);
}
/** The Google extension is installed but has not downloaded agy yet; installing again would duplicate it. */
function antigravityDownloadPending(result: SetupStatus): boolean {
  return result.client === 'agy' && !result.installed && result.action !== 'blocked' && vscode.extensions.getExtension(VENDOR_EXTENSIONS.agy.id) !== undefined;
}
function describe(result: SetupStatus): string {
  if (result.installed) return `Available - ${result.compatibility}; sign-in ${result.authentication}`;
  if (antigravityDownloadPending(result)) return 'Downloading - the Google Antigravity extension installs this CLI when its backend starts';
  return `${result.action === 'blocked' ? 'Blocked' : 'Missing'} - ${result.message}`;
}
function quote(value: string): string {
  return process.platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
}
/** Official standalone installers; each installs to its vendor's own location. */
function installCommand(client: SetupClient): string {
  const windows = process.platform === 'win32';
  return client === 'codex' ? 'npm install -g @openai/codex'
    : client === 'claude' ? (windows ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash')
      : (windows ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
}
/** Inserts an explicitly chosen action for review; the user presses Enter to run it. */
function offerTerminal(command: string, name: string, context: vscode.ExtensionContext): void {
  const windows = process.platform === 'win32';
  const terminal = vscode.window.createTerminal({ name, shellPath: windows ? 'powershell.exe' : '/bin/bash', shellArgs: windows ? ['-NoProfile'] : [] });
  context.subscriptions.push(terminal);
  terminal.show();
  terminal.sendText(command, false);
}
/**
 * Waits until an installation the user started makes the CLI discoverable.
 * @param found - Re-resolves the CLI; called after clearing the resolver cache.
 * @returns False on timeout or cancellation; nothing is installed or retried here.
 */
async function waitForCli(title: string, found: () => boolean): Promise<boolean> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
    const deadline = Date.now() + CLI_WAIT_MS;
    while (!token.isCancellationRequested) {
      clearCliResolverCache();
      if (found()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>(resolve => {
        let settled = false;
        let listener: vscode.Disposable | undefined;
        const timer = setTimeout(done, CLI_POLL_MS);
        listener = token.onCancellationRequested(done);
        // A token may call the listener during subscription, before it is assigned.
        if (settled) listener.dispose();
        function done(): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          listener?.dispose();
          resolve();
        }
      });
    }
    return false;
  });
}
/** Registers the independent MCP provider and explicit onboarding/registration/cleanup actions. */
export function activate(context: vscode.ExtensionContext): void {
  const storage = context.globalStorageUri.fsPath;
  // Earlier builds kept onboarding state in globalState, which VS Code keeps after uninstall.
  for (const key of ['setupClients', 'setupOffered', 'setupDismissed']) {
    if (context.globalState.get(key) !== undefined) context.globalState.update(key, undefined).then(undefined, showLifecycleError);
  }
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('coagent8')) {
      clearCliResolverCache(); changed.fire();
    }
  }));
  context.subscriptions.push(vscode.extensions.onDidChange(() => { clearCliResolverCache(); changed.fire(); }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('coagent8', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions() {
      if (hasManualVscodeRegistration(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [])) return [];
      const command = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
      if (!command) throw new Error('CoAgent8: configure coagent8.nodePath with a Node.js 24+ executable.');
      return [new vscode.McpStdioServerDefinition('CoAgent8', command, [context.asAbsolutePath('dist/index.cjs')], {
        coagent8_EXTENSION_PATHS: discoveryEnvironment(storage).coagent8_EXTENSION_PATHS!,
        coagent8_DIR: storage,
        coagent8_CONFIG: configurationFile(storage),
        [EDITOR_SETTINGS_ENV]: editorSettings(),
      }, `${version}#${createHash('sha256').update(fs.readFileSync(context.asAbsolutePath('dist/index.cjs'))).digest('hex')}`)];
    },
  }));
  const profileMcpFile = path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'mcp.json');
  const mcpFiles = [profileMcpFile, ...vscode.workspace.workspaceFolders?.map(folder => path.join(folder.uri.fsPath, '.vscode', 'mcp.json')) ?? []];
  let manualRegistration = false;
  try { manualRegistration = hasManualVscodeRegistration(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []); }
  catch (error) { showLifecycleError(error); }
  function registrationChanged(): void {
    try {
      const registered = hasManualVscodeRegistration(context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []);
      if (registered || manualRegistration) {
        changed.fire();
      }
      manualRegistration = registered;
    } catch (error) { showLifecycleError(error); }
  }
  for (const file of new Set(mcpFiles)) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(file), path.basename(file)));
    context.subscriptions.push(watcher, watcher.onDidChange(registrationChanged), watcher.onDidCreate(registrationChanged), watcher.onDidDelete(registrationChanged));
  }
  function showLifecycleError(error: unknown): void {
    void vscode.window.showErrorMessage(`CoAgent8: ${redactDiagnostic(error instanceof Error ? error.message : 'MCP configuration refresh failed.')}`);
  }
  let output: vscode.OutputChannel | undefined;
  /**
   * Records evidence in the CoAgent8 Setup channel.
   * @param reveal - Shows the channel without taking focus; an open picker loses focus otherwise and closes.
   */
  function report(value: unknown, reveal = false): void {
    if (!output) { output = vscode.window.createOutputChannel('CoAgent8 Setup'); context.subscriptions.push(output); }
    output.appendLine(redactDiagnostic(JSON.stringify(value, null, 2)));
    if (reveal) output.show(true);
  }
  function options() {
    const nodePath = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
    if (!nodePath) throw new Error('Configure coagent8.nodePath with a Node.js 24+ executable.');
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 1) throw new Error('Run coagent8 setup from the intended workspace in a multi-root window.');
    clearCliResolverCache();
    return { runtimeSource: context.asAbsolutePath('dist/index.cjs'), nodePath, home: os.homedir(), cwd: folders[0]?.uri.fsPath || os.homedir(), env: discoveryEnvironment(storage), origin: EXTENSION_ORIGIN };
  }
  let lastStatus: SetupStatus[] = [];
  /** One readable state per CLI; the full evidence is written only through Show Details. */
  function describeState(result: SetupStatus): string {
    const cli = result.ready ? 'ready'
      : !result.installed ? (result.action === 'blocked' ? 'blocked' : 'not installed')
        : result.compatibility !== 'supported' ? `${result.compatibility} controls` : `sign-in ${result.authentication}`;
    return `${result.client}: ${cli}${result.registered ? ', registered in its host' : ''}`;
  }
  /**
   * Runs the bounded CLI checks and logs one summary line.
   * @param trigger - The action that ran the check, shown in the log.
   */
  async function status(trigger: string, clients: SetupClient[] = [...SETUP_CLIENTS]): Promise<SetupStatus[]> {
    const results = await setupClients({ ...options(), clients, statusOnly: true });
    if (!output) { output = vscode.window.createOutputChannel('CoAgent8 Setup'); context.subscriptions.push(output); }
    output.appendLine(`[${new Date().toTimeString().slice(0, 8)}] ${trigger} - ${results.map(describeState).join('; ')}`);
    lastStatus = results;
    return results;
  }
  function showDetails(): void {
    report(lastStatus, true);
  }
  function discoverable(client: SetupClient): boolean {
    const opts = options();
    return resolveSetupClient(client, opts.home, opts.env, opts.nodePath) !== null;
  }
  /** Summarizes readiness and offers optional native-host registration, which keeps its own confirmation. */
  async function summarize(results: SetupStatus[]): Promise<void> {
    const ready = results.filter(result => result.ready).map(result => LABELS[result.client]);
    const unregistered = results.filter(result => result.ready && !result.registered).map(result => LABELS[result.client]);
    const actions = unregistered.length ? ['Register in Chat Hosts', 'Show Details'] : ['Show Details'];
    const choice = await vscode.window.showInformationMessage(ready.length
      ? `Ready: ${ready.join(', ')}. CoAgent8 works in VS Code chat now.${unregistered.length ? ` To use it inside ${unregistered.join(', ')} as well, register it there.` : ''}`
      : 'No CLI has verified compatibility and sign-in yet. Install/update or sign in, then refresh.', ...actions);
    if (choice === 'Show Details') showDetails();
    else if (choice === 'Register in Chat Hosts') await vscode.commands.executeCommand('coagent8.registerNativeHosts');
  }
  /**
   * Opens the CLI picker at once and fills it when the bounded CLI checks finish.
   * @returns The checked statuses and accepted clients, or undefined when the picker was dismissed.
   */
  async function pickClients(): Promise<{ results: SetupStatus[]; clients: SetupClient[] } | undefined> {
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { client: SetupClient }>();
    picker.title = 'Set Up Coding CLIs';
    picker.placeholder = 'Checking installed CLIs...';
    picker.canSelectMany = true;
    // Notifications and terminals opened by earlier actions must not dismiss the choice.
    picker.ignoreFocusOut = true;
    picker.busy = true;
    picker.enabled = false;
    let hidden = false;
    const closed = new Promise<boolean>(resolve => {
      picker.onDidAccept(() => resolve(true));
      picker.onDidHide(() => { hidden = true; resolve(false); });
    });
    picker.show();
    try {
      const results = await status('Set Up Coding CLIs');
      if (hidden) return undefined;
      const remembered = readSetupState(storage).setupClients;
      picker.items = results.map(result => ({ label: LABELS[result.client], client: result.client, description: describe(result) }));
      // Without a remembered choice, the CLIs that are already ready are selected.
      const preselected = remembered ?? results.filter(result => result.ready).map(result => result.client);
      picker.selectedItems = picker.items.filter(item => preselected.includes(item.client));
      picker.placeholder = 'Select CLIs to install or check (native-host registration is separate)';
      picker.busy = false;
      picker.enabled = true;
      if (!await closed) return undefined;
      return { results, clients: picker.selectedItems.map(item => item.client) };
    } finally {
      picker.dispose();
    }
  }
  /** Reports a CLI that did not appear in time; the user's installation itself may still finish. */
  async function waited(client: SetupClient, found: boolean, viaAntigravity: boolean): Promise<boolean> {
    if (!found) {
      await vscode.window.showWarningMessage(viaAntigravity
        ? `${LABELS[client]} is not available yet. Open the Antigravity view once so the extension starts its backend and downloads the CLI, then run CoAgent8: Refresh CLI Status.`
        : `${LABELS[client]} is not available yet. If the extension is not visible, reload the window, then run CoAgent8: Refresh CLI Status.`);
    }
    return found;
  }
  /**
   * Offers the vendor extension or the official standalone installer for a missing CLI.
   * @returns Whether the CLI became discoverable; installation never authorizes MCP registration.
   */
  async function installCli(client: SetupClient): Promise<boolean> {
    const vendor = VENDOR_EXTENSIONS[client];
    if (client === 'agy' && vscode.extensions.getExtension(vendor.id)) {
      return waited(client, await waitForCli('Waiting for the Google Antigravity extension to download Antigravity CLI...', () => discoverable(client)), true);
    }
    const choice = await vscode.window.showInformationMessage(
      `${LABELS[client]} is not installed. Install it with the ${vendor.name} VS Code extension (updates itself and adds its own chat) or as the standalone CLI from the official installer (lighter, also usable in terminals)?`,
      'Install Vendor Extension', 'Install Standalone CLI');
    if (choice === 'Install Vendor Extension') {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vendor.id);
      return waited(client, await waitForCli(`Waiting for ${LABELS[client]} from the ${vendor.name} extension...`, () => discoverable(client)), client === 'agy');
    }
    if (choice !== 'Install Standalone CLI') return false;
    offerTerminal(installCommand(client), `Install ${LABELS[client]}`, context);
    const next = await vscode.window.showInformationMessage(`Press Enter in the terminal to install ${LABELS[client]}. When it finishes, check it here.`, 'Check Now', 'Reload Window');
    if (next === 'Reload Window') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return false; }
    if (next !== 'Check Now') return false;
    clearCliResolverCache();
    if (discoverable(client)) return true;
    // An installer updates PATH for new processes only; this extension host keeps its old PATH.
    const reload = await vscode.window.showWarningMessage(`${LABELS[client]} was not found with this window's PATH. Reload the window after the installer finishes, then run CoAgent8: Set Up Coding CLIs again.`, 'Reload Window');
    if (reload === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return false;
  }
  /** @returns Whether a sign-in command was opened. */
  async function offerSignIn(result: SetupStatus): Promise<boolean> {
    const client = result.client;
    const choice = await vscode.window.showInformationMessage(`${LABELS[client]} sign-in is ${result.authentication}. Open a sign-in command?`, 'Open Sign-in Command');
    if (choice !== 'Open Sign-in Command') return false;
    const opts = options(), cli = resolveSetupClient(client, opts.home, opts.env, opts.nodePath);
    if (!cli) throw new Error('CLI disappeared; refresh discovery.');
    const args = client === 'codex' ? ['login'] : client === 'claude' ? ['auth', 'login'] : [];
    offerTerminal(`${process.platform === 'win32' ? '& ' : ''}${[cli.command, ...cli.argsPrefix, ...args].map(quote).join(' ')}`, `Sign in to ${LABELS[client]}`, context);
    await vscode.window.showInformationMessage('Press Enter in the terminal to sign in. When it finishes, run CoAgent8: Refresh CLI Status.');
    return true;
  }
  function register(name: string, action: () => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      if (vscode.env.remoteName) { await vscode.window.showWarningMessage('CoAgent8 setup supports the local default profile. Run coagent8 status/setup/cleanup on the intended machine.'); return; }
      try { await action(); }
      catch (error) { await vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Action failed or was cancelled; refresh and retry.')}`); }
    }));
  }
  register('coagent8.refreshCliStatus', async () => { await summarize(await status('Refresh CLI Status')); });
  register('coagent8.openSettings', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:okidev.coagent8-mcp'); });
  register('coagent8.manageMcpServers', async () => { await vscode.commands.executeCommand('workbench.mcp.listServer'); });
  register('coagent8.resetConfiguration', async () => {
    const file = configurationFile(storage);
    const dirty = vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === path.resolve(file) && document.isDirty);
    if (dirty) throw new Error('Save or revert the configuration editor before resetting the file.');
    const choice = await vscode.window.showWarningMessage(`Reset ${file} to defaults? The current file will be saved as ${path.basename(file)}.backup, replacing an earlier backup. CoAgent8 settings in VS Code, CLI sign-ins and MCP registrations will be retained.`, { modal: true }, 'Reset Configuration');
    if (choice !== 'Reset Configuration') return;
    const backup = await resetConfigurationFile(file, validateConfig({ $schema: vscode.Uri.file(context.asAbsolutePath('schemas/config.schema.json')).toString() }));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    const next = await vscode.window.showInformationMessage(`CoAgent8 configuration reset.${backup ? ` Backup: ${backup}.` : ''} CoAgent8 settings set in VS Code still take precedence; reset them in Settings.`, 'Open Settings');
    if (next === 'Open Settings') await vscode.commands.executeCommand('coagent8.openSettings');
  });
  register('coagent8.resetSetupState', async () => {
    const choice = await vscode.window.showWarningMessage('Reset the remembered CLI selection and welcome dismissal? Configuration files, registrations and CLI sign-ins will be retained.', { modal: true }, 'Reset Setup State');
    if (choice !== 'Reset Setup State') return;
    await updateSetupState(storage, null);
    await showWelcome();
    await vscode.window.showInformationMessage('CoAgent8 setup state reset. The welcome notification appears only when no compatible signed-in CLI is ready.');
  });
  register('coagent8.openConfiguration', async () => {
    const file = configurationFile(storage);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const defaults = validateConfig({ $schema: vscode.Uri.file(context.asAbsolutePath('schemas/config.schema.json')).toString() });
    try { fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  });
  register('coagent8.setup', async () => {
    const picked = await pickClients();
    if (!picked?.clients.length) return;
    const { results, clients: selected } = picked;
    await updateSetupState(storage, { setupClients: selected });
    // Checks run again only after an installation or sign-in could have changed a CLI.
    let changed = false;
    for (const client of selected) {
      let result = results.find(item => item.client === client)!;
      // An override error is not absence: do not install around an authoritative setting.
      try {
        if (!result.installed && result.action !== 'blocked') {
          if (!await installCli(client)) continue;
          changed = true;
          result = (await status(`Installed ${LABELS[client]}`, [client])).find(item => item.client === client)!;
        }
        if (result.installed && result.compatibility === 'supported' && result.authentication !== 'authenticated') changed = await offerSignIn(result) || changed;
      } catch (error) {
        await vscode.window.showErrorMessage(`${LABELS[client]}: ${redactDiagnostic(error instanceof Error ? error.message : 'Installation failed or was cancelled.')} Refresh CLI Status to retry.`);
      }
    }
    await summarize(changed ? await status('Set Up Coding CLIs (after changes)') : results);
  });
  register('coagent8.registerNativeHosts', async () => {
    const results = await status('Register or Repair Native Chat Hosts');
    const picked = await vscode.window.showQuickPick(results.filter(result => result.installed && result.compatibility === 'supported').map(result => ({
      label: LABELS[result.client], client: result.client, picked: result.ready && !result.registered,
      description: result.registered ? 'Inspect or repair existing registration' : 'Add external MCP registration',
    })), { canPickMany: true, ignoreFocusOut: true, title: 'Optional: register CoAgent8 in native chat hosts' });
    if (!picked?.length) return;
    const choice = await vscode.window.showWarningMessage(`Write CoAgent8 MCP registrations in ${picked.map(item => item.label).join(', ')} configuration? This is separate from CLI installation and the VS Code provider.`, { modal: true }, 'Register Selected Hosts');
    if (choice !== 'Register Selected Hosts') return;
    const resultsAfter = await setupClients({ ...options(), clients: picked.map(item => item.client) });
    report(resultsAfter, true);
    if (resultsAfter.some(result => result.action === 'installed' || result.action === 'updated')) await vscode.window.showInformationMessage('CoAgent8 native-host registration was written. Restart the affected native chat hosts to refresh their tools. VS Code manages its own MCP server separately through MCP: List Servers.');
  });
  register('coagent8.cleanup', async () => {
    const preview = await cleanupClients({ home: os.homedir(), env: process.env });
    // The modal confirmation refers to this preview, so it must be visible.
    report(preview.results, true);
    const count = preview.results.filter(result => result.action === 'remove').length;
    if (!count) { await vscode.window.showInformationMessage('No unchanged owned registrations to remove. Manual/edited entries and VS Code profile data are preserved.'); return; }
    const choice = await vscode.window.showWarningMessage(`Remove ${count} unchanged CoAgent8-owned external registrations? Preview is in CoAgent8 Setup. Private backups and runtime files will be retained.`, { modal: true }, 'Remove Owned Registrations');
    if (choice !== 'Remove Owned Registrations') return;
    const result = await cleanupClients({ home: os.homedir(), env: process.env, apply: preview.token });
    report(result, true);
    if (!result.stateError && !result.results.some(item => item.action === 'blocked' || item.action === 'preserved')) await updateSetupState(storage, { setupClients: [] });
    await vscode.window.showInformationMessage('Cleanup results are in CoAgent8 Setup. Restart native hosts to refresh cached catalogs. Uninstall the VSIX separately to remove its provider; profile databases and other extensions are retained.');
  });
  async function showWelcome(): Promise<void> {
    if (vscode.env.remoteName || readSetupState(storage).setupDismissed) return;
    const ready = (await status('Welcome CLI Check')).filter(result => result.ready).map(result => LABELS[result.client]);
    if (ready.length) {
      if (readSetupState(storage).readyAnnounced) return;
      await updateSetupState(storage, { readyAnnounced: true });
      const next = await vscode.window.showInformationMessage(`CoAgent8 is ready with ${ready.join(', ')}. Use its tools from chat; VS Code starts the server on first use.`, 'Show MCP Servers');
      if (next === 'Show MCP Servers') await vscode.commands.executeCommand('coagent8.manageMcpServers');
      return;
    }
    const choice = await vscode.window.showInformationMessage('CoAgent8 needs one compatible signed-in coding CLI. Check existing CLIs or choose an installation.', 'Set Up CLIs', "Don't Show Again");
    if (choice === "Don't Show Again") await updateSetupState(storage, { setupDismissed: true });
    if (choice === 'Set Up CLIs') await vscode.commands.executeCommand('coagent8.setup');
  }
  void showWelcome().catch(error => { void vscode.window.showErrorMessage(`CoAgent8 onboarding: ${redactDiagnostic(error instanceof Error ? error.message : 'Onboarding failed.')}`); });
}
