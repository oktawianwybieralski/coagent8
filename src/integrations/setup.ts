/**
 * Shared local-default-profile setup used by the CLI and VS Code onboarding.
 * @remarks
 * Existing manual entries are preserved. Managed updates require a successful
 * native-host check before and after replacement; SDK probes alone cannot approve
 * a migration. No backend download, login, or background synchronization occurs.
 * @packageDocumentation
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { modify, applyEdits } from 'jsonc-parser';
import { readBoundedFileSync } from '../storage/read.js';
import { runCommand } from '../execution/process.js';
import { CliResolutionError, resolveBundledClaude, resolveBundledCodex, resolveCliCommand, resolveManagedAgy, type CliCommand } from '../execution/cli-resolver.js';
import { backendCommand, environmentOverride, VSCODE_EXTENSION_EXECUTABLE } from '../backends/executable.js';
import { readBackendExecutable, recordBackendExecutable, readBackendSkills } from '../config.js';
import type { ProviderId } from '../contracts/index.js';
import { redactDiagnostic } from '../security/redaction.js';
import { withFileLock } from '../storage/lock.js';
import { object, withStdioRpc } from './rpc.js';
import { errorCodeOf } from '../contracts/index.js';

import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
export { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
import { read, hash, document, servers, registration, configPath, writeChecked, readSelection, serializeSelection, backupDirectory, entryOwnership, extractRuntimePath, CODEX_TOOL_TIMEOUT_SEC, setupConfigFile, type Registration, type RegistrationOrigin } from './setup-storage.js';
export { extractRuntimePath } from './setup-storage.js';
import { inspectCli, type CliReadiness } from './cli-readiness.js';
import { assertSkillRoot, describeSkills, readSkillCatalog, type SkillPackage, type SkillStatus } from './skills.js';
import { reconcileSkills, selectedSkills } from './skill-management.js';
import { recoverSkillTransaction } from './skill-transaction.js';
/** Separates registry, direct-runtime, and native-host evidence. No credentials are returned. */
export interface SetupStatus extends CliReadiness {
  client: SetupClient;
  installed: boolean;
  registered: boolean;
  runtimeCallable: boolean;
  hostCallable: boolean;
  tools: string[];
  /** Native-host registration outcome; `missing` means the CLI itself is absent. */
  action: 'preserved' | 'installed' | 'updated' | 'blocked' | 'missing' | 'not-registered';
  message: string;
  /** Skill packages synchronized after a working registration; absent without a catalog or registration. */
  skills?: SkillStatus[];
}
export interface SetupOptions {
  /** Explicit selections authorize setup; omitted selections reuse the saved list. */
  clients?: SetupClient[];
  /** Read-only status does not publish runtime, backups, or selections. */
  statusOnly?: boolean;
  /** Standalone built bundle, outside a versioned extension directory. */
  runtimeSource: string;
  /** Node executable supplied by VS Code; its extension host executable is not Node. */
  nodePath?: string;
  /** Local profile boundary. Used for isolated acceptance profiles. */
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Records registrations as the VS Code extension's, which its uninstall hook removes. */
  origin?: RegistrationOrigin;
  /**
   * Data directory (`coagent8_DIR`) recorded in new registrations. The VS Code extension
   * passes its global storage, which VS Code deletes on uninstall; omitted, the runtime
   * uses `~/.coagent8`.
   */
  dataDirectory?: string;
  /**
   * Packaged skill catalog (`skills/` of the npm package or the VSIX). A client whose
   * registration works gets its packages; omitted, setup leaves skills unchanged.
   */
  skillsSource?: string;
}
/** The runtime backend each setup client runs as. */
export const SETUP_PROVIDERS: Record<SetupClient, ProviderId> = { codex: 'codex', claude: 'claude', agy: 'agy' };
/** The configuration file a runtime started with this environment reads. */
export { setupConfigFile } from './setup-storage.js';
/**
 * Resolves an installed client the way the runtime does: environment override, then
 * `backends.<id>.executable`, then PATH and the vendor extensions' copies.
 * @param client - A supported standalone client, separate from backend readiness.
 * @param home - Local user's home/profile boundary.
 * @param env - PATH, explicit CLI overrides and the configuration file; explicit choices fail closed.
 * @param nodePath - Node executable for JavaScript launchers, supplied by the VSIX.
 * @returns A shell-free command, or null when no supported executable is installed,
 * including a missing copy selected with `vscode-extension`. Other explicit choices fail closed.
 */
