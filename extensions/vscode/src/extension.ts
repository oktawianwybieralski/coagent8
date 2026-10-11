import * as vscode from 'vscode';
import { version } from '../../../package.json';
import { checkExecutable, clientSource, configuredExecutable, listInstallations, setupClients, readRegistrations, SETUP_CLIENTS, SETUP_PROVIDERS, resolveSetupClient, type ClientInstallation, type ClientSource, type RegistrationStatus, type SetupClient, type SetupStatus } from '../../../src/integrations/setup.js';
import { cleanupClients } from '../../../src/integrations/cleanup.js';
import { redactDiagnostic } from '../../../src/security/redaction.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readGovernance, setBackendExecutable, setModelRule, setPriceRules, validateConfig } from '../../../src/config.js';
import { runCommand } from '../../../src/execution/process.js';
import type { ModelReport } from '../../../src/diagnostics/doctor.js';
import type { ModelCandidate } from '../../../src/models/selection.js';
import type { ConsentBasis, ProviderId } from '../../../src/contracts/index.js';
import { hasManualVscodeRegistration, hasWorkspaceVscodeRegistration, syncVscodeRegistration, type VscodeRegistration, type VscodeServer } from '../../../src/integrations/vscode-profile.js';
import { clearCliResolverCache } from '../../../src/execution/cli-resolver.js';
import { EDITOR_SETTINGS, EDITOR_SETTINGS_ENV } from '../../../src/config-overrides.js';
import { VSCODE_EXTENSION_EXECUTABLE } from '../../../src/backends/executable.js';
import { readInstallRecord, readSetupState, resetConfigurationFile, updateInstallList, updateSetupState, type StateLocation } from './configuration.js';
import { EXTENSION_ORIGIN } from '../../../src/integrations/setup-storage.js';
import { manageSkills, skillSelectionForAction, type ManagedSkill } from '../../../src/integrations/skill-management.js';

/** This extension's identifier, as published. */
const EXTENSION_ID = 'okidev.coagent8-mcp';
const LABELS: Record<SetupClient, string> = { codex: 'Codex CLI', claude: 'Claude Code CLI', agy: 'Antigravity CLI' };
/** Longest the model view may take: a first read probes each CLI and reads the price list. */
const MODEL_REPORT_TIMEOUT_MS = 90_000;
type ApprovalRule = 'allow' | 'ask' | 'deny';
type PriceRule = 'askAbovePrice' | 'priceMultiplier';
/** The rules the user can give one model, in the order Manage Model Approvals offers them. */
const RULE_ITEMS: (vscode.QuickPickItem & { rule: ApprovalRule | null })[] = [
  { label: '$(pass-filled) Allow', rule: 'allow', description: 'Runs without asking' },
  { label: '$(question) Ask Every Time', rule: 'ask', description: 'The approval form asks before each call' },
  { label: '$(circle-slash) Deny', rule: 'deny', description: 'Never runs' },
  { label: '$(law) Price Rules', rule: null, description: 'Asks only when the price rules say so' },
];
const RULE_TEXT: Record<ApprovalRule, string> = { allow: 'allow', ask: 'ask every time', deny: 'deny' };
/** Why the price rules ask for a model, as its line says. */
const PRICE_REASONS: Partial<Record<ConsentBasis, string>> = {
  'above-limit': 'above price', relative: 'above default price', unpriced: 'price unknown', approximate: 'approximate price', 'no-price-list': 'no price list',
};
const PRICE_RULES: Record<PriceRule, { title: string; prompt: string; invalid: string }> = {
  askAbovePrice: { title: 'Ask Above Price', prompt: 'USD per million output tokens at or above which a model asks; leave empty to turn this rule off', invalid: 'Enter a price of 0 or more, or leave it empty.' },
  priceMultiplier: { title: 'Ask Above Default Price', prompt: 'How many times the price of the backend\'s default model a model may cost before it asks', invalid: 'Enter a number greater than 1.' },
};
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
/** The CLI's state and whether CoAgent8 is in its chat, on one line. */
function describe(result: SetupStatus, registration: RegistrationStatus): string {
  const cli = result.ready ? `Ready${result.version ? ` ${result.version}` : ''}`
    : result.installed ? (result.compatibility === 'supported' ? `Sign-in needed (${result.authentication})` : `Update needed - ${result.diagnostic}`)
      : antigravityDownloadPending(result) ? 'Downloading - the Google Antigravity extension installs this CLI when its backend starts'
        : result.action === 'blocked' ? `Blocked - ${result.message}` : 'Not installed';
  const chat = registration.state === 'owned' ? (registration.current ? 'in its chat' : 'in its chat for another version')
    : registration.state === 'manual' ? 'in its chat (manual entry, kept)'
      : registration.state === 'blocked' ? `chat configuration unreadable - ${registration.message}` : 'not in its chat';
  return `${cli} · ${chat}`;
}
/** Whether Manage Coding CLIs can install or sign in the CLI; ready, blocked and outdated CLIs need nothing it offers. */
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
 * Folders the official Windows installers create; those left empty are deleted with their
 * user PATH entries. Inner folders come first.
 */
const INSTALLER_FOLDERS: Record<SetupClient, string[]> = {
  codex: [],
  claude: ['$env:USERPROFILE\\.local\\bin', '$env:USERPROFILE\\.local\\share'],
  agy: ['$env:LOCALAPPDATA\\agy\\bin', '$env:LOCALAPPDATA\\agy', '$env:USERPROFILE\\.gemini\\bin'],
};
/** What {@link removeCommand} removes for a client, for the removal confirmation. */
function removalSummary(client: SetupClient): string {
  if (client === 'codex') return 'npm uninstall -g @openai/codex';
  if (process.platform !== 'win32') return client === 'claude' ? '~/.local/bin/claude and ~/.local/share/claude' : '~/.local/bin/agy';
  return client === 'claude' ? '~/.local/bin/claude.exe, ~/.local/share/claude, the installer folders left empty and their PATH entries'
    : '%LOCALAPPDATA%\\agy\\bin (a link to ~/.gemini/bin), agy.exe, the installer folders left empty and their PATH entries';
}
/**
 * Removes what an official standalone installer installed: the global npm package that
 * setup installs for Codex, the files Claude Code's uninstall documentation names, and
 * the agy binary (its installer publishes no uninstall). On Windows the agy installer
 * links %LOCALAPPDATA%\agy\bin to ~/.gemini/bin, so the link itself is deleted, never its
 * target's other contents; ~/.gemini/bin/agy.exe stays while the Google Antigravity
 * extension, which downloads it there, is installed.
 * @param keepAgyDownload - The Google Antigravity extension is installed.
 */
function removeCommand(client: SetupClient, keepAgyDownload: boolean): string {
  const windows = process.platform === 'win32';
  if (client === 'codex') return 'npm uninstall -g @openai/codex';
  if (client === 'claude') {
    return windows ? 'Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\claude.exe", "$env:USERPROFILE\\.local\\share\\claude" -Recurse -Force -ErrorAction SilentlyContinue'
      : 'rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude';
  }
  if (!windows) return 'rm -f ~/.local/bin/agy';
  return '$agy = "$env:LOCALAPPDATA\\agy\\bin"; if ((Get-Item -LiteralPath $agy -Force -ErrorAction SilentlyContinue).LinkType) { [IO.Directory]::Delete($agy) } '
    + 'else { Remove-Item -LiteralPath "$agy\\agy.exe" -Force -ErrorAction SilentlyContinue }'
    + (keepAgyDownload ? '' : '; Remove-Item -LiteralPath "$env:USERPROFILE\\.gemini\\bin\\agy.exe" -Force -ErrorAction SilentlyContinue');
}
/**
 * Deletes the installer folders left empty and removes their entries from the user PATH in
 * the registry, keeping the value's type and unexpanded variables. Windows only; on other
 * systems the installers' shell profile lines stay.
 */
