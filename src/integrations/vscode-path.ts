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
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hash } from './setup-storage.js';
import { pruneUnreferencedRuntimes } from './cleanup.js';
import { withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { redactDiagnostic } from '../security/redaction.js';

export interface WindowsRegistryPath {
  value: string;
  kind: 'REG_SZ' | 'REG_EXPAND_SZ';
  exists?: boolean;
}

export interface PathSystemAdapter {
  readUserPath(timeoutMs?: number): Promise<WindowsRegistryPath | null>;
  writeUserPath(value: string, kind: 'REG_SZ' | 'REG_EXPAND_SZ', timeoutMs?: number): Promise<void>;
  /**
   * Tells open windows that the environment changed. Advisory and bounded by `timeoutMs`,
   * including process start; never rejects.
   * @returns Whether the change was delivered.
   */
  broadcastEnvironmentChange(timeoutMs?: number): Promise<boolean>;
  isWindows(): boolean;
  /** Whether this adapter's user `PATH` belongs to `home`; enable and remove refuse any other home. */
  ownsHome(home: string): boolean;
}

function resolvePowerShellExecutable(): string {
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const candidate = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

export class DefaultWindowsPathAdapter implements PathSystemAdapter {
  /** @param powershell - Windows PowerShell executable; the system copy unless a test names another. */
  constructor(private readonly powershell = resolvePowerShellExecutable()) {}

  isWindows(): boolean {
    return process.platform === 'win32';
  }

  /**
   * `HKCU\Environment` belongs to the signed-in account. On Windows `os.userInfo().homedir`
   * comes from the process token, not from `HOME` or `USERPROFILE`, so a redirected home
   * (a test fixture or a tool run with another home) never edits the account's real `PATH`.
   */
  ownsHome(home: string): boolean {
    return sameFolder(home, os.userInfo().homedir);
  }

  async readUserPath(timeoutMs = 5000): Promise<WindowsRegistryPath | null> {
    if (!this.isWindows()) return null;
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($null -eq $key) {
  Write-Output '{"exists":false,"kind":"REG_SZ","value":""}'
} else {
  try {
    $names = $key.GetValueNames()
    if ($names -notcontains 'Path') {
      Write-Output '{"exists":false,"kind":"REG_SZ","value":""}'
    } else {
      $kind = $key.GetValueKind('Path')
      $val = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kindStr = if ($kind.ToString() -eq 'ExpandString') { 'REG_EXPAND_SZ' } else { 'REG_SZ' }
      Write-Output (@{ exists = $true; kind = $kindStr; value = [string]$val } | ConvertTo-Json -Compress)
    }
  } finally {
    $key.Close()
  }
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = this.powershell;
    let res: cp.SpawnSyncReturns<string>;
    try {
      res = cp.spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: timeoutMs,
      });
    } catch (err) {
      throw new Error(`Failed to execute powershell.exe: ${(err as Error).message}`);
    }
    if (res.error) {
      throw new Error(`Registry query error: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`Failed to query HKCU\\Environment Path (exit ${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
    }
    try {
      const parsed = JSON.parse(res.stdout.trim());
      return {
        exists: Boolean(parsed.exists),
        kind: parsed.kind === 'REG_EXPAND_SZ' ? 'REG_EXPAND_SZ' : 'REG_SZ',
        value: typeof parsed.value === 'string' ? parsed.value : '',
      };
    } catch (err) {
      throw new Error(`Unexpected registry query output format: ${res.stdout.trim()}`);
    }
  }

  async writeUserPath(value: string, kind: 'REG_SZ' | 'REG_EXPAND_SZ', timeoutMs = 5000): Promise<void> {
    if (!this.isWindows()) return;
    const script = `
$ErrorActionPreference = 'Stop'
$targetKind = if ($env:COAGENT8_REG_KIND -eq 'REG_EXPAND_SZ') { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { [Microsoft.Win32.RegistryValueKind]::String }
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $val = if ($null -eq $env:COAGENT8_REG_VAL) { '' } else { [string]$env:COAGENT8_REG_VAL }
  if ($val -eq '') {
    $key.DeleteValue('Path', $false)
    if ($key.GetValueNames() -contains 'Path') {
      throw 'Registry delete verification failed: Path is still present'
    }
  } else {
    $key.SetValue('Path', $val, $targetKind)
    $written = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ([string]$written -ne $val) {
      throw 'Registry write verification failed: readback did not match written value'
    }
  }
} catch {
  [Console]::Error.WriteLine($_)
  exit 1
} finally {
  $key.Close()
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = this.powershell;
    let res: cp.SpawnSyncReturns<string>;
    try {
      res = cp.spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          COAGENT8_REG_KIND: kind,
          COAGENT8_REG_VAL: value,
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      throw new Error(`Failed to execute powershell.exe: ${(err as Error).message}`);
    }
    if (res.error) {
      throw new Error(`Registry write error: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`Failed to write HKCU\\Environment Path: ${res.stderr || res.stdout || 'unknown error'}`);
    }
  }

  async broadcastEnvironmentChange(timeoutMs = 1000): Promise<boolean> {
    if (!this.isWindows()) return true;
    const budget = Math.max(timeoutMs, 50);
    const perWindow = Math.min(budget, 3000);
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
$result = [UIntPtr]::Zero
$sent = [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, ${perWindow}, [ref]$result)
if ($sent -eq [IntPtr]::Zero) { exit 1 }
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // Not detached: a detached child gets no CREATE_NO_WINDOW and can show a console window.
    // The child is owned and awaited, and the timeout kills it when the budget runs out.
    return new Promise<boolean>(resolve => {
      let child: cp.ChildProcess;
      try {
        child = cp.spawn(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: budget,
        });
      } catch {
        resolve(false);
        return;
      }
      child.once('error', () => resolve(false));
      child.once('exit', code => resolve(code === 0));
    });
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
  /** False when open windows were not told about a changed `PATH`; a sign-out applies it. */
  environmentNotified: boolean;
}

export interface PathRemovalResult {
  action: 'removed' | 'preserved' | 'missing' | 'blocked';
  message?: string;
  /** False when the `PATH` entry was removed but open windows were not told. */
  environmentNotified?: boolean;
}

export interface PathSyncResult {
  action: 'updated' | 'preserved' | 'missing' | 'noop';
}

function installRecordFile(home: string): string {
  return path.join(home, '.coagent8', 'installs.json');
}

function canonicalFolder(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameFolder(a: string, b: string): boolean {
  const normal = (val: string) => (process.platform === 'win32' ? canonicalFolder(val).toLowerCase() : canonicalFolder(val));
  return normal(a) === normal(b);
}

function sameInstallation(a: string | undefined, b: string): boolean {
  return a !== undefined && sameFolder(a, b);
}

function normalizePathEntry(entry: string): string {
  return entry
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();
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

function setupLockTarget(home: string): string {
  return path.join(home, '.coagent8', 'setup');
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

function ensureRuntimeCopy(home: string, bundle: string): string {
  const content = fs.readFileSync(bundle);
  const digest = hash(content);
  const runtimeDir = path.join(home, '.coagent8', 'runtime', digest);
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

function atomicWriteShim(shimPath: string, content: string): void {
  const dir = path.dirname(shimPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${shimPath}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o755 });
    fs.renameSync(tmp, shimPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Removes `normalizedEntry` from the user `PATH` after a write whose outcome is unknown.
 * @returns Whether the entry may still be present.
 */
async function entryMayRemain(adapter: PathSystemAdapter, normalizedEntry: string): Promise<boolean> {
  try {
    const current = await adapter.readUserPath();
    if (!current) return true;
    const entries = current.value
      .split(';')
      .map(p => p.trim())
      .filter(Boolean);
    const kept = entries.filter(p => normalizePathEntry(p) !== normalizedEntry);
    if (kept.length === entries.length) return false;
    await adapter.writeUserPath(kept.join(';'), current.kind);
    return false;
  } catch {
    return true;
  }
}

export async function enablePathIntegration(
  options: PathOptInOptions,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter(),
): Promise<PathEnableResult> {
  if (!adapter.isWindows()) {
    return { action: 'unsupported', addedToPath: false, shimPath: '', environmentNotified: true };
  }
  if (!adapter.ownsHome(options.home)) {
    throw new Error(`The user PATH does not belong to ${options.home}`);
  }
  return withFileLock(setupLockTarget(options.home), async () => {
    const binDir = path.join(options.home, '.coagent8', 'bin');
    const shimPath = path.join(binDir, 'coagent8.cmd');

    const records = readRecordFile(options.home);
    const existingPath = readPathRecord(options.home);

    let shimExistedBefore = false;
    let previousShimContent: string | null = null;
    if (fs.existsSync(shimPath)) {
      shimExistedBefore = true;
      previousShimContent = fs.readFileSync(shimPath, 'utf8');
      const onDiskHash = hash(previousShimContent);
      if (!existingPath) {
        throw new Error(`Cannot overwrite unowned file at ${shimPath}`);
      }
      if (onDiskHash !== existingPath.shimHash) {
        throw new Error(`Cannot overwrite user-modified shim at ${shimPath}`);
      }
    }

    const currentPath = await adapter.readUserPath();
    if (currentPath === null && adapter.isWindows()) {
      throw new Error('Failed to read HKCU\\Environment Path');
    }
    const kind = currentPath?.kind ?? 'REG_SZ';
    const rawVal = currentPath?.value ?? '';
    const parts = rawVal
      .split(';')
      .map(p => p.trim())
      .filter(Boolean);

    const runtimeTarget = ensureRuntimeCopy(options.home, options.bundle);
    const nodeExec = options.nodePath?.trim() || 'node';
    const shimContent = generateShimContent(nodeExec, runtimeTarget);
    const shimDigest = hash(shimContent);

    atomicWriteShim(shimPath, shimContent);

    const rollbackShim = () => {
      try {
        if (!shimExistedBefore) {
          fs.rmSync(shimPath, { force: true });
        } else if (previousShimContent !== null) {
          atomicWriteShim(shimPath, previousShimContent);
        }
      } catch {}
    };

    const normalizedBin = normalizePathEntry(binDir);
    const alreadyExists = parts.some(p => normalizePathEntry(p) === normalizedBin);

    const installations = existingPath?.installations ? [...existingPath.installations] : [];
    if (!installations.some(i => sameInstallation(i, options.installation))) {
      installations.push(options.installation);
    }

    const updatedRecord: PathOwnershipRecord = {
      shimPath,
      pathEntry: binDir,
      runtime: runtimeTarget,
      addedToPath: existingPath ? existingPath.addedToPath || !alreadyExists : !alreadyExists,
      shimHash: shimDigest,
      installations,
    };

    records.path = updatedRecord;
    try {
      writeRecordFile(options.home, records);
    } catch (err) {
      rollbackShim();
      throw err;
    }

    let addedToPath = false;
    let environmentNotified = true;
    if (!alreadyExists) {
      parts.push(binDir);
      try {
        await adapter.writeUserPath(parts.join(';'), kind);
      } catch (err) {
        // A failed or timed-out write may still have reached the registry. Take the entry out
        // again; while it may remain, the shim and the record stay so Remove from PATH or the
        // uninstall hook can clean it up later.
        if (await entryMayRemain(adapter, normalizedBin)) {
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}; the PATH entry may remain and is still recorded for removal`,
          );
        }
        rollbackShim();
        if (existingPath) {
          records.path = existingPath;
        } else {
          delete records.path;
        }
        try {
          writeRecordFile(options.home, records);
        } catch {}
        throw err;
      }
      environmentNotified = await adapter.broadcastEnvironmentChange(5000);
      addedToPath = true;
    }

    return { action: 'enabled', addedToPath, shimPath, environmentNotified };
  });
}

export async function disablePathIntegration(
  options: PathOptInOptions,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter(),
): Promise<PathRemovalResult> {
  return removePathIntegration(options.home, options.installation, 5000, adapter);
}

export async function syncPathShim(
  options: PathOptInOptions,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter(),
): Promise<PathSyncResult> {
  if (!adapter.isWindows()) return { action: 'noop' };
  if (!readPathRecord(options.home)) return { action: 'missing' };
  return withFileLock(setupLockTarget(options.home), async () => {
    const records = readRecordFile(options.home);
    const record = readPathRecord(options.home);
    if (!record) return { action: 'missing' };

    if (!record.installations.some(i => sameInstallation(i, options.installation))) {
      return { action: 'noop' };
    }

    if (!fs.existsSync(record.shimPath)) return { action: 'missing' };

    const previousShimContent = fs.readFileSync(record.shimPath, 'utf8');
    if (hash(previousShimContent) !== record.shimHash) {
      return { action: 'preserved' };
    }

    const runtimeTarget = ensureRuntimeCopy(options.home, options.bundle);
    const nodeExec = options.nodePath?.trim() || 'node';
    const newShimContent = generateShimContent(nodeExec, runtimeTarget);
    const newShimHash = hash(newShimContent);

    atomicWriteShim(record.shimPath, newShimContent);
    record.runtime = runtimeTarget;
    record.shimHash = newShimHash;
    records.path = record;
    try {
      writeRecordFile(options.home, records);
    } catch (err) {
      try {
        atomicWriteShim(record.shimPath, previousShimContent);
      } catch {}
      throw err;
    }

    return { action: 'updated' };
  });
}

export async function removePathIntegration(
  home: string,
  installation: string,
  leaseTimeoutMs = 1500,
  adapter: PathSystemAdapter = new DefaultWindowsPathAdapter(),
  deadline = Date.now() + leaseTimeoutMs,
): Promise<PathRemovalResult> {
  if (!readPathRecord(home)) return { action: 'missing' };
  if (!adapter.ownsHome(home)) {
    return { action: 'blocked', message: 'The user PATH does not belong to this home' };
  }
  const timeRemaining = () => deadline - Date.now();
  if (timeRemaining() <= 0) {
    return { action: 'blocked', message: 'Uninstall deadline exceeded before PATH removal' };
  }
  const res = await withFileLock<PathRemovalResult>(
    setupLockTarget(home),
    async (): Promise<PathRemovalResult> => {
      const records = readRecordFile(home);
      const record = readPathRecord(home);
      if (!record) return { action: 'missing' };

      const isOwner = record.installations.some(i => sameInstallation(i, installation));
      if (!isOwner) return { action: 'preserved', message: 'Not an owner of PATH integration' };

      const remaining = record.installations.filter(i => !sameInstallation(i, installation));
      if (remaining.length > 0) {
        record.installations = remaining;
        records.path = record;
        writeRecordFile(home, records);
        return { action: 'preserved', message: 'Remaining installations active' };
      }

      // Check budget before performing any destructive file system changes
      if (record.addedToPath && timeRemaining() <= 100) {
        records.path = record;
        try {
          writeRecordFile(home, records);
        } catch {}
        return { action: 'blocked', message: 'Uninstall deadline exceeded before registry operation' };
      }

      let environmentNotified = true;
      let previousShimContent: string | null = null;
      let shimRemoved = false;
      const restoreShimIfNeeded = () => {
        if (shimRemoved && previousShimContent !== null) {
          try {
            atomicWriteShim(record.shimPath, previousShimContent);
          } catch {}
        }
      };

      if (fs.existsSync(record.shimPath)) {
        const onDiskContent = fs.readFileSync(record.shimPath, 'utf8');
        const onDiskHash = hash(onDiskContent);
        if (onDiskHash !== record.shimHash) {
          record.userRetained = true;
          record.installations = remaining;
          records.path = record;
          writeRecordFile(home, records);
          return { action: 'preserved', message: 'User-modified shim preserved' };
        }

        previousShimContent = onDiskContent;
        fs.rmSync(record.shimPath, { force: true });
        shimRemoved = true;
        const dir = path.dirname(record.shimPath);
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch {}
      }

      if (record.addedToPath) {
        const remainingRead = timeRemaining();
        if (remainingRead <= 0) {
          restoreShimIfNeeded();
          records.path = record;
          try {
            writeRecordFile(home, records);
          } catch {}
          return { action: 'blocked', message: 'Uninstall deadline exceeded before registry read' };
        }
        try {
          const readBudget = Math.max(100, remainingRead - 200);
          const current = await adapter.readUserPath(readBudget);
          if (current) {
            const normalizedTarget = normalizePathEntry(record.pathEntry);
            const originalEntries = current.value
              .split(';')
              .map(p => p.trim())
              .filter(Boolean);
            const kept = originalEntries.filter(p => normalizePathEntry(p) !== normalizedTarget);
            if (kept.length !== originalEntries.length) {
              const remainingWrite = timeRemaining();
              if (remainingWrite <= 0) {
                throw new Error('Uninstall deadline exceeded before registry write');
              }
              const writeBudget = Math.max(100, remainingWrite - 100);
              await adapter.writeUserPath(kept.join(';'), current.kind, writeBudget);
              const remainingBroadcast = timeRemaining();
              environmentNotified =
                remainingBroadcast > 100 && (await adapter.broadcastEnvironmentChange(Math.min(remainingBroadcast, 1500)));
            }
          }
        } catch (error) {
          restoreShimIfNeeded();
          records.path = record;
          try {
            writeRecordFile(home, records);
          } catch {}
          return { action: 'blocked', message: redactDiagnostic(error instanceof Error ? error.message : String(error)) };
        }
      }

      delete records.path;
      writeRecordFile(home, records);
      const root = path.join(home, '.coagent8');
      try {
        pruneUnreferencedRuntimes(root, home);
      } catch {}
      return { action: 'removed', environmentNotified };
    },
    Math.min(leaseTimeoutMs, Math.max(100, timeRemaining())),
  );
  const root = path.join(home, '.coagent8');
  if (res.action === 'removed') {
    try {
      if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
        fs.rmdirSync(root);
      }
    } catch {}
  }
  return res;
}
