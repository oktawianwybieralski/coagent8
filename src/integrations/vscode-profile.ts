/**
 * The VS Code extension's CoAgent8 entry in the editor profile's `mcp.json`.
 *
 * @remarks
 * VS Code lists only `mcp.json` entries and gallery installs as installed MCP servers ("User"
 * in the Agent Customizations editor, "MCP Servers - Installed" in the Extensions view); a
 * `mcpServerDefinitionProviders` server appears only under "Extensions". The extension
 * therefore keeps one stdio entry in its profile's `mcp.json`, started from a copy of the
 * bundle in its global storage, so the entry outlives an extension update until the new
 * version activates and rewrites it.
 *
 * Ownership is recorded in `~/.coagent8/vscode-mcp.json`, which survives the uninstall: the
 * `vscode:uninstall` hook removes each entry of its own VS Code installation that is still
 * exactly as written. Other installations (Stable, Insiders) share the file and keep theirs. An entry the
 * user edited or wrote is theirs and is never changed; an entry the user removed is not
 * added again until they ask for it.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, applyEdits, modify, type ParseError } from 'jsonc-parser';
import { readBoundedFileSync } from '../storage/read.js';
import { withFileLock } from '../storage/lock.js';
import { object } from './rpc.js';
import { EXTENSION_STORAGE_NAME, hash, json, read, writeChecked } from './setup-storage.js';

/** The entry's name, which VS Code shows in its MCP server lists. */
export const VSCODE_SERVER_NAME = 'CoAgent8';
/** The stdio server the extension starts: the command and environment of its definition. */
export interface VscodeServer { command: string; env: Record<string, string> }
/**
 * Result of a synchronization: the entry was written (`registered`) or already matched
 * (`current`), another CoAgent8 entry in the profile is the user's (`manual`), or the user
 * removed the extension's entry (`declined`).
 */
export type VscodeRegistration = 'registered' | 'current' | 'manual' | 'declined';
/**
 * Ownership per profile `mcp.json`: the digest of the entry written, or the user's removal;
 * `pending` is the digest of an entry being written, until the write completes.
 */
/**
 * Per profile `mcp.json`: the entry written, the user's removal, or only the digest pending
 * while a first write is under way.
 */
type RegistrationRecord = Record<string, ({ entry: string; version?: string } | { declined: true } | { pending: string }) & { pending?: string; pendingVersion?: string; installation: string }>;

const FORMATTING = { insertSpaces: true, tabSize: 2 };
const RUNTIME_SHAPE = new RegExp(`[\\\\/]globalStorage[\\\\/]${EXTENSION_STORAGE_NAME.replace('.', '\\.')}[\\\\/]runtime[\\\\/][a-f0-9]{64}[\\\\/]index\\.cjs$`, 'i');

/** The `mcp.json` of the profile whose global storage is `storagePath`. */
export function profileMcpFile(storagePath: string): string {
  return path.join(path.dirname(path.dirname(storagePath)), 'mcp.json');
}
/**
 * The lease every VS Code window holds while it synchronizes or removes profile entries: copying
 * a runtime, writing the entry and record, and pruning copies happen as one step, so no window
 * deletes a copy another is about to register.
 */
