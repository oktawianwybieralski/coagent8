/**
 * Explicit preview/apply cleanup of unchanged, fingerprint-owned registrations.
 * @remarks Runtime files, credentials, histories, extensions and VS Code databases
 * are retained. Cleanup works even when the backend CLI has been uninstalled.
 * @packageDocumentation
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify } from 'jsonc-parser';
import { withFileLock } from '../storage/lock.js';
import { redactDiagnostic } from '../redaction.js';
import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
import { backupDirectory, configPath, document, EXTENSION_BACKUP_PREFIX, hash, read, readSelection, servers, writeChecked, type RegistrationOrigin } from './setup-storage.js';

/** Public cleanup evidence contains neither configuration contents nor private backup paths. */
export interface CleanupStatus {
  client: SetupClient;
  action: 'remove' | 'removed' | 'absent' | 'preserved' | 'blocked';
  message: string;
}
export interface CleanupOptions {
  clients?: SetupClient[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Omit to preview. Apply requires the exact token from a current preview. */
  apply?: string;
  /** Limits removal to registrations recorded with this origin; others are preserved. */
  origin?: RegistrationOrigin;
  /** Who removes the entries; the VS Code extension's private backups are tagged so its uninstall removes them. */
  actor?: RegistrationOrigin;
  /**
   * Uninstall mode for the VS Code extension: no private backup of the verified, unchanged
   * entry (setup can recreate it), and runtime copies no registration references are
   * deleted with an empty CoAgent8 setup state, together with the private backups
   * written for the extension.
   */
  uninstall?: boolean;
}
export interface CleanupPreview { token: string; results: CleanupStatus[]; stateError?: string }

function removeEntry(client: SetupClient, before: string): string {
  // Remove only full owned TOML tables, preserving bytes of other tables/comments.
  // Parsing the header handles quoted keys; an inline/dotted unsupported layout
  // fails closed below instead of rewriting the user's entire document.
  let owned = false;
  const after = client !== 'codex'
    ? applyEdits(before, modify(before, ['mcpServers', 'coagent8'], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
    : before.split(/(?<=\n)/).filter(line => {
    if (/^\s*\[/.test(line)) {
      try { owned = Object.hasOwn(servers('codex', document('codex', line + '\n')), 'coagent8'); }
      catch { owned = false; }
    }
    return !owned;
  }).join('');
  const oldDoc = document(client, before), newDoc = document(client, after);
  const { coagent8: _removed, ...remaining } = servers(client, oldDoc);
  const key = client === 'codex' ? 'mcp_servers' : 'mcpServers';
  if (!isDeepStrictEqual({ ...servers(client, newDoc) }, remaining)
      || !isDeepStrictEqual({ ...oldDoc, [key]: undefined }, { ...newDoc, [key]: undefined })) {
    throw new Error('Entry cannot be removed without changing other settings; preserved.');
  }
  return after;
}

/**
 * Deletes runtime copies that no host registration references, the private backups
 * written for the VS Code extension, and the setup state when it no longer records a
 * selection or an owned registration. Backups of `coagent8` CLI changes are kept.
 * @throws When a host configuration cannot be read; nothing is deleted then.
 */
function removeUnreferencedSetup(root: string, home: string, env: NodeJS.ProcessEnv, stateFile: string): void {
  const runtimes = path.join(root, 'runtime');
  const referenced = new Set<string>();
  for (const client of SETUP_CLIENTS) {
    const text = read(configPath(client, home, env));
    if (text === null) continue;
    for (const entry of Object.values(servers(client, document(client, text)))) {
      for (const arg of Array.isArray((entry as { args?: unknown })?.args) ? (entry as { args: unknown[] }).args : []) {
        if (typeof arg === 'string' && path.resolve(arg).startsWith(runtimes + path.sep)) referenced.add(path.relative(runtimes, path.resolve(arg)).split(path.sep)[0]!);
      }
    }
  }
  if (fs.existsSync(runtimes)) {
    for (const name of fs.readdirSync(runtimes)) {
      if (/^[a-f0-9]{64}$/.test(name) && !referenced.has(name)) fs.rmSync(path.join(runtimes, name), { recursive: true, force: true });
    }
    if (!fs.readdirSync(runtimes).length) fs.rmdirSync(runtimes);
  }
  const backups = path.join(root, 'setup-backups');
  if (fs.existsSync(backups)) {
    for (const name of fs.readdirSync(backups)) {
      if (name.startsWith(EXTENSION_BACKUP_PREFIX)) fs.rmSync(path.join(backups, name), { recursive: true, force: true });
    }
    if (!fs.readdirSync(backups).length) fs.rmdirSync(backups);
  }
  const saved = readSelection(stateFile);
  if (!saved.clients.length && !Object.keys(saved.owned).length) fs.rmSync(stateFile, { force: true });
}

/** Previews cleanup or applies a matching preview under the same lease as setup. */
export async function cleanupClients(options: CleanupOptions = {}): Promise<CleanupPreview> {
  const home = path.resolve(options.home || os.homedir()), env = options.env || process.env;
  if (env.CODEX_CONFIG_PATH || env.CLAUDE_CONFIG_DIR || env.GEMINI_CLI_HOME || (env.CODEX_HOME && path.resolve(env.CODEX_HOME) !== path.join(home, '.codex'))) {
    throw new Error('Custom client/profile roots are unsupported; cleanup requires the local default profile.');
  }
  const root = path.join(home, '.coagent8'), stateFile = path.join(root, 'setup.json');
  async function perform(): Promise<CleanupPreview> {
    const stateBefore = read(stateFile), saved = readSelection(stateFile, stateBefore);
    const selected = [...new Set(options.clients ?? SETUP_CLIENTS)];
    if (!selected.length || !selected.every(client => SETUP_CLIENTS.includes(client))) throw new Error('Unknown cleanup client.');
    const snapshots = new Map<SetupClient, { file: string; before: string | null; after?: string }>();
    const results: CleanupStatus[] = selected.map(client => {
      try {
        const file = configPath(client, home, env), before = read(file);
        snapshots.set(client, { file, before });
        const entry = before === null ? undefined : servers(client, document(client, before)).coagent8;
        if (entry === undefined) return { client, action: 'absent', message: 'No CoAgent8 entry; nothing to remove.' };
        if (!saved.owned[client] || hash(JSON.stringify(entry)) !== saved.owned[client]) {
          return { client, action: 'preserved', message: 'Manual or independently edited entry preserved; no matching ownership.' };
        }
        if (options.origin && saved.origin[client] !== options.origin) {
          return { client, action: 'preserved', message: 'Entry registered outside the VS Code extension preserved.' };
        }
        snapshots.set(client, { file, before, after: removeEntry(client, before!) });
        return { client, action: 'remove', message: 'Unchanged owned entry; removal keeps other settings and retains runtime files.' };
      } catch (error) {
        return { client, action: 'blocked', message: redactDiagnostic(error instanceof Error ? error.message : 'Cleanup failed.') };
      }
    });
    const token = hash(JSON.stringify({ home, state: stateBefore === null ? null : hash(stateBefore), selected,
      files: selected.map(client => { const item = snapshots.get(client); return item ? [item.file, item.before === null ? null : hash(item.before)] : null; }), results }));
    if (options.apply === undefined) return { token, results };
    if (options.apply !== token) throw new Error('Cleanup preview changed; inspect a new preview before applying.');
    for (const result of results) {
      if (result.action !== 'remove' && result.action !== 'absent') continue;
      try {
        const snapshot = snapshots.get(result.client)!;
        if (read(stateFile) !== stateBefore) throw new Error('Setup ownership changed concurrently; cleanup stopped.');
        if (result.action === 'remove') {
          if (!options.uninstall) {
            const backup = backupDirectory(root, options.actor);
            fs.writeFileSync(path.join(backup, result.client + '.config'), snapshot.before!, { flag: 'wx', mode: 0o600 });
          }
          writeChecked(snapshot.file, snapshot.before, snapshot.after!);
          result.action = 'removed';
          result.message = options.uninstall ? 'Owned registration removed with the VS Code extension. Restart the host to refresh its catalog.'
            : 'Owned registration removed; private backup and runtime files retained. Restart the host to refresh its catalog.';
        } else if (read(snapshot.file) !== snapshot.before) throw new Error('Configuration changed concurrently; retry cleanup.');
        delete saved.owned[result.client];
        delete saved.origin[result.client];
        saved.clients = saved.clients.filter(client => client !== result.client);
      } catch (error) {
        result.action = 'blocked';
        result.message = redactDiagnostic(error instanceof Error ? error.message : 'Cleanup failed; backup retained.');
      }
    }
    // Absent stale ownership is safely recoverable after an interrupted removal.
    if (stateBefore !== null) {
      try { writeChecked(stateFile, stateBefore, JSON.stringify(saved, null, 2) + '\n'); }
      catch { return { token, results, stateError: 'Registration results above are final, but setup state changed or could not be saved. Keep backups and retry a fresh preview.' }; }
    }
    if (options.uninstall) {
      try { removeUnreferencedSetup(root, home, env, stateFile); }
      catch (error) { return { token, results, stateError: redactDiagnostic(error instanceof Error ? error.message : 'Unreferenced runtime copies could not be removed.') }; }
    }
    return { token, results };
  }
  if (options.apply === undefined) return perform();
  const applied = await withFileLock(path.join(root, 'setup'), perform);
  // The lease lived in the directory until now; remove it only when nothing else remains.
  if (options.uninstall && fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
  return applied;
}