export function resolveSetupClient(client: SetupClient, home = os.homedir(), env = process.env, nodePath = process.execPath): CliCommand | null {
  const id = SETUP_PROVIDERS[client];
  const override = environmentOverride(id, env);
  const configured = override ? undefined : readBackendExecutable(id, setupConfigFile(home, env));
  try { return resolveCliCommand(backendCommand(id, configured, env, home), { env: { ...env, HOME: home, USERPROFILE: home }, nodePath }); }
  catch (error) {
    if (override) throw new Error('Configured client executable cannot be resolved.');
    if (configured === VSCODE_EXTENSION_EXECUTABLE && errorCodeOf(error) === 'CLI_NOT_FOUND') return null;
    if (configured) throw new Error(`backends.${id}.executable (${configured === VSCODE_EXTENSION_EXECUTABLE ? configured : 'configured path'}) cannot be resolved; change or remove it in config.json.`);
    if (errorCodeOf(error) !== 'CLI_NOT_FOUND') throw new Error('Configured client executable cannot be resolved.');
  }
  return null;
}
/** Where a resolved client comes from, and the `backends.<id>.executable` value that keeps it. */
export interface ClientSource {
  kind: 'vscode-extension' | 'standalone' | 'npm';
  /** `vscode-extension` survives the versioned folders of extension updates; other sources keep their path. */
  executable: string;
}
/** One installation of a client on this machine. */
export interface ClientInstallation extends ClientSource {
  /** The file that runs: the vendor extension's current copy for `vscode-extension`, else the executable. */
  file: string;
}
/** The copy the vendor's VS Code extension provides; for agy, the binary in `~/.gemini/bin`. */
function extensionCopy(client: SetupClient, home: string, env: NodeJS.ProcessEnv): CliCommand | null {
  return client === 'codex' ? resolveBundledCodex(home, env) : client === 'claude' ? resolveBundledClaude(home, env) : resolveManagedAgy(home, env);
}
/**
 * Identifies a file for comparison: a link, such as the agy installer's junction to
 * `~/.gemini/bin`, is its target, and a path that cannot be resolved, such as a missing
 * file, compares as written.
 */
function fileIdentity(file: string): string {
  let real: string;
  try { real = fs.realpathSync.native(file); } catch { real = path.resolve(file); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
/** Classifies a client that {@link resolveSetupClient} resolved. */
export function clientSource(client: SetupClient, cli: CliCommand, home = os.homedir(), env = process.env): ClientSource {
  const bundled = extensionCopy(client, home, env);
  if (bundled && fileIdentity(bundled.command) === fileIdentity(cli.command)) return { kind: 'vscode-extension', executable: VSCODE_EXTENSION_EXECUTABLE };
  return cli.source === 'native' ? { kind: 'standalone', executable: path.resolve(cli.command) } : { kind: 'npm', executable: path.resolve(cli.argsPrefix[0] ?? cli.command) };
}
/**
 * Folders that official installers and package managers use and that may be missing from
 * the PATH of the process that asks, such as a window started before an installation.
 */
function installerFolders(home: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'win32') {
    return [
      path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.codex', 'bin'),
      path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agy', 'bin'),
      path.join(env.SCOOP || path.join(home, 'scoop'), 'shims'),
    ];
  }
  return [path.join(home, '.local', 'bin'), path.join(home, '.codex', 'bin'), path.join(home, '.npm-global', 'bin')];
}
/**
 * Lists every installation of a client without starting any: the vendor extension's copy,
 * each PATH folder, the installer folders and a path set in `backends.<id>.executable`.
 * @returns One entry per distinct file, the extension's copy first.
 * @remarks A folder whose launcher cannot be resolved, such as an unsupported shim, holds no
 * usable installation and is left out; other failures propagate.
 */
export function listInstallations(client: SetupClient, home = os.homedir(), env = process.env, nodePath = process.execPath): ClientInstallation[] {
  const lookup = { env: { ...env, HOME: home, USERPROFILE: home }, nodePath };
  const found: ClientInstallation[] = [];
  const seen = new Set<string>();
  const add = (cli: CliCommand) => {
    const source = clientSource(client, cli, home, env);
    const file = source.kind === 'vscode-extension' ? cli.command : source.executable;
    const key = source.kind === 'vscode-extension' ? VSCODE_EXTENSION_EXECUTABLE : fileIdentity(file);
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...source, file });
  };
  const bundled = extensionCopy(client, home, env);
  if (bundled) add(bundled);
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const configured = configuredExecutable(client, home, env, nodePath);
  const candidates = [
    ...[...searchPath.split(path.delimiter), ...installerFolders(home, env)].filter(Boolean).map(folder => path.join(folder.replace(/^"|"$/g, ''), client)),
    ...(configured?.found && configured.value !== VSCODE_EXTENSION_EXECUTABLE ? [backendCommand(SETUP_PROVIDERS[client], configured.value, env, home)] : []),
  ];
  for (const candidate of candidates) {
    let cli: CliCommand;
    try { cli = resolveCliCommand(candidate, lookup); }
    catch (error) { if (error instanceof CliResolutionError) continue; throw error; }
    add(cli);
  }
  return found;
}
/**
 * The executable set in `backends.<id>.executable`, and whether it can be started.
 * @returns Undefined when none is set or an environment override replaces it.
 */