function leaseResource(home: string): string {
  return path.join(home, '.coagent8', 'vscode-mcp');
}
function recordFile(home: string): string {
  return path.join(home, '.coagent8', 'vscode-mcp.json');
}
function readRecord(home: string): { text: string | null; record: RegistrationRecord } {
  const text = read(recordFile(home));
  return { text, record: text === null ? {} : json(text) as RegistrationRecord };
}
/** Writes the record, or removes its file when it is empty; returns the text now on disk. */
function writeRecord(home: string, before: string | null, record: RegistrationRecord): string | null {
  const file = recordFile(home);
  if (!Object.keys(record).length) {
    if (read(file) !== before) throw new Error('Configuration changed concurrently; setup did not overwrite it.');
    fs.rmSync(file, { force: true });
    return null;
  }
  const text = JSON.stringify(record, null, 2) + '\n';
  writeChecked(file, before, text);
  return text;
}
/** Whether extension version `a` is newer than `b` (numeric `X.Y.Z`, no pre-release suffix). */
function newerVersion(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const [x, y] = [a, b].map(value => value.split('.').map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}
/**
 * The window that recorded the entry with `digest`: the written entry, or the pending one of an
 * interrupted rewrite, each with the extension version that wrote it.
 */
function recordedWriter(recorded: RegistrationRecord[string], digest: string): { version?: string } | undefined {
  if ('entry' in recorded && recorded.entry === digest) return { version: recorded.version };
  if (recorded.pending === digest) return { version: recorded.pendingVersion };
  return undefined;
}
/** Whether two installation folders are the same; Windows paths ignore case. */
function sameInstallation(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const normal = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normal(a) === normal(b);
}
/** Whether an entry has the shape only this extension writes: its bundle copy in global storage. */
function extensionShaped(entry: unknown): boolean {
  const args = object(entry).args;
  return Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' && RUNTIME_SHAPE.test(args[0]);
}
/**
 * Whether the extension owns a profile's entry: a recorded digest, written or pending, must
 * match, so an entry the user edited is theirs even while it still starts the runtime copy.
 * Only without any record (lost) does the shape identify the entry.
 */
function owned(entry: unknown, recorded: RegistrationRecord[string] | undefined): boolean {
  if (entry === undefined) return false;
  if (recorded === undefined) return extensionShaped(entry);
  const digest = hash(JSON.stringify(entry));
  return ('entry' in recorded && recorded.entry === digest) || recorded.pending === digest;
}
function profileServers(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const servers = json(text).servers;
  return servers === undefined ? {} : object(servers);
}
const mentionsCoagent = ([name, entry]: [string, unknown]) => /coagent8/i.test(name) || /coagent8/i.test(JSON.stringify(entry));

/**
 * Detects CoAgent8 definitions in the active editor profile and workspace, the extension's
 * own entry included, so the definition provider never adds a second server.
 * @param storagePath - VS Code's globalStorageUri path for this extension/profile.
 * @param folders - Workspace folder paths on the current extension host.
 * @returns True when an `mcp.json` entry already provides CoAgent8.
 * @throws When an existing MCP file is malformed or unreadable; preserve it.
 * @remarks No other editor profile or machine is read or changed.
 */
export function hasManualVscodeRegistration(storagePath: string, folders: string[]): boolean {
  return [profileMcpFile(storagePath), ...workspaceMcpFiles(folders)].some(fileProvidesCoagent);
}
/**
 * Detects CoAgent8 definitions in the workspace's `.vscode/mcp.json` files, which VS Code
 * lists beside the profile's entry as a separate server.
 * @param folders - Workspace folder paths on the current extension host.
 * @throws When an existing MCP file is malformed or unreadable; preserve it.
 */
export function hasWorkspaceVscodeRegistration(folders: string[]): boolean {
  return workspaceMcpFiles(folders).some(fileProvidesCoagent);
}
function workspaceMcpFiles(folders: string[]): string[] {
  return folders.map(folder => path.join(folder, '.vscode', 'mcp.json'));
}
function fileProvidesCoagent(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const errors: ParseError[] = [];
  const value: unknown = parse(readBoundedFileSync(file, 512 * 1024), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Existing VS Code MCP configuration is malformed; preserve it before setup.');
  const servers = object(value).servers;
  return servers !== undefined && Object.entries(object(servers)).some(mentionsCoagent);
}

/** Copies the bundle to `<storage>/runtime/<sha256>/index.cjs` once and returns the copy. */
function runtimeCopy(storagePath: string, bundle: string): string {
  const content = fs.readFileSync(bundle);
  const directory = path.join(storagePath, 'runtime', hash(content)), target = path.join(directory, 'index.cjs');
  if (fs.existsSync(target) && hash(fs.readFileSync(target)) === path.basename(directory)) return target;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}
/** Removes bundle copies in global storage that the profile entry no longer starts. */
function pruneRuntimes(storagePath: string, keep: string): void {
  const root = path.join(storagePath, 'runtime');
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (/^[a-f0-9]{64}$/.test(name) && path.join(root, name) !== path.dirname(keep)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

/**
 * Keeps the extension's CoAgent8 entry in its profile `mcp.json` equal to `server`.
 * @param options - `storagePath`, the extension's global storage in this profile; `bundle`,
 * the runtime bundle shipped with the running extension; `home`, the directory holding
 * `~/.coagent8`; `folders`, the window's workspace folders; `restore`, which adds the entry
 * again after the user removed it or while a workspace provides CoAgent8.
 * @remarks The entry serves every window of the profile, so it is not added while this
 * window's workspace registers CoAgent8 (VS Code would list both), and never removed for it:
 * windows of other workspaces would add it back.
 * Runs under the lease of `~/.coagent8` that every window and the uninstall hook share.
 * @throws When the profile `mcp.json` or the ownership record is malformed or unreadable,
 * when another process keeps changing them, or when the lease is not acquired in time.
 */
export async function syncVscodeRegistration(options: VscodeSyncOptions): Promise<VscodeRegistration> {
  return withFileLock(leaseResource(options.home), async () => {
    for (let attempt = 0; ; attempt++) {
      try { return syncOnce(options); }
      catch (error) {
        // VS Code or the user wrote mcp.json at the same time; read their result again.
        if (attempt < 2 && error instanceof Error && /changed concurrently/.test(error.message)) continue;
        throw error;
      }
    }
  });
}
/** Inputs of {@link syncVscodeRegistration}. */
export interface VscodeSyncOptions {
  storagePath: string; bundle: string; server: VscodeServer; home: string;
  /** The extensions folder of this VS Code installation; its uninstall removes only its entries. */
  installation: string;
  /** The running extension's version; an older one never replaces a newer one's entry. */
  version: string;
  /**
   * Another window may have written the profile file (its watcher fired): a complete entry it
   * recorded is kept, so windows whose environments differ never rewrite it in turn.
   */
  adopt?: boolean;
  folders?: string[]; restore?: boolean;
}
function syncOnce({ storagePath, bundle, server, home, installation, version, adopt = false, folders = [], restore = false }: VscodeSyncOptions): VscodeRegistration {
  const file = profileMcpFile(storagePath);
  const { text: recordText, record } = readRecord(home);
  const text = read(file);
  const servers = profileServers(text);
  const current = servers[VSCODE_SERVER_NAME];
  const recorded = record[file];
  const ours = owned(current, recorded);
  if (current !== undefined && !ours) return 'manual';
  if (Object.entries(servers).some(entry => entry[0] !== VSCODE_SERVER_NAME && mentionsCoagent(entry))) {
    // The user's own entry provides CoAgent8; a second one would list every tool twice.
    if (ours) {
      writeChecked(file, text, applyEdits(text!, modify(text!, ['servers', VSCODE_SERVER_NAME], undefined, { formattingOptions: FORMATTING })));
      writeRecord(home, recordText, Object.fromEntries(Object.entries(record).filter(([key]) => key !== file)));
    }
    return 'manual';
  }
  // A record of only a pending digest is a first write that did not finish, not a removal.
  if (!restore && current === undefined && recorded !== undefined && ('entry' in recorded || 'declined' in recorded)) {
    // The user removed the entry in VS Code: remember it, never add it back unasked.
    if (!('declined' in recorded) || !sameInstallation(recorded.installation, installation)) writeRecord(home, recordText, { ...record, [file]: { declined: true, installation } });
    return 'declined';
  }
  // This window's workspace provides CoAgent8; nothing is recorded, so other windows add the entry.
  if (!restore && current === undefined && hasWorkspaceVscodeRegistration(folders)) return 'manual';
  // Every window of the profile shares the entry. One a window recorded, written or pending, is
  // kept when this window only reacts to that write, or when a newer extension version wrote
  // it: this window neither replaces it nor deletes the runtime copy it starts.
  const writer = ours && recorded !== undefined ? recordedWriter(recorded, hash(JSON.stringify(current))) : undefined;
  if (writer && (adopt || newerVersion(writer.version, version))) return 'current';
  const runtime = runtimeCopy(storagePath, bundle);
  const desired = { type: 'stdio', command: server.command, args: [runtime], env: server.env };
  if (ours && JSON.stringify(current) === JSON.stringify(desired)) {
    if (!recorded || !('entry' in recorded) || recorded.entry !== hash(JSON.stringify(current)) || recorded.pending !== undefined || recorded.version !== version || !sameInstallation(recorded.installation, installation)) {
      writeRecord(home, recordText, { ...record, [file]: { entry: hash(JSON.stringify(current)), version, installation } });
    }
    pruneRuntimes(storagePath, runtime);
    return 'current';
  }
  const base = text ?? '{}\n';
  const after = applyEdits(base, modify(base, ['servers', VSCODE_SERVER_NAME], desired, { formattingOptions: { ...FORMATTING, eol: base.includes('\r\n') ? '\r\n' : '\n' } }));
  const digest = hash(JSON.stringify(profileServers(after)[VSCODE_SERVER_NAME]));
  // Record the digest being written first, the first write included: should the write below be
  // interrupted, the entry, old or new, is still ours and the uninstall finds it, while an edit or
  // removal racing it stays the user's. The entry on disk, when ours, is the one recorded as
  // written, whichever digest identified it.
  const written = ours ? { entry: hash(JSON.stringify(current)), ...(writer?.version ? { version: writer.version } : {}) } : recorded ?? {};
  const marked = writeRecord(home, recordText, { ...record, [file]: { ...written, pending: digest, pendingVersion: version, installation } });
  writeChecked(file, text, after);
  writeRecord(home, marked, { ...record, [file]: { entry: digest, version, installation } });
  pruneRuntimes(storagePath, runtime);
  return 'registered';
}

/** Outcome of the uninstall cleanup for one profile `mcp.json`. */
export interface VscodeRemoval { file: string; action: 'removed' | 'preserved' | 'missing' }
/**
 * Removes every entry this installation recorded that is still exactly as the extension wrote
 * it, then its records. Runs from the `vscode:uninstall` hook, without the VS Code API.
 * @param home - The directory holding `~/.coagent8`.
 * @param installation - The extensions folder of the VS Code installation being uninstalled.
 * @param leaseTimeoutMs - How long to wait for the lease a synchronizing window holds; the
 * hook has a time limit of its own.
 * @returns One result per profile of this installation; edited entries are preserved, and
 * other installations' entries and records are left alone.
 * @throws When the lease is not acquired within `leaseTimeoutMs`; no entry is changed then.
 */
export async function removeVscodeRegistrations(home: string, installation: string, leaseTimeoutMs: number): Promise<VscodeRemoval[]> {
  return withFileLock(leaseResource(home), async () => removeOwned(home, installation), leaseTimeoutMs);
}
function removeOwned(home: string, installation: string): VscodeRemoval[] {
  const { text: recordText, record } = readRecord(home);
  const results: VscodeRemoval[] = [];
  // A record naming no installation was written by an unreleased build before 0.6.0; it is left
  // alone like another installation's (owner decision 2026-10-11: no migration before 0.6.0).
  const others = Object.fromEntries(Object.entries(record).filter(([, recorded]) => !sameInstallation(recorded.installation, installation)));
  for (const [file, recorded] of Object.entries(record)) {
    if (file in others) continue;
    const text = read(file);
    const current = profileServers(text)[VSCODE_SERVER_NAME];
    if (text === null || current === undefined) { results.push({ file, action: 'missing' }); continue; }
    if (!owned(current, recorded)) { results.push({ file, action: 'preserved' }); continue; }
    writeChecked(file, text, applyEdits(text, modify(text, ['servers', VSCODE_SERVER_NAME], undefined, { formattingOptions: FORMATTING })));
    results.push({ file, action: 'removed' });
  }
  writeRecord(home, recordText, others);
  return results;
}
