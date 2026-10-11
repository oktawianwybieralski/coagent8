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
 * `vscode:uninstall` hook removes each entry that is still exactly as written. An entry the
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
/** Ownership per profile `mcp.json`: the digest of the entry written, or the user's removal. */
type RegistrationRecord = Record<string, { entry: string } | { declined: true }>;

const FORMATTING = { insertSpaces: true, tabSize: 2 };
const RUNTIME_SHAPE = new RegExp(`[\\\\/]globalStorage[\\\\/]${EXTENSION_STORAGE_NAME.replace('.', '\\.')}[\\\\/]runtime[\\\\/][a-f0-9]{64}[\\\\/]index\\.cjs$`, 'i');

/** The `mcp.json` of the profile whose global storage is `storagePath`. */
export function profileMcpFile(storagePath: string): string {
  return path.join(path.dirname(path.dirname(storagePath)), 'mcp.json');
}
function recordFile(home: string): string {
  return path.join(home, '.coagent8', 'vscode-mcp.json');
}
function readRecord(home: string): { text: string | null; record: RegistrationRecord } {
  const text = read(recordFile(home));
  return { text, record: text === null ? {} : json(text) as RegistrationRecord };
}
function writeRecord(home: string, before: string | null, record: RegistrationRecord): void {
  const file = recordFile(home);
  if (!Object.keys(record).length) {
    if (read(file) !== before) throw new Error('Configuration changed concurrently; setup did not overwrite it.');
    fs.rmSync(file, { force: true });
    return;
  }
  writeChecked(file, before, JSON.stringify(record, null, 2) + '\n');
}
/** Whether an entry has the shape only this extension writes: its bundle copy in global storage. */
function extensionShaped(entry: unknown): boolean {
  const args = object(entry).args;
  return Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' && RUNTIME_SHAPE.test(args[0]);
}
function owned(entry: unknown, recorded: RegistrationRecord[string] | undefined): boolean {
  return entry !== undefined && ((recorded !== undefined && 'entry' in recorded && recorded.entry === hash(JSON.stringify(entry))) || extensionShaped(entry));
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
  const files = [profileMcpFile(storagePath), ...folders.map(folder => path.join(folder, '.vscode', 'mcp.json'))];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const errors: ParseError[] = [];
    const value: unknown = parse(readBoundedFileSync(file, 512 * 1024), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('Existing VS Code MCP configuration is malformed; preserve it before setup.');
    const servers = object(value).servers;
    if (servers === undefined) continue;
    if (Object.entries(object(servers)).some(mentionsCoagent)) return true;
  }
  return false;
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
 * `~/.coagent8`; `restore`, which adds the entry again after the user removed it.
 * @throws When the profile `mcp.json` or the ownership record is malformed or unreadable,
 * or when another process keeps changing them.
 */
export function syncVscodeRegistration(options: { storagePath: string; bundle: string; server: VscodeServer; home: string; restore?: boolean }): VscodeRegistration {
  for (let attempt = 0; ; attempt++) {
    try { return syncOnce(options); }
    catch (error) {
      // Another window of the same profile wrote at the same time; read its result again.
      if (attempt < 2 && error instanceof Error && /changed concurrently/.test(error.message)) continue;
      throw error;
    }
  }
}
function syncOnce({ storagePath, bundle, server, home, restore = false }: { storagePath: string; bundle: string; server: VscodeServer; home: string; restore?: boolean }): VscodeRegistration {
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
  if (!restore && current === undefined && recorded !== undefined) {
    // The user removed the entry in VS Code: remember it, never add it back unasked.
    if (!('declined' in recorded)) writeRecord(home, recordText, { ...record, [file]: { declined: true } });
    return 'declined';
  }
  const runtime = runtimeCopy(storagePath, bundle);
  const desired = { type: 'stdio', command: server.command, args: [runtime], env: server.env };
  if (ours && JSON.stringify(current) === JSON.stringify(desired)) {
    if (!recorded || !('entry' in recorded) || recorded.entry !== hash(JSON.stringify(current))) writeRecord(home, recordText, { ...record, [file]: { entry: hash(JSON.stringify(current)) } });
    pruneRuntimes(storagePath, runtime);
    return 'current';
  }
  const base = text ?? '{}\n';
  const after = applyEdits(base, modify(base, ['servers', VSCODE_SERVER_NAME], desired, { formattingOptions: { ...FORMATTING, eol: base.includes('\r\n') ? '\r\n' : '\n' } }));
  writeChecked(file, text, after);
  // Should this write be interrupted, the entry's shape still identifies it as ours.
  writeRecord(home, recordText, { ...record, [file]: { entry: hash(JSON.stringify(profileServers(after)[VSCODE_SERVER_NAME])) } });
  pruneRuntimes(storagePath, runtime);
  return 'registered';
}

/** Outcome of the uninstall cleanup for one profile `mcp.json`. */
export interface VscodeRemoval { file: string; action: 'removed' | 'preserved' | 'missing' }
/**
 * Removes every recorded entry that is still exactly as the extension wrote it, then the
 * record. Runs from the `vscode:uninstall` hook, without the VS Code API.
 * @returns One result per recorded profile; edited entries are preserved.
 */
export function removeVscodeRegistrations(home: string): VscodeRemoval[] {
  const { text: recordText, record } = readRecord(home);
  const results: VscodeRemoval[] = [];
  for (const [file, recorded] of Object.entries(record)) {
    const text = read(file);
    const current = profileServers(text)[VSCODE_SERVER_NAME];
    if (text === null || current === undefined) { results.push({ file, action: 'missing' }); continue; }
    if (!owned(current, recorded)) { results.push({ file, action: 'preserved' }); continue; }
    writeChecked(file, text, applyEdits(text, modify(text, ['servers', VSCODE_SERVER_NAME], undefined, { formattingOptions: FORMATTING })));
    results.push({ file, action: 'removed' });
  }
  writeRecord(home, recordText, {});
  return results;
}
