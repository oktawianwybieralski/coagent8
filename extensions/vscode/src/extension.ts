import * as vscode from 'vscode';
import { version } from '../../../package.json';
import { alternativeSource, clientSource, setupClients, readRegistrations, SETUP_CLIENTS, SETUP_PROVIDERS, resolveSetupClient, type ClientSource, type RegistrationStatus, type SetupClient, type SetupStatus } from '../../../src/integrations/setup.js';
import { cleanupClients } from '../../../src/integrations/cleanup.js';
import { redactDiagnostic } from '../../../src/redaction.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readBackendExecutable, setBackendExecutable, validateConfig } from '../../../src/config.js';
import { hasManualVscodeRegistration } from '../../../src/integrations/vscode-profile.js';
import { clearCliResolverCache } from '../../../src/execution/cli-resolver.js';
import { EDITOR_SETTINGS, EDITOR_SETTINGS_ENV } from '../../../src/config-overrides.js';
import { readSetupState, resetConfigurationFile, updateInstallList, updateSetupState } from './configuration.js';
import { EXTENSION_ORIGIN } from '../../../src/integrations/setup-storage.js';

/** This extension's identifier, as published. */
const EXTENSION_ID = 'okidev.coagent8-mcp';
const LABELS: Record<SetupClient, string> = { codex: 'Codex CLI', claude: 'Claude Code CLI', agy: 'Antigravity CLI' };
/** Extensions whose bundled CLI paths the runtime receives through `coagent8_EXTENSION_PATHS`. */
const EXTENSIONS = { codex: 'openai.chatgpt', claude: 'anthropic.claude-code' };
/** Vendor extensions offered as an installation method; Antigravity's downloads agy to `~/.gemini/bin`. */
const VENDOR_EXTENSIONS: Record<SetupClient, { id: string; name: string }> = {
  codex: { id: 'openai.chatgpt', name: 'Codex (OpenAI)' },
  claude: { id: 'anthropic.claude-code', name: 'Claude Code (Anthropic)' },
  agy: { id: 'google.google-antigravity', name: 'Google Antigravity' },
};
/** Where the Google Antigravity extension downloads agy; uninstalling the extension leaves it. */
const ANTIGRAVITY_DOWNLOAD = `~/.gemini/bin/${process.platform === 'win32' ? 'agy.exe' : 'agy'}`;
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
  return { ...process.env, coagent8_EXTENSION_PATHS: JSON.stringify(locations), coagent8_DIR: storage, coagent8_CONFIG: configurationFile(), [EDITOR_SETTINGS_ENV]: editorSettings() };
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
 * value), then `coagent8_CONFIG`, then `~/.coagent8/config.json`, shared with the CLI and other hosts.
 */
