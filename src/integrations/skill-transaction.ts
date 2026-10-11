/** Recoverable package writes under the setup lease; no client settings or registration effects. @packageDocumentation */
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFileSync } from '../storage/read.js';
import { assertSkillRoot, disabledSkillRoot, observeSkill, pruneDisabledSkillRoot, skillRoot, SKILL_NAME } from './skills.js';
import { hash, read, writeChecked } from './setup-storage.js';
import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';

interface PackageSnapshot { name: string; disabled: boolean; before: string | null; after: string | null }
interface Journal { client: SetupClient; stateBefore: string | null; stateAfter: string | null; committed: boolean; packages: PackageSnapshot[] }
const journalFile = (home: string) => path.join(home, '.coagent8', 'skill-transaction.json');
const stateFile = (home: string) => path.join(home, '.coagent8', 'setup.json');
const JOURNAL_LIMIT = 16 * 1024 * 1024;
const directory = (home: string, client: SetupClient, item: PackageSnapshot) => path.join(item.disabled ? disabledSkillRoot(client, home) : skillRoot(client, home), item.name);

function loadJournal(home: string): Journal | undefined {
  if (!fs.existsSync(journalFile(home))) return undefined;
  const value: unknown = JSON.parse(readBoundedFileSync(journalFile(home), JOURNAL_LIMIT));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skill transaction journal; preserved.');
  const data = value as Record<string, unknown>;
  const text = (value: unknown, limit = 512 * 1024) => value === null || (typeof value === 'string' && Buffer.byteLength(value) <= limit);
  if (!SETUP_CLIENTS.includes(data.client as SetupClient) || !text(data.stateBefore) || !text(data.stateAfter) || typeof data.committed !== 'boolean' || !Array.isArray(data.packages) || data.packages.length > 256) throw new Error('Invalid skill transaction journal; preserved.');
  const seen = new Set<string>();
  for (const item of data.packages) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !SKILL_NAME.test(item.name) || typeof item.disabled !== 'boolean' || !text(item.before, 64 * 1024) || !text(item.after, 64 * 1024)) throw new Error('Invalid skill transaction package; preserved.');
    const key = `${item.disabled}:${item.name}`;
    if (seen.has(key)) throw new Error('Duplicate skill transaction package; preserved.');
    seen.add(key);
  }
  return data as unknown as Journal;
}

function restore(home: string, journal: Journal): void {
  const currentState = read(stateFile(home));
  if (currentState !== journal.stateBefore) throw new Error('Setup state changed during skill transaction; journal preserved for recovery.');
  // Inspect every path first. A concurrent user edit is never overwritten by rollback.
  for (const item of journal.packages) {
    const root = item.disabled ? disabledSkillRoot(journal.client, home) : skillRoot(journal.client, home);
    assertSkillRoot(root, home);
    const seen = observeSkill(directory(home, journal.client, item));
    if (seen.state === 'foreign' || (seen.state === 'file' && ![item.before, item.after].some(content => content !== null && hash(content) === seen.digest))) throw new Error('Skill changed during transaction; rollback stopped and journal preserved.');
  }
  for (const item of journal.packages) {
    assertSkillRoot(item.disabled ? disabledSkillRoot(journal.client, home) : skillRoot(journal.client, home), home);
    const target = directory(home, journal.client, item), file = path.join(target, 'SKILL.md');
    const seen = observeSkill(target);
    const current = seen.state === 'file' ? readBoundedFileSync(file, 64 * 1024) : null;
    if (seen.state === 'foreign' || (current !== null && current !== item.before && current !== item.after)) throw new Error('Skill changed during rollback; journal preserved.');
    if (item.before === null) {
      if (seen.state !== 'absent') { fs.unlinkSync(file); fs.rmdirSync(target); }
    } else {
      if (seen.state === 'absent') fs.mkdirSync(target, { recursive: true });
      writeChecked(file, current, item.before);
    }
  }
  pruneDisabledSkillRoot(journal.client, home);
}

/** Recovers an interrupted package transaction before another operation holds the same setup lease. */
export function recoverSkillTransaction(home: string): void {
  assertSkillRoot(path.join(home, '.coagent8'), home);
  if (fs.existsSync(journalFile(home)) && !fs.lstatSync(journalFile(home)).isFile()) throw new Error('Linked or invalid skill journal preserved.');
  const journal = loadJournal(home);
  if (!journal) return;
  if (!(journal.committed && read(stateFile(home)) === journal.stateAfter)) restore(home, journal);
  fs.unlinkSync(journalFile(home));
}

/** Expected package bytes after a transaction; paths are derived, never accepted from callers. */
export interface SkillTarget { name: string; disabled: boolean; content: string | null }

/** Journals package changes before effects, persists ownership last, and rolls back failed writes. */
export function transactSkills(home: string, client: SetupClient, targets: SkillTarget[], stateBefore: string | null, perform: () => string): void {
  recoverSkillTransaction(home);
  assertSkillRoot(path.join(home, '.coagent8'), home);
  const seenTargets = new Set<string>();
  if (!SETUP_CLIENTS.includes(client) || targets.length > 256) throw new Error('Invalid skill transaction scope.');
  const packages: PackageSnapshot[] = targets.map(target => {
    const key = `${target.disabled}:${target.name}`;
    if (!SKILL_NAME.test(target.name) || typeof target.disabled !== 'boolean' || (target.content !== null && (typeof target.content !== 'string' || Buffer.byteLength(target.content) > 64 * 1024)) || seenTargets.has(key)) throw new Error('Invalid skill transaction package.');
    seenTargets.add(key);
    const root = target.disabled ? disabledSkillRoot(client, home) : skillRoot(client, home);
    assertSkillRoot(root, home);
    const dir = path.join(root, target.name), seen = observeSkill(dir);
    if (seen.state === 'foreign') throw new Error('Conflicting skill package preserved.');
    return { name: target.name, disabled: target.disabled, before: seen.state === 'absent' ? null : readBoundedFileSync(path.join(dir, 'SKILL.md'), 64 * 1024), after: target.content };
  });
  if (read(stateFile(home)) !== stateBefore) throw new Error('Setup state changed; retry.');
  const journal: Journal = { client, stateBefore, stateAfter: null, committed: false, packages };
  const file = journalFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serializeJournal = () => {
    const content = JSON.stringify(journal);
    if (Buffer.byteLength(content) > JOURNAL_LIMIT) throw new Error('Skill transaction exceeds the journal byte limit.');
    return content;
  };
  writeChecked(file, null, serializeJournal());
  try {
    journal.stateAfter = perform();
    journal.committed = true;
    writeChecked(file, read(file), serializeJournal());
    writeChecked(stateFile(home), stateBefore, journal.stateAfter);
  } catch (error) {
    try { restore(home, journal); fs.unlinkSync(file); }
    catch (rollbackError) { throw new Error(`Skill apply failed (${error instanceof Error ? error.message : 'unknown error'}); recovery required (${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}).`); }
    throw error;
  }
  fs.unlinkSync(file);
}
