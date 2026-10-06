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
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { parse, parseTree, modify, applyEdits, type ParseError, type Node as JsonNode } from 'jsonc-parser';
import { readBoundedFileSync } from '../execution/stream.js';
import { runCommand } from '../execution/process.js';
import { resolveCliCommand, resolveBundledClaude, type CliCommand } from '../backends/cli-resolver.js';
import { redactDiagnostic } from '../redaction.js';
import { withFileLock } from '../sessions/lock.js';
import { object, withStdioRpc } from './rpc.js';

export const SETUP_CLIENTS = ['codex', 'claude', 'agy'] as const;
export type SetupClient = typeof SETUP_CLIENTS[number];
export interface Registration { command: string; args: string[]; env?: Record<string, string> }
interface Selection { clients: SetupClient[]; owned: Partial<Record<SetupClient, string>> }
/** Separates registry, direct-runtime, and native-host evidence. No credentials are returned. */
export interface SetupStatus {
  client: SetupClient;
  installed: boolean;
  registered: boolean;
  runtimeCallable: boolean;
  hostCallable: boolean;
  tools: string[];
  action: 'preserved' | 'installed' | 'updated' | 'blocked' | 'missing';
  message: string;
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
}
const CONFIG_LIMIT = 512 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function read(file: string): string | null {
  try { return readBoundedFileSync(file, CONFIG_LIMIT); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Parser/I/O errors can include configuration excerpts containing secrets.
    throw new Error('Configuration is unreadable or exceeds the byte limit.');
  }
}
function rejectDuplicateKeys(node: JsonNode | undefined): void {
  if (!node) return;
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string;
      if (keys.has(key)) throw new Error('Configuration contains duplicate keys.');
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}
function json(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Malformed JSON/JSONC configuration.');
  rejectDuplicateKeys(parseTree(text));
  return object(value);
}
function document(client: SetupClient, text: string): Record<string, unknown> {
  if (client !== 'codex') return json(text);
  try { return object(parseToml(text, { integersAsBigInt: 'asNeeded' })); }
  catch { throw new Error('Malformed TOML configuration.'); }
}
function servers(client: SetupClient, config: Record<string, unknown>): Record<string, unknown> {
  const value = config[client === 'codex' ? 'mcp_servers' : 'mcpServers'];
  return value === undefined ? {} : object(value);
}
function registration(value: unknown): Registration {
  const entry = object(value);
  if (typeof entry.command !== 'string' || !entry.command || !Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === 'string')) {
    throw new Error('Existing CoAgent entry is not a supported stdio definition; preserve it and resolve the conflict.');
  }
  if (entry.disabled === true || entry.enabled === false) throw new Error('Existing CoAgent entry is disabled; enable it in the host explicitly.');
  const env = entry.env === undefined ? undefined : object(entry.env);
  if (env && !Object.values(env).every(value => typeof value === 'string')) throw new Error('Invalid CoAgent environment.');
  return { command: entry.command, args: entry.args, env: env as Record<string, string> | undefined };
}
function configPath(client: SetupClient, home: string, env: NodeJS.ProcessEnv): string {
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  if (client === 'claude') return path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  return path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'config', 'mcp_config.json');
}

/**
 * Resolves an installed client, including the newest usable Claude extension binary.
 * @param client - A supported standalone client, separate from backend readiness.
 * @param home - Local user's home/profile boundary.
 * @param env - PATH and explicit CLI overrides; overrides fail closed.
 * @param nodePath - Node executable for JavaScript launchers, supplied by the VSIX.
 * @returns A shell-free command, or null when no supported executable is installed.
 * @remarks Extension candidates are evaluated on each setup; paths are never persisted.
 */
export function resolveSetupClient(client: SetupClient, home = os.homedir(), env = process.env, nodePath = process.execPath): CliCommand | null {
  const override = client === 'codex' ? env.CODEX_PATH : client === 'claude' ? env.CLAUDE_PATH : env.AGY_PATH || env.GEMINI_PATH;
  try { return resolveCliCommand(override || client, { env: { ...env, HOME: home, USERPROFILE: home }, nodePath }); }
  catch (error) {
    if (override || (error as { code?: string }).code !== 'CLI_NOT_FOUND') throw new Error('Configured client executable cannot be resolved.');
  }
  if (client !== 'claude') return null;
  return resolveBundledClaude(home, env);
}