export function configuredExecutable(client: SetupClient, home = os.homedir(), env = process.env, nodePath = process.execPath): { value: string; found: boolean } | undefined {
  const id = SETUP_PROVIDERS[client];
  if (environmentOverride(id, env)) return undefined;
  const value = readBackendExecutable(id, setupConfigFile(home, env));
  if (value === undefined) return undefined;
  try { resolveCliCommand(backendCommand(id, value, env, home), { env: { ...env, HOME: home, USERPROFILE: home }, nodePath }); }
  catch (error) { if (error instanceof CliResolutionError) return { value, found: false }; throw error; }
  return { value, found: true };
}
/**
 * Checks a file the user chose as a client's executable, as setup checks the CLI it finds.
 * Starts the file for its version, help and sign-in metadata only.
 * @returns The `backends.<id>.executable` value that selects the file, and the CLI evidence.
 * @throws When the file cannot be started or is not a compatible CLI of this client.
 */
export async function checkExecutable(client: SetupClient, file: string, home = os.homedir(), env = process.env, nodePath = process.execPath, cwd = home): Promise<{ source: ClientSource; readiness: CliReadiness }> {
  let cli: CliCommand;
  try { cli = resolveCliCommand(path.resolve(file), { env: { ...env, HOME: home, USERPROFILE: home }, nodePath }); }
  catch (error) {
    if (error instanceof CliResolutionError) throw new Error(`${path.basename(file)} cannot be started: ${error.message}`);
    throw error;
  }
  const readiness = await inspectCli(client, cli, env, cwd);
  if (readiness.compatibility !== 'supported') throw new Error(`${path.basename(file)} is not a compatible ${client} CLI: ${readiness.diagnostic}`);
  return { source: clientSource(client, cli, home, env), readiness };
}

