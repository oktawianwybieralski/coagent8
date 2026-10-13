/**
 * VS Code extension PATH opt-in and lifecycle integration.
 *
 * @remarks
 * Implements explicit opt-in PATH configuration, binary shim installation in
 * `~/.coagent8/bin`, and cleanup during extension uninstallation per ARCHITECTURE.md.
 * All registry and environment interactions are decoupled through an injectable adapter.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hash, writeChecked } from './setup-storage.js';
import { withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { redactDiagnostic } from '../security/redaction.js';

export interface WindowsRegistryPath {
  value: string;
  kind: 'REG_SZ' | 'REG_EXPAND_SZ';
}

export interface PathSystemAdapter {
  readUserPath(): Promise<WindowsRegistryPath | null>;
  writeUserPath(value: string, kind: 'REG_SZ' | 'REG_EXPAND_SZ'): Promise<void>;
  broadcastEnvironmentChange(timeoutMs?: number): Promise<void>;
  isWindows(): boolean;
}

export class DefaultWindowsPathAdapter implements PathSystemAdapter {
  isWindows(): boolean {
    return process.platform === 'win32';
  }

  async readUserPath(): Promise<WindowsRegistryPath | null> {
    if (!this.isWindows()) return null;
    try {
      const res = cp.spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000,
      });
      if (res.status !== 0 || !res.stdout) return null;
      const match = /^\s*Path\s+(REG_SZ|REG_EXPAND_SZ)\s*(.*)$/im.exec(res.stdout);
      if (!match) return null;
      return {
        kind: match[1] as 'REG_SZ' | 'REG_EXPAND_SZ',
        value: match[2]?.trim() ?? '',
      };
    } catch {
      return null;
    }
  }

  async writeUserPath(value: string, kind: 'REG_SZ' | 'REG_EXPAND_SZ'): Promise<void> {
    if (!this.isWindows()) return;
    const res = cp.spawnSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', kind, '/d', value, '/f'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.status !== 0) {
      throw new Error(`Failed to write HKCU\\Environment Path: ${res.stderr || res.stdout || 'unknown error'}`);
    }
  }

  async broadcastEnvironmentChange(timeoutMs = 1000): Promise<void> {
    if (!this.isWindows()) return;
    const script = `
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@ -ErrorAction SilentlyContinue;
[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, ${timeoutMs}, [ref][UIntPtr]::Zero)
`;
    try {
      cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        timeout: Math.max(timeoutMs + 2000, 3000),
      });
    } catch {
      // Broadcast is advisory; do not fail operation if broadcast times out
    }
  }
}

export interface PathOwnershipRecord {
  shimPath: string;
  pathEntry: string;
  runtime: string;
  addedToPath: boolean;
  shimHash: string;
  installations: string[];
  userRetained?: boolean;
}

export interface PathOptInOptions {
  home: string;
  storage: string;
  installation: string;
  bundle: string;
  nodePath?: string;
}

export interface PathEnableResult {
  action: 'enabled' | 'unsupported';
  addedToPath: boolean;
  shimPath: string;
}

export interface PathRemovalResult {
  action: 'removed' | 'preserved' | 'missing' | 'blocked';
  message?: string;
}

export interface PathSyncResult {
  action: 'updated' | 'preserved' | 'missing' | 'noop';
}

function installRecordFile(home: string): string {
  return path.join(home, '.coagent8', 'installs.json');
}

function leaseResource(home: string): string {
  return path.join(home, '.coagent8', 'vscode-path');
}

function canonicalFolder(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameInstallation(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const normal = (val: string) => process.platform === 'win32' ? canonicalFolder(val).toLowerCase() : canonicalFolder(val);
  return normal(a) === normal(b);
}

function normalizePathEntry(entry: string): string {
  return entry.trim().replace(/[\\/]+$/, '').toLowerCase();
}

function readRecordFile(home: string): Record<string, unknown> {
  const file = installRecordFile(home);
  let raw: string;
  try {
    raw = readBoundedFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const val = JSON.parse(raw);
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
  return val as Record<string, unknown>;
}

function writeRecordFile(home: string, record: Record<string, unknown>): void {
  const file = installRecordFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (Object.keys(record).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readPathRecord(home: string): PathOwnershipRecord | undefined {
  const record = readRecordFile(home);
  const p = record.path;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const pathObj = p as Record<string, unknown>;
  if (
    typeof pathObj.shimPath === 'string' &&
    typeof pathObj.pathEntry === 'string' &&
    typeof pathObj.shimHash === 'string' &&
    Array.isArray(pathObj.installations)
  ) {
    return {
      shimPath: pathObj.shimPath,
      pathEntry: pathObj.pathEntry,
      runtime: typeof pathObj.runtime === 'string' ? pathObj.runtime : '',
      addedToPath: pathObj.addedToPath === true,
      shimHash: pathObj.shimHash,
      installations: pathObj.installations.filter((i): i is string => typeof i === 'string'),
      userRetained: pathObj.userRetained === true,
    };
  }
  return undefined;
}

function ensureRuntimeCopy(storage: string, bundle: string): string {
  const content = fs.readFileSync(bundle);
  const digest = hash(content);
  const runtimeDir = path.join(storage, 'runtime', digest);
  const target = path.join(runtimeDir, 'index.cjs');
  if (fs.existsSync(target) && hash(fs.readFileSync(target)) === digest) return target;
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return target;
}

function generateShimContent(nodePath: string, runtimeTarget: string): string {
  return `@echo off\r\n"${nodePath}" "${runtimeTarget}" %*\r\n`;
}

export async function enablePathIntegration(
  options: PathOptInOptions,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter()
): Promise<PathEnableResult> {
  if (!adapter.isWindows()) {
    return { action: 'unsupported', addedToPath: false, shimPath: '' };
  }
  return withFileLock(leaseResource(options.home), async () => {
    const runtimeTarget = ensureRuntimeCopy(options.storage, options.bundle);
    const binDir = path.join(options.home, '.coagent8', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const shimPath = path.join(binDir, 'coagent8.cmd');

    const nodeExec = options.nodePath?.trim() || 'node';
    const shimContent = generateShimContent(nodeExec, runtimeTarget);
    const shimDigest = hash(shimContent);

    fs.writeFileSync(shimPath, shimContent, 'utf8');

    const currentPath = await adapter.readUserPath();
    const kind = currentPath?.kind ?? 'REG_SZ';
    const rawVal = currentPath?.value ?? '';
    const parts = rawVal.split(';').map(p => p.trim()).filter(Boolean);

    const normalizedBin = normalizePathEntry(binDir);
    const alreadyExists = parts.some(p => normalizePathEntry(p) === normalizedBin);

    let addedToPath = false;
    if (!alreadyExists) {
      parts.push(binDir);
      await adapter.writeUserPath(parts.join(';'), kind);
      await adapter.broadcastEnvironmentChange(1000);
      addedToPath = true;
    }

    const records = readRecordFile(options.home);
    const existingPath = readPathRecord(options.home);
    const installations = existingPath?.installations ? [...existingPath.installations] : [];
    if (!installations.some(i => sameInstallation(i, options.installation))) {
      installations.push(options.installation);
    }

    const updatedRecord: PathOwnershipRecord = {
      shimPath,
      pathEntry: binDir,
      runtime: runtimeTarget,
      addedToPath: existingPath ? existingPath.addedToPath || addedToPath : addedToPath,
      shimHash: shimDigest,
      installations,
    };

    records.path = updatedRecord;
    writeRecordFile(options.home, records);

    return { action: 'enabled', addedToPath, shimPath };
  });
}

export async function disablePathIntegration(
  options: PathOptInOptions,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter()
): Promise<PathRemovalResult> {
  return withFileLock(leaseResource(options.home), async () => {
    const records = readRecordFile(options.home);
    const record = readPathRecord(options.home);
    if (!record) return { action: 'missing' };

    if (fs.existsSync(record.shimPath)) {
      const onDiskHash = hash(fs.readFileSync(record.shimPath));
      if (onDiskHash === record.shimHash) {
        fs.rmSync(record.shimPath, { force: true });
        const dir = path.dirname(record.shimPath);
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch {}
      }
    }

    if (record.addedToPath) {
      const current = await adapter.readUserPath();
      if (current) {
        const normalizedTarget = normalizePathEntry(record.pathEntry);
        const kept = current.value
          .split(';')
          .map(p => p.trim())
          .filter(p => p && normalizePathEntry(p) !== normalizedTarget);
        if (kept.length !== current.value.split(';').filter(Boolean).length) {
          await adapter.writeUserPath(kept.join(';'), current.kind);
          await adapter.broadcastEnvironmentChange(500);
        }
      }
    }

    delete records.path;
    writeRecordFile(options.home, records);
    return { action: 'removed' };
  });
}

export async function syncPathShim(
  options: PathOptInOptions,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter()
): Promise<PathSyncResult> {
  if (!adapter.isWindows()) return { action: 'noop' };
  if (!readPathRecord(options.home)) return { action: 'missing' };
  return withFileLock(leaseResource(options.home), async () => {
    const records = readRecordFile(options.home);
    const record = readPathRecord(options.home);
    if (!record) return { action: 'missing' };

    if (!record.installations.some(i => sameInstallation(i, options.installation))) {
      return { action: 'noop' };
    }

    if (!fs.existsSync(record.shimPath)) return { action: 'missing' };

    const onDiskContent = fs.readFileSync(record.shimPath);
    if (hash(onDiskContent) !== record.shimHash) {
      return { action: 'preserved' };
    }

    const runtimeTarget = ensureRuntimeCopy(options.storage, options.bundle);
    const nodeExec = options.nodePath?.trim() || 'node';
    const newShimContent = generateShimContent(nodeExec, runtimeTarget);
    const newShimHash = hash(newShimContent);

    fs.writeFileSync(record.shimPath, newShimContent, 'utf8');
    record.runtime = runtimeTarget;
    record.shimHash = newShimHash;
    records.path = record;
    writeRecordFile(options.home, records);

    return { action: 'updated' };
  });
}

export async function removePathIntegration(
  home: string,
  installation: string,
  leaseTimeoutMs = 1500,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter()
): Promise<PathRemovalResult> {
  if (!readPathRecord(home)) return { action: 'missing' };
  const res = await withFileLock<PathRemovalResult>(
    leaseResource(home),
    async (): Promise<PathRemovalResult> => {
      const records = readRecordFile(home);
      const record = readPathRecord(home);
      if (!record) return { action: 'missing' };

      const isOwner = record.installations.some(i => sameInstallation(i, installation));
      if (!isOwner) return { action: 'preserved', message: 'Not an owner of PATH integration' };

      const remaining = record.installations.filter(i => !sameInstallation(i, installation));
      record.installations = remaining;

      if (remaining.length > 0) {
        records.path = record;
        writeRecordFile(home, records);
        return { action: 'preserved', message: 'Remaining installations active' };
      }

      if (fs.existsSync(record.shimPath)) {
        const onDiskHash = hash(fs.readFileSync(record.shimPath));
        if (onDiskHash !== record.shimHash) {
          record.userRetained = true;
          records.path = record;
          writeRecordFile(home, records);
          return { action: 'preserved', message: 'User-modified shim preserved' };
        }

        fs.rmSync(record.shimPath, { force: true });
        const dir = path.dirname(record.shimPath);
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch {}
      }

      if (record.addedToPath) {
        try {
          const current = await adapter.readUserPath();
          if (current) {
            const normalizedTarget = normalizePathEntry(record.pathEntry);
            const kept = current.value
              .split(';')
              .map(p => p.trim())
              .filter(p => p && normalizePathEntry(p) !== normalizedTarget);
            if (kept.length !== current.value.split(';').filter(Boolean).length) {
              await adapter.writeUserPath(kept.join(';'), current.kind);
              await adapter.broadcastEnvironmentChange(500);
            }
          }
        } catch {
          // Bounded tolerance for environment broadcast/registry during uninstall
        }
      }

      delete records.path;
      writeRecordFile(home, records);
      return { action: 'removed' };
    },
    leaseTimeoutMs
  );
  const root = path.join(home, '.coagent8');
  try {
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
      fs.rmdirSync(root);
    }
  } catch {}
  return res;
}