function folderCleanupCommand(clients: SetupClient[]): string {
  const folders = clients.flatMap(client => INSTALLER_FOLDERS[client]);
  if (process.platform !== 'win32' || !folders.length) return '';
  return '$folders = @(' + folders.map(folder => '"' + folder + '"').join(', ') + '); '
    + 'foreach ($folder in $folders) { if ((Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force)) { Remove-Item -LiteralPath $folder -Force } }; '
    + "$key = Get-Item -LiteralPath 'HKCU:\\Environment'; $path = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); "
    + "$kept = @($path -split ';' | Where-Object { $_ -and ((Test-Path -LiteralPath ([Environment]::ExpandEnvironmentVariables($_))) -or ($folders -notcontains [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\'))) }) -join ';'; "
    + "if ($path -and $kept -ne $path) { Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value $kept -Type $key.GetValueKind('Path') }";
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
/** Workspace state: the duplicate CoAgent8 registration notice was shown in this workspace. */
const DUPLICATE_NOTED = 'coagent8.workspaceDuplicateNoted';
/**
 * Registers the independent MCP provider and explicit onboarding/registration/cleanup actions.
 * @returns The first synchronization of the profile entry, which VS Code awaits.
 */
export function activate(context: vscode.ExtensionContext): Promise<void> {
  const storage = context.globalStorageUri.fsPath;
  const location = (): StateLocation => ({ storage, home: os.homedir() });
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  /** The server's command and environment, shared by the profile entry and the provider. */
  function server(): VscodeServer {
    const command = vscode.workspace.getConfiguration('coagent8').get<string>('nodePath', 'node').trim();
    if (!command) throw new Error('CoAgent8: configure coagent8.nodePath with a Node.js 24+ executable.');
    return { command, env: {
      coagent8_EXTENSION_PATHS: discoveryEnvironment(storage).coagent8_EXTENSION_PATHS!,
      coagent8_DIR: storage,
      coagent8_CONFIG: configurationFile(),
      [EDITOR_SETTINGS_ENV]: editorSettings(),
    } };
  }
  const folders = () => vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  let profileRegistration: VscodeRegistration | undefined;
  /**
   * Keeps CoAgent8 in the profile `mcp.json`, where VS Code lists installed MCP servers. When
   * that fails, the definition provider below still offers the server.
   */
  // Synchronizations run in order, each under the lease every window shares.
  let profileSync = Promise.resolve();
  function syncProfile(restore = false, adopt = false): Promise<void> {
    profileSync = profileSync.then(async () => {
      try {
        profileRegistration = await syncVscodeRegistration({ storagePath: storage, bundle: context.asAbsolutePath('dist/index.cjs'), server: server(), home: os.homedir(),
          installation: path.dirname(context.extensionPath), version, adopt, folders: folders(), restore });
        noteWorkspaceDuplicate();
      }
      catch (error) { profileRegistration = undefined; showLifecycleError(error); }
    });
    return profileSync;
  }
  /**
   * The profile entry serves every window, so a workspace that also registers CoAgent8 lists it
   * twice; the user chooses which to keep. Said once per workspace.
   */
  function noteWorkspaceDuplicate(): void {
    if (profileRegistration !== 'registered' && profileRegistration !== 'current') return;
    if (context.workspaceState.get<boolean>(DUPLICATE_NOTED) || !hasWorkspaceVscodeRegistration(folders())) return;
    void context.workspaceState.update(DUPLICATE_NOTED, true);
    void vscode.window.showInformationMessage("CoAgent8 is registered in this workspace's .vscode/mcp.json and in your user MCP servers, so VS Code lists it twice. Remove one of them.");
  }
  const activated = syncProfile();
  // Each listener returns its synchronization, so a caller can await the entry it writes.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('coagent8')) return undefined;
    clearCliResolverCache();
    const synced = syncProfile();
    changed.fire();
    return synced;
  }));
  context.subscriptions.push(vscode.extensions.onDidChange(() => { clearCliResolverCache(); const synced = syncProfile(); changed.fire(); return synced; }));
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('coagent8', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions() {
      if (profileRegistration === 'declined' || hasManualVscodeRegistration(storage, folders())) return [];
      const { command, env } = server();
      return [new vscode.McpStdioServerDefinition('CoAgent8', command, [context.asAbsolutePath('dist/index.cjs')], env,
        `${version}#${createHash('sha256').update(fs.readFileSync(context.asAbsolutePath('dist/index.cjs'))).digest('hex')}`)];
    },
  }));
  const profileMcpFile = path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'mcp.json');
  const mcpFiles = [profileMcpFile, ...vscode.workspace.workspaceFolders?.map(folder => path.join(folder.uri.fsPath, '.vscode', 'mcp.json')) ?? []];
  let manualRegistration = false;
  try { manualRegistration = hasManualVscodeRegistration(storage, folders()); }
  catch (error) { showLifecycleError(error); }
  async function registrationChanged(): Promise<void> {
    const declined = profileRegistration === 'declined';
    // Another window may have written the file: its complete entry is kept, not rewritten in turn.
    await syncProfile(false, true);
    try {
      const registered = hasManualVscodeRegistration(storage, folders());
      if (registered || manualRegistration || declined !== (profileRegistration === 'declined')) {
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
    return { runtimeSource: context.asAbsolutePath('dist/index.cjs'), skillsSource: context.asAbsolutePath('skills'), nodePath, home: os.homedir(), cwd: folders[0]?.uri.fsPath || os.homedir(), env: discoveryEnvironment(storage), origin: EXTENSION_ORIGIN, dataDirectory: storage };
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
    await reconcileInstallRecord(clients);
    return results;
  }
  /** Vendor extensions installed in this window, which the extension API can report later. */
  const installedHere = new Set<string>();
  /**
   * Keeps the record of what CoAgent8 installed current: a standalone installer it opened counts
   * once its CLI is found, also after a window reload, and a vendor extension removed in the
   * meantime leaves it. A standalone CLI leaves it only after its removal through this menu.
   */
  async function reconcileInstallRecord(clients: SetupClient[]): Promise<void> {
    const record = readInstallRecord(location());
    const found = clients.filter(client => record.pendingClis?.includes(client) && standaloneFound(client, inventory(client)));
    if (found.length) {
      await updateInstallList(location(), 'installedClis', found);
      await updateInstallList(location(), 'pendingClis', [], found);
    }
    const gone = clients.map(client => VENDOR_EXTENSIONS[client].id).filter(id => record.installedExtensions?.includes(id) && !installedHere.has(id) && !vscode.extensions.getExtension(id));
    if (gone.length) await updateInstallList(location(), 'installedExtensions', [], gone);
  }
  function showDetails(value: unknown = lastStatus): void {
    report(value, true);
  }
  /** Shows home paths as `~`. */
  function shownPath(value: string, home: string): string {
    const relative = path.relative(home, value);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join('~', relative) : value;
  }
  /** What kind of installation a source is, without its path. */
  function sourceName(client: SetupClient, source: ClientSource): string {
    const vendor = VENDOR_EXTENSIONS[client];
    // The official agy installer places its binary in the same folder the Google extension downloads to.
    if (source.kind === 'vscode-extension' && client === 'agy') return vscode.extensions.getExtension(vendor.id) ? `${vendor.name} VS Code extension` : 'Standalone CLI';
    if (source.kind === 'vscode-extension') return `${vendor.name} VS Code extension`;
    return source.kind === 'npm' ? 'npm package' : 'Standalone CLI';
  }
  /** Where a source is installed, for its path where the kind alone is ambiguous. */
  function sourcePath(client: SetupClient, source: ClientSource, home: string): string | undefined {
    if (source.kind !== 'vscode-extension') return shownPath(source.executable, home);
    return client === 'agy' && !vscode.extensions.getExtension(VENDOR_EXTENSIONS.agy.id) ? ANTIGRAVITY_DOWNLOAD : undefined;
  }
  function describeSource(client: SetupClient, source: ClientSource, home: string): string {
    const where = sourcePath(client, source, home);
    return `${sourceName(client, source)}${where ? ` - ${where}` : ''}`;
  }
  /** Whether an installation is a standalone or npm one rather than the vendor extension's copy. */
  function standaloneOnly(client: SetupClient, source: ClientSource): boolean {
    return source.kind !== 'vscode-extension' || (client === 'agy' && !vscode.extensions.getExtension(VENDOR_EXTENSIONS.agy.id));
  }
  /** Whether a standalone or npm installation is present; agy's installer and the Google extension share one binary. */
  function standaloneFound(client: SetupClient, installations: ClientInstallation[]): boolean {
    return installations.some(item => standaloneOnly(client, item));
  }
  function inventory(client: SetupClient): ClientInstallation[] {
    const opts = options();
    return listInstallations(client, opts.home, opts.env, opts.nodePath);
  }
  /** What the menus show for one CLI. */
  interface ClientView {
    status: SetupStatus;
    registration: RegistrationStatus;
    /** Every installation found, the one in use included. */
    installations: ClientInstallation[];
    /** The installation the runtime starts; absent when the CLI is not installed. */
    inUse?: ClientInstallation;
    /** `backends.<id>.executable`, when set. */
    configured?: { value: string; found: boolean };
  }
  function clientView(result: SetupStatus, registration: RegistrationStatus): ClientView {
    const client = result.client, opts = options();
    const installations = listInstallations(client, opts.home, opts.env, opts.nodePath);
    const configured = configuredExecutable(client, opts.home, opts.env, opts.nodePath);
    const cli = result.installed ? resolveSetupClient(client, opts.home, opts.env, opts.nodePath) : null;
    let inUse: ClientInstallation | undefined;
    if (cli) {
      const source = clientSource(client, cli, opts.home, opts.env);
      inUse = installations.find(item => item.kind === source.kind && item.executable === source.executable);
      // An environment override can name a file outside the folders searched.
      if (!inUse) installations.unshift(inUse = { ...source, file: source.kind === 'vscode-extension' ? cli.command : source.executable });
    }
    return { status: result, registration, installations, inUse, configured };
  }
  /**
   * Shows the one closing notice for registration changes.
   * @param added - Setup results of the CLIs that should have CoAgent8 in their chat.
   * @param removed - Cleanup results of the CLIs whose CoAgent8 entry should be gone.
   * @remarks Vendor chat extensions load MCP servers only when they start, so a change
   * for a CLI whose extension is installed offers **Restart Extensions**.
   */
  async function announce(added: SetupStatus[], removed: { client: SetupClient; action: string; message: string }[], details: unknown): Promise<void> {
    const installed = added.filter(result => result.action === 'installed').map(result => result.client);
    const updated = added.filter(result => result.action === 'updated').map(result => result.client);
    const gone = removed.filter(result => result.action === 'removed').map(result => result.client);
    const failed = [...added.filter(result => !installed.includes(result.client) && !updated.includes(result.client)), ...removed.filter(result => result.action !== 'removed')];
    const changed = [...installed, ...updated, ...gone];
    const restart = changed.some(client => vscode.extensions.getExtension(VENDOR_EXTENSIONS[client].id) !== undefined);
    const message = [
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
   * Adds CoAgent8 to the chats of the given CLIs or updates it there, and announces the outcome
   * without waiting for it: a notice moved to the notification center never answers.
   */
  async function connect(clients: SetupClient[]): Promise<void> {
    const added = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Updating CoAgent8 in CLI chats...' }, () => setupClients({ ...options(), clients }));
    report({ added });
    void announce(added, [], { added }).catch(showLifecycleError);
  }
  /** Removes the entries CoAgent8 wrote from the chats of the given CLIs; manual entries stay. */
  async function disconnect(clients: SetupClient[]): Promise<{ client: SetupClient; action: string; message: string }[]> {
    const opts = options();
    // The preview is applied at once: choosing the action was the confirmation.
    const preview = await cleanupClients({ home: opts.home, env: opts.env, clients, actor: EXTENSION_ORIGIN });
    const removed = (await cleanupClients({ home: opts.home, env: opts.env, clients, actor: EXTENSION_ORIGIN, apply: preview.token })).results;
    report({ removed });
    return removed;
  }
  /**
   * Opens a single-choice picker at once and fills it when its bounded checks finish.
   * @param load - Runs the checks and returns the items; the title-bar Check Again button runs it again.
   * @param back - Adds the title-bar Back button.
   * @param shown - The placeholder while checking, the evidence Show Details writes (default: the last CLI status) and the step of a multi-step flow.
   * @returns The accepted item, `back`, or undefined when the picker was dismissed.
   */
  async function pick<T extends vscode.QuickPickItem>(title: string, load: (trigger: string) => Promise<{ items: T[]; placeholder: string; title?: string }>, back = false, shown: { busy?: string; details?: () => unknown; step?: [number, number] } = {}): Promise<T | 'back' | undefined> {
    const picker = vscode.window.createQuickPick<T>();
    [picker.step, picker.totalSteps] = shown.step ?? [undefined, undefined];
    const again: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Check Again' };
    const details: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('output'), tooltip: 'Show Details' };
    picker.title = title;
    // Notifications and terminals opened by earlier actions must not dismiss the choice.
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = true;
    picker.buttons = [...(back ? [vscode.QuickInputButtons.Back] : []), again, details];
    let hidden = false;
    let result: T | 'back' | undefined;
    const closed = new Promise<void>(resolve => {
      picker.onDidAccept(() => {
        result = picker.selectedItems[0];
        if (result) resolve();
      });
      picker.onDidHide(() => { hidden = true; resolve(); });
    });
    function checking(): void {
      picker.placeholder = shown.busy ?? 'Checking installed CLIs...';
      picker.busy = true;
      picker.enabled = false;
    }
    async function fill(trigger: string): Promise<void> {
      checking();
      const loaded = await load(trigger);
      if (hidden) return;
      picker.items = loaded.items;
      if (loaded.title) picker.title = loaded.title;
      picker.placeholder = loaded.placeholder;
      picker.busy = false;
      picker.enabled = true;
    }
    const failed = (error: unknown) => { picker.hide(); void vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Check failed.')}`); };
    picker.onDidTriggerButton(button => {
      if (button === vscode.QuickInputButtons.Back) { result = 'back'; picker.hide(); }
      else if (button === details) showDetails(shown.details?.());
      else void fill(`${title} (Check Again)`).catch(failed);
    });
    // The picker appears busy before the checks start.
    checking();
    picker.show();
    try {
      await fill(title);
      await closed;
      return result;
    } finally {
      picker.dispose();
    }
  }
  /** Reports a CLI that did not appear in time; the user's installation itself may still finish. */
  async function waited(client: SetupClient, found: boolean): Promise<boolean> {
    if (!found) {
      await vscode.window.showWarningMessage(client === 'agy'
        ? `${LABELS[client]} is not available yet. Open the Antigravity view once so the extension starts its backend and downloads the CLI, then run CoAgent8: Manage Coding CLIs again.`
        : `${LABELS[client]} is not available yet. If the extension is not visible, reload the window, then run CoAgent8: Manage Coding CLIs again.`);
    }
    return found;
  }
  /** Installs the vendor extension for a CLI and waits until its copy is found. */
  async function installVendorExtension(client: SetupClient): Promise<boolean> {
    const vendor = VENDOR_EXTENSIONS[client];
    const preinstalled = vscode.extensions.getExtension(vendor.id) !== undefined;
    // Machine-scoped: the CLI and its sign-in belong to this machine, and VS Code then installs
    // without asking whether Settings Sync should copy it to other devices (owner decision 2026-10-11).
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vendor.id, { donotSync: true });
    // The command returns once the extension is installed (a cancellation throws); the
    // extension API can report it later, so it is not consulted here. Only an extension
    // this action added may later be offered for removal.
    if (!preinstalled) {
      installedHere.add(vendor.id);
      await updateInstallList(location(), 'installedExtensions', [vendor.id]);
    }
    return waited(client, await waitForCli(`Waiting for ${LABELS[client]} from the ${vendor.name} extension...`, () => inventory(client).some(item => item.kind === 'vscode-extension')));
  }
  /**
   * Selects an installation that was just added when the CLI uses another one, after asking.
   * One that this window cannot otherwise start, such as a standalone CLI outside the PATH
   * this window inherited, is selected without asking.
   */
  async function offerUse(client: SetupClient, added: ClientInstallation): Promise<void> {
    const opts = options();
    clearCliResolverCache();
    const cli = resolveSetupClient(client, opts.home, opts.env, opts.nodePath);
    const current = cli ? clientSource(client, cli, opts.home, opts.env) : undefined;
    if (current && current.kind === added.kind && current.executable === added.executable) return;
    if (current) {
      const choice = await vscode.window.showInformationMessage(`${LABELS[client]} still uses ${describeSource(client, current, opts.home)}. Use ${describeSource(client, added, opts.home)} instead?`, 'Use It', 'Keep Current');
      if (choice !== 'Use It') return;
    }
    // The runtime, VS Code chat and the CLI chats read this file on their next turn.
    await setBackendExecutable(SETUP_PROVIDERS[client], added.executable, configurationFile());
    clearCliResolverCache();
  }
  function register(name: string, action: () => Promise<void>): void {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      if (vscode.env.remoteName) { await vscode.window.showWarningMessage('CoAgent8 setup supports the local default profile. Run coagent8 status/setup/cleanup on the intended machine.'); return; }
      try { await action(); }
      catch (error) { await vscode.window.showErrorMessage(`CoAgent8 setup: ${redactDiagnostic(error instanceof Error ? error.message : 'Action failed or was cancelled; retry.')}`); }
    }));
  }
  register('coagent8.openSettings', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`); });
  register('coagent8.manageMcpServers', async () => {
    if (profileRegistration === 'declined') {
      const choice = await vscode.window.showInformationMessage('CoAgent8 was removed from your MCP servers. Add it again?', 'Add CoAgent8');
      if (choice === 'Add CoAgent8') { await syncProfile(true); changed.fire(); }
    }
    await vscode.commands.executeCommand('workbench.mcp.listServer');
  });
  /**
   * Opens a picker whose items are known, with an optional Back button in its title bar.
   * @param many - Lets several items be selected; items marked `picked` start selected, which
   * `createQuickPick` honors only through `selectedItems`.
   * @param step - The step of a multi-step flow and its total, shown in the title.
   * @returns The accepted items, `back`, or undefined when the picker was dismissed.
   */
  async function choose<T extends vscode.QuickPickItem>(options: { title: string; placeholder: string; items: T[]; back?: boolean; many?: boolean; step?: [number, number] }): Promise<readonly T[] | 'back' | undefined> {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    [picker.step, picker.totalSteps] = options.step ?? [undefined, undefined];
    picker.placeholder = options.placeholder;
    picker.ignoreFocusOut = true;
    picker.canSelectMany = options.many ?? false;
    picker.items = options.items;
    if (options.many) picker.selectedItems = options.items.filter(item => item.picked);
    if (options.back) picker.buttons = [vscode.QuickInputButtons.Back];
    try {
      return await new Promise<readonly T[] | 'back' | undefined>(resolve => {
        picker.onDidAccept(() => {
          if (options.many || picker.selectedItems.length) resolve(picker.selectedItems);
        });
        picker.onDidTriggerButton(button => { if (button === vscode.QuickInputButtons.Back) resolve('back'); });
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
    } finally {
      picker.dispose();
    }
  }
  /** A client's packages in one line, such as `5 enabled · 1 disabled · 1 update available`. */
  function skillSummary(skills: ManagedSkill[]): string {
    const count = (state: ManagedSkill['state']) => skills.filter(item => item.state === state).length;
    const updates = skills.filter(item => item.updateAvailable).length;
    return [
      `${count('enabled')} enabled`,
      count('disabled') ? `${count('disabled')} disabled` : '',
      count('absent') ? `${count('absent')} not installed` : '',
      updates ? `${updates} update${updates > 1 ? 's' : ''} available` : '',
      count('conflict') ? `${count('conflict')} changed outside CoAgent8` : '',
    ].filter(Boolean).join(' · ');
  }
  /** The packages each action can change; an action without any is not offered. */
  const SKILL_ACTIONS = [
    { label: '$(cloud-download) Install / Update', action: 'install' as const, count: 'to install or update', applies: (item: ManagedSkill) => item.state === 'absent' || item.state === 'conflict' || item.updateAvailable },
    { label: '$(eye) Enable', action: 'enable' as const, count: 'disabled', applies: (item: ManagedSkill) => item.state === 'disabled' },
    { label: '$(eye-closed) Disable', action: 'disable' as const, count: 'enabled', applies: (item: ManagedSkill) => item.state === 'enabled' },
    { label: '$(trash) Uninstall', action: 'uninstall' as const, count: 'installed', applies: (item: ManagedSkill) => item.state !== 'absent' },
  ];
  /** A package's state as a short description. */
  function skillState(item: ManagedSkill): string {
    const state = item.state === 'absent' ? 'not installed' : item.state === 'conflict' ? 'changed outside CoAgent8' : item.state;
    return `${state}${item.updateAvailable ? ' · update available' : ''}`;
  }
  /**
   * Chooses an action, then packages, for one client's skills; Back returns one step.
   * @param chosenClient - The client was chosen in a step of this flow, which counts as its first.
   * @returns `back` when the user went back from the first step.
   */
  async function manageSkillsOf(client: SetupClient, chosenClient = false): Promise<'back' | void> {
    const first = chosenClient ? 2 : 1, total = first + 1;
    const skillOptions = { client, home: os.homedir(), env: discoveryEnvironment(storage), skillsSource: context.asAbsolutePath('skills'), origin: EXTENSION_ORIGIN };
    for (;;) {
      const current = await manageSkills(skillOptions);
      const actions = SKILL_ACTIONS.filter(entry => current.skills.some(entry.applies));
      const chosen = await choose({ title: `${LABELS[client]} Skills`, placeholder: skillSummary(current.skills), back: true, step: [first, total],
        items: actions.map(entry => ({ label: entry.label, action: entry.action, description: `${current.skills.filter(entry.applies).length} ${entry.count}` })) });
      if (chosen === 'back') return 'back';
      if (!chosen) return;
      const action = SKILL_ACTIONS.find(entry => entry.action === chosen[0].action)!;
      const candidates = current.skills.filter(action.applies);
      const packages = await choose({ title: `${action.label.replace(/^\$\([^)]+\) /, '')}: ${LABELS[client]} Skills`, many: true, back: true, step: [total, total],
        placeholder: `Packages in ${redactDiagnostic(action.action === 'enable' ? current.disabledRoot : current.root)}; other tools reading it see the change`,
        items: candidates.map(item => ({ label: item.name, name: item.name, description: skillState(item), picked: true })) });
      if (packages === 'back') continue;
      if (!packages?.length) return;
      const selection = skillSelectionForAction(current.selection, packages.map(item => item.name), action.action);
      const preview = await manageSkills({ ...skillOptions, selection });
      const result = await manageSkills({ ...skillOptions, selection, apply: preview.token });
      report(result);
      const conflicts = result.skills.filter(item => item.state === 'conflict').length;
      const message = `${LABELS[client]} skill selection applied.${conflicts ? ` ${conflicts} conflicting packages were preserved; see details.` : ''} Start a new chat to refresh its skills. Native client visibility settings and other discovered copies still apply.`;
      const notice = conflicts ? vscode.window.showWarningMessage(message, 'Show Details') : vscode.window.showInformationMessage(message, 'Show Details');
      void notice.then(choice => { if (choice === 'Show Details') showDetails(result); });
      return;
    }
  }
  register('coagent8.manageSkills', async () => {
    for (;;) {
      const items = await Promise.all(SETUP_CLIENTS.map(async client => {
        const { skills } = await manageSkills({ client, home: os.homedir(), env: discoveryEnvironment(storage), skillsSource: context.asAbsolutePath('skills'), origin: EXTENSION_ORIGIN });
        return { label: `${skills.some(item => item.state === 'enabled') ? '$(pass-filled)' : '$(circle-large-outline)'} ${LABELS[client]}`, client, description: skillSummary(skills) };
      }));
      const chosen = await choose({ title: 'Manage Skills', placeholder: 'Choose a CLI', items, step: [1, 3] });
      if (!chosen || chosen === 'back') return;
      if (await manageSkillsOf(chosen[0].client, true) !== 'back') return;
    }
  });
  /**
   * Reads the model view through the bundled runtime (`coagent8 models --json`), so it uses
   * the server's own caches and configuration file.
   */
  async function readModelReport(): Promise<ModelReport> {
    const opts = options();
    const result = await runCommand(opts.nodePath, [opts.runtimeSource, 'models', '--json'], { cwd: opts.cwd, env: opts.env, timeoutMs: MODEL_REPORT_TIMEOUT_MS });
    if (result.status !== 'completed' || result.exitCode !== 0) {
      throw new Error(`Reading the models failed: ${result.error?.message || result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    return JSON.parse(result.stdout) as ModelReport;
  }
  const backendLabel = (id: ProviderId) => LABELS[SETUP_CLIENTS.find(client => SETUP_PROVIDERS[client] === id)!];
  /** A model's output price as the menu shows it: `~` approximate, or unknown. */
  function priceText(row: ModelCandidate): string {
    const { outputUsdPerMTok: output, match } = row.price;
    return output === null ? 'price unknown' : `${match === 'approximate' ? '~' : ''}${Number(output.toFixed(4))} USD`;
  }
  /** The user's rule for a model, if one of the lists names it. */
  function ruleOf(row: ModelCandidate): ApprovalRule | null {
    return row.approval.denied ? 'deny' : row.approval.basis === 'ask' || row.approval.basis === 'allow' ? row.approval.basis : null;
  }
  /** A model's icon and what decides it: the user's rule, or the price rules. */
  function approvalOf(row: ModelCandidate): { icon: string; text: string } {
    const rule = ruleOf(row);
    if (rule) return { icon: RULE_ITEMS.find(item => item.rule === rule)!.label.split(' ')[0]!, text: RULE_TEXT[rule] };
    return row.approval.required
      ? { icon: '$(question)', text: `asks: ${PRICE_REASONS[row.approval.basis] ?? row.approval.basis}` }
      : { icon: '$(circle-large-outline)', text: 'runs without asking' };
  }
  /** One backend's models in one line, such as `8 models · 2 ask · 1 deny`. */
  function modelSummary(rows: ModelCandidate[]): string {
    const asks = rows.filter(row => row.approval.required).length, denied = rows.filter(row => row.approval.denied).length;
    const allowed = rows.filter(row => ruleOf(row) === 'allow').length;
    return [`${rows.length} model${rows.length === 1 ? '' : 's'}`, asks ? `${asks} ask` : '', denied ? `${denied} deny` : '', allowed ? `${allowed} allow` : ''].filter(Boolean).join(' · ');
  }
  /** The value a price rule's input means: a number, null for an empty `askAbovePrice`, else undefined (invalid). */
  function parsePriceRule(field: PriceRule, text: string): number | null | undefined {
    const trimmed = text.trim();
    if (field === 'askAbovePrice' && trimmed === '') return null;
    const value = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(value)) return undefined;
    return field === 'askAbovePrice' ? (value >= 0 ? value : undefined) : (value > 1 ? value : undefined);
  }
  async function editPriceRule(field: PriceRule): Promise<void> {
    const current = readGovernance(configurationFile())[field];
    const text = await vscode.window.showInputBox({
      title: PRICE_RULES[field].title,
      prompt: PRICE_RULES[field].prompt,
      value: current === null ? '' : String(current),
      ignoreFocusOut: true,
      validateInput: input => parsePriceRule(field, input) === undefined ? PRICE_RULES[field].invalid : null,
    });
    if (text === undefined) return;
    const value = parsePriceRule(field, text);
    if (value === undefined) return;
    await setPriceRules(field === 'askAbovePrice' ? { askAbovePrice: value } : { priceMultiplier: value! }, configurationFile());
  }
  /**
   * Lists one backend's models, most expensive first, and sets the rule of the chosen one;
   * the list is read again after each change.
   * @returns `back` when the user went back to the first step.
   */
  async function manageModelsOf(id: ProviderId): Promise<'back' | void> {
    let report: ModelReport | undefined;
    for (;;) {
      const chosen = await pick<vscode.QuickPickItem & { row?: ModelCandidate }>(`${backendLabel(id)} Models`, async () => {
        report = await readModelReport();
        const rows = report.selection.filter(row => row.backend === id)
          .sort((a, b) => (b.price.outputUsdPerMTok ?? Infinity) - (a.price.outputUsdPerMTok ?? Infinity));
        return { placeholder: 'Choose a model to set its rule', items: rows.map(row => {
          const { icon, text } = approvalOf(row);
          return { label: `${icon} ${row.model}`, description: [priceText(row), row.defaultSource ? 'default' : '', text].filter(Boolean).join(' · '), row };
        }) };
      }, true, { busy: 'Reading models and prices...', details: () => report, step: [2, 3] });
      if (chosen === 'back') return 'back';
      if (!chosen?.row) return;
      const { row } = chosen, current = ruleOf(row);
      const rule = await choose({ title: row.model, step: [3, 3], back: true,
        placeholder: `${priceText(row)} per million output tokens · applies to every client that runs CoAgent8`,
        items: RULE_ITEMS.map(item => ({ ...item, description: item.rule === current ? `current · ${item.description}` : item.description })) });
      if (rule === 'back') continue;
      if (!rule?.length) return;
      if (rule[0].rule === current) continue;
      // The entry that decides the model, such as the variant a default runs as, is the one changed.
      const target = row.approval.ruleEntry ?? row.model;
      await setModelRule(target, rule[0].rule, configurationFile());
      vscode.window.setStatusBarMessage(`CoAgent8: ${target} · ${rule[0].rule ? RULE_TEXT[rule[0].rule] : 'price rules'}`, 5000);
    }
  }
  register('coagent8.manageModelApprovals', async () => {
    let report: ModelReport | undefined;
    for (;;) {
      const chosen = await pick<vscode.QuickPickItem & { backend?: ProviderId; price?: PriceRule }>('Manage Model Approvals', async () => {
        report = await readModelReport();
        const governance = readGovernance(configurationFile());
        const backends = (Object.keys(report.backends) as ProviderId[]).filter(id => report!.selection.some(row => row.backend === id));
        return { placeholder: 'Rules apply to every client that runs CoAgent8', items: [
          separator('Price rules'),
          { label: '$(symbol-number) Ask Above Price', price: 'askAbovePrice' as const,
            description: governance.askAbovePrice === null ? 'off' : `${governance.askAbovePrice} USD per million output tokens` },
          { label: '$(symbol-number) Ask Above Default Price', price: 'priceMultiplier' as const, description: `${governance.priceMultiplier}× the backend's default model` },
          separator('Models'),
          ...backends.map(id => ({ label: `$(server) ${backendLabel(id)}`, backend: id, description: modelSummary(report!.selection.filter(row => row.backend === id)) })),
        ] };
      }, false, { busy: 'Reading models and prices...', details: () => report, step: [1, 3] });
      if (!chosen || chosen === 'back') return;
      if (chosen.price) { await editPriceRule(chosen.price); continue; }
      if (chosen.backend && await manageModelsOf(chosen.backend) !== 'back') return;
    }
  });
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

  /** A line of the list of CLIs: one CLI, or an action for several CLI chats at once. */
  type ListItem = vscode.QuickPickItem & { client?: SetupClient; clients?: SetupClient[] };
  type MenuAction = 'use' | 'discovery' | 'installExtension' | 'installStandalone' | 'chooseExecutable' | 'signIn' | 'connect' | 'disconnect' | 'skills' | 'uninstallExtension' | 'uninstallStandalone';
  /** A line of one CLI's menu. */
  type MenuItem = vscode.QuickPickItem & { action?: MenuAction; installation?: ClientInstallation };
  const separator = <T extends vscode.QuickPickItem>(label: string): T => ({ label, kind: vscode.QuickPickItemKind.Separator }) as T;
  /** A CLI's state at a glance: ready, needs something, not installed or blocked. */
  function stateIcon(result: SetupStatus): string {
    if (result.ready) return '$(pass-filled)';
    if (result.installed) return '$(warning)';
    return result.action === 'blocked' ? '$(error)' : '$(circle-slash)';
  }
  function listItems(results: SetupStatus[], registrations: RegistrationStatus[]): { items: ListItem[]; placeholder: string } {
    const registrationOf = (client: SetupClient) => registrations.find(item => item.client === client)!;
    const items: ListItem[] = results.map(result => {
      const registration = registrationOf(result.client), used = clientView(result, registration).inUse;
      return { label: `${stateIcon(result)} ${LABELS[result.client]}`, client: result.client, description: describe(result, registration),
        detail: used ? describeSource(result.client, used, options().home) : undefined };
    });
    // Registration needs a compatible CLI, not a sign-in; manual entries stay as they are.
    const addable = results.filter(result => result.installed && result.compatibility === 'supported' && registrationOf(result.client).state === 'absent').map(result => result.client);
    const outdated = registrations.filter(item => item.state === 'owned' && !item.current).map(item => item.client);
    const bulk: ListItem[] = [
      ...(addable.length ? [{ label: '$(plug) Add CoAgent8 to All CLI Chats', description: labels(addable), clients: addable }] : []),
      ...(outdated.length ? [{ label: '$(sync) Update CoAgent8 in All CLI Chats', description: labels(outdated), clients: outdated }] : []),
    ];
    return { items: bulk.length ? [...items, separator<ListItem>('All CLIs'), ...bulk] : items, placeholder: 'Choose a CLI' };
  }
  /**
   * One CLI's menu in sections: its installations, installation methods, its chat, its skills
   * and removals. Each line is an action with an icon and a short description.
   */
  function menuItems(view: ClientView): MenuItem[] {
    const { status: result, registration, installations, inUse, configured } = view;
    const client = result.client, vendor = VENDOR_EXTENSIONS[client], home = options().home;
    const record = readInstallRecord(location());
    const extensionInstalled = vscode.extensions.getExtension(vendor.id) !== undefined;
    const compatible = result.installed && result.compatibility === 'supported';
    const section = (label: string, lines: MenuItem[]): MenuItem[] => lines.length ? [separator(label), ...lines] : [];
    const installed: MenuItem[] = installations.map(item => item === inUse
      ? { label: `$(pass-filled) ${sourceName(client, item)}`, description: [sourcePath(client, item, home), configured?.found ? 'in use, selected' : 'in use'].filter(Boolean).join(' · ') }
      : { label: `$(circle-large-outline) ${sourceName(client, item)}`, description: sourcePath(client, item, home), action: 'use', installation: item });
    if (configured && !configured.found) {
      installed.push({ label: '$(warning) Selected CLI not found', description: configured.value === VSCODE_EXTENSION_EXECUTABLE ? `${vendor.name} VS Code extension` : shownPath(configured.value, home) });
    }
    // Clearing the selection matters when its file is gone or another installation exists.
    if (configured && (!configured.found || installations.length > 1)) installed.push({ label: '$(discard) Use Automatic Discovery', description: 'clear the selection', action: 'discovery' });
    const install: MenuItem[] = [];
    if (!extensionInstalled) install.push({ label: '$(extensions) Install VS Code Extension', description: 'recommended', action: 'installExtension' });
    // The Google extension and agy's installer place the same binary in ~/.gemini/bin.
    if (client === 'agy' ? !installations.length && !extensionInstalled : !installations.some(item => item.kind !== 'vscode-extension')) {
      install.push({ label: '$(terminal) Install Standalone CLI', description: 'official installer', action: 'installStandalone' });
    }
    install.push({ label: '$(folder-opened) Choose Executable', description: 'from any folder', action: 'chooseExecutable' });
    const chat: MenuItem[] = [];
    if (compatible && result.authentication !== 'authenticated') chat.push({ label: '$(sign-in) Sign In', description: `sign-in ${result.authentication}`, action: 'signIn' });
    if (compatible && registration.state === 'absent') chat.push({ label: '$(plug) Add CoAgent8 to Its Chat', action: 'connect' });
    if (registration.state === 'owned' && !registration.current) chat.push({ label: '$(sync) Update CoAgent8 in Its Chat', description: 'another CoAgent8 version', action: 'connect' });
    const removals: MenuItem[] = [];
    if (registration.state === 'owned') removals.push({ label: '$(debug-disconnect) Remove CoAgent8 from Its Chat', description: 'the CLI stays', action: 'disconnect' });
    if (record.installedExtensions?.includes(vendor.id) && extensionInstalled) removals.push({ label: '$(trash) Uninstall VS Code Extension', description: 'in the Extensions view', action: 'uninstallExtension' });
    if (record.installedClis?.includes(client) && standaloneFound(client, installations)) removals.push({ label: '$(trash) Uninstall Standalone CLI', description: 'installed by CoAgent8', action: 'uninstallStandalone' });
    return [
      ...section('Installations', installed),
      ...section('Install', install),
      ...section('Chat', chat),
      ...section('Skills', [{ label: '$(book) Manage Skills', action: 'skills' }]),
      ...section('Remove', removals),
    ];
  }
  /** Why there is no installation yet, when the menu can say it; otherwise the usual prompt. */
  function menuPlaceholder(view: ClientView): string {
    if (!view.installations.length && view.status.client === 'agy' && vscode.extensions.getExtension(VENDOR_EXTENSIONS.agy.id)) return 'The Google Antigravity extension downloads this CLI when its view first opens';
    return 'Choose an action';
  }
  /**
   * Runs one action of a CLI's menu.
   * @returns `close` when the menu must not reopen, as after an extension removal that needs a reload.
   */
  async function perform(item: MenuItem, view: ClientView): Promise<'close' | void> {
    const client = view.status.client, id = SETUP_PROVIDERS[client], vendor = VENDOR_EXTENSIONS[client], opts = options();
    switch (item.action) {
      case 'use':
        // The runtime, VS Code chat and the CLI chats read this file on their next turn.
        await setBackendExecutable(id, item.installation!.executable, configurationFile());
        clearCliResolverCache();
        report({ client, executable: item.installation!.executable });
        return;
      case 'discovery':
        await setBackendExecutable(id, undefined, configurationFile());
        clearCliResolverCache();
        report({ client, executable: null });
        return;
      case 'installExtension': {
        if (!await installVendorExtension(client)) return;
        // Choosing the extension satisfies an unavailable preference for its copy.
        const added = inventory(client).find(entry => entry.kind === 'vscode-extension');
        if (added && view.inUse && client !== 'agy') await offerUse(client, added);
        return;
      }
      case 'installStandalone': {
        // Choosing a standalone installation replaces an unavailable extension preference.
        if (view.configured?.value === VSCODE_EXTENSION_EXECUTABLE && !view.configured.found) {
          await setBackendExecutable(id, undefined, configurationFile());
          clearCliResolverCache();
        }
        // The CLI is absent here, so a later check that finds it identifies this installation.
        await updateInstallList(location(), 'pendingClis', [client]);
        offerTerminal(installCommand(client), `Install ${LABELS[client]}`, context);
        const next = await vscode.window.showInformationMessage(`Press Enter in the terminal to install ${LABELS[client]}. When it finishes, check it here.`, 'Check Now', 'Reload Window');
        if (next === 'Reload Window') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return 'close'; }
        if (next !== 'Check Now') return;
        clearCliResolverCache();
        const known = new Set(view.installations.map(entry => entry.executable));
        const added = inventory(client).find(entry => standaloneOnly(client, entry) && !known.has(entry.executable));
        if (!added) {
          // An installer updates PATH for new processes only; this extension host keeps its old PATH.
          const reload = await vscode.window.showWarningMessage(`${LABELS[client]} was not found. Reload the window after the installer finishes, then run CoAgent8: Manage Coding CLIs again.`, 'Reload Window');
          if (reload === 'Reload Window') { await vscode.commands.executeCommand('workbench.action.reloadWindow'); return 'close'; }
          return;
        }
        await updateInstallList(location(), 'installedClis', [client]);
        await updateInstallList(location(), 'pendingClis', [], [client]);
        await offerUse(client, added);
        return;
      }
      case 'chooseExecutable': {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: `Choose the ${LABELS[client]} executable`, openLabel: 'Check and Use' });
        if (!picked?.length) return;
        const file = picked[0].fsPath;
        const checked = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${path.basename(file)}...` },
          () => checkExecutable(client, file, opts.home, opts.env, opts.nodePath, opts.cwd));
        await setBackendExecutable(id, checked.source.executable, configurationFile());
        clearCliResolverCache();
        report({ client, executable: checked.source.executable, readiness: checked.readiness });
        void vscode.window.showInformationMessage(`${LABELS[client]} now uses ${describeSource(client, checked.source, opts.home)}${checked.readiness.version ? ` ${checked.readiness.version}` : ''}.`);
        return;
      }
      case 'signIn': {
        const cli = resolveSetupClient(client, opts.home, opts.env, opts.nodePath);
        if (!cli) throw new Error('CLI disappeared; check again.');
        const args = client === 'codex' ? ['login'] : client === 'claude' ? ['auth', 'login'] : [];
        offerTerminal(`${process.platform === 'win32' ? '& ' : ''}${[cli.command, ...cli.argsPrefix, ...args].map(quote).join(' ')}`, `Sign in to ${LABELS[client]}`, context);
        await vscode.window.showInformationMessage(`Press Enter in the terminal to sign in to ${LABELS[client]}. When it finishes, check it here.`, 'Check Now');
        return;
      }
      case 'connect':
        await connect([client]);
        return;
      case 'disconnect': {
        const removed = await disconnect([client]);
        void announce([], removed, { removed }).catch(showLifecycleError);
        return;
      }
      case 'skills':
        await manageSkillsOf(client);
        return;
      case 'uninstallExtension': {
        // VS Code's own Uninstall and Restart Extensions apply the removal to every running
        // extension, the chat included; no command offers that restart. The user removes the
        // extension there, and CoAgent8 finishes its part once the extension is gone.
        await updateSetupState(storage, { removingExtensions: [...new Set([...readSetupState(storage).removingExtensions ?? [], vendor.id])] });
        await vscode.commands.executeCommand('workbench.extensions.search', vendor.id);
        return 'close';
      }
      case 'uninstallStandalone': {
        const choice = await vscode.window.showWarningMessage(`Remove ${LABELS[client]}?`, { modal: true, detail: [
          `The removal commands are inserted in a terminal; press Enter there to run them. They remove ${removalSummary(client)}.`,
          'If CoAgent8 uses this installation, it then uses another one or none. Sign-ins and histories stay.',
        ].join(' ') }, 'Remove');
        if (choice !== 'Remove') return;
        const keepAgyDownload = vscode.extensions.getExtension(VENDOR_EXTENSIONS.agy.id) !== undefined;
        const name = `Remove ${LABELS[client]}`;
        offerTerminal([removeCommand(client, keepAgyDownload), folderCleanupCommand([client])].filter(Boolean).join(process.platform === 'win32' ? '; ' : ' && '), name, context);
        const check = await vscode.window.showInformationMessage(`Press Enter in the "${name}" terminal. When it finishes, check it here.`, 'Check Now');
        if (check !== 'Check Now') return;
        clearCliResolverCache();
        // Another standalone installation, such as a package manager's, may stay; one of them must be gone.
        const remaining = inventory(client);
        const gone = view.installations.filter(entry => standaloneOnly(client, entry) && !remaining.some(other => other.kind === entry.kind && other.executable === entry.executable));
        if (!gone.length) {
          void vscode.window.showWarningMessage(`${LABELS[client]} is still installed. Run the commands in the "${name}" terminal, then check again.`);
          return;
        }
        await updateInstallList(location(), 'installedClis', [], [client]);
        // A configured path to the removed files must not stay selected.
        if (configuredExecutable(client, opts.home, opts.env, opts.nodePath)?.found === false) {
          await setBackendExecutable(id, remaining[0]?.executable, configurationFile());
          clearCliResolverCache();
        }
        return;
      }
    }
  }
  /**
   * One CLI's menu; it reopens after each action with fresh checks.
   * @param first - The checks the list of CLIs just ran, reused for the first fill.
   * @returns True when the user went back to the list of CLIs.
   */
  async function manageClient(client: SetupClient, first?: { results: SetupStatus[]; registrations: RegistrationStatus[] }): Promise<boolean> {
    let view: ClientView | undefined;
    for (;;) {
      const chosen = await pick<MenuItem>(LABELS[client], async trigger => {
        const [result] = first ? first.results.filter(item => item.client === client) : await status(trigger, [client]);
        const registration = (first?.registrations ?? readRegistrations(options())).find(item => item.client === client)!;
        first = undefined;
        view = clientView(result, registration);
        return { title: `${LABELS[client]}: ${describe(result, registration)}`, items: menuItems(view), placeholder: menuPlaceholder(view) };
      }, true);
      if (chosen === 'back') return true;
      if (!chosen) return false;
      if (!chosen.action) continue;
      try {
        if (await perform(chosen, view!) === 'close') return false;
      } catch (error) {
        void vscode.window.showErrorMessage(`${LABELS[client]}: ${redactDiagnostic(error instanceof Error ? error.message : 'Action failed or was cancelled; retry.')}`);
      }
    }
  }
  register('coagent8.manageClis', async () => {
    for (;;) {
      let checked: { results: SetupStatus[]; registrations: RegistrationStatus[] } | undefined;
      const chosen = await pick<ListItem>('Manage Coding CLIs', async trigger => {
        const results = await status(trigger);
        const registrations = readRegistrations(options());
        checked = { results, registrations };
        return listItems(results, registrations);
      });
      if (!chosen || chosen === 'back') return;
      if (chosen.clients) { await connect(chosen.clients); return; }
      if (!await manageClient(chosen.client!, checked)) return;
    }
  });
  /** Checks the CLIs once per installation; later activations start no process. */
  async function showWelcome(): Promise<void> {
    if (vscode.env.remoteName || readSetupState(storage).welcomed) return;
    const results = await status('Welcome CLI Check');
    // Recorded before the notice, so a reload while it is open does not check again.
    await updateSetupState(storage, { welcomed: true });
    const ready = results.filter(result => result.ready);
    if (ready.length) {
      // The other CLIs and the CLI chats are offered from the start, in the one menu.
      const missing = results.filter(needsAction).map(result => result.client);
      const unregistered = ready.filter(result => !result.registered).map(result => result.client);
      const offer = [missing.length ? `installs or signs in ${labels(missing)}` : '', unregistered.length ? `adds CoAgent8 to the chats of ${labels(unregistered)}` : ''].filter(Boolean).join(' and ');
      const next = await vscode.window.showInformationMessage(`CoAgent8 is ready with ${labels(ready.map(result => result.client))}. Use its tools from VS Code chat; VS Code starts the server on first use.${offer ? ` Manage CLIs ${offer}.` : ''}`,
        ...(offer ? ['Manage CLIs'] : []), 'Show MCP Servers');
      if (next === 'Manage CLIs') await vscode.commands.executeCommand('coagent8.manageClis');
      else if (next === 'Show MCP Servers') await vscode.commands.executeCommand('coagent8.manageMcpServers');
      return;
    }
    const choice = await vscode.window.showInformationMessage('CoAgent8 needs one compatible, signed-in coding CLI: Codex CLI, Claude Code CLI or Antigravity CLI.', 'Manage CLIs');
    if (choice === 'Manage CLIs') await vscode.commands.executeCommand('coagent8.manageClis');
  }
  void showWelcome().catch(error => { void vscode.window.showErrorMessage(`CoAgent8 onboarding: ${redactDiagnostic(error instanceof Error ? error.message : 'Onboarding failed.')}`); });
  /**
   * Finishes the removals started from a CLI menu once VS Code has removed the extension (after
   * Restart Extensions, or at the next start): the record of what CoAgent8 installed, a selection
   * of the removed copy and, for Google Antigravity, the agy it downloaded and leaves behind.
   * @param started - At activation an extension that is still installed was kept, so its removal
   * is forgotten.
   */
  async function finishRemovals(started: boolean): Promise<void> {
    if (vscode.env.remoteName) return;
    const pending = readSetupState(storage).removingExtensions ?? [];
    const gone = pending.filter(id => !vscode.extensions.getExtension(id));
    const kept = started ? pending.filter(id => !gone.includes(id)) : [];
    if (!gone.length && !kept.length) return;
    for (const id of gone) {
      const client = SETUP_CLIENTS.find(item => VENDOR_EXTENSIONS[item].id === id);
      if (client === 'agy') fs.rmSync(path.join(os.homedir(), ANTIGRAVITY_DOWNLOAD.slice(2)), { force: true });
      installedHere.delete(id);
      await updateInstallList(location(), 'installedExtensions', [], [id]);
      if (!client) continue;
      // A selection of the removed copy moves to the remaining installation or is cleared.
      const opts = options();
      if (configuredExecutable(client, opts.home, opts.env, opts.nodePath)?.found === false) {
        await setBackendExecutable(SETUP_PROVIDERS[client], inventory(client)[0]?.executable, configurationFile());
        clearCliResolverCache();
      }
    }
    const rest = pending.filter(id => !gone.includes(id) && !kept.includes(id));
    await updateSetupState(storage, { removingExtensions: rest.length ? rest : undefined });
  }
  const removalFailed = (error: unknown) => { void vscode.window.showErrorMessage(`CoAgent8: ${redactDiagnostic(error instanceof Error ? error.message : 'Finishing an extension removal failed.')}`); };
  context.subscriptions.push(vscode.extensions.onDidChange(() => { void finishRemovals(false).catch(removalFailed); }));
  void finishRemovals(true).catch(removalFailed);
  /**
   * Offers to update the CLI chats once per bundled runtime when one still starts another
   * runtime, as after an extension update. Reads the CLI configuration files only and starts no process.
   */
  async function offerRegistrationUpdate(): Promise<void> {
    if (vscode.env.remoteName || !readSetupState(storage).welcomed) return;
    const runtime = `${version}#${createHash('sha256').update(fs.readFileSync(context.asAbsolutePath('dist/index.cjs'))).digest('hex')}`;
    if (readSetupState(storage).updateOffered === runtime) return;
    const outdated = readRegistrations(options()).filter(item => item.state === 'owned' && !item.current).map(item => item.client);
    if (!outdated.length) return;
    await updateSetupState(storage, { updateOffered: runtime });
    const next = await vscode.window.showWarningMessage(`CoAgent8 was updated, but the chats of ${labels(outdated)} still start the previous version. Update them now, then restart those chats.`, 'Update CLI Chats');
    if (next === 'Update CLI Chats') await connect(outdated);
  }
  void offerRegistrationUpdate().catch(error => { void vscode.window.showErrorMessage(`CoAgent8 update check: ${redactDiagnostic(error instanceof Error ? error.message : 'Update check failed.')}`); });
  return activated;
}