function checkScopes(client: SetupClient, config: Record<string, unknown>, cwd: string, globalFile: string, home: string): void {
  const entries = servers(client, config);
  for (const [name, value] of Object.entries(entries)) {
    if (name === 'coagent8') continue;
    if (/coagent8/i.test(name) || /coagent8/i.test(JSON.stringify(value))) throw new Error('Possible duplicate CoAgent definition; resolve it in the host before setup.');
  }
  if (config.plugins && Object.entries(object(config.plugins)).some(([name, value]) => /coagent8/i.test(name) && object(value).enabled !== false)) {
    throw new Error('CoAgent plugin is configured; preserve native plugin ownership and verify it in the host.');
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
      throw new Error('Workspace/profile CoAgent registration conflicts with local default scope.');
    }
    if (dir === home || fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
}

/** Initializes a registered runtime and invokes doctor without claiming native host discovery. */
export async function probeRuntime(entry: Registration, env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  return withStdioRpc(entry.command, entry.args, async rpc => {
    const init = object(await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'coagent8-setup', version: '1' } }));
    if (object(init.serverInfo).name !== 'coagent8') throw new Error('Configured process is not CoAgent.');
    rpc.notify('notifications/initialized');
    const tools = object(await rpc.request('tools/list', {})).tools;
    if (!Array.isArray(tools)) throw new Error('Invalid tool catalog.');
    const names = tools.map(tool => object(tool).name);
    if (!names.every(name => typeof name === 'string') || !names.includes('doctor')) throw new Error('CoAgent doctor is unavailable.');
    const result = object(await rpc.request('tools/call', { name: 'doctor', arguments: {} }));
    if (result.isError) throw new Error('CoAgent doctor call failed.');
    return names as string[];
  }, { env: { ...env, ...entry.env }, cwd });
}

