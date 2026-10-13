import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedFileSync } from '../../../src/storage/read.js';
import { withFileLock } from '../../../src/storage/lock.js';

/** Writes `content` to `file` through a temporary file in the same directory. */
function replaceFile(file: string, content: string): void {
  const temporary = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/**
 * Replaces the configuration file with the defaults after the user confirmed it.
 * @param defaults - Validated default configuration.
 * @returns The single backup (`<file>.backup`, replaced by the next reset), or undefined
 * when there was no file.
 * @throws When the file changes while it is being reset, or cannot be read or written.
 */
export async function resetConfigurationFile(file: string, defaults: unknown): Promise<string | undefined> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    let previous: string | undefined;
    try { previous = readBoundedFileSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const backup = previous === undefined ? undefined : `${file}.backup`;
    if (backup) replaceFile(backup, previous!);
    if (previous !== undefined && readBoundedFileSync(file) !== previous) throw new Error('Configuration changed during reset; retry.');
    replaceFile(file, JSON.stringify(defaults, null, 2) + '\n');
    return backup;
  });
}

/** Onboarding state; kept in the extension's global storage so uninstalling removes it. */
export interface SetupState {
  /** The first-activation notice was shown; later activations start no CLI check. */
  welcomed?: boolean;
  /** The runtime (`<version>#<sha-256>`) whose outdated CLI chat registrations were last offered for update. */
  updateOffered?: string;
  /** Vendor extensions whose removal the user started from a CLI menu, finished once VS Code has removed them. */
  removingExtensions?: string[];
  /** State of the PATH opt-in prompt. */
  pathPrompt?: 'accepted' | 'declined' | 'dismissed';
}
/**
 * What CoAgent8 installed. It is kept in `~/.coagent8/installs.json`, outside the
 * extension's storage, so that it survives an uninstall from the Extensions view and
 * **Manage Coding CLIs** can still offer to remove it after CoAgent8 is installed again.
 */
export interface InstallRecord {
  /** Vendor extensions that CoAgent8 installed; only these are offered for removal. */
  installedExtensions?: string[];
  /** CLIs whose official standalone installer setup opened; one counts as installed once a check finds it. */
  pendingClis?: string[];
  /** CLIs that CoAgent8 installed with the official standalone installer; only these are offered for removal. */
  installedClis?: string[];
}
/** The lists of what CoAgent8 setup installed. */
export type SetupInstallList = keyof InstallRecord;
const INSTALL_LISTS: SetupInstallList[] = ['installedExtensions', 'pendingClis', 'installedClis'];
/** Where the extension keeps its state: its global storage and the user's home directory. */
export interface StateLocation { storage: string; home: string }

function setupStateFile(storage: string): string {
  return path.join(storage, 'setup-state.json');
}
function installRecordFile(home: string): string {
  return path.join(home, '.coagent8', 'installs.json');
}
/** Reads a JSON object file; none when it does not exist. */
function readObject(file: string): Record<string, unknown> {
  let raw: string;
  try { raw = readBoundedFileSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object.`);
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

/**
 * Reads the onboarding state.
 * @returns The stored state, or none when the file does not exist.
 * @throws When the file cannot be read or is not a JSON object.
 */
export function readSetupState(storage: string): SetupState {
  const record = readObject(setupStateFile(storage));
  const state: SetupState = record.welcomed === true ? { welcomed: true } : {};
  if (typeof record.updateOffered === 'string') state.updateOffered = record.updateOffered;
  const removing = strings(record.removingExtensions);
  if (removing?.length) state.removingExtensions = removing;
  if (typeof record.pathPrompt === 'string' && (record.pathPrompt === 'accepted' || record.pathPrompt === 'declined' || record.pathPrompt === 'dismissed')) {
    state.pathPrompt = record.pathPrompt;
  }
  return state;
}

/**
 * Reads what CoAgent8 setup installed, including lists that earlier versions kept in the
 * extension's storage.
 * @throws When a file cannot be read or is not a JSON object.
 */
export function readInstallRecord(location: StateLocation): InstallRecord {
  const current = readObject(installRecordFile(location.home)), legacy = readObject(setupStateFile(location.storage));
  const record: InstallRecord = {};
  for (const list of INSTALL_LISTS) {
    const items = [...new Set([...strings(current[list]) ?? [], ...strings(legacy[list]) ?? []])];
    if (items.length) record[list] = items;
  }
  return record;
}

/**
 * Adds items to, or removes them from, one list of what CoAgent8 setup installed, and moves
 * the lists earlier versions kept in the extension's storage. An empty record deletes the file.
 */
export async function updateInstallList(location: StateLocation, list: SetupInstallList, add: string[], remove: string[] = []): Promise<void> {
  const file = installRecordFile(location.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const raw = readObject(file);
    const legacy = readObject(setupStateFile(location.storage));
    const items = [...new Set([...strings(raw[list]) ?? [], ...strings(legacy[list]) ?? [], ...add])].filter(item => !remove.includes(item));
    if (items.length) raw[list] = items;
    else delete raw[list];
    if (Object.keys(raw).length) replaceFile(file, JSON.stringify(raw, null, 2) + '\n');
    else fs.rmSync(file, { force: true });
  });
  const legacy = readObject(setupStateFile(location.storage));
  if (INSTALL_LISTS.some(name => Object.hasOwn(legacy, name))) {
    await withFileLock(setupStateFile(location.storage), async () => {
      replaceFile(setupStateFile(location.storage), JSON.stringify(readSetupState(location.storage), null, 2) + '\n');
    });
  }
}

/** Merges onboarding state into the state file. */
export async function updateSetupState(storage: string, changes: SetupState): Promise<void> {
  const file = setupStateFile(storage);
  fs.mkdirSync(storage, { recursive: true });
  await withFileLock(file, async () => {
    replaceFile(file, JSON.stringify({ ...readSetupState(storage), ...changes }, null, 2) + '\n');
  });
}
