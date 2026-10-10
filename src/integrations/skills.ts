/**
 * Client skill packages installed with a CoAgent8 registration and removed with it (SKILLS-001).
 * @remarks
 * A package is one SKILL.md that tells a client how to call CoAgent8 tools; nothing in it is
 * executed. Setup writes a package only into a missing directory or over the unchanged copy
 * it recorded, and removes only that copy. A directory with the same name that differs, holds
 * other files or is a link is preserved. Paths are the user scope of the local default
 * profile, taken from the loader evidence recorded in the roadmap for each client version.
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBoundedFileSync } from '../storage/read.js';
import { redactDiagnostic } from '../security/redaction.js';
import { hash } from './setup-storage.js';
import type { SetupClient } from './setup-clients.js';

/** Names setup owns; the fixed prefix keeps them apart from other skills in shared directories. */
export const SKILL_NAME = /^coagent8-[a-z]+(?:-[a-z]+)*$/;
const SKILL_FILE = 'SKILL.md';
const SKILL_LIMIT = 64 * 1024;

/** One catalog package as shipped in the npm package and the VSIX. */
export interface SkillPackage { name: string; content: string; digest: string }
/** Outcome for one package; `remove` is a cleanup preview, the other actions are final. */
export interface SkillStatus {
  name: string;
  action: 'installed' | 'updated' | 'current' | 'remove' | 'removed' | 'absent' | 'preserved' | 'blocked';
  message: string;
}
/** Digests of the packages setup wrote for one client, by package name. */
export type SkillRecord = Record<string, string>;

/**
 * The user-scope skill directory each client loads.
 * @remarks Codex reads `~/.agents/skills`, which other tools share; agy reads its global
 * customization root `~/.gemini/config`, the root of the MCP configuration setup edits.
 */
export function skillRoot(client: SetupClient, home: string): string {
  if (client === 'claude') return path.join(home, '.claude', 'skills');
  if (client === 'codex') return path.join(home, '.agents', 'skills');
  return path.join(home, '.gemini', 'config', 'skills');
}

/**
 * Reads the packaged catalog.
 * @param source - Directory holding one directory per package, each with only SKILL.md.
 * @throws On any other entry, a missing name/description or an empty catalog: a defect of
 * the package itself, reported before any client is changed.
 */