/** Verifies Codex's actual tool catalog and doctor call without a model turn. */
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
    if (!server || !object(server.tools).doctor) throw new Error('Codex did not discover CoAgent doctor.');
    const result = object(await rpc.request('mcpServer/tool/call', { threadId, server: 'coagent8', tool: 'doctor', arguments: {} }));
    if (result.isError) throw new Error('Codex doctor call failed.');
    return true;
  }, { env, cwd });
}
async function hostCallable(client: SetupClient, cli: CliCommand, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  if (client !== 'codex') return false;
  try { return await probeCodex(cli, env, cwd); }
  catch { return false; } // Host versions without the direct-call API remain explicitly unverified.
}
function writeChecked(file: string, before: string | null, after: string): void {
  if (read(file) !== before) throw new Error('Configuration changed concurrently; setup did not overwrite it.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, after, { flag: 'wx', mode: before === null ? 0o600 : fs.statSync(file).mode & 0o777 });
    if (read(file) !== before) throw new Error('Configuration changed concurrently; setup did not overwrite it.');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function readSelection(file: string): Selection {
  const content = read(file);
  if (content === null) return { clients: [], owned: {} };
  const data = json(content);
  if (!Array.isArray(data.clients) || !data.clients.every(client => SETUP_CLIENTS.includes(client as SetupClient))) throw new Error('Invalid saved setup selections.');
  const owned: Selection['owned'] = {};
  if (data.owned) for (const [client, value] of Object.entries(object(data.owned))) {
    if (!SETUP_CLIENTS.includes(client as SetupClient)) throw new Error('Invalid setup ownership record.');
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid setup ownership fingerprint.');
    owned[client as SetupClient] = value;
  }
  return { clients: [...new Set(data.clients)] as SetupClient[], owned };
}
async function nativeCodexEdit(before: string | null, target: Registration | null, cli: CliCommand, backup: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const staging = path.join(backup, 'codex-staging-' + randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  if (before !== null) fs.writeFileSync(path.join(staging, 'config.toml'), before, { mode: 0o600 });
  const envArgs = Object.entries(target?.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const args = target ? ['mcp', 'add', 'coagent8', ...envArgs, '--', target.command, ...target.args] : ['mcp', 'remove', 'coagent8'];
  const edited = await runCommand(cli.command, [...cli.argsPrefix, ...args], { cwd, env: { ...env, CODEX_HOME: staging }, timeoutMs: 15_000 });
  const after = read(path.join(staging, 'config.toml'));
  if (edited.status !== 'completed' || after === null) throw new Error('Native Codex registration failed.');
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
  if (!isDeepStrictEqual(currentEntry, installed)) throw new Error('CoAgent entry changed independently; rollback preserves it and retains the private backup.');
  const original = before === null ? undefined : servers(client, document(client, before)).coagent8;
  const updated = client === 'codex'
    ? await nativeCodexEdit(current, original === undefined ? null : registration(original), cli, backup, env, cwd)
    : applyEdits(current, modify(current, ['mcpServers', 'coagent8'], original, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  if (!isDeepStrictEqual(servers(client, document(client, updated)).coagent8, original)) throw new Error('Native rollback could not preserve original entry options; private backup retained.');
  writeChecked(file, current, updated);
}

/**
 * Installs missing selected registrations or safely repairs managed entries.
 * @param options - Local boundary, built runtime, explicit or remembered client selections.
 * @returns Per-client evidence and conflicts; a failed client does not hide other results.
 * @throws On setup-state/lock/runtime errors before any client mutation.
 * @remarks
 * Private backups retain original bytes. Existing manual entries and independently
 * changed managed entries are never replaced. Failed candidate checks restore only
 * the owned entry, preserving concurrent unrelated edits. Restart/new chat is needed
 * for hosts caching tool catalogs. Remote scopes are intentionally unsupported here.
 */
export async function setupClients(options: SetupOptions): Promise<SetupStatus[]> {
  const home = path.resolve(options.home || os.homedir());
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  if (env.CODEX_CONFIG_PATH || env.CLAUDE_CONFIG_DIR || env.GEMINI_CLI_HOME || (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== path.join(home, '.codex'))) {
    throw new Error('Custom client/profile roots are unsupported; run setup in the local default profile.');
  }
  const root = path.join(home, '.coagent8');
  const stateFile = path.join(root, 'setup.json');
  const saved = readSelection(stateFile);
  const selected = [...new Set(options.clients ?? saved.clients)];
  if (!selected.length && !options.statusOnly) throw new Error('Select clients with --clients=codex,claude,agy on first setup.');
  if (!selected.every(client => SETUP_CLIENTS.includes(client))) throw new Error('Unknown setup client.');
  if (!options.statusOnly) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  async function performSetup(): Promise<SetupStatus[]> {
    let candidate: Registration | null = null;
    if (!options.statusOnly) {
      const bundle = readBoundedFileSync(options.runtimeSource, 8 * 1024 * 1024);
      const runtime = path.join(root, 'runtime', hash(bundle), 'index.cjs');
      fs.mkdirSync(path.dirname(runtime), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(runtime)) fs.writeFileSync(runtime, bundle, { flag: 'wx', mode: 0o600 });
      if (hash(readBoundedFileSync(runtime, 8 * 1024 * 1024)) !== hash(bundle)) throw new Error('Owned runtime hash mismatch.');
      const node = resolveCliCommand(options.nodePath || process.execPath, { env, cwd });
      candidate = { command: node.command, args: [...node.argsPrefix, runtime], env: undefined };
      await probeRuntime(candidate, env, cwd);
    }
    const results: SetupStatus[] = [];
    for (const client of selected.length ? selected : SETUP_CLIENTS) {
      const result: SetupStatus = { client, installed: false, registered: false, runtimeCallable: false, hostCallable: false, tools: [], action: 'blocked', message: '' };
      results.push(result);
      try {
        const cli = resolveSetupClient(client, home, env, options.nodePath || process.execPath);
        if (!cli) { result.action = 'missing'; result.message = 'Client not installed; install/authenticate it separately.'; continue; }
        result.installed = true;
        const file = configPath(client, home, env);
        const before = read(file);
        const config = before === null ? {} : document(client, before);
        checkScopes(client, config, cwd, file, home);
        const entry = servers(client, config).coagent8;
        result.registered = entry !== undefined;
        if (entry !== undefined) {
          const existing = registration(entry);
          result.tools = await probeRuntime(existing, env, cwd);
          result.runtimeCallable = true;
          result.hostCallable = await hostCallable(client, cli, env, cwd);
          result.action = 'preserved';
          result.message = 'Existing registration preserved. Start a new chat to refresh cached tools.';
          if (options.statusOnly || isDeepStrictEqual(existing, candidate)) continue;
          if (hash(JSON.stringify(entry)) !== saved.owned[client]) {
            result.message = 'Manual or independently changed registration preserved; migration requires native-host acceptance.';
            continue;
          }
          if (!result.hostCallable) {
            result.message = 'Managed runtime update deferred: native-host call is unverified; old connection retained.';
            continue;
          }
        } else if (options.statusOnly) {
          result.action = 'missing'; result.message = 'Client installed; CoAgent is not registered.'; continue;
        }
        if (!candidate) throw new Error('Setup runtime is unavailable.');
        const backup = path.join(root, 'setup-backups', randomUUID());
        fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
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
              const otherFields = (value: unknown) => Object.fromEntries(Object.entries(object(value)).filter(([key]) => !['command', 'args'].includes(key)));
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
          if (entry !== undefined && !result.hostCallable) throw new Error('Replacement failed native-host acceptance.');
          const current = read(file);
          if (current === null || !isDeepStrictEqual(servers(client, document(client, current)).coagent8, servers(client, document(client, after)).coagent8)) {
            throw new Error('CoAgent entry changed during verification; ownership was not transferred.');
          }
          result.registered = true;
          result.action = entry === undefined ? 'installed' : 'updated';
          result.message = result.hostCallable ? 'Native host discovered tools and invoked doctor. Start a new chat to refresh existing catalogs.'
            : 'Registered; runtime doctor passed. Native host discovery/call and icon presentation still need acceptance in a new chat.';
          saved.owned[client] = hash(JSON.stringify(servers(client, document(client, after)).coagent8));
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
    if (!options.statusOnly) {
      saved.clients = selected;
      writeChecked(stateFile, read(stateFile), JSON.stringify(saved, null, 2) + '\n');
    }
    return results;
  }
  return options.statusOnly ? performSetup() : withFileLock(path.join(root, 'setup'), performSetup);
}
