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
