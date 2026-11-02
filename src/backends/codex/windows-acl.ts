/**
 * Folders a Codex writer cannot reach on Windows (#127).
 *
 * @remarks
 * Codex grants its sandbox write access on the workspace folder, and the grant reaches a subfolder
 * only by inheritance. A folder with its own permissions, as seen in synced folders, stays closed:
 * the worker then spends a turn and reports a denied write. Observed on codex-cli 0.164, 2026-11-02.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../../execution/process.js';
import type { BackendReadContext } from '../../contracts/execution.js';

/** One entry of a folder's permissions. */
export interface AclEntry {
  name: string;
  inherited: boolean;
  writes: boolean;
}

/**
 * Reads the `name:(flags)(rights)` entries of `icacls` output.
 * @param output - The output, whose first line starts with the folder as given.
 * @param folder - The folder as given: names and paths can both hold spaces.
 * @returns The entries, or none when a line looks like an entry and cannot be read: the caller
 * then treats the check as inconclusive.
 */
export function parseAcl(output: string, folder: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.startsWith(folder) ? raw.slice(folder.length) : raw;
    const match = /^\s*(.+?):((?:\([A-Za-z,]+\))+)\s*$/.exec(line);
    if (!match) {
      if (line.includes(':(')) return [];
      continue;
    }
    const rights = match[2]!.match(/\(([A-Za-z,]+)\)/g)!.map(part => part.slice(1, -1));
    entries.push({
      // Without its domain: the sandbox's group is the same name in every locale.
      name: match[1]!.split('\\').pop()!,
      inherited: rights.includes('I'),
      writes: rights.some(right => right === 'F' || right === 'M' || right.split(',').some(part => part === 'W' || part === 'WD')),
    });
  }
  return entries;
}

async function readAcl(directory: string, context?: BackendReadContext): Promise<AclEntry[] | null> {
  const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const ran = await runCommand(icacls, [directory], { abortSignal: context?.abortSignal, timeoutMs: 10000, maxBufferBytes: 256 * 1024 });
  if (ran.status !== 'completed' || ran.exitCode !== 0) return null;
  const entries = parseAcl(ran.stdout ?? '', directory);
  return entries.length ? entries : null;
}

/**
 * Whether the grant on a workspace reaches a folder: by inheritance, or by its own entry for one
 * of the names that may write in the workspace. Any inherited entry shows that inheritance is on;
 * the walk from the workspace down checks each folder above this one the same way.
 */
export function aclReachesFolder(workspace: readonly AclEntry[], folder: readonly AclEntry[]): boolean {
  if (folder.some(entry => entry.inherited)) return true;
  const writers = new Set(workspace.filter(entry => entry.writes).map(entry => entry.name));
  // The account itself and the system usually have their own entries; only the sandbox's count.
  return folder.some(entry => entry.writes && /^(?:S-1-5-21-|CodexSandbox)/.test(entry.name) && writers.has(entry.name));
}

/**
 * Finds the first existing folder on the way to a scope entry that a Codex writer cannot reach.
 * Folders below a scope entry are not walked, which could take long: a denial there gets the
 * warning after the turn.
 * @param cwd - The workspace.
 * @param scope - Scope entries relative to it.
 * @returns The folder, or undefined when none is found or the system does not tell: a check that
 * fails must not stop a run that may work.
 */
export async function unreachableWriteFolder(
  cwd: string,
  scope: readonly string[],
  context?: BackendReadContext,
): Promise<string | undefined> {
  if (process.platform !== 'win32' || !scope.length) return undefined;
  const workspace = await readAcl(cwd, context);
  // Without the sandbox's group on the workspace, its grants are not known here: no refusal.
  if (!workspace?.some(entry => /^CodexSandbox/i.test(entry.name))) return undefined;
  const seen = new Set<string>();
  for (const entry of scope) {
    let current = cwd;
    for (const part of entry.split(/[\\/]/).filter(Boolean)) {
      current = path.join(current, part);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(current, { throwIfNoEntry: false })?.isDirectory() ?? false;
      } catch {
        // Inconclusive, like a failed read of the permissions.
      }
      if (!isDirectory) break;
      if (seen.has(current)) continue;
      seen.add(current);
      const folder = await readAcl(current, context);
      if (folder && !aclReachesFolder(workspace, folder)) return current;
    }
  }
  return undefined;
}