export function readSkillCatalog(source: string): SkillPackage[] {
  const packages = fs.readdirSync(source, { withFileTypes: true }).map(entry => {
    if (!entry.isDirectory() || !SKILL_NAME.test(entry.name)) throw new Error(`Skill catalog entry ${entry.name} is not a CoAgent8 skill directory.`);
    const directory = path.join(source, entry.name);
    const files = fs.readdirSync(directory);
    if (files.length !== 1 || files[0] !== SKILL_FILE) throw new Error(`Skill ${entry.name} must contain only ${SKILL_FILE}.`);
    const content = readBoundedFileSync(path.join(directory, SKILL_FILE), SKILL_LIMIT);
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
    if (!front || !new RegExp(`^name: ${entry.name}\\r?$`, 'm').test(front[1]) || !/^description: \S/m.test(front[1])) {
      throw new Error(`Skill ${entry.name} has no frontmatter with its own name and a description.`);
    }
    return { name: entry.name, content, digest: hash(content) };
  });
  if (!packages.length) throw new Error('Skill catalog is empty.');
  return packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

type Observed = { state: 'absent' } | { state: 'file'; digest: string } | { state: 'foreign' };
/** Reads an installed package without following links: only a real directory holding one regular SKILL.md qualifies. */
function observe(directory: string): Observed {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  if (!stat.isDirectory()) return { state: 'foreign' };
  const files = fs.readdirSync(directory), file = path.join(directory, SKILL_FILE);
  if (files.length !== 1 || files[0] !== SKILL_FILE || !fs.lstatSync(file).isFile()) return { state: 'foreign' };
  try { return { state: 'file', digest: hash(readBoundedFileSync(file, SKILL_LIMIT)) }; }
  catch { return { state: 'foreign' }; } // A file beyond the limit is not one setup wrote.
}
const same = (a: Observed, b: Observed) => a.state === b.state && (a.state !== 'file' || a.digest === (b as { digest: string }).digest);

/** Writes SKILL.md through a temporary sibling, after checking the directory still holds what was observed. */
function writePackage(directory: string, seen: Observed, content: string): void {
  if (seen.state === 'absent') {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.mkdirSync(directory); // Fails when another writer created it meanwhile.
  } else if (!same(observe(directory), seen)) throw new Error('Skill changed concurrently; setup did not overwrite it.');
  const temp = path.join(directory, `.${SKILL_FILE}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: 'wx' });
    fs.renameSync(temp, path.join(directory, SKILL_FILE));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Removes an unchanged recorded package; anything else stays where it is. */
function removePackage(root: string, name: string, digest: string): SkillStatus {
  const directory = path.join(root, name), seen = observe(directory);
  if (seen.state === 'absent') return { name, action: 'absent', message: 'Not installed.' };
  if (seen.state !== 'file' || seen.digest !== digest) return { name, action: 'preserved', message: 'Changed since setup installed it; preserved.' };
  fs.rmSync(path.join(directory, SKILL_FILE));
  fs.rmdirSync(directory);
  return { name, action: 'removed', message: 'Removed.' };
}
function failure(name: string, error: unknown): SkillStatus {
  return { name, action: 'blocked', message: redactDiagnostic(error instanceof Error ? error.message : 'Skill could not be changed.') };
}

/**
 * Installs or updates the catalog for one client and removes recorded packages the catalog dropped.
 * @param owned - Digests setup recorded for this client.
 * @returns Outcomes, the new record and whether a file was written. A failed package keeps its previous record.
 */
export function installSkills(client: SetupClient, home: string, catalog: SkillPackage[], owned: SkillRecord): { statuses: SkillStatus[]; owned: SkillRecord; written: boolean } {
  const root = skillRoot(client, home), next: SkillRecord = {};
  let written = false;
  const statuses = catalog.map((item): SkillStatus => {
    const name = item.name;
    try {
      const seen = observe(path.join(root, name));
      if (seen.state === 'file' && seen.digest === item.digest) {
        next[name] = item.digest;
        return { name, action: 'current', message: 'Installed and current.' };
      }
      if (seen.state === 'absent' || (seen.state === 'file' && seen.digest === owned[name])) {
        writePackage(path.join(root, name), seen, item.content);
        next[name] = item.digest;
        written = true;
        return seen.state === 'absent' ? { name, action: 'installed', message: 'Installed.' } : { name, action: 'updated', message: 'Updated to this version.' };
      }
      return { name, action: 'preserved', message: 'Another skill with this name exists; preserved.' };
    } catch (error) {
      if (owned[name]) next[name] = owned[name];
      return failure(name, error);
    }
  });
  for (const [name, digest] of Object.entries(owned)) {
    if (catalog.some(item => item.name === name)) continue;
    try {
      const status = removePackage(root, name, digest);
      written ||= status.action === 'removed';
      statuses.push(status.action === 'removed' ? { ...status, message: 'No longer part of CoAgent8; removed.' } : status);
    } catch (error) {
      next[name] = digest;
      statuses.push(failure(name, error));
    }
  }
  return { statuses, owned: next, written };
}

/**
 * One sentence for setup results: counts per action, names of packages left alone or failed,
 * and how the client invokes a package. Codex has no per-skill slash command.
 */
export function describeSkills(client: SetupClient, statuses: SkillStatus[]): string {
  if (!statuses.length) return 'No skills.';
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status.action, (counts.get(status.action) ?? 0) + 1);
  const notable = statuses.filter(status => status.action === 'preserved' || status.action === 'blocked').map(status => `${status.name} ${status.action}`);
  const invoke = client === 'codex' ? 'mention one as $coagent8-review or open /skills' : 'type /coagent8-review or another /coagent8- command';
  return `Skills: ${[...counts].map(([action, count]) => `${count} ${action}`).join(', ')}${notable.length ? ` (${notable.join(', ')})` : ''}; ${invoke} in a new chat.`;
}

/** Previews removal of recorded packages without changing anything. */
export function previewSkillRemoval(client: SetupClient, home: string, owned: SkillRecord): SkillStatus[] {
  const root = skillRoot(client, home);
  return Object.entries(owned).map(([name, digest]): SkillStatus => {
    try {
      const seen = observe(path.join(root, name));
      if (seen.state === 'absent') return { name, action: 'absent', message: 'Not installed.' };
      if (seen.state !== 'file' || seen.digest !== digest) return { name, action: 'preserved', message: 'Changed since setup installed it; preserved.' };
      return { name, action: 'remove', message: 'Unchanged skill setup installed.' };
    } catch (error) {
      return failure(name, error);
    }
  });
}

/**
 * Applies a removal preview.
 * @returns Final outcomes and the remaining record: only a package whose removal failed stays recorded.
 */
export function removeSkills(client: SetupClient, home: string, owned: SkillRecord, preview: SkillStatus[]): { statuses: SkillStatus[]; owned: SkillRecord } {
  const root = skillRoot(client, home), remaining: SkillRecord = {};
  const statuses = preview.map((planned): SkillStatus => {
    const digest = owned[planned.name];
    if (planned.action !== 'remove' || digest === undefined) {
      if (planned.action === 'blocked' && digest !== undefined) remaining[planned.name] = digest;
      return planned;
    }
    try { return removePackage(root, planned.name, digest); }
    catch (error) {
      remaining[planned.name] = digest;
      return failure(planned.name, error);
    }
  });
  return { statuses, owned: remaining };
}
