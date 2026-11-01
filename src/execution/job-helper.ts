/**
 * Locates the Windows job helper and reads its status line (WINDOWS-001).
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionError } from '../contracts/index.js';

/** Package name that identifies a source checkout of this project. */
const PACKAGE_NAME = 'coagent8';
/** Win32 errors that mean the program does not exist. */
const NOT_FOUND_ERRORS = new Set(['2', '3']);
let located: { path: string | undefined } | undefined;

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
 * @remarks Looks beside the bundle (`dist/win32-<arch>/`), then in the Cargo output of a source
 * checkout. The package root follows from where this code runs, `dist` or `src/execution`, so
 * nothing outside the package is searched: its parent can be `node_modules`, where anyone's
 * executable could lie.
 * @param moduleDir - Directory of the running bundle or source module.
 * @param arch - Processor architecture.
 * @returns The helper's path, or `undefined` when this installation has none.
 */
export function locateJobHelper(moduleDir: string, arch: string = process.arch): string | undefined {
  const isFile = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  const packaged = path.join(moduleDir, `win32-${arch}`, 'coagent8-job.exe');
  if (isFile(packaged)) return packaged;
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
 * The job helper of this installation, kept for the life of the process.
 * @returns The helper's path, or `undefined` off Windows and when it is not installed.
 */
export function jobHelperPath(): string | undefined {
  located ??= { path: process.platform === 'win32' ? locateJobHelper(__dirname) : undefined };
  return located.path;
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