function configurationFile(): string {
  const selected = vscode.workspace.getConfiguration('coagent8').get<string>('configPath', '').trim();
  if (!selected) return path.resolve(process.env.coagent8_CONFIG || path.join(os.homedir(), '.coagent8', 'config.json'));
  const expanded = selected.startsWith('~/') || selected.startsWith('~\\') ? path.join(os.homedir(), selected.slice(2)) : selected;
  if (!path.isAbsolute(expanded)) throw new Error('CoAgent8: coagent8.configPath must be an absolute path or start with ~/; leave it empty to use the default.');
  return path.normalize(expanded);
}
/** The Google extension is installed but has not downloaded agy yet; installing again would duplicate it. */
function antigravityDownloadPending(result: SetupStatus): boolean {
  return result.client === 'agy' && !result.installed && result.action !== 'blocked' && vscode.extensions.getExtension(VENDOR_EXTENSIONS.agy.id) !== undefined;
}
/** Whether CoAgent8 is in the CLI's own chat; a manual entry counts, and setup leaves it as it is. */
function inChat(registration: RegistrationStatus): boolean {
  return registration.state === 'owned' || registration.state === 'manual';
}
/** The CLI's state and whether CoAgent8 is in its chat, on one line. */
function describe(result: SetupStatus, registration: RegistrationStatus): string {
  const cli = result.ready ? `Ready${result.version ? ` ${result.version}` : ''}`
    : result.installed ? (result.compatibility === 'supported' ? `Sign-in needed (${result.authentication})` : `Update needed - ${result.diagnostic}`)
      : antigravityDownloadPending(result) ? 'Downloading - the Google Antigravity extension installs this CLI when its backend starts'
        : result.action === 'blocked' ? `Blocked - ${result.message}` : 'Not installed';
  const chat = registration.state === 'owned' ? (registration.current ? 'in its chat' : 'in its chat for another version; stays checked to update')
    : registration.state === 'manual' ? 'in its chat (manual entry, kept)'
      : registration.state === 'blocked' ? `chat configuration unreadable - ${registration.message}` : 'not in its chat';
  return `${cli} · ${chat}`;
}
/** Whether Set Up Coding CLIs can install or sign in the CLI; ready, blocked and outdated CLIs need nothing it offers. */
function needsAction(result: SetupStatus): boolean {
  return result.installed ? result.compatibility === 'supported' && result.authentication !== 'authenticated' : result.action !== 'blocked';
}
function labels(clients: SetupClient[]): string {
  return clients.map(client => LABELS[client]).join(', ');
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
/**
 * Removes what an official standalone installer installed: the global npm package that
 * setup installs for Codex, the files Claude Code's uninstall documentation names, and
 * the single binary the Antigravity CLI installer copies (it publishes no uninstall).
 * PATH entries the installers added are left as they are.
 */
function removeCommand(client: SetupClient): string {
  const windows = process.platform === 'win32';
  if (client === 'codex') return 'npm uninstall -g @openai/codex';
  if (client === 'claude') {
    return windows ? 'Remove-Item -Path "$env:USERPROFILE\\.local\\bin\\claude.exe" -Force; Remove-Item -Path "$env:USERPROFILE\\.local\\share\\claude" -Recurse -Force'
      : 'rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude';
  }
  return windows ? 'Remove-Item -Path "$env:LOCALAPPDATA\\agy\\bin\\agy.exe" -Force' : 'rm -f ~/.local/bin/agy';
}
/**
 * Inserts an explicitly chosen action for review; the user presses Enter to run it.
 * @param context - Owns the terminal; omitted, the terminal outlives the extension.
 */
function offerTerminal(command: string, name: string, context?: vscode.ExtensionContext): void {
  const windows = process.platform === 'win32';
  const terminal = vscode.window.createTerminal({ name, shellPath: windows ? 'powershell.exe' : '/bin/bash', shellArgs: windows ? ['-NoProfile'] : [] });
  context?.subscriptions.push(terminal);
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
        coagent8_CONFIG: configurationFile(),
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
    return { runtimeSource: context.asAbsolutePath('dist/index.cjs'), nodePath, home: os.homedir(), cwd: folders[0]?.uri.fsPath || os.homedir(), env: discoveryEnvironment(storage), origin: EXTENSION_ORIGIN, dataDirectory: storage };
  }
  let lastStatus: SetupStatus[] = [];
  /** One readable state per CLI; the full evidence is written only through Show Details. */
  function describeState(result: SetupStatus): string {
    const cli = result.ready ? 'ready'
      : !result.installed ? (result.action === 'blocked' ? 'blocked' : 'not installed')
        : result.compatibility !== 'supported' ? `${result.compatibility} controls` : `sign-in ${result.authentication}`;
    return `${result.client}: ${cli}${result.registered ? ', added to its chat' : ''}`;
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
    // A standalone installer setup opened counts once a check finds its CLI, also after a reload.
    const pending = readSetupState(storage).pendingClis ?? [];
    const found = results.filter(result => pending.includes(result.client) && result.installed).map(result => result.client);
    if (found.length) {
      await updateInstallList(storage, 'installedClis', found);
      await updateInstallList(storage, 'pendingClis', [], found);
    }
    return results;
  }
  function showDetails(value: unknown = lastStatus): void {
    report(value, true);
  }
  /** Shows home paths as `~`. */
  function shownPath(value: string, home: string): string {
    const relative = path.relative(home, value);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : value;
  }
  function describeSource(client: SetupClient, source: ClientSource, home: string): string {
    const vendor = VENDOR_EXTENSIONS[client];
    if (source.kind === 'vscode-extension') return client === 'agy' ? `Downloaded by the ${vendor.name} VS Code extension` : `${vendor.name} VS Code extension`;
    return `${source.kind === 'npm' ? 'npm package' : 'Standalone CLI'} - ${shownPath(source.executable, home)}`;
  }
  /**
   * Where an installed CLI comes from, shown under its name, and the other installation the
   * runtime could use instead, offered as a button on the line.
   */
  function installation(result: SetupStatus): { detail?: string; alternative?: ClientSource } {
    if (!result.installed) return {};
    const opts = options();
    const cli = resolveSetupClient(result.client, opts.home, opts.env, opts.nodePath);
    if (!cli) return {};
    const source = clientSource(result.client, cli, opts.home, opts.env);
    const state = readSetupState(storage);
    const byCoAgent8 = source.kind === 'vscode-extension' ? state.installedExtensions?.includes(VENDOR_EXTENSIONS[result.client].id) : state.installedClis?.includes(result.client);
    const configured = readBackendExecutable(SETUP_PROVIDERS[result.client], configurationFile()) !== undefined;
    const alternative = alternativeSource(result.client, source, opts.home, opts.env, opts.nodePath);
    return {
      detail: `${describeSource(result.client, source, opts.home)}${byCoAgent8 ? ', installed by CoAgent8' : ''}${configured ? ', set in config.json' : ''}${alternative ? `; also: ${describeSource(result.client, alternative, opts.home)}` : ''}`,
      alternative,
    };
  }
  function discoverable(client: SetupClient): boolean {
    const opts = options();
    return resolveSetupClient(client, opts.home, opts.env, opts.nodePath) !== null;
  }
  /**
   * Shows the one closing notice for setup and registration changes.
   * @param lead - Sentences that precede the registration outcome, such as readiness.
   * @param added - Setup results of the CLIs that should have CoAgent8 in their chat.
   * @param removed - Cleanup results of the CLIs whose CoAgent8 entry should be gone.
   * @remarks Vendor chat extensions load MCP servers only when they start, so a change
   * for a CLI whose extension is installed offers **Restart Extensions**.
   */
  async function announce(lead: string[], added: SetupStatus[], removed: { client: SetupClient; action: string; message: string }[], details: unknown): Promise<void> {
    const installed = added.filter(result => result.action === 'installed').map(result => result.client);
    const updated = added.filter(result => result.action === 'updated').map(result => result.client);
    const gone = removed.filter(result => result.action === 'removed').map(result => result.client);
    const failed = [...added.filter(result => !installed.includes(result.client) && !updated.includes(result.client)), ...removed.filter(result => result.action !== 'removed')];
    const changed = [...installed, ...updated, ...gone];
    const restart = changed.some(client => vscode.extensions.getExtension(VENDOR_EXTENSIONS[client].id) !== undefined);
    const message = [
      ...lead,
      installed.length ? `CoAgent8 added to the chats of ${labels(installed)}.` : '',
      updated.length ? `CoAgent8 updated in the chats of ${labels(updated)}.` : '',
      gone.length ? `CoAgent8 removed from the chats of ${labels(gone)}.` : '',
      failed.length ? `Not changed: ${failed.map(result => `${LABELS[result.client]} - ${result.message}`).join(' ')}` : '',
      !changed.length ? '' : restart ? 'Restart extensions so their VS Code chats load it; new terminal sessions have it already.' : 'New terminal sessions have it.',
    ].filter(Boolean).join(' ');
    const actions = [...(restart ? ['Restart Extensions'] : []), 'Show Details'];
    const choice = failed.length ? await vscode.window.showWarningMessage(message, ...actions) : await vscode.window.showInformationMessage(message, ...actions);
    if (choice === 'Restart Extensions') await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    else if (choice === 'Show Details') showDetails(details);
  }
  /**
   * Opens a multi-select picker at once and fills it when its bounded checks finish.
   * @param load - Runs the checks and returns the items with their initial selection; the
   * title-bar Check Again button runs it again.
   * @returns The accepted items, or undefined when the picker was dismissed.
   */
  async function pick<T extends vscode.QuickPickItem>(title: string, load: (trigger: string) => Promise<{ items: T[]; selected: T[]; placeholder: string }>,
    onItemButton?: (item: T, button: vscode.QuickInputButton) => Promise<string>): Promise<readonly T[] | undefined> {
    const picker = vscode.window.createQuickPick<T>();
    const again: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Check Again' };
    const details: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('output'), tooltip: 'Show Details' };
    picker.title = title;
    picker.canSelectMany = true;
    // Notifications and terminals opened by earlier actions must not dismiss the choice.
    picker.ignoreFocusOut = true;
    picker.buttons = [again, details];
    let hidden = false;
    const closed = new Promise<boolean>(resolve => {
      picker.onDidAccept(() => resolve(true));
      picker.onDidHide(() => { hidden = true; resolve(false); });
    });
    function checking(): void {
      picker.placeholder = 'Checking installed CLIs...';
      picker.busy = true;
      picker.enabled = false;
    }
    let filled = false;
    async function fill(trigger: string): Promise<void> {
      // A refill keeps the choices made so far; the first fill shows the current state.
      const chosen = filled ? new Set(picker.selectedItems.map(item => item.label)) : undefined;
      checking();
      const loaded = await load(trigger);
      if (hidden) return;
      picker.items = loaded.items;
      picker.selectedItems = chosen ? loaded.items.filter(item => chosen.has(item.label)) : loaded.selected;
      filled = true;
      picker.placeholder = loaded.placeholder;
      picker.busy = false;
      picker.enabled = true;
    }
    const failed = (error: unknown) => { picker.hide(); void vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Check failed.')}`); };
    picker.onDidTriggerButton(button => {
      if (button === details) showDetails();
      else void fill(`${title} (Check Again)`).catch(failed);
    });
    picker.onDidTriggerItemButton(event => {
      if (!onItemButton) return;
      checking();
      void onItemButton(event.item, event.button).then(trigger => fill(trigger)).catch(failed);
    });
    // The picker appears busy before the checks start.
    checking();
    picker.show();
    try {
      await fill(title);
      if (!await closed) return undefined;
      return picker.selectedItems;
    } finally {
      picker.dispose();
    }
  }
  /** Reports a CLI that did not appear in time; the user's installation itself may still finish. */
  async function waited(client: SetupClient, found: boolean, viaAntigravity: boolean): Promise<boolean> {
    if (!found) {
      await vscode.window.showWarningMessage(viaAntigravity
        ? `${LABELS[client]} is not available yet. Open the Antigravity view once so the extension starts its backend and downloads the CLI, then run CoAgent8: Set Up Coding CLIs again.`
        : `${LABELS[client]} is not available yet. If the extension is not visible, reload the window, then run CoAgent8: Set Up Coding CLIs again.`);
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
      'Install VS Code Extension', 'Install Standalone CLI');
    if (choice === 'Install VS Code Extension') {
      const preinstalled = vscode.extensions.getExtension(vendor.id) !== undefined;
      // Machine-scoped: the CLI and its sign-in belong to this machine, and VS Code then
      // installs without asking whether Settings Sync should copy it to other devices.
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vendor.id, { donotSync: true });
      // The command returns once the extension is installed (a cancellation throws); the
      // extension API can report it later, so it is not consulted here. Only an extension
      // this action added may later be offered for removal with CoAgent8.
      if (!preinstalled) await updateInstallList(storage, 'installedExtensions', [vendor.id]);
      const found = await waitForCli(`Waiting for ${LABELS[client]} from the ${vendor.name} extension...`, () => discoverable(client));
      return waited(client, found, client === 'agy');
    }
    if (choice !== 'Install Standalone CLI') return false;
    // The CLI is absent here, so a later check that finds it identifies this installation.
    await updateInstallList(storage, 'pendingClis', [client]);
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
  /** @returns Whether the user asked to check the CLI after opening its sign-in command. */
  async function offerSignIn(result: SetupStatus): Promise<boolean> {
    const client = result.client;
    const choice = await vscode.window.showInformationMessage(`${LABELS[client]} sign-in is ${result.authentication}. Open a sign-in command?`, 'Open Sign-in Command');
    if (choice !== 'Open Sign-in Command') return false;
    const opts = options(), cli = resolveSetupClient(client, opts.home, opts.env, opts.nodePath);
    if (!cli) throw new Error('CLI disappeared; run CoAgent8: Set Up Coding CLIs again.');
    const args = client === 'codex' ? ['login'] : client === 'claude' ? ['auth', 'login'] : [];
    offerTerminal(`${process.platform === 'win32' ? '& ' : ''}${[cli.command, ...cli.argsPrefix, ...args].map(quote).join(' ')}`, `Sign in to ${LABELS[client]}`, context);
    return await vscode.window.showInformationMessage(`Press Enter in the terminal to sign in to ${LABELS[client]}. When it finishes, check it here.`, 'Check Now') === 'Check Now';
  }
  function register(name: string, action: () => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      if (vscode.env.remoteName) { await vscode.window.showWarningMessage('CoAgent8 setup supports the local default profile. Run coagent8 status/setup/cleanup on the intended machine.'); return; }
      try { await action(); }
      catch (error) { await vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Action failed or was cancelled; retry.')}`); }
    }));
  }
  register('coagent8.openSettings', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`); });
  register('coagent8.manageMcpServers', async () => { await vscode.commands.executeCommand('workbench.mcp.listServer'); });
  register('coagent8.resetConfiguration', async () => {
    const file = configurationFile();
    const dirty = vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && path.resolve(document.uri.fsPath) === path.resolve(file) && document.isDirty);
    if (dirty) throw new Error('Save or revert the configuration editor before resetting the file.');
    const choice = await vscode.window.showWarningMessage(`Reset ${file} to defaults? The current file will be saved as ${path.basename(file)}.backup, replacing an earlier backup. CoAgent8 settings in VS Code, CLI sign-ins and MCP registrations will be retained.`, { modal: true }, 'Reset Configuration');
    if (choice !== 'Reset Configuration') return;
    const backup = await resetConfigurationFile(file, validateConfig({ $schema: vscode.Uri.file(context.asAbsolutePath('schemas/config.schema.json')).toString() }));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    const next = await vscode.window.showInformationMessage(`CoAgent8 configuration reset.${backup ? ` Backup: ${backup}.` : ''} CoAgent8 settings set in VS Code still take precedence; reset them in Settings.`, 'Open Settings');
    if (next === 'Open Settings') await vscode.commands.executeCommand('coagent8.openSettings');
  });
  register('coagent8.openConfiguration', async () => {
    const file = configurationFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const defaults = validateConfig({ $schema: vscode.Uri.file(context.asAbsolutePath('schemas/config.schema.json')).toString() });
    try { fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
  });
  register('coagent8.setup', async () => {
    let results: SetupStatus[] = [];
    let registrations: RegistrationStatus[] = [];
    const picked = await pick<vscode.QuickPickItem & { client: SetupClient; alternative?: ClientSource }>('Set Up Coding CLIs', async trigger => {
      results = await status(trigger);
      registrations = readRegistrations(options());
      const items = results.map(result => {
        const registration = registrations.find(item => item.client === result.client)!;
        const { detail, alternative } = installation(result);
        const opts = options();
        return { label: LABELS[result.client], client: result.client, description: describe(result, registration), detail, alternative,
          buttons: alternative ? [{ iconPath: new vscode.ThemeIcon('arrow-swap'), tooltip: `Use ${describeSource(result.client, alternative, opts.home)}` }] : [] };
      });
      // Checked means CoAgent8 is in that CLI's chat, so accepting the list unchanged changes nothing.
      const selected = items.filter(item => inChat(registrations.find(registration => registration.client === item.client)!));
      return { items, selected, placeholder: 'Checked: CoAgent8 uses the CLI and is in its chat. Check to install, sign in and add; uncheck to remove from the chat.' };
    }, async item => {
      // The runtime, VS Code chat and the CLI chats read this file on their next turn.
      await setBackendExecutable(SETUP_PROVIDERS[item.client], item.alternative!.executable, configurationFile());
      clearCliResolverCache();
      return `Set Up Coding CLIs (${LABELS[item.client]} switched)`;
    });
    if (!picked) return;
    const checked = new Set(picked.map(item => item.client));
    const registrationOf = (client: SetupClient) => registrations.find(item => item.client === client)!;
    // Checks run again only after an installation or sign-in could have changed a CLI.
    let changed = false;
    const add: SetupClient[] = [];
    for (const client of SETUP_CLIENTS.filter(item => checked.has(item))) {
      let result = results.find(item => item.client === client)!;
      try {
        if (!result.installed) {
          if (result.action === 'blocked' || !await installCli(client)) continue;
          changed = true;
          result = (await status(`Installed ${LABELS[client]}`, [client])).find(item => item.client === client)!;
        }
        if (result.installed && result.compatibility === 'supported' && result.authentication !== 'authenticated') changed = await offerSignIn(result) || changed;
        // Registration needs a compatible CLI, not a sign-in; manual entries stay as they are.
        const registration = registrationOf(client);
        if (result.installed && result.compatibility === 'supported' && (registration.state === 'absent' || (registration.state === 'owned' && !registration.current))) add.push(client);
      } catch (error) {
        await vscode.window.showErrorMessage(`${LABELS[client]}: ${redactDiagnostic(error instanceof Error ? error.message : 'Installation failed or was cancelled.')} Run CoAgent8: Set Up Coding CLIs to retry.`);
      }
    }
    // Unchecking removes only an entry CoAgent8 wrote; the CLI itself stays installed.
    const remove = SETUP_CLIENTS.filter(client => !checked.has(client) && registrationOf(client).state === 'owned');
    if (!changed && !add.length && !remove.length) return;
    const outcome = add.length || remove.length ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating CoAgent8 in CLI chats...' }, async () => {
      const opts = options();
      let removed: { client: SetupClient; action: string; message: string }[] = [];
      if (remove.length) {
        // The preview is applied at once: accepting the list was the confirmation.
        const preview = await cleanupClients({ home: opts.home, env: opts.env, clients: remove, actor: EXTENSION_ORIGIN });
        removed = (await cleanupClients({ home: opts.home, env: opts.env, clients: remove, actor: EXTENSION_ORIGIN, apply: preview.token })).results;
      }
      return { removed, added: add.length ? await setupClients({ ...opts, clients: add }) : [] };
    }) : { removed: [], added: [] };
    if (add.length || remove.length) report(outcome);
    const final = changed ? await status('Set Up Coding CLIs (after changes)') : results;
    const ready = final.filter(result => result.ready).map(result => result.client);
    const lead = !changed ? [] : [ready.length
      ? `Ready: ${labels(ready)}. CoAgent8 can use ${ready.length > 1 ? 'them' : 'it'} from VS Code chat now.`
      : 'No CLI is ready yet. CoAgent8 needs a compatible, signed-in CLI; run CoAgent8: Set Up Coding CLIs again when the installation or sign-in has finished.'];
    await announce(lead, outcome.added, outcome.removed, add.length || remove.length ? outcome : final);
  });
  register('coagent8.uninstall', async () => {
    const state = readSetupState(storage);
    // Only what CoAgent8 setup installed and is still present is offered; nothing is preselected.
    const items: (vscode.QuickPickItem & { client: SetupClient; target: 'extension' | 'cli' })[] = [];
    for (const client of SETUP_CLIENTS) {
      const vendor = VENDOR_EXTENSIONS[client];
      if (state.installedExtensions?.includes(vendor.id) && vscode.extensions.getExtension(vendor.id)) {
        items.push({ label: vendor.name, description: `VS Code extension ${vendor.id}`, client, target: 'extension',
          detail: `Installed by CoAgent8 setup for ${LABELS[client]}. Removing it removes its chat and the CLI it provides${client === 'agy' ? `, including ${ANTIGRAVITY_DOWNLOAD}, which the extension downloaded and leaves behind` : ''}; sign-ins and histories stay.` });
      }
      if (state.installedClis?.includes(client) && discoverable(client)) {
        items.push({ label: LABELS[client], description: 'standalone CLI', client, target: 'cli',
          detail: `Installed by CoAgent8 setup with the official installer. Removal runs: ${removeCommand(client)}. Sign-ins and histories stay.` });
      }
    }
    let remove: typeof items = [];
    if (items.length) {
      const picked = await vscode.window.showQuickPick(items, { canPickMany: true, ignoreFocusOut: true, title: 'Uninstall CoAgent8',
        placeHolder: 'Also remove what CoAgent8 setup installed? Select none to keep it.' });
      if (!picked) return;
      remove = [...picked];
    }
    const names = remove.map(item => item.label).join(', ');
    const first = await vscode.window.showWarningMessage(`Uninstall CoAgent8${remove.length ? ` and ${names}` : ''}?`,
      { modal: true, detail: 'CoAgent8 removes its registrations in the CLI chats now. VS Code removes the extension and its data when it next starts.' }, 'Uninstall');
    if (first !== 'Uninstall') return;
    const extensions = remove.filter(item => item.target === 'extension');
    const clis = remove.filter(item => item.target === 'cli');
    if (remove.length) {
      const second = await vscode.window.showWarningMessage(`Remove ${names}?`, { modal: true, detail: [
        extensions.length ? 'The selected extensions are uninstalled from VS Code; their chats stop working and the CLIs they provide go with them.' : '',
        clis.length ? 'The removal commands for the selected standalone CLIs are inserted in a terminal; press Enter there to run them.' : '',
        'Sign-ins and histories stay. Reinstalling CoAgent8 does not restore them.',
      ].filter(Boolean).join(' ') }, 'Remove');
      if (second !== 'Remove') return;
    }
    // Registrations go first, while the runtime they start still exists.
    const opts = options();
    const preview = await cleanupClients({ home: opts.home, env: opts.env, origin: EXTENSION_ORIGIN, uninstall: true });
    const cleaned = await cleanupClients({ home: opts.home, env: opts.env, origin: EXTENSION_ORIGIN, uninstall: true, apply: preview.token });
    report(cleaned);
    // Not owned by the extension: the terminal must outlive its deactivation.
    if (clis.length) offerTerminal(clis.map(item => removeCommand(item.client)).join(process.platform === 'win32' ? '; ' : ' && '), 'Remove coding CLIs');
    const leftovers: string[] = [];
    for (const item of extensions) {
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', VENDOR_EXTENSIONS[item.client].id);
      // The Google Antigravity extension downloads agy outside its folder and does not remove it.
      if (item.client === 'agy') {
        try { fs.rmSync(path.join(os.homedir(), ANTIGRAVITY_DOWNLOAD.slice(2)), { force: true }); }
        catch (error) { leftovers.push(`${ANTIGRAVITY_DOWNLOAD} was not deleted (${redactDiagnostic(error instanceof Error ? error.message : 'unknown error')}); delete it after quitting VS Code.`); }
      }
    }
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', EXTENSION_ID);
    const kept = cleaned.results.filter(result => result.action === 'blocked');
    const message = [
      `CoAgent8${extensions.length ? ` and ${extensions.map(item => item.label).join(', ')}` : ''} uninstalled.`,
      ...leftovers,
      kept.length ? `Registrations not removed: ${kept.map(result => `${LABELS[result.client]} - ${result.message}`).join(' ')}` : '',
      cleaned.stateError ?? '',
      clis.length ? `Press Enter in the "Remove coding CLIs" terminal to remove ${clis.map(item => item.label).join(', ')}.` : '',
      'Quit VS Code and start it again to finish.',
    ].filter(Boolean).join(' ');
    const next = kept.length || cleaned.stateError || leftovers.length ? await vscode.window.showWarningMessage(message, 'Quit VS Code') : await vscode.window.showInformationMessage(message, 'Quit VS Code');
    if (next === 'Quit VS Code') await vscode.commands.executeCommand('workbench.action.quit');
  });
  /** Checks the CLIs once per installation; later activations start no process. */
  async function showWelcome(): Promise<void> {
    if (vscode.env.remoteName || readSetupState(storage).welcomed) return;
    const results = await status('Welcome CLI Check');
    // Recorded before the notice, so a reload while it is open does not check again.
    await updateSetupState(storage, { welcomed: true });
    const ready = results.filter(result => result.ready);
    if (ready.length) {
      // The other CLIs and the CLI chats are offered from the start, in the one setup list.
      const missing = results.filter(needsAction).map(result => result.client);
      const unregistered = ready.filter(result => !result.registered).map(result => result.client);
      const offer = [missing.length ? `installs or signs in ${labels(missing)}` : '', unregistered.length ? `adds CoAgent8 to the chats of ${labels(unregistered)}` : ''].filter(Boolean).join(' and ');
      const next = await vscode.window.showInformationMessage(`CoAgent8 is ready with ${labels(ready.map(result => result.client))}. Use its tools from VS Code chat; VS Code starts the server on first use.${offer ? ` Set Up CLIs ${offer}.` : ''}`,
        ...(offer ? ['Set Up CLIs'] : []), 'Show MCP Servers');
      if (next === 'Set Up CLIs') await vscode.commands.executeCommand('coagent8.setup');
      else if (next === 'Show MCP Servers') await vscode.commands.executeCommand('coagent8.manageMcpServers');
      return;
    }
    const choice = await vscode.window.showInformationMessage('CoAgent8 needs one compatible, signed-in coding CLI: Codex CLI, Claude Code CLI or Antigravity CLI.', 'Set Up CLIs');
    if (choice === 'Set Up CLIs') await vscode.commands.executeCommand('coagent8.setup');
  }
  void showWelcome().catch(error => { void vscode.window.showErrorMessage(`CoAgent8 onboarding: ${redactDiagnostic(error instanceof Error ? error.message : 'Onboarding failed.')}`); });
  /**
   * Offers Set Up CLIs once per bundled runtime when a CLI chat still starts another one,
   * as after an extension update. Reads the CLI configuration files only and starts no process.
   */
  async function offerRegistrationUpdate(): Promise<void> {
    if (vscode.env.remoteName || !readSetupState(storage).welcomed) return;
    const runtime = `${version}#${createHash('sha256').update(fs.readFileSync(context.asAbsolutePath('dist/index.cjs'))).digest('hex')}`;
    if (readSetupState(storage).updateOffered === runtime) return;
    const outdated = readRegistrations(options()).filter(item => item.state === 'owned' && !item.current).map(item => item.client);
    if (!outdated.length) return;
    await updateSetupState(storage, { updateOffered: runtime });
    const next = await vscode.window.showWarningMessage(`CoAgent8 was updated, but the chats of ${labels(outdated)} still start the previous version. Set Up CLIs updates them; restart those chats afterwards.`, 'Set Up CLIs');
    if (next === 'Set Up CLIs') await vscode.commands.executeCommand('coagent8.setup');
  }
  void offerRegistrationUpdate().catch(error => { void vscode.window.showErrorMessage(`CoAgent8 update check: ${redactDiagnostic(error instanceof Error ? error.message : 'Update check failed.')}`); });
}
