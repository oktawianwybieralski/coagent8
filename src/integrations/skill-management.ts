/** Independent package selection and activation; shares setup ownership and lease. @packageDocumentation */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readBackendSkills, setBackendSkills } from '../config.js';
import type { SkillSelection } from '../contracts/skills.js';
import { withFileLock } from '../storage/lock.js';
import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
import { read, hash, readSelection, serializeSelection, setupConfigFile, writeChecked, type Selection, type RegistrationOrigin } from './setup-storage.js';
import { assertSkillRoot, disabledSkillRoot, installSkills, observeSkill, previewSkillRemoval, pruneDisabledSkillRoot, readSkillCatalog, removeSkills, skillRoot, type SkillPackage, type SkillRecord, type SkillStatus } from './skills.js';
import { recoverSkillTransaction, transactSkills, type SkillTarget } from './skill-transaction.js';

/** Physical package state, independent of a client's native visibility overrides. */
export interface ManagedSkill {
  name: string;
  state: 'enabled' | 'disabled' | 'absent' | 'conflict';
  desired: 'enabled' | 'disabled' | 'absent';
  updateAvailable: boolean;
  message: string;
}
/** Preview binding for one client's selected packages. */
export interface SkillManagementResult { client: SetupClient; root: string; disabledRoot: string; selection: SkillSelection; skills: ManagedSkill[]; token: string; applied?: boolean }
export interface SkillManagementOptions {
  client: SetupClient;
  skillsSource: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  origin?: RegistrationOrigin;
  /** Omit for status; both lists are explicit, including empty lists. */
  selection?: SkillSelection;
  /** Applying a selection requires the current preview token. */
  apply?: string;
}

function validateProfile(home: string, env: NodeJS.ProcessEnv): void {
  if (env.CODEX_CONFIG_PATH || env.CLAUDE_CONFIG_DIR || env.GEMINI_CLI_HOME || (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== path.join(home, '.codex'))) throw new Error('Custom client/profile roots are unsupported; skill management requires the local default profile.');
}

/** Default selections preserve legacy catalog installation; explicit selections never add new names. */
export function selectedSkills(catalog: SkillPackage[], selection?: SkillSelection): SkillSelection {
  return selection ?? { installed: catalog.map(item => item.name), disabled: [] };
}

function inventory(client: SetupClient, home: string, catalog: SkillPackage[], saved: Selection, selection: SkillSelection): ManagedSkill[] {
  const roots = [skillRoot(client, home), disabledSkillRoot(client, home)];
  roots.forEach(root => assertSkillRoot(root, home));
  return catalog.map(item => {
    const active = observeSkill(path.join(roots[0], item.name)), disabled = observeSkill(path.join(roots[1], item.name));
    const conflict = active.state === 'foreign' || disabled.state === 'foreign' || (active.state !== 'absent' && disabled.state !== 'absent')
      || (active.state === 'file' && active.digest !== saved.skills[client]?.[item.name])
      || (disabled.state === 'file' && disabled.digest !== saved.disabledSkills?.[client]?.[item.name]);
    const state = conflict ? 'conflict' : active.state === 'file' ? 'enabled' : disabled.state === 'file' ? 'disabled' : 'absent';
    const desired = !selection.installed.includes(item.name) ? 'absent' : selection.disabled.includes(item.name) ? 'disabled' : 'enabled';
    return { name: item.name, state, desired, updateAvailable: (active.state === 'file' && active.digest !== item.digest) || (disabled.state === 'file' && disabled.digest !== item.digest),
      message: conflict ? 'Edited, foreign, linked or duplicate package; preserved.' : state === 'enabled' ? 'In the client skill directory; native client settings still apply.' : state === 'disabled' ? 'Retained outside client discovery.' : 'Not installed.' };
  });
}