function checkScopes(client: SetupClient, config: Record<string, unknown>, cwd: string, globalFile: string, home: string): void {
  const entries = servers(client, config);
  for (const [name, value] of Object.entries(entries)) {
    if (name === 'coagent8') continue;
    if (/coagent8/i.test(name) || /coagent8/i.test(JSON.stringify(value))) throw new Error('Possible duplicate CoAgent8 definition; resolve it in the host before setup.');
  }
  if (config.plugins && Object.entries(object(config.plugins)).some(([name, value]) => /coagent8/i.test(name) && object(value).enabled !== false)) {
    throw new Error('CoAgent8 plugin is configured; preserve native plugin ownership and verify it in the host.');
  }
  if (client === 'claude' && config.projects) {
    const local = object(config.projects)[cwd];
    if (local && object(local).mcpServers && Object.hasOwn(object(object(local).mcpServers), 'coagent8')) {
      throw new Error('Workspace-local Claude registration shadows user scope.');
    }
  }
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const file = client === 'codex' ? path.join(dir, '.codex', 'config.toml')
      : client === 'claude' ? path.join(dir, '.mcp.json') : path.join(dir, '.agents', 'mcp_config.json');
    const content = file === globalFile ? null : read(file);
    if (content && Object.entries(servers(client, document(client, content))).some(([name, value]) => /coagent8/i.test(name) || /coagent8/i.test(JSON.stringify(value)))) {
      throw new Error('Workspace/profile CoAgent8 registration conflicts with local default scope.');
    }
    if (dir === home || fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
}

/**
 * Initializes a registered runtime and reads its tool catalog without claiming native host discovery.
 * @remarks No tool is called: `doctor` probes every backend again and took 5-11 s on Windows,
 * once per registered client. A tool call is first exercised on actual use.
 */
async function probeRuntime(entry: Registration, env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  return withStdioRpc(entry.command, entry.args, async rpc => {
    const init = object(await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'coagent8-setup', version: '1' } }));
    if (object(init.serverInfo).name !== 'coagent8') throw new Error('Configured process is not CoAgent8.');
    rpc.notify('notifications/initialized');
    const tools = object(await rpc.request('tools/list', {})).tools;
    if (!Array.isArray(tools)) throw new Error('Invalid tool catalog.');
    const names = tools.map(tool => object(tool).name);
    if (!names.every(name => typeof name === 'string') || !names.includes('doctor')) throw new Error('CoAgent8 doctor is unavailable.');
    return names as string[];
  }, { env: { ...env, ...entry.env }, cwd });
}

