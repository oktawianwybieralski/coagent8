/**
 * Locates the Windows job helper and reads its status line (WINDOWS-001).
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionError } from '../contracts/index.js';

/** Win32 errors that mean the program does not exist. */
const NOT_FOUND_ERRORS = new Set(['2', '3']);
let located: { path: string | undefined } | undefined;

/**
 * The job helper of this installation.
 * @remarks Looks beside the bundle (`dist/win32-<arch>/`) and in a source checkout's Cargo
 * output. The result is kept for the life of the process.
 * @returns The helper's path, or `undefined` off Windows and when it is not installed.
 */
export function jobHelperPath(): string | undefined {
  if (located) return located.path;
  located = { path: undefined };
  if (process.platform === 'win32') {
    const release = path.join('native', 'coagent8-job', 'target', 'release', 'coagent8-job.exe');
    const candidates = [
      path.join(__dirname, `win32-${process.arch}`, 'coagent8-job.exe'),
      path.resolve(__dirname, '..', release),
      path.resolve(__dirname, '..', '..', release),
    ];
    located.path = candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  }
  return located.path;
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
