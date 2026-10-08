import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedFileSync } from '../../../src/execution/stream.js';
import { withFileLock } from '../../../src/sessions/lock.js';

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
  /** Vendor extensions that CoAgent8 setup installed; only these are offered for removal with it. */
  installedExtensions?: string[];
  /** CLIs whose official standalone installer setup opened; one counts as installed once a check finds it. */
  pendingClis?: string[];
  /** CLIs that CoAgent8 setup installed with the official standalone installer; offered for removal with it. */
  installedClis?: string[];
}
/** The lists of what CoAgent8 setup installed. */
export type SetupInstallList = 'installedExtensions' | 'pendingClis' | 'installedClis';
const INSTALL_LISTS: SetupInstallList[] = ['installedExtensions', 'pendingClis', 'installedClis'];

function setupStateFile(storage: string): string {
  return path.join(storage, 'setup-state.json');
}

/**
 * Reads the onboarding state.
 * @returns The stored state, or none when the file does not exist.
 * @throws When the file cannot be read or is not a JSON object.
 */
export function readSetupState(storage: string): SetupState {
  let raw: string;
  try { raw = readBoundedFileSync(setupStateFile(storage)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${setupStateFile(storage)} is not a JSON object.`);
  const record = value as Record<string, unknown>;
  const state: SetupState = record.welcomed === true ? { welcomed: true } : {};
  for (const list of INSTALL_LISTS) {
    const items = record[list];
    if (Array.isArray(items) && items.every(item => typeof item === 'string')) state[list] = items;
  }
  return state;
}

/** Adds items to, or removes them from, one list of what CoAgent8 setup installed. */
export async function updateInstallList(storage: string, list: SetupInstallList, add: string[], remove: string[] = []): Promise<void> {
  const file = setupStateFile(storage);
  fs.mkdirSync(storage, { recursive: true });
  await withFileLock(file, async () => {
    const { [list]: previous, ...rest } = readSetupState(storage);
    const items = [...new Set([...previous ?? [], ...add])].filter(item => !remove.includes(item));
    replaceFile(file, JSON.stringify(items.length ? { ...rest, [list]: items } : rest, null, 2) + '\n');
  });
}

/** Merges onboarding state into the state file. */
export async function updateSetupState(storage: string, changes: SetupState): Promise<void> {
  const file = setupStateFile(storage);
  fs.mkdirSync(storage, { recursive: true });
  await withFileLock(file, async () => {
    replaceFile(file, JSON.stringify({ ...readSetupState(storage), ...changes }, null, 2) + '\n');
  });
}