/** Verifies that Codex itself starts the registered server and discovers its tools, without a model turn. */
async function probeCodex(cli: CliCommand, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  return withStdioRpc(cli.command, [...cli.argsPrefix, 'app-server'], async rpc => {
    await rpc.request('initialize', { clientInfo: { name: 'coagent8_setup', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const started = object(await rpc.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true }));
    const threadId = object(started.thread).id;
    if (typeof threadId !== 'string') throw new Error('Codex omitted the probe thread.');
    const status = object(await rpc.request('mcpServerStatus/list', { threadId, serverName: 'coagent8' }));
    if (!Array.isArray(status.data)) throw new Error('Codex MCP discovery is unavailable.');
    const server = status.data.map(object).find(item => item.name === 'coagent8');
    if (!server || !object(server.tools).doctor) throw new Error('Codex did not discover CoAgent8 doctor.');
    return true;
  }, { env, cwd });
}
/**
 * Clients whose host can call CoAgent8 under setup's control; only their failed check is
 * evidence against a registration. Claude and agy offer no such call (owner decision
 * 2026-10-09: their owned entries update on the runtime check, as a first registration does).
 */
const HOST_CHECKED_CLIENTS: readonly SetupClient[] = ['codex'];
async function hostCallable(client: SetupClient, cli: CliCommand, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  if (!HOST_CHECKED_CLIENTS.includes(client)) return false;
  try { return await probeCodex(cli, env, cwd); }
  catch { return false; } // Host versions without the direct-call API remain explicitly unverified.
}
export { CODEX_TOOL_TIMEOUT_SEC } from './setup-storage.js';

/**
 * Adds `tool_timeout_sec` to the CoAgent8 table that `codex mcp add` wrote, which has no option for it.
 * @remarks The line goes right after the table header, keeping the user's formatting and comments;
 * the parsed result must differ from the input by that key alone.
 */
export function withCodexToolTimeout(config: string): string {
  const written = servers('codex', document('codex', config)).coagent8;
  const header = /^\[mcp_servers\.coagent8\][^\S\r\n]*(?=\r?\n|$)/m.exec(config);
  if (written === undefined || !header) throw new Error('Native Codex registration wrote no [mcp_servers.coagent8] table.');
  const entry = object(written);
  if (entry.tool_timeout_sec !== undefined) return config;
  const eol = config.includes('\r\n') ? '\r\n' : '\n';
  const at = header.index + header[0].length;
  const edited = `${config.slice(0, at)}${eol}tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}${config.slice(at)}`;
  const parsed = document('codex', edited);
  const added = object(servers('codex', parsed).coagent8);
  const { tool_timeout_sec: timeout, ...rest } = added;
  // Spread both sides: TOML tables have no prototype, the destructured rest has one.
  if (timeout !== CODEX_TOOL_TIMEOUT_SEC || !isDeepStrictEqual(rest, { ...entry })
      || !isDeepStrictEqual({ ...parsed, mcp_servers: undefined }, { ...document('codex', config), mcp_servers: undefined })) {
    throw new Error('Adding the Codex tool timeout changed other settings.');
  }
  return edited;
}

async function nativeCodexEdit(before: string | null, target: Registration | null, cli: CliCommand, backup: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const staging = path.join(backup, 'codex-staging-' + randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  let edited: Awaited<ReturnType<typeof runCommand>>, written: string | null;
  // The staging copy is temporary; only the backup beside it is kept.
  try {
    if (before !== null) fs.writeFileSync(path.join(staging, 'config.toml'), before, { mode: 0o600 });
    const envArgs = Object.entries(target?.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const args = target ? ['mcp', 'add', 'coagent8', ...envArgs, '--', target.command, ...target.args] : ['mcp', 'remove', 'coagent8'];
    edited = await runCommand(cli.command, [...cli.argsPrefix, ...args], { cwd, env: { ...env, CODEX_HOME: staging }, timeoutMs: 15_000 });
    written = read(path.join(staging, 'config.toml'));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (edited.status !== 'completed' || written === null) throw new Error('Native Codex registration failed.');
  const after = target ? withCodexToolTimeout(written) : written;
  const oldDoc = before === null ? {} : document('codex', before);
  const newDoc = document('codex', after);
  const strip = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'coagent8'));
  if (!isDeepStrictEqual(strip(servers('codex', oldDoc)), strip(servers('codex', newDoc))) ||
      !isDeepStrictEqual({ ...oldDoc, mcp_servers: undefined }, { ...newDoc, mcp_servers: undefined })) {
    throw new Error('Native registration changed unrelated settings.');
  }
  return after;
}
async function restoreOwnedEntry(client: SetupClient, file: string, before: string | null, installed: unknown, cli: CliCommand, backup: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const current = read(file);
  if (current === null) throw new Error('Configuration was removed concurrently; backup retained.');
  const currentEntry = servers(client, document(client, current)).coagent8;
  if (!isDeepStrictEqual(currentEntry, installed)) throw new Error('CoAgent8 entry changed independently; rollback preserves it and retains the private backup.');
  const original = before === null ? undefined : servers(client, document(client, before)).coagent8;
  const updated = client === 'codex'
    ? await nativeCodexEdit(current, original === undefined ? null : registration(original), cli, backup, env, cwd)
    : applyEdits(current, modify(current, ['mcpServers', 'coagent8'], original, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  if (!isDeepStrictEqual(servers(client, document(client, updated)).coagent8, original)) throw new Error('Native rollback could not preserve original entry options; private backup retained.');
  writeChecked(file, current, updated);
}

/** Resolves the local default profile; custom client roots are refused before any read or write. */
function localProfile(options: Pick<SetupOptions, 'home' | 'cwd' | 'env'>) {
  const home = path.resolve(options.home || os.homedir());
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  if (env.CODEX_CONFIG_PATH || env.CLAUDE_CONFIG_DIR || env.GEMINI_CLI_HOME || (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== path.join(home, '.codex'))) {
    throw new Error('Custom client/profile roots are unsupported; run setup in the local default profile.');
  }
  const root = path.join(home, '.coagent8');
  assertSkillRoot(root, home);
  return { home, cwd, env, root, stateFile: path.join(root, 'setup.json') };
}
/** The entry setup writes for this bundle, Node executable, configuration file and data directory. */
function candidateRegistration(bundle: string, root: string, options: Pick<SetupOptions, 'nodePath' | 'dataDirectory'>, env: NodeJS.ProcessEnv, cwd: string): Registration {
  const runtime = path.join(root, 'runtime', hash(bundle), 'index.cjs');
  const node = resolveCliCommand(options.nodePath || process.execPath, { env, cwd });
  const variables = {
    ...(env.coagent8_CONFIG ? { coagent8_CONFIG: env.coagent8_CONFIG } : {}),
    ...(options.dataDirectory ? { coagent8_DIR: path.resolve(options.dataDirectory) } : {}),
  };
  return { command: node.command, args: [...node.argsPrefix, runtime], env: Object.keys(variables).length ? variables : undefined };
}

/** A CoAgent8 entry in one host configuration, read without starting a process. */
export interface RegistrationStatus {
  client: SetupClient;
  /**
   * `owned`: written by setup and unchanged since, by its recorded fingerprint or its shape;
   * `manual`: any other CoAgent8 entry, which setup preserves.
   */
  state: 'absent' | 'owned' | 'manual' | 'blocked';
  /** The entry is what setup writes now: same runtime bundle, Node executable and configuration file. */
  current: boolean;
  message: string;
}
/**
 * Reads the CoAgent8 registration of every client from its configuration file.
 * @remarks Starts no CLI, runtime or host; ownership uses the fingerprints setup recorded,
 * else the shape only setup writes.
 * @throws On a custom profile root or an unreadable setup state.
 */
export function readRegistrations(options: Pick<SetupOptions, 'runtimeSource' | 'nodePath' | 'dataDirectory' | 'home' | 'cwd' | 'env'>): RegistrationStatus[] {
  const { home, cwd, env, root, stateFile } = localProfile(options);
  const saved = readSelection(stateFile);
  const node = resolveCliCommand(options.nodePath || process.execPath, { env, cwd });
  const candidate = candidateRegistration(readBoundedFileSync(options.runtimeSource, 8 * 1024 * 1024), root, options, env, cwd);
  return SETUP_CLIENTS.map(client => {
    try {
      const text = read(configPath(client, home, env));
      const entry = text === null ? undefined : servers(client, document(client, text)).coagent8;
      if (entry === undefined) return { client, state: 'absent', current: false, message: 'No CoAgent8 entry.' };
      const current = isDeepStrictEqual(registration(entry), candidate);
      if (!entryOwnership(client, entry, saved, root, options.nodePath, node.argsPrefix).owned) return { client, state: 'manual', current, message: 'Manual or independently edited entry; setup preserves it.' };
      return { client, state: 'owned', current, message: current ? 'Registered by setup.' : 'Registered by setup for another CoAgent8 version, configuration file or data directory.' };
    } catch (error) {
      return { client, state: 'blocked', current: false, message: redactDiagnostic(error instanceof Error ? error.message : 'Configuration is unreadable.') };
    }
  });
}

/**
 * Installs missing selected registrations or safely repairs managed entries.
 * @param options - Local boundary, built runtime, explicit or remembered client selections.
 * @returns Per-client evidence and conflicts; a failed client does not hide other results.
 * @throws On setup-state/lock/runtime errors before any client mutation.
 * @remarks
 * Private backups retain original bytes. Existing manual entries and independently
 * changed managed entries are never replaced. An owned entry is updated after the new
 * runtime starts and lists its tools; a client whose host setup can check also needs that
 * host's call. Failed candidate checks restore only
 * the owned entry, preserving concurrent unrelated edits. Restart/new chat is needed
 * for hosts caching tool catalogs. Remote scopes are intentionally unsupported here.
 * Status reads host files and CLI metadata only, without starting the runtime or a host.
 */
export async function setupClients(options: SetupOptions): Promise<SetupStatus[]> {
  const { home, cwd, env, root, stateFile } = localProfile(options);
  if (!options.statusOnly) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  async function performSetup(): Promise<SetupStatus[]> {
    if (!options.statusOnly) recoverSkillTransaction(home);
    let stateBefore = read(stateFile);
    const saved = readSelection(stateFile, stateBefore);
    const selected = [...new Set(options.clients ?? (options.statusOnly ? SETUP_CLIENTS : saved.clients))];
    if (!selected.length && !options.statusOnly) throw new Error('Select clients with --clients=codex,claude,agy on first setup.');
    if (!selected.every(client => SETUP_CLIENTS.includes(client))) throw new Error('Unknown setup client.');
    let candidate: Registration | null = null;
    let catalog: SkillPackage[] | null = null;
    if (!options.statusOnly) {
      // An invalid catalog is a package defect; it stops setup before any client changes.
      if (options.skillsSource) catalog = readSkillCatalog(options.skillsSource);
      const bundle = readBoundedFileSync(options.runtimeSource, 8 * 1024 * 1024);
      candidate = candidateRegistration(bundle, root, options, env, cwd);
      const runtime = extractRuntimePath(candidate, root) ?? candidate.args.at(-1)!;
      fs.mkdirSync(path.dirname(runtime), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(runtime)) fs.writeFileSync(runtime, bundle, { flag: 'wx', mode: 0o600 });
      if (hash(readBoundedFileSync(runtime, 8 * 1024 * 1024)) !== hash(bundle)) throw new Error('Owned runtime hash mismatch.');
      await probeRuntime(candidate, env, cwd);
    }
    const results: SetupStatus[] = (selected.length ? selected : SETUP_CLIENTS).map(client => (
      { client, version: null, compatibility: 'unknown', authentication: 'unknown', ready: false, diagnostic: '', installed: false, registered: false, runtimeCallable: false, hostCallable: false, tools: [], action: 'blocked', message: '' }));
    // Status checks only read, so clients run in parallel; setup writes stay serial under the lease.
    if (options.statusOnly) await Promise.all(results.map(check));
    else for (const result of results) {
      await check(result);
      if (catalog && ['installed', 'updated', 'preserved'].includes(result.action)) {
        syncSkills(result, catalog);
        stateBefore = read(stateFile);
      }
    }
    if (!options.statusOnly) {
      saved.clients = selected;
      writeChecked(stateFile, stateBefore, serializeSelection(saved));
    }
    return results;
    /** Installs the catalog for a client whose registration works; skills never change the registration outcome. */
    function syncSkills(result: SetupStatus, packages: SkillPackage[]): void {
      const client = result.client;
      result.skills = reconcileSkills(client, home, packages, saved, selectedSkills(packages, readBackendSkills(client, setupConfigFile(home, env))), options.origin, stateBefore);
      result.message += ' ' + describeSkills(client, result.skills);
    }
    async function check(result: SetupStatus): Promise<void> {
      const client = result.client;
      try {
        let cli: CliCommand | null = null;
        let resolutionError: unknown;
        try { cli = resolveSetupClient(client, home, env, options.nodePath || process.execPath); }
        catch (error) { resolutionError = error; }
        if (cli) {
          result.installed = true;
          Object.assign(result, await inspectCli(client, cli, env, cwd));
        }
        const file = configPath(client, home, env);
        const before = read(file);
        const config = before === null ? {} : document(client, before);
        const entry = servers(client, config).coagent8;
        result.registered = entry !== undefined;
        if (resolutionError) throw resolutionError;
        if (!cli) {
          result.action = 'missing'; result.message = 'CLI missing; any external registration is retained. Install/authenticate explicitly.'; return;
        }
        if (!options.statusOnly && result.compatibility !== 'supported') { result.message = result.diagnostic; return; }
        checkScopes(client, config, cwd, file, home);
        if (entry !== undefined) {
          const existing = registration(entry);
          result.action = 'preserved';
          // Status reads the host files only; starting the runtime and the host is setup/repair work.
          if (options.statusOnly) { result.message = 'Registered. Status reads the host configuration only; CoAgent8: Manage Coding CLIs or npx -y coagent8@next repair (coagent8 repair when installed globally) verifies the connection.'; return; }
          const node = resolveCliCommand(options.nodePath || process.execPath, { env, cwd });
          const owned = entryOwnership(client, entry, saved, root, options.nodePath, node.argsPrefix).owned;
          // An owned entry whose runtime copy is gone starts nothing, so there is no working
          // connection to verify or keep; the candidate written above replaces it.
          const existingRuntime = extractRuntimePath(existing, root, node.argsPrefix);
          const broken = owned && (!existingRuntime || !fs.existsSync(existingRuntime));
          if (!broken) {
            result.tools = await probeRuntime(existing, env, cwd);
            result.runtimeCallable = true;
            result.hostCallable = await hostCallable(client, cli, env, cwd);
          }
          result.message = 'Existing registration preserved. Start a new chat to refresh cached tools.';
          if (isDeepStrictEqual(existing, candidate)) return;
          if (!owned) {
            result.message = 'Manual or independently changed registration preserved; migration requires native-host acceptance.';
            return;
          }
          if (!broken && HOST_CHECKED_CLIENTS.includes(client) && !result.hostCallable) {
            result.message = 'Managed runtime update deferred: the native host did not call the current registration; old connection retained.';
            return;
          }
        } else if (options.statusOnly) {
          // Registration in the CLI's own configuration is optional; the CLI itself is present.
          result.action = 'not-registered';
          result.message = 'CLI found; CoAgent8 is not registered in this client. Optional: CoAgent8: Manage Coding CLIs, or coagent8 setup.';
          return;
        }
        if (!candidate) throw new Error('Setup runtime is unavailable.');
        const backup = backupDirectory(root, options.origin);
        fs.writeFileSync(path.join(backup, client + '.config'), before ?? '', { flag: 'wx', mode: 0o600 });
        let after: string | null = null;
        let liveWritten = false;
        const previousEvidence = { registered: result.registered, runtimeCallable: result.runtimeCallable, hostCallable: result.hostCallable, tools: result.tools };
        try {
          if (client === 'codex') {
            // Let the native CLI edit an isolated copy, then commit it with a conflict check.
            // Failed native serialization never touches the user's live registration.
            after = await nativeCodexEdit(before, candidate, cli, backup, env, cwd);
            if (entry !== undefined) {
              const otherFields = (value: unknown) => {
                const entryObject = object(value);
                const remainingEnv = Object.fromEntries(Object.entries(entryObject.env === undefined ? {} : object(entryObject.env)).filter(([key]) => key !== 'coagent8_CONFIG' && key !== 'coagent8_DIR'));
                return { ...Object.fromEntries(Object.entries(entryObject).filter(([key]) => !['command', 'args', 'env'].includes(key))), env: remainingEnv };
              };
              if (!isDeepStrictEqual(otherFields(entry), otherFields(servers(client, document(client, after)).coagent8))) throw new Error('Native update would change existing registration options; preserve it.');
            }
            writeChecked(file, before, after);
          } else {
            const text = before ?? '{}\n';
            after = applyEdits(text, modify(text, ['mcpServers', 'coagent8'], candidate, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
            writeChecked(file, before, after);
          }
          liveWritten = true;
          const installed = registration(servers(client, document(client, after)).coagent8);
          result.tools = await probeRuntime(installed, env, cwd);
          result.runtimeCallable = true;
          result.hostCallable = await hostCallable(client, cli, env, cwd);
          if (entry !== undefined && HOST_CHECKED_CLIENTS.includes(client) && !result.hostCallable) throw new Error('Replacement failed native-host acceptance.');
          const current = read(file);
          if (current === null || !isDeepStrictEqual(servers(client, document(client, current)).coagent8, servers(client, document(client, after)).coagent8)) {
            throw new Error('CoAgent8 entry changed during verification; ownership was not transferred.');
          }
          result.registered = true;
          result.action = entry === undefined ? 'installed' : 'updated';
          result.message = result.hostCallable ? 'Native host discovered the CoAgent8 tools. Start a new chat to refresh existing catalogs.'
            : 'Registered; the runtime starts and lists its tools. Native host discovery and icon presentation still need acceptance in a new chat.';
          if (entry !== undefined && !result.hostCallable) result.message += ' The previous runtime stays until cleanup; restart running chats to use this one.';
          saved.owned[client] = hash(JSON.stringify(servers(client, document(client, after)).coagent8));
          if (options.origin) saved.origin[client] = options.origin;
          else delete saved.origin[client];
          // The first registration records the CLI it found; the user may change it afterwards.
          if (entry === undefined) {
            try {
              if (await recordBackendExecutable(SETUP_PROVIDERS[client], clientSource(client, cli, home, env).executable, setupConfigFile(home, env))) {
                result.message += ` Recorded backends.${SETUP_PROVIDERS[client]}.executable in the configuration.`;
              }
            } catch (error) {
              result.message += ` The CLI was not recorded in the configuration: ${redactDiagnostic(error instanceof Error ? error.message : 'unknown error')}`;
            }
          }
        } catch (error) {
          // Restore exact original bytes only if no concurrent editor changed the file.
          if (liveWritten && after !== null && read(file) === after) {
            if (before === null) fs.rmSync(file);
            else writeChecked(file, after, before);
          } else if (liveWritten && after !== null) {
            await restoreOwnedEntry(client, file, before, servers(client, document(client, after)).coagent8, cli, backup, env, cwd);
          }
          Object.assign(result, previousEvidence);
          throw error;
        }
      } catch (error) {
        result.action = 'blocked';
        result.message = redactDiagnostic(error instanceof Error ? error.message : 'Setup failed.');
      }
    }
  }
  return options.statusOnly ? performSetup() : withFileLock(path.join(root, 'setup'), performSetup);
}