function persistRecords(saved: Selection, client: SetupClient, active: SkillRecord, disabled: SkillRecord, changed: Set<string>, origin?: RegistrationOrigin): void {
  const previousNames = new Set([...Object.keys(saved.skills[client] ?? {}), ...Object.keys(saved.disabledSkills?.[client] ?? {})]);
  const owners = Object.fromEntries([...new Set([...Object.keys(active), ...Object.keys(disabled)])].map(name => [name, saved.skillOwners?.[client]?.[name] ?? (previousNames.has(name) ? saved.skillOrigin[client] ?? 'cli' : changed.has(name) ? origin ?? 'cli' : 'cli')]));
  saved.skillOwners ??= {};
  if (Object.keys(owners).length) saved.skillOwners[client] = owners; else delete saved.skillOwners[client];
  if (Object.keys(active).length) saved.skills[client] = active; else delete saved.skills[client];
  saved.disabledSkills ??= {};
  if (Object.keys(disabled).length) saved.disabledSkills[client] = disabled; else delete saved.disabledSkills[client];
  if (Object.keys(active).length || Object.keys(disabled).length) {
    if (Object.values(owners).every(value => value === 'vscode-extension')) saved.skillOrigin[client] = 'vscode-extension';
    else delete saved.skillOrigin[client];
  } else delete saved.skillOrigin[client];
}

/** Reconciles package files and ownership under the caller's setup lease, with crash recovery. */
export function reconcileSkills(client: SetupClient, home: string, catalog: SkillPackage[], saved: Selection, selection: SkillSelection, origin?: RegistrationOrigin, expectedState?: string | null): SkillStatus[] {
  const state = path.join(home, '.coagent8', 'setup.json'), before = expectedState === undefined ? read(state) : expectedState;
  if (read(state) !== before) throw new Error('Setup ownership changed concurrently; retry skill apply.');
  const statuses: SkillStatus[] = [];
  const active = { ...saved.skills[client] }, disabled = { ...saved.disabledSkills?.[client] };
  const targets: SkillTarget[] = [];
  const planned = inventory(client, home, catalog, saved, selection);
  for (const item of planned) {
    if (item.state === 'conflict') { statuses.push({ name: item.name, action: 'preserved', message: item.message }); continue; }
    const content = catalog.find(pkg => pkg.name === item.name)!.content;
    const unchanged = item.state === item.desired && !item.updateAvailable;
    if (unchanged) { statuses.push({ name: item.name, action: item.state === 'absent' ? 'absent' : 'current', message: item.message, ...(item.state === 'disabled' ? { location: 'disabled' as const } : {}) }); continue; }
    targets.push({ name: item.name, disabled: false, content: item.desired === 'enabled' ? content : null }, { name: item.name, disabled: true, content: item.desired === 'disabled' ? content : null });
  }
  // Catalog removals are handled by ownership, including disabled packages.
  for (const name of new Set([...Object.keys(active), ...Object.keys(disabled)])) {
    if (catalog.some(item => item.name === name)) continue;
    for (const [isDisabled, record] of [[false, active], [true, disabled]] as const) {
      if (!record[name]) continue;
      const root = isDisabled ? disabledSkillRoot(client, home) : skillRoot(client, home);
      const seen = observeSkill(path.join(root, name));
      if (seen.state === 'file' && seen.digest === record[name]) targets.push({ name, disabled: isDisabled, content: null });
      else if (seen.state === 'absent') delete record[name];
      else statuses.push({ name, action: 'preserved', message: 'Dropped catalog package was edited; preserved.' });
    }
  }
  const previous = JSON.stringify(saved);
  const perform = () => {
    for (const target of targets) {
      const root = target.disabled ? disabledSkillRoot(client, home) : skillRoot(client, home), record = target.disabled ? disabled : active;
      let result: SkillStatus;
      if (target.content !== null) {
        const pkg = catalog.find(item => item.name === target.name)!;
        const outcome = installSkills(client, home, [pkg], record[target.name] ? { [target.name]: record[target.name] } : {}, root);
        result = outcome.statuses[0];
        if (outcome.owned[target.name]) record[target.name] = outcome.owned[target.name];
      } else {
        const owned = record[target.name] ? { [target.name]: record[target.name] } : {};
        const preview = previewSkillRemoval(client, home, owned, root);
        const outcome = removeSkills(client, home, owned, preview, root);
        result = outcome.statuses[0] ?? { name: target.name, action: 'absent', message: 'Not installed.' };
        if (!outcome.owned[target.name] && result.action !== 'preserved') delete record[target.name];
      }
      if (result.action === 'blocked' || result.action === 'preserved') throw new Error(`${target.name}: ${result.message}`);
      statuses.push({ ...result, ...(target.disabled ? { location: 'disabled' as const } : {}) });
    }
    pruneDisabledSkillRoot(client, home);
    persistRecords(saved, client, active, disabled, new Set(targets.map(target => target.name)), origin);
    return serializeSelection(saved);
  };
  try {
    if (targets.length) transactSkills(home, client, targets, before, perform);
    else {
      persistRecords(saved, client, active, disabled, new Set());
      const after = serializeSelection(saved);
      if (after !== before) writeChecked(state, before, after);
    }
  } catch (error) {
    delete saved.disabledSkills;
    delete saved.skillOwners;
    Object.assign(saved, JSON.parse(previous));
    throw error;
  }
  return [...new Set(statuses.map(item => item.name))].map(name => {
    const entries = statuses.filter(item => item.name === name), desired = planned.find(item => item.name === name)?.desired;
    if (desired === 'enabled') return entries.find(item => item.location !== 'disabled') ?? entries[0];
    if (desired === 'disabled') return entries.find(item => item.location === 'disabled') ?? entries[0];
    return entries.find(item => item.action === 'removed') ?? entries[0];
  });
}

