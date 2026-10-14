/**
 * Bounded configuration parsing, private state and conflict-checked setup writes.
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { parse, parseTree, type ParseError, type Node as JsonNode } from 'jsonc-parser';
import { readBoundedFileSync } from '../storage/read.js';
import { object } from './rpc.js';
import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
export interface Registration { command: string; args: string[]; env?: Record<string, string> }
/** Registrations written on behalf of the VS Code extension, which removes them on uninstall. */
export const EXTENSION_ORIGIN = 'vscode-extension' as const;
/** Shared configuration file used by a runtime started with this setup environment. */
export function setupConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  return path.resolve(env.coagent8_CONFIG || path.join(env.coagent8_DIR || path.join(home, '.coagent8'), 'config.json'));
}
export type RegistrationOrigin = typeof EXTENSION_ORIGIN;
/**
 * Saved selections and ownership; `origin` is absent for the CLI and for earlier records.
 * `skills` holds the digests of the skill packages setup wrote per client, and `skillOrigin`
 * marks those the VS Code extension wrote; both are omitted from the file while empty.
 */
export interface Selection {
  clients: SetupClient[];
  owned: Partial<Record<SetupClient, string>>;
  origin: Partial<Record<SetupClient, RegistrationOrigin>>;
  skills: Partial<Record<SetupClient, Record<string, string>>>;
  /** Owned disabled packages stored outside client discovery. */
  disabledSkills?: Partial<Record<SetupClient, Record<string, string>>>;
  /** Per-package origin, allowing VSIX and CLI installations to coexist. */
  skillOwners?: Partial<Record<SetupClient, Record<string, RegistrationOrigin | 'cli'>>>;
  skillOrigin: Partial<Record<SetupClient, RegistrationOrigin>>;
}
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
/** Parses a JSON/JSONC configuration object, rejecting syntax errors and duplicate keys. */
export function json(text: string): Record<string, unknown> {
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
  if (content === null) return { clients: [], owned: {}, origin: {}, skills: {}, skillOrigin: {} };
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
  function skillRecords(records: unknown): Selection['skills'] {
    const skills: Selection['skills'] = {};
    if (records !== undefined) for (const [client, value] of Object.entries(object(records))) {
    const record = object(value);
    if (!SETUP_CLIENTS.includes(client as SetupClient) || !Object.entries(record).every(([name, digest]) => /^coagent8-[a-z]+(?:-[a-z]+)*$/.test(name) && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))) {
      throw new Error('Invalid setup skill record.');
    }
    skills[client as SetupClient] = { ...record } as Record<string, string>;
    }
    return skills;
  }
  const skills = skillRecords(data.skills), disabledSkills = skillRecords(data.disabledSkills);
  const skillOwners: NonNullable<Selection['skillOwners']> = {};
  if (data.skillOwners !== undefined) for (const [client, record] of Object.entries(object(data.skillOwners))) {
    if (!SETUP_CLIENTS.includes(client as SetupClient)) throw new Error('Invalid skill owner client.');
    const owners: Record<string, RegistrationOrigin | 'cli'> = {};
    for (const [name, origin] of Object.entries(object(record))) {
      if ((origin !== EXTENSION_ORIGIN && origin !== 'cli') || (!skills[client as SetupClient]?.[name] && !disabledSkills[client as SetupClient]?.[name])) throw new Error('Invalid skill package owner.');
      owners[name] = origin;
    }
    if (Object.keys(owners).length) skillOwners[client as SetupClient] = owners;
  }
  const skillOrigin: Selection['skillOrigin'] = {};
  if (data.skillOrigin) for (const [client, value] of Object.entries(object(data.skillOrigin))) {
    if (!SETUP_CLIENTS.includes(client as SetupClient) || value !== EXTENSION_ORIGIN || (!skills[client as SetupClient] && !disabledSkills[client as SetupClient])) throw new Error('Invalid setup skill origin record.');
    skillOrigin[client as SetupClient] = value;
  }
  return { clients: [...new Set(data.clients)] as SetupClient[], owned, origin, skills, skillOrigin, ...(Object.keys(disabledSkills).length ? { disabledSkills } : {}), ...(Object.keys(skillOwners).length ? { skillOwners } : {}) };
}
/** The setup state file's contents; empty skill records are left out, as earlier versions wrote it. */
export function serializeSelection(saved: Selection): string {
  const { skills, disabledSkills, skillOrigin, skillOwners, ...rest } = saved;
  const recorded = Object.fromEntries(Object.entries(skills).filter(([, record]) => Object.keys(record ?? {}).length));
  const disabled = Object.fromEntries(Object.entries(disabledSkills ?? {}).filter(([, record]) => Object.keys(record ?? {}).length));
  const origins = Object.fromEntries(Object.entries(skillOrigin).filter(([client]) => Object.hasOwn(recorded, client) || Object.hasOwn(disabled, client)));
  const packageOwners = Object.fromEntries(Object.entries(skillOwners ?? {}).map(([client, owners]) => [client, Object.fromEntries(Object.entries(owners ?? {}).filter(([name]) => saved.skills[client as SetupClient]?.[name] || saved.disabledSkills?.[client as SetupClient]?.[name]))]).filter(([, owners]) => Object.keys(owners).length));
  return JSON.stringify({ ...rest, ...(Object.keys(recorded).length ? { skills: recorded } : {}), ...(Object.keys(disabled).length ? { disabledSkills: disabled } : {}), ...(Object.keys(origins).length ? { skillOrigin: origins } : {}), ...(Object.keys(packageOwners).length ? { skillOwners: packageOwners } : {}) }, null, 2) + '\n';
}

