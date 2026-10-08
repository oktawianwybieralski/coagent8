/**
 * Bounded configuration parsing, private state and conflict-checked setup writes.
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { parse, parseTree, type ParseError, type Node as JsonNode } from 'jsonc-parser';
import { readBoundedFileSync } from '../execution/stream.js';
import { object } from './rpc.js';
import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
export interface Registration { command: string; args: string[]; env?: Record<string, string> }
/** Registrations written on behalf of the VS Code extension, which removes them on uninstall. */
export const EXTENSION_ORIGIN = 'vscode-extension' as const;
export type RegistrationOrigin = typeof EXTENSION_ORIGIN;
/** Saved selections and ownership; `origin` is absent for the CLI and for earlier records. */
export interface Selection { clients: SetupClient[]; owned: Partial<Record<SetupClient, string>>; origin: Partial<Record<SetupClient, RegistrationOrigin>> }
const CONFIG_LIMIT = 512 * 1024;
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function read(file: string): string | null {
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
export function document(client: SetupClient, text: string): Record<string, unknown> {
  if (client !== 'codex') return json(text);
  try { return object(parseToml(text, { integersAsBigInt: 'asNeeded' })); }
  catch { throw new Error('Malformed TOML configuration.'); }
}
export function servers(client: SetupClient, config: Record<string, unknown>): Record<string, unknown> {
  const value = config[client === 'codex' ? 'mcp_servers' : 'mcpServers'];
  return value === undefined ? {} : object(value);
}
export function registration(value: unknown): Registration {
  const entry = object(value);
  if (typeof entry.command !== 'string' || !entry.command || !Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === 'string')) {
    throw new Error('Existing CoAgent8 entry is not a supported stdio definition; preserve it and resolve the conflict.');
  }
  if (entry.disabled === true || entry.enabled === false) throw new Error('Existing CoAgent8 entry is disabled; enable it in the host explicitly.');
  const env = entry.env === undefined ? undefined : object(entry.env);
  if (env && !Object.values(env).every(value => typeof value === 'string')) throw new Error('Invalid CoAgent8 environment.');
  // TOML tables have no prototype; a plain copy keeps deep comparison with a candidate exact.
  return { command: entry.command, args: [...entry.args], env: env ? { ...env } as Record<string, string> : undefined };
}
export function configPath(client: SetupClient, home: string, env: NodeJS.ProcessEnv): string {
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  if (client === 'claude') return path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  return path.join(env.GEMINI_CLI_HOME || home, '.gemini', 'config', 'mcp_config.json');
}


/** Prefix of private backups written for the VS Code extension, which its uninstall removes. */
export const EXTENSION_BACKUP_PREFIX = `${EXTENSION_ORIGIN}-`;
/** Creates a private backup directory, tagged when the VS Code extension made the change. */
export function backupDirectory(root: string, origin?: RegistrationOrigin): string {
  const directory = path.join(root, 'setup-backups', `${origin ? EXTENSION_BACKUP_PREFIX : ''}${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function writeChecked(file: string, before: string | null, after: string): void {
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
export function readSelection(file: string, snapshot?: string | null): Selection {
  const content = snapshot === undefined ? read(file) : snapshot;
  if (content === null) return { clients: [], owned: {}, origin: {} };
  const data = json(content);
  if (!Array.isArray(data.clients) || !data.clients.every(client => SETUP_CLIENTS.includes(client as SetupClient))) throw new Error('Invalid saved setup selections.');
  const owned: Selection['owned'] = {};
  if (data.owned) for (const [client, value] of Object.entries(object(data.owned))) {
    if (!SETUP_CLIENTS.includes(client as SetupClient)) throw new Error('Invalid setup ownership record.');
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid setup ownership fingerprint.');
    owned[client as SetupClient] = value;
  }
  const origin: Selection['origin'] = {};
  if (data.origin) for (const [client, value] of Object.entries(object(data.origin))) {
    if (!SETUP_CLIENTS.includes(client as SetupClient) || value !== EXTENSION_ORIGIN || !owned[client as SetupClient]) throw new Error('Invalid setup origin record.');
    origin[client as SetupClient] = value;
  }
  return { clients: [...new Set(data.clients)] as SetupClient[], owned, origin };
}
