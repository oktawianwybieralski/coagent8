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

/** Onboarding choices; kept in the extension's global storage so uninstalling removes them. */
export interface SetupState {
  setupClients?: string[];
  setupDismissed?: boolean;
}

function setupStateFile(storage: string): string {
  return path.join(storage, 'setup-state.json');
}

/**
 * Reads the onboarding choices.
 * @returns The stored choices, or none when the file does not exist.
 * @throws When the file cannot be read or is not a JSON object.
 */
export function readSetupState(storage: string): SetupState {
  let raw: string;
  try { raw = readBoundedFileSync(setupStateFile(storage)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${setupStateFile(storage)} is not a JSON object.`);
  const { setupClients, setupDismissed } = value as Record<string, unknown>;
  return {
    ...(Array.isArray(setupClients) && setupClients.every(item => typeof item === 'string') ? { setupClients } : {}),
    ...(setupDismissed === true ? { setupDismissed } : {}),
  };
}

/**
 * Merges onboarding choices into the state file.
 * @param changes - Choices to store, or null to remove every choice.
 */
export async function updateSetupState(storage: string, changes: SetupState | null): Promise<void> {
  const file = setupStateFile(storage);
  fs.mkdirSync(storage, { recursive: true });
  await withFileLock(file, async () => {
    if (changes === null) { fs.rmSync(file, { force: true }); return; }
    replaceFile(file, JSON.stringify({ ...readSetupState(storage), ...changes }, null, 2) + '\n');
  });
}