/** Codex stops an MCP tool call after 60 s by default; a review can take several minutes. */
export const CODEX_TOOL_TIMEOUT_SEC = 1800;
/** Folder of the VS Code extension's global storage (`<publisher>.<name>`), the data directory of its registrations. */
export const EXTENSION_STORAGE_NAME = 'okidev.coagent8-mcp';
const SETUP_ENTRY_ENV = ['coagent8_CONFIG', 'coagent8_DIR'];

/** Whether a data directory is the VS Code extension's global storage, in any profile or VS Code variant. */
function extensionStorage(directory: string | undefined): boolean {
  return directory !== undefined && path.basename(directory).toLowerCase() === EXTENSION_STORAGE_NAME
    && path.basename(path.dirname(directory)).toLowerCase() === 'globalstorage';
}

/** Whether semantic version `a` is strictly newer than `b` (numeric `X.Y.Z`, ignoring pre-release suffixes). */
export function newerVersion(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const parseParts = (v: string) => v.replace(/-.*$/, '').split('.').map(Number);
  const [x, y] = [parseParts(a), parseParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * Reads or extracts the version of a CoAgent8 runtime bundle.
 * Checks for a sibling `version.json` file first; otherwise scans for `SERVER_VERSION` in the bundle.
 */
export function extractRuntimeVersion(runtimePath: string): string | null {
  try {
    const dir = path.dirname(runtimePath);
    const versionFile = path.join(dir, 'version.json');
    if (fs.existsSync(versionFile)) {
      const parsed = JSON.parse(readBoundedFileSync(versionFile, 64 * 1024));
      if (typeof parsed?.version === 'string' && parsed.version.length > 0) return parsed.version;
    }
  } catch {
    // Fall back to bundle content inspection
  }
  try {
    const content = readBoundedFileSync(runtimePath, 4 * 1024 * 1024);
    const match = /SERVER_VERSION:\s*[`'"]([^`'"]+)[`'"]/.exec(content);
    if (match?.[1]) return match[1];
  } catch {
    return null;
  }
  return null;
}

/** Whether a command resolves to Node (`process.execPath` or a candidate `nodePath`). */
function isNodeCommand(command: string, nodePath?: string): boolean {
  if (typeof command !== 'string' || !command) return false;
  const base = path.basename(command).toLowerCase();
  const name = base.endsWith('.exe') ? base.slice(0, -4) : base;
  if (name === 'node') return true;
  const same = (a: string, b: string) => {
    try {
      const realA = fs.realpathSync.native(a);
      const realB = fs.realpathSync.native(b);
      return process.platform === 'win32' ? realA.toLowerCase() === realB.toLowerCase() : realA === realB;
    } catch {
      return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
    }
  };
  if (same(command, process.execPath)) return true;
  if (nodePath && same(command, nodePath)) return true;
  return false;
}

/**
 * Extracts and strictly validates the runtime path from a CoAgent8 stdio registration entry.
 * @param entry - The candidate registration entry or object containing `args`.
 * @param root - The base runtime root (e.g. `~/.coagent8`), or omitted to resolve from environment/globalStorage.
 * @param argsPrefix - Optional permitted launcher argument prefix from resolved Node CLI.
 * @returns The validated absolute runtime path, or null if the layout, containment, or path shape is invalid.
 * @remarks
 * Recognizes modern `[...node.argsPrefix, runtimePath, 'mcp']` and legacy
 * `[...node.argsPrefix, runtimePath]` argument layouts. The candidate path must resolve
 * inside the owned runtime root or extension global storage with a 64-character hex subdirectory
 * and `index.cjs` basename. Foreign tokens or extra flags yield null.
 */
export function extractRuntimePath(entry: unknown, root?: string, argsPrefix?: string[]): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const rawArgs = (entry as { args?: unknown }).args;
  if (!Array.isArray(rawArgs) || !rawArgs.every(arg => typeof arg === 'string') || rawArgs.length === 0) return null;
  const args = rawArgs as string[];

  let candidate: string | undefined;
  const last = args.at(-1);
  if (last === 'mcp') {
    if (argsPrefix !== undefined) {
      if (args.length !== argsPrefix.length + 2) return null;
      for (let i = 0; i < argsPrefix.length; i++) {
        if (args[i] !== argsPrefix[i]) return null;
      }
    } else {
      if (args.length !== 2) return null;
    }
    candidate = args.at(-2);
  } else if (typeof last === 'string' && path.isAbsolute(last) && last.endsWith('index.cjs')) {
    if (argsPrefix !== undefined) {
      if (args.length !== argsPrefix.length + 1) return null;
      for (let i = 0; i < argsPrefix.length; i++) {
        if (args[i] !== argsPrefix[i]) return null;
      }
    } else {
      if (args.length !== 1) return null;
    }
    candidate = last;
  } else {
    return null;
  }

  if (!candidate || typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;

  const normalizedCandidate = path.resolve(candidate);
  if (path.basename(normalizedCandidate) !== 'index.cjs') return null;

  const shaDir = path.dirname(normalizedCandidate);
  const sha = path.basename(shaDir);
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;

  const runtimeDir = path.dirname(shaDir);
  if (path.basename(runtimeDir) !== 'runtime') return null;

  const storageRoot = path.dirname(runtimeDir);

  // Validate env.coagent8_DIR type if present; reject malformed non-string values
  let envDir: string | undefined;
  if ('env' in entry && (entry as { env?: unknown }).env && typeof (entry as { env?: unknown }).env === 'object') {
    const rawEnv = (entry as { env: Record<string, unknown> }).env;
    if (typeof rawEnv.coagent8_DIR === 'string') {
      envDir = rawEnv.coagent8_DIR;
    } else if (rawEnv.coagent8_DIR !== undefined) {
      return null;
    }
  }

  const isMatch = (target: string) => {
    const normTarget = path.resolve(target);
    return process.platform === 'win32'
      ? storageRoot.toLowerCase() === normTarget.toLowerCase()
      : storageRoot === normTarget;
  };

  const isExtension = extensionStorage(storageRoot);

  if (root && isMatch(root)) {
    // Resolves inside the supplied runtime root (~/.coagent8)
  } else if (isExtension && (!envDir || (extensionStorage(envDir) && isMatch(envDir)))) {
    // Resolves inside verified extension globalStorage
  } else if (!root && !envDir && path.basename(storageRoot).toLowerCase() === '.coagent8') {
    // Default fallback when neither root nor envDir is provided
  } else {
    return null;
  }

  return normalizedCandidate;
}

/**
 * Recognizes an entry setup wrote by its shape, for when its ownership record is missing,
 * as after `~/.coagent8/setup.json` was deleted: it starts a runtime copy setup keeps in
 * `<root>/runtime/<sha256>/index.cjs` and holds only the fields setup writes. Nothing else
 * writes there; an entry with any other field, command, foreign token or variable stays the user's.
 * @param client - The setup client whose registration is inspected.
 * @param entry - The candidate configuration entry.
 * @param root - The `~/.coagent8` directory.
 * @param nodePath - Optional Node executable path to recognize alongside process.execPath.
 * @param argsPrefix - Optional permitted launcher argument prefix from resolved Node CLI.
 * @returns Null for any other entry; otherwise the VS Code extension as its origin when its
 * data directory is the extension's global storage, which VS Code deletes on uninstall.
 */
export function setupShapedEntry(client: SetupClient, entry: unknown, root: string, nodePath?: string, argsPrefix?: string[]): { origin?: RegistrationOrigin } | null {
  let parsed: Registration;
  try { parsed = registration(entry); }
  catch { return null; }
  const extra: Record<string, unknown> = client === 'codex' ? { tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC } : {};
  const fields = object(entry);
  if (!Object.keys(fields).every(key => ['command', 'args', 'env'].includes(key) || (Object.hasOwn(extra, key) && fields[key] === extra[key]))) return null;
  if (!Object.keys(parsed.env ?? {}).every(key => SETUP_ENTRY_ENV.includes(key))) return null;
  if (!isNodeCommand(parsed.command, nodePath)) return null;
  const runtime = extractRuntimePath(parsed, root, argsPrefix);
  if (runtime === null) return null;
  return extensionStorage(parsed.env?.coagent8_DIR) ? { origin: EXTENSION_ORIGIN } : {};
}

/**
 * Whether setup owns a client's CoAgent8 entry and on whose behalf it wrote it: the recorded
 * fingerprint, else the shape only setup writes ({@link setupShapedEntry}).
 * @param client - The setup client whose registration is inspected.
 * @param entry - The candidate configuration entry.
 * @param saved - Active selection and ownership fingerprints.
 * @param root - The `~/.coagent8` directory.
 * @param nodePath - Optional Node executable path to recognize alongside process.execPath.
 * @param argsPrefix - Optional permitted launcher argument prefix from resolved Node CLI.
 * @returns Ownership state and optional registration origin.
 */
export function entryOwnership(client: SetupClient, entry: unknown, saved: Selection, root: string, nodePath?: string, argsPrefix?: string[]): { owned: boolean; origin?: RegistrationOrigin } {
  if (saved.owned[client] === hash(JSON.stringify(entry))) return { owned: true, origin: saved.origin[client] };
  const shaped = setupShapedEntry(client, entry, root, nodePath, argsPrefix);
  return shaped ? { owned: true, ...shaped } : { owned: false };
}
