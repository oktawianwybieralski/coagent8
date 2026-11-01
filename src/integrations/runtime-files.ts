/**
 * Files that belong beside an owned runtime copy of the bundle (WINDOWS-001).
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Errors Windows reports for a directory that still holds a running executable. */
const IN_USE_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/**
 * Copies this machine's job helper from beside a bundle to its runtime copy, so the copy finds
 * it the way an installed bundle does. The copy's directory is named after the bundle, which
 * embeds the helper's digest, so an existing file is either the right one or refused at launch.
 * @param bundle - The source bundle.
 * @param runtimeDir - The directory of the runtime copy.
 * @param arch - Processor architecture.
 */
export function copyJobHelperBeside(bundle: string, runtimeDir: string, arch: string = process.arch): void {
  const relative = path.join(`win32-${arch}`, 'coagent8-job.exe');
  const source = path.join(path.dirname(bundle), relative);
  const target = path.join(runtimeDir, relative);
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/**
 * Removes a runtime copy that is no longer referenced.
 * @remarks A server still running from it keeps its job helper locked on Windows. That directory
 * stays until a later removal; a turn in progress is never a reason for setup to fail.
 * @param directory - The directory of the runtime copy.
 * @returns Whether the directory is gone.
 */
export function removeRuntimeDirectory(directory: string): boolean {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (IN_USE_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}