/** Converts a package action into explicit desired state while retaining other selections. */
export function skillSelectionForAction(current: SkillSelection, names: string[], action: 'install' | 'uninstall' | 'enable' | 'disable'): SkillSelection {
  const installed = new Set(current.installed), disabled = new Set(current.disabled);
  for (const name of names) {
    if (action === 'install') installed.add(name);
    else if (action === 'uninstall') { installed.delete(name); disabled.delete(name); }
    else {
      if (!installed.has(name)) throw new Error(`${name} is not selected for installation; install it first.`);
      if (action === 'enable') disabled.delete(name); else disabled.add(name);
    }
  }
  return { installed: [...installed].sort(), disabled: [...disabled].sort() };
}

/** Previews both enabled and disabled packages, filtering ownership per package rather than per client. */
export function previewManagedSkillRemoval(client: SetupClient, home: string, saved: Selection, origin?: RegistrationOrigin): SkillStatus[] {
  const statuses: SkillStatus[] = [];
  for (const [isDisabled, record] of [[false, saved.skills[client]], [true, saved.disabledSkills?.[client]]] as const) {
    for (const [name, digest] of Object.entries(record ?? {})) {
      const owner = saved.skillOwners?.[client]?.[name] ?? saved.skillOrigin[client] ?? 'cli';
      const root = isDisabled ? disabledSkillRoot(client, home) : skillRoot(client, home);
      const status: SkillStatus = origin && owner !== origin ? { name, action: 'preserved', message: 'Installed outside the VS Code extension; preserved.' } : previewSkillRemoval(client, home, { [name]: digest }, root)[0];
      statuses.push({ ...status, ...(isDisabled ? { location: 'disabled' as const } : {}) });
    }
  }
  return statuses;
}

/** Removes the unchanged packages from a preview, retaining ownership of packages excluded by origin. */
export function removeManagedSkills(client: SetupClient, home: string, saved: Selection, preview: SkillStatus[], origin?: RegistrationOrigin): SkillStatus[] {
  const statuses: SkillStatus[] = [];
  const records = [{ ...saved.skills[client] }, { ...saved.disabledSkills?.[client] }];
  for (const planned of preview) {
    const owner = saved.skillOwners?.[client]?.[planned.name] ?? saved.skillOrigin[client] ?? 'cli';
    if (origin && owner !== origin) { statuses.push(planned); continue; }
    const index = planned.location === 'disabled' ? 1 : 0, record = records[index], digest = record[planned.name];
    if (!digest) { statuses.push(planned); continue; }
    const root = index ? disabledSkillRoot(client, home) : skillRoot(client, home);
    const outcome = removeSkills(client, home, { [planned.name]: digest }, [planned], root);
    if (!outcome.owned[planned.name]) delete record[planned.name];
    statuses.push(...outcome.statuses);
  }
  pruneDisabledSkillRoot(client, home);
  persistRecords(saved, client, records[0], records[1], new Set());
  return statuses;
}

