/**
 * Locates the Windows job helper and reads its status line (WINDOWS-001).
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionError } from '../contracts/index.js';

/** Package name that identifies a source checkout of this project. */
const PACKAGE_NAME = 'coagent8';
/** Win32 errors that mean the program does not exist. */
const NOT_FOUND_ERRORS = new Set(['2', '3']);
/** SHA-256 digests per architecture of the helpers in this package; set by `scripts/build.cjs`. */
declare const __COAGENT8_JOB_HELPER_DIGESTS__: Readonly<Record<string, string>> | undefined;
const PACKAGED_DIGESTS: Readonly<Record<string, string>> =
  typeof __COAGENT8_JOB_HELPER_DIGESTS__ === 'undefined' ? {} : __COAGENT8_JOB_HELPER_DIGESTS__;

/** Whether a directory is a source checkout of this project, which alone holds Cargo output. */
function isSourceCheckout(root: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: unknown };
    return manifest.name === PACKAGE_NAME && fs.statSync(path.join(root, 'native', 'coagent8-job', 'Cargo.toml')).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the helper for a module directory.
 * @remarks Looks beside the bundle (`dist/win32-<arch>/`), where a helper counts only when its
 * SHA-256 digest matches the one embedded in the bundle, then in the Cargo output of a source
 * checkout, which is built from the same checkout. The package root follows from where this code runs, `dist` or `src/execution`, so
 * nothing outside the package is searched: its parent can be `node_modules`, where anyone's
 * executable could lie.
 * @param moduleDir - Directory of the running bundle or source module.
 * @param arch - Processor architecture.
 * @param digests - Expected digests of the packaged helpers per architecture.
 * @returns The helper's path, or `undefined` when this installation has none.
 */
export function locateJobHelper(
  moduleDir: string,
  arch: string = process.arch,
  digests: Readonly<Record<string, string>> = PACKAGED_DIGESTS,
): string | undefined {
  const isFile = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  const packaged = path.join(moduleDir, `win32-${arch}`, 'coagent8-job.exe');
  try {
    if (isFile(packaged)) {
      const digest = createHash('sha256').update(fs.readFileSync(packaged)).digest('hex');
      return digest === digests[arch] ? packaged : undefined;
    }
  } catch (err) {
    // A helper that cannot be read is an unavailable helper, which callers report or refuse.
    if ((err as NodeJS.ErrnoException).code) return undefined;
    throw err;
  }
  const parent = path.dirname(moduleDir);
  const root =
    path.basename(moduleDir) === 'dist'
      ? parent
      : path.basename(moduleDir) === 'execution' && path.basename(parent) === 'src'
        ? path.dirname(parent)
        : undefined;
  if (!root || !isSourceCheckout(root)) return undefined;
  const built = path.join(root, 'native', 'coagent8-job', 'target', 'release', 'coagent8-job.exe');
  return isFile(built) ? built : undefined;
}

/**
 * The job helper of this installation, checked anew for every launch, so a helper changed while
 * the server runs is refused. A change between this check and the spawn remains possible: Node
 * can only start a program by its path.
 * @returns The helper's path, or `undefined` off Windows and when it is not installed or fails
 * its digest check.
 */
export function jobHelperPath(): string | undefined {
  return process.platform === 'win32' ? locateJobHelper(__dirname) : undefined;
}

/**
 * Whether the helper confirmed that the whole process tree has ended.
 * @param text - Everything the helper wrote to its status pipe.
 * @returns True only after its final `ended` line.
 */
export function jobTreeEnded(text: string): boolean {
  return /(?:^|\n)ended\n$/.test(text);
}

/**
 * Reads the helper's status text.
 * @param text - What the helper has written to its status pipe so far.
 * @returns The failure when the helper reports a failed start; otherwise `undefined`,
 * also while the line is incomplete.
 */
export function parseJobStatus(text: string): { code: ExecutionError['code']; message: string } | undefined {
  const match = /^error ([a-z-]+) (\d+)\n/.exec(text);
  if (!match) return undefined;
  const [, stage, win32Code] = match;
  return stage === 'process-create' && NOT_FOUND_ERRORS.has(win32Code)
    ? { code: 'CLI_NOT_FOUND', message: `The CLI program was not found (Windows error ${win32Code}).` }
    : { code: 'PROCESS_ERROR', message: `The job helper could not start the CLI at ${stage} (Windows error ${win32Code}).` };
}