/** Reads or applies one client's package selection without starting CLIs or changing MCP entries. */
export async function manageSkills(options: SkillManagementOptions): Promise<SkillManagementResult> {
  if (!SETUP_CLIENTS.includes(options.client)) throw new Error('Unknown skill client.');
  const home = path.resolve(options.home ?? os.homedir()), env = options.env ?? process.env, client = options.client;
  validateProfile(home, env);
  assertSkillRoot(path.join(home, '.coagent8'), home);
  const catalog = readSkillCatalog(options.skillsSource), file = setupConfigFile(home, env), root = path.join(home, '.coagent8');
  const selection = options.selection;
  if (selection && (!Array.isArray(selection.installed) || !Array.isArray(selection.disabled) || selection.installed.some(name => !catalog.some(item => item.name === name)) || new Set(selection.installed).size !== selection.installed.length || selection.disabled.some(name => !selection.installed.includes(name)) || new Set(selection.disabled).size !== selection.disabled.length)) throw new Error('Invalid skill selection; choose catalog names and a unique disabled subset.');
  const perform = async (): Promise<SkillManagementResult> => {
    if (options.apply !== undefined) recoverSkillTransaction(home);
    const stateSnapshot = read(path.join(root, 'setup.json'));
    const saved = readSelection(path.join(root, 'setup.json'), stateSnapshot);
    const configSnapshot = read(file);
    const configured = readBackendSkills(client, file);
    if (read(file) !== configSnapshot) throw new Error('Skill configuration changed concurrently; inspect a fresh preview.');
    const current = configured ? { installed: configured.installed.filter(name => catalog.some(item => item.name === name)), disabled: configured.disabled.filter(name => catalog.some(item => item.name === name)) } : { installed: catalog.filter(item => saved.skills[client]?.[item.name] || saved.disabledSkills?.[client]?.[item.name]).map(item => item.name), disabled: catalog.filter(item => saved.disabledSkills?.[client]?.[item.name]).map(item => item.name) };
    const desired = selection ?? current;
    const skills = inventory(client, home, catalog, saved, desired);
    const observations = catalog.map(pkg => [pkg.name, observeSkill(path.join(skillRoot(client, home), pkg.name)), observeSkill(path.join(disabledSkillRoot(client, home), pkg.name))]);
    const token = hash(JSON.stringify({ client, home, config: configSnapshot, state: stateSnapshot, catalog: catalog.map(pkg => [pkg.name, pkg.digest]), desired, observations }));
    const result: SkillManagementResult = { client, root: skillRoot(client, home), disabledRoot: disabledSkillRoot(client, home), selection: desired, skills, token };
    if (options.apply === undefined) return result;
    if (!selection || options.apply !== token) throw new Error('Skill preview changed; inspect a fresh preview before applying.');
    if (skills.some(item => item.state === 'conflict' && (item.desired !== (current.installed.includes(item.name) ? current.disabled.includes(item.name) ? 'disabled' : 'enabled' : 'absent')))) throw new Error('Conflicting skill packages are preserved; resolve them before applying this selection.');
    const same = JSON.stringify(configured ?? current) === JSON.stringify(desired);
    // Desired intent is durable first. If an apply fails, repair retries it; actual state is reported separately.
    if (!same || configured === undefined) await setBackendSkills(client, desired, file, configSnapshot);
    reconcileSkills(client, home, catalog, saved, desired, options.origin, stateSnapshot);
    return { ...result, applied: true, skills: inventory(client, home, catalog, saved, desired) };
  };
  if (options.apply === undefined) return perform();
  fs.mkdirSync(root, { recursive: true });
  return withFileLock(path.join(root, 'setup'), perform);
}
