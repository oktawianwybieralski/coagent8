/**
 * Stable runtime launcher, atomic pointer updates, runtime verification, per-process leases,
 * and lease-aware cleanup (`#250`).
 *
 * @remarks
 * Content-addressed runtime copies live under `<root>/runtime/<sha256>/`.
 * Stable entrypoints (`<root>/runtime/current/index.cjs` and `<root>/runtime/dev/index.cjs`)
 * validate their adjacent `pointer.json`, acquire a per-process runtime lease under the shared
 * `runtime-lock` lease, record the resolved immutable path for child commands (`wait`), and load
 * the target bundle in-process.
 *
 * @packageDocumentation
 */

import cp from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRAND } from '../brand.js';
import { resolveCliCommand } from '../execution/cli-resolver.js';
import { redactDiagnostic } from '../security/redaction.js';
import { LockTimeoutError, withFileLock } from '../storage/lock.js';
import { readBoundedFileSync } from '../storage/read.js';
import { object, withStdioRpc } from './rpc.js';
import { copyJobHelperBeside, removeRuntimeDirectory } from './runtime-files.js';
import { compareSemver, isDevSemver, parseSemver, type RuntimeNamespace } from './runtime-version.js';
import { SETUP_CLIENTS, type SetupClient } from './setup-clients.js';
import { configPath, document, json, read, servers } from './setup-storage.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const POINTER_LIMIT = 64 * 1024;
const BUNDLE_LIMIT = 16 * 1024 * 1024;
const LEASE_LIMIT = 16 * 1024;
const LEASE_CAPABLE_MARKER = '.lease-capable';
const STAGED_POINTER_NAME = 'pointer.next.json';
const PROBE_POINTER_ARG_PREFIX = '--probe-pointer=';
/** Maximum age (ms) of an unrenewed runtime lease before identity re-verification runs. */
export const RUNTIME_LEASE_MAX_AGE_MS = 60_000;
/** Shared lock timeout for short runtime pointer, copy, and lease metadata operations. */
const RUNTIME_LOCK_TIMEOUT_MS = 5_000;
/** Updater lock timeout serializing full verified runtime update/pin/unpin transactions across probes. */
const RUNTIME_UPDATE_LOCK_TIMEOUT_MS = 60_000;

/** Explicit downgrade/rollback pin stored in `pointer.json`. */
export interface RuntimePin {
  digest: string;
  version: string;
  pinnedAt: string;
  reason?: string;
}

/** Validated pointer document adjacent to the stable launcher. */
export interface RuntimePointer {
  schemaVersion: 1;
  digest: string;
  version: string;
  updatedAt: string;
  pinned?: RuntimePin;
}

/** Per-process lease recorded under `<runtimeRoot>/leases/`. */
export interface RuntimeLease {
  schemaVersion: 1;
  pid: number;
  token: string;
  digest: string;
  execPath: string;
  createdAt: number;
  linuxStartTime?: string;
}

/** Options for installing a runtime copy without yet switching the pointer. */
export interface RuntimeCopyOptions {
  home: string;
  runtimeSource: string;
  version?: string;
  arch?: string;
}

/** Verified immutable runtime copy ready for probing and pointer selection. */
export interface InstalledRuntimeCopy {
  root: string;
  runtimeRoot: string;
  digest: string;
  version: string;
  runtimeDir: string;
  runtimePath: string;
}

/** Options for installing and selecting a stable runtime pointer. */
export interface RuntimeInstallOptions extends RuntimeCopyOptions {
  namespace?: RuntimeNamespace;
  allowDevInCurrent?: boolean;
  pin?: boolean;
  unpin?: boolean;
  reason?: string;
}

/** Result of pointer selection under precedence and pin rules. */
export interface RuntimeInstallResult {
  namespace: RuntimeNamespace;
  launcherPath: string;
  pointerFile: string;
  runtimePath: string;
  digest: string;
  version: string;
  action: 'installed' | 'updated' | 'noop' | 'kept-incumbent' | 'downgrade-blocked' | 'pinned-blocked';
  incumbent?: { digest: string; version: string; pinned?: RuntimePin };
  message: string;
}

/** Options for {@link cleanupUnreferencedRuntimes}. */
export interface RuntimeCleanupOptions {
  /** Keep `current/` and `dev/` launcher directories even if no host config references them yet. */
  keepStableNamespaces?: boolean;
  /** Additional runtime digests that must be preserved (for example active VS Code globalStorage copy). */
  extraReferencedDigests?: string[];
  /**
   * Allow deleting pre-lease copies lacking `.lease-capable`. Only full uninstall should set this;
   * automatic and explicit runtime cleanups keep pre-lease copies because older servers write no leases.
   */
  removePreLeaseCopies?: boolean;
  /** Maximum time to wait for the runtime lock (ms). */
  leaseTimeoutMs?: number;
  /** Override for testing OS process identity checks on aged leases. */
  checkProcessIdentity?: (lease: RuntimeLease) => 'alive' | 'dead' | 'uncertain';
}

/** Options for probing and selecting a candidate runtime with incumbent rollback on failure. */
export interface VerifiedRuntimeInstallOptions extends RuntimeInstallOptions {
  /** Node executable supplied by VS Code or caller; defaults to `process.execPath`. */
  nodePath?: string;
  /** Environment used to resolve `nodePath` and spawn runtime probes. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for runtime probes. */
  cwd?: string;
  /** Additional environment variables injected into the probed runtime (e.g. `coagent8_CONFIG`). */
  probeEnv?: Record<string, string>;
}

/** Result returned by {@link installAndSelectVerifiedRuntime}, including discovered tool names when probed. */
export interface VerifiedRuntimeInstallResult extends RuntimeInstallResult {
  tools?: string[];
  /** Non-fatal cleanup diagnostic when post-selection cleanup fails after pointer commit. */
  cleanupWarning?: string;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function atomicWriteText(file: string, content: string | Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode });
    fs.renameSync(temp, file);
  } finally {
    // After rename succeeds, temp removal is best-effort; before rename, never mask the original error.
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
  }
}

function extractVersionFromBundle(runtimeSource: string): string | null {
  try {
    const dir = path.dirname(runtimeSource);
    const versionFile = path.join(dir, 'version.json');
    if (fs.existsSync(versionFile)) {
      const parsed = JSON.parse(readBoundedFileSync(versionFile, POINTER_LIMIT)) as { version?: unknown };
      if (typeof parsed?.version === 'string' && parsed.version.length > 0) return parsed.version;
    }
  } catch {
    // Fall back to bundle inspection.
  }
  try {
    const content = readBoundedFileSync(runtimeSource, BUNDLE_LIMIT);
    const match = /SERVER_VERSION:\s*[`'"]([^`'"]+)[`'"]/.exec(content);
    if (match?.[1]) return match[1];
  } catch {
    return null;
  }
  return null;
}

/** Canonical CoAgent8 root (`~/.coagent8`) for a home directory. */
export function coagentRootForHome(home: string): string {
  return path.join(path.resolve(home), '.coagent8');
}

/**
 * Shared lock resource path guarding runtime pointer, copies, leases, and cleanup.
 *
 * @remarks
 * Lock order: `setup` (optional caller lock) -\> `runtime-update` ({@link runtimeUpdateLockResource}) -\> `runtime-lock`.
 * Never hold `runtime-lock` across `probeRuntime` calls because the launcher acquires `runtime-lock` during startup.
 */
export function runtimeLockResource(root: string): string {
  return path.join(path.resolve(root), 'runtime-lock');
}

/**
 * Shared updater lock resource path serializing full verified runtime update, pin, unpin, and
 * unreferenced-runtime cleanup transactions.
 *
 * @remarks
 * Acquired BEFORE `runtime-lock` and never acquired by launchers or process leases.
 * Uses `withFileLock` stale-lease reclamation (dead owner PID or unrenewed age).
 */
export function runtimeUpdateLockResource(root: string): string {
  return path.join(path.resolve(root), 'runtime-update');
}

/** Directory holding immutable `<sha256>` copies, stable namespaces, and process leases. */
export function runtimeRootDir(root: string): string {
  return path.join(path.resolve(root), 'runtime');
}

/** Stable launcher path for a namespace (`<root>/runtime/<namespace>/index.cjs`). */
export function stableLauncherPath(root: string, namespace: RuntimeNamespace = 'current'): string {
  return path.join(runtimeRootDir(root), namespace, 'index.cjs');
}

/** Pointer file path for a namespace (`<root>/runtime/<namespace>/pointer.json`). */
export function runtimePointerPath(root: string, namespace: RuntimeNamespace = 'current'): string {
  return path.join(runtimeRootDir(root), namespace, 'pointer.json');
}

/** Directory holding active per-process runtime lease files. */
export function runtimeLeasesDir(root: string): string {
  return path.join(runtimeRootDir(root), 'leases');
}

/** Determines the runtime namespace for a version, routing `-dev` builds to `dev` unless opted in. */
export function resolveRuntimeNamespace(
  version: string,
  options: { namespace?: RuntimeNamespace; allowDevInCurrent?: boolean } = {},
): RuntimeNamespace {
  const dev = isDevSemver(version);
  if (options.namespace === 'current') {
    if (dev && !options.allowDevInCurrent) {
      throw new Error(`Development build ${version} requires the dev namespace or explicit opt-in.`);
    }
    return 'current';
  }
  if (options.namespace === 'dev') return 'dev';
  return dev && !options.allowDevInCurrent ? 'dev' : 'current';
}

/** Parses and validates a pointer object; throws a sanitized error on invalid structure. */
export function validateRuntimePointer(value: unknown): RuntimePointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid runtime pointer: expected JSON object.');
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1) throw new Error('Invalid runtime pointer schemaVersion.');
  if (typeof obj.digest !== 'string' || !SHA256_HEX.test(obj.digest)) {
    throw new Error('Invalid runtime pointer digest.');
  }
  if (typeof obj.version !== 'string' || !parseSemver(obj.version)) {
    throw new Error('Invalid runtime pointer version.');
  }
  if (typeof obj.updatedAt !== 'string' || !obj.updatedAt) {
    throw new Error('Invalid runtime pointer timestamp.');
  }
  let pinned: RuntimePin | undefined;
  if (obj.pinned !== undefined) {
    if (!obj.pinned || typeof obj.pinned !== 'object' || Array.isArray(obj.pinned)) {
      throw new Error('Invalid runtime pointer pin.');
    }
    const rawPin = obj.pinned as Record<string, unknown>;
    if (typeof rawPin.digest !== 'string' || !SHA256_HEX.test(rawPin.digest)) {
      throw new Error('Invalid runtime pin digest.');
    }
    if (typeof rawPin.version !== 'string' || !parseSemver(rawPin.version)) {
      throw new Error('Invalid runtime pin version.');
    }
    if (typeof rawPin.pinnedAt !== 'string' || !rawPin.pinnedAt) {
      throw new Error('Invalid runtime pin timestamp.');
    }
    if (rawPin.reason !== undefined && typeof rawPin.reason !== 'string') {
      throw new Error('Invalid runtime pin reason.');
    }
    pinned = {
      digest: rawPin.digest,
      version: rawPin.version,
      pinnedAt: rawPin.pinnedAt,
      ...(rawPin.reason !== undefined ? { reason: rawPin.reason } : {}),
    };
  }
  return {
    schemaVersion: 1,
    digest: obj.digest,
    version: obj.version,
    updatedAt: obj.updatedAt,
    ...(pinned ? { pinned } : {}),
  };
}

/**
 * Reads and validates a namespace pointer file.
 *
 * @param root - CoAgent8 root directory (`~/.coagent8`).
 * @param namespace - Runtime namespace (`current` or `dev`).
 * @returns Validated pointer or `null` when absent.
 * @throws When the pointer file exists but is unreadable or malformed.
 */
export function readRuntimePointer(root: string, namespace: RuntimeNamespace = 'current'): RuntimePointer | null {
  const file = runtimePointerPath(root, namespace);
  let raw: string;
  try {
    raw = readBoundedFileSync(file, POINTER_LIMIT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Runtime pointer is unreadable: ${redactDiagnostic((err as Error).message)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Malformed runtime pointer JSON.');
  }
  return validateRuntimePointer(parsed);
}

/**
 * Resolves a stable launcher (`current/index.cjs` or `dev/index.cjs`) to its target bundle.
 *
 * @param root - CoAgent8 root directory (`~/.coagent8`).
 * @param namespace - Runtime namespace.
 * @returns Resolved digest, version, derived immutable path, and whether the target exists on disk.
 */
export function resolveStableTarget(
  root: string,
  namespace: RuntimeNamespace = 'current',
): { digest: string; version: string; targetPath: string; exists: boolean; pinned?: RuntimePin } | null {
  const pointer = readRuntimePointer(root, namespace);
  if (!pointer) return null;
  const targetPath = path.join(runtimeRootDir(root), pointer.digest, 'index.cjs');
  const exists = fs.statSync(targetPath, { throwIfNoEntry: false })?.isFile() ?? false;
  return {
    digest: pointer.digest,
    version: pointer.version,
    targetPath,
    exists,
    ...(pointer.pinned ? { pinned: pointer.pinned } : {}),
  };
}

/**
 * Renders the small, self-contained CommonJS stable launcher script.
 *
 * @remarks
 * Uses only Node built-ins so first-launch time is unchanged. Acquires the shared `runtime-lock`
 * (synchronously when uncontended, with bounded async fallback on contention), validates
 * `pointer.json`, records a per-process lease under `leases/`, sets `Symbol.for('coagent8.runtimePath')`
 * so child commands (`wait`, `doctor`) observe the immutable copy path, and loads the target
 * bundle in-process.
 */
export function renderStableLauncher(): string {
  return [
    "'use strict';",
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '',
    'const NAMESPACE_DIR = __dirname;',
    'const RUNTIME_ROOT = path.dirname(NAMESPACE_DIR);',
    'const COAGENT_ROOT = path.dirname(RUNTIME_ROOT);',
    "const STAGED_POINTER_ARG_PREFIX = '--probe-pointer=';",
    "const STAGED_POINTER_NAME = 'pointer.next.json';",
    'function resolvePointerFile() {',
    '  const arg = process.argv[2];',
    "  if (typeof arg === 'string' && arg.startsWith(STAGED_POINTER_ARG_PREFIX) && process.argv[3] === 'mcp') {",
    '    const candidate = arg.slice(STAGED_POINTER_ARG_PREFIX.length);',
    '    process.argv.splice(2, 1);',
    '    if (candidate !== STAGED_POINTER_NAME) {',
    "      fail('invalid staged pointer name');",
    '    }',
    '    const resolved = path.join(NAMESPACE_DIR, candidate);',
    '    if (path.dirname(resolved) !== NAMESPACE_DIR) {',
    "      fail('invalid staged pointer path');",
    '    }',
    '    return resolved;',
    '  }',
    "  return path.join(NAMESPACE_DIR, 'pointer.json');",
    '}',
    'const POINTER_FILE = resolvePointerFile();',
    "const LEASES_DIR = path.join(RUNTIME_ROOT, 'leases');",
    "const LOCK_FILE = path.join(COAGENT_ROOT, 'runtime-lock.lease');",
    'const LOCK_TIMEOUT_MS = 5000;',
    'const LEASE_MAX_AGE_MS = 30000;',
    'const UNREADABLE_GRACE_MS = 2000;',
    'const HEARTBEAT_MS = 15000;',
    "const RUNTIME_PATH_SYM = Symbol.for('coagent8.runtimePath');",
    "const RUNTIME_LEASE_SYM = Symbol.for('coagent8.runtimeLease');",
    'const SHA256_RE = /^[a-f0-9]{64}$/;',
    '',
    'function fail(msg) {',
    "  process.stderr.write('CoAgent8 runtime launcher error: ' + msg + '\\n');",
    '  process.exit(1);',
    '}',
    '',
    'function alive(pid) {',
    '  try {',
    '    process.kill(pid, 0);',
    '    return true;',
    '  } catch (err) {',
    "    return Boolean(err && err.code === 'EPERM');",
    '  }',
    '}',
    '',
    'function readLinuxStartTime() {',
    "  if (process.platform !== 'linux') return undefined;",
    '  try {',
    "    const raw = fs.readFileSync('/proc/self/stat', 'utf8');",
    "    const idx = raw.lastIndexOf(')');",
    '    if (idx < 0) return undefined;',
    "    const fields = raw.slice(idx + 2).split(' ');",
    '    return fields[19] || undefined;',
    '  } catch {',
    '    return undefined;',
    '  }',
    '}',
    '',
    'function inspectLock() {',
    '  let stat;',
    '  try {',
    '    stat = fs.statSync(LOCK_FILE);',
    '  } catch (err) {',
    '    const code = err && err.code;',
    "    if (code === 'ENOENT' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY'))) return null;",
    '    throw err;',
    '  }',
    '  let owner = null;',
    '  try {',
    "    const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));",
    "    if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') owner = parsed;",
    '  } catch {}',
    '  return { owner, mtimeMs: stat.mtimeMs };',
    '}',
    '',
    'function isStaleLock(lease) {',
    '  const age = Date.now() - lease.mtimeMs;',
    '  if (!lease.owner) return age > UNREADABLE_GRACE_MS;',
    '  if (age > LEASE_MAX_AGE_MS) return true;',
    "  return typeof lease.owner.pid === 'number' && !alive(lease.owner.pid);",
    '}',
    '',
    'function tryAcquireLock(payload) {',
    "  const temp = LOCK_FILE + '.tmp.' + crypto.randomUUID();",
    '  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true, mode: 0o700 });',
    "  fs.writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 });",
    '  try {',
    '    fs.linkSync(temp, LOCK_FILE);',
    '    return true;',
    '  } catch (err) {',
    '    const code = err && err.code;',
    "    if (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY') return false;",
    '    throw err;',
    '  } finally {',
    '    try { fs.rmSync(temp, { force: true }); } catch {}',
    '  }',
    '}',
    '',
    'function tryReclaimStaleLock(judged) {',
    "  const reclaim = LOCK_FILE + '.reclaim.' + crypto.randomUUID();",
    '  try {',
    '    fs.renameSync(LOCK_FILE, reclaim);',
    '  } catch (err) {',
    '    const code = err && err.code;',
    "    if (code === 'ENOENT' || code === 'EPERM' || code === 'EBUSY') return false;",
    '    throw err;',
    '  }',
    '  try {',
    '    let moved = null;',
    '    try {',
    '      const st = fs.statSync(reclaim);',
    "      const parsed = JSON.parse(fs.readFileSync(reclaim, 'utf8'));",
    '      moved = { mtimeMs: st.mtimeMs, token: parsed && parsed.token };',
    '    } catch {}',
    '    if (moved && (moved.mtimeMs !== judged.mtimeMs || moved.token !== (judged.owner && judged.owner.token))) {',
    '      try { fs.linkSync(reclaim, LOCK_FILE); } catch {}',
    '      return false;',
    '    }',
    '    return true;',
    '  } finally {',
    '    try { fs.rmSync(reclaim, { force: true }); } catch {}',
    '  }',
    '}',
    '',
    'function launchTarget(lockToken) {',
    '  let target;',
    '  let digest;',
    '  let leaseFile;',
    '  try {',
    '    let raw;',
    '    try {',
    "      raw = fs.readFileSync(POINTER_FILE, 'utf8');",
    '    } catch {',
    "      fail('missing runtime pointer at ' + POINTER_FILE);",
    '    }',
    '    let pointer;',
    '    try {',
    '      pointer = JSON.parse(raw);',
    '    } catch {',
    "      fail('malformed runtime pointer JSON');",
    '    }',
    "    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) || pointer.schemaVersion !== 1 || typeof pointer.digest !== 'string' || !SHA256_RE.test(pointer.digest) || typeof pointer.version !== 'string' || !pointer.version) {",
    "      fail('invalid runtime pointer payload');",
    '    }',
    '    digest = pointer.digest;',
    "    target = path.join(RUNTIME_ROOT, digest, 'index.cjs');",
    '    const stat = fs.statSync(target, { throwIfNoEntry: false });',
    '    if (!stat || !stat.isFile()) {',
    "      fail('target runtime missing: ' + digest);",
    '    }',
    '    fs.mkdirSync(LEASES_DIR, { recursive: true, mode: 0o700 });',
    '    const leaseToken = crypto.randomUUID();',
    "    leaseFile = path.join(LEASES_DIR, process.pid + '-' + leaseToken + '.json');",
    '    const linuxStartTime = readLinuxStartTime();',
    '    const leaseData = {',
    '      schemaVersion: 1,',
    '      pid: process.pid,',
    '      token: leaseToken,',
    '      digest,',
    '      execPath: process.execPath,',
    '      createdAt: Date.now(),',
    '      ...(linuxStartTime ? { linuxStartTime } : {}),',
    '    };',
    "    fs.writeFileSync(leaseFile, JSON.stringify(leaseData) + '\\n', { flag: 'wx', mode: 0o600 });",
    '  } finally {',
    '    try {',
    '      const current = inspectLock();',
    '      if (current && current.owner && current.owner.token === lockToken) fs.rmSync(LOCK_FILE, { force: true });',
    '    } catch {}',
    '  }',
    '  const releaseLease = () => {',
    '    try { fs.rmSync(leaseFile, { force: true }); } catch {}',
    '  };',
    "  process.once('exit', releaseLease);",
    '  const timer = setInterval(() => {',
    '    try {',
    '      const now = new Date();',
    '      fs.utimesSync(leaseFile, now, now);',
    '    } catch {}',
    '  }, HEARTBEAT_MS);',
    '  timer.unref();',
    '  globalThis[RUNTIME_PATH_SYM] = target;',
    '  globalThis[RUNTIME_LEASE_SYM] = { leaseFile, digest, release: releaseLease };',
    '  try {',
    '    require(target);',
    '  } catch (err) {',
    '    clearInterval(timer);',
    '    releaseLease();',
    '    throw err;',
    '  }',
    '}',
    '',
    'const lockToken = crypto.randomUUID();',
    'const lockPayload = JSON.stringify({ token: lockToken, pid: process.pid, createdAt: Date.now() });',
    'if (tryAcquireLock(lockPayload)) {',
    '  launchTarget(lockToken);',
    '} else {',
    '  const started = Date.now();',
    '  (async () => {',
    '    for (let attempt = 0; ; attempt++) {',
    '      const existing = inspectLock();',
    '      if (existing && isStaleLock(existing) && tryReclaimStaleLock(existing)) {',
    '        if (tryAcquireLock(lockPayload)) {',
    '          launchTarget(lockToken);',
    '          return;',
    '        }',
    '      }',
    '      if (tryAcquireLock(lockPayload)) {',
    '        launchTarget(lockToken);',
    '        return;',
    '      }',
    '      const elapsed = Date.now() - started;',
    "      if (elapsed >= LOCK_TIMEOUT_MS) fail('timed out waiting for runtime lock');",
    '      const waitMs = Math.min(50, 5 + Math.floor(attempt * 2), Math.max(1, LOCK_TIMEOUT_MS - elapsed));',
    '      await new Promise(resolve => setTimeout(resolve, waitMs));',
    '    }',
    "  })().catch(err => fail(err && err.message ? err.message : 'launch failed'));",
    '}',
    '',
  ].join('\n');
}

/**
 * Installs and verifies a full content-addressed runtime copy under `<root>/runtime/<sha256>/`.
 *
 * @remarks
 * Verifies the copied `index.cjs` SHA-256, `version.json`, Windows `coagent8-job.exe` SHA-256
 * (when present beside `runtimeSource`), and optional `setup.cjs` / `skills/` support files
 * before any pointer switch may reference the copy.
 *
 * @param options - Home boundary, source bundle, optional version and arch override.
 * @returns Verified runtime copy metadata.
 * @throws When verification of the bundle, setup bundle, or job helper fails.
 */
export function installAndVerifyRuntimeCopy(options: RuntimeCopyOptions): InstalledRuntimeCopy {
  const root = coagentRootForHome(options.home);
  const runtimeRoot = runtimeRootDir(root);
  const sourceDir = path.dirname(path.resolve(options.runtimeSource));
  const sourceStat = fs.statSync(options.runtimeSource);
  if (sourceStat.size > BUNDLE_LIMIT) {
    throw new Error(`Runtime bundle exceeds ${BUNDLE_LIMIT} byte limit.`);
  }
  const bundleBytes = fs.readFileSync(options.runtimeSource);
  const digest = sha256(bundleBytes);
  const version = options.version ?? extractVersionFromBundle(options.runtimeSource) ?? BRAND.SERVER_VERSION;
  if (!parseSemver(version)) {
    throw new Error(`Invalid CoAgent8 runtime version: ${version}`);
  }

  const runtimeDir = path.join(runtimeRoot, digest);
  const runtimePath = path.join(runtimeDir, 'index.cjs');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  const createdFreshly = !fs.existsSync(runtimePath);
  if (createdFreshly || sha256(fs.readFileSync(runtimePath)) !== digest) {
    atomicWriteText(runtimePath, bundleBytes, 0o600);
  }
  if (sha256(fs.readFileSync(runtimePath)) !== digest) {
    throw new Error('Owned runtime hash mismatch after installation.');
  }

  const arch = options.arch ?? process.arch;
  const sourceHelper = path.join(sourceDir, `win32-${arch}`, 'coagent8-job.exe');
  if (fs.existsSync(sourceHelper)) {
    const expectedHelperDigest = sha256(fs.readFileSync(sourceHelper));
    copyJobHelperBeside(options.runtimeSource, runtimeDir, arch);
    const targetHelper = path.join(runtimeDir, `win32-${arch}`, 'coagent8-job.exe');
    if (!fs.existsSync(targetHelper) || sha256(fs.readFileSync(targetHelper)) !== expectedHelperDigest) {
      throw new Error('Owned Windows job helper verification failed.');
    }
  }

  const sourceSetup = path.join(sourceDir, 'setup.cjs');
  if (fs.existsSync(sourceSetup)) {
    const setupBytes = fs.readFileSync(sourceSetup);
    const setupDigest = sha256(setupBytes);
    const targetSetup = path.join(runtimeDir, 'setup.cjs');
    if (!fs.existsSync(targetSetup) || sha256(fs.readFileSync(targetSetup)) !== setupDigest) {
      atomicWriteText(targetSetup, setupBytes, 0o600);
    }
    if (sha256(fs.readFileSync(targetSetup)) !== setupDigest) {
      throw new Error('Owned setup bundle hash mismatch after installation.');
    }
  }

  const sourceSkills = path.resolve(sourceDir, '..', 'skills');
  if (fs.existsSync(sourceSkills) && fs.statSync(sourceSkills).isDirectory()) {
    const targetSkills = path.join(runtimeDir, 'skills');
    if (!fs.existsSync(targetSkills)) {
      fs.cpSync(sourceSkills, targetSkills, { recursive: true });
    }
  }

  const versionFile = path.join(runtimeDir, 'version.json');
  if (!fs.existsSync(versionFile)) {
    atomicWriteText(versionFile, JSON.stringify({ version }) + '\n', 0o600);
  }
  // Only mark copies freshly created here; an existing unmarked copy may still be running in a pre-lease server.
  if (createdFreshly) {
    markRuntimeLeaseCapable(runtimeDir);
  }

  return { root, runtimeRoot, digest, version, runtimeDir, runtimePath };
}

/** Marks a runtime copy directory as lease-capable so future cleanups can rely on per-process leases. */
export function markRuntimeLeaseCapable(runtimeDir: string): void {
  const marker = path.join(runtimeDir, LEASE_CAPABLE_MARKER);
  if (!fs.existsSync(marker)) {
    atomicWriteText(marker, '1\n', 0o600);
  }
}

function isLeaseCapableCopy(runtimeDir: string): boolean {
  return fs.existsSync(path.join(runtimeDir, LEASE_CAPABLE_MARKER));
}

function ensureLauncherFile(root: string, namespace: RuntimeNamespace): string {
  const launcherPath = stableLauncherPath(root, namespace);
  const content = renderStableLauncher();
  if (!fs.existsSync(launcherPath) || fs.readFileSync(launcherPath, 'utf8') !== content) {
    atomicWriteText(launcherPath, content, 0o755);
  }
  return launcherPath;
}

/**
 * Evaluates the target pointer selection without writing `pointer.json`; caller MUST hold `runtimeLockResource`.
 */
function planRuntimePointerSelectionLocked(
  copy: InstalledRuntimeCopy,
  options: { namespace?: RuntimeNamespace; allowDevInCurrent?: boolean; pin?: boolean; unpin?: boolean; reason?: string } = {},
): { result: RuntimeInstallResult; nextPointer: RuntimePointer | null } {
  const namespace = resolveRuntimeNamespace(copy.version, options);
  const targetStat = fs.statSync(copy.runtimePath, { throwIfNoEntry: false });
  if (!targetStat || !targetStat.isFile()) {
    throw new Error(`Runtime copy ${copy.digest.slice(0, 12)} is missing before pointer selection.`);
  }
  if (sha256(fs.readFileSync(copy.runtimePath)) !== copy.digest) {
    throw new Error(`Runtime copy ${copy.digest.slice(0, 12)} failed integrity verification before pointer selection.`);
  }
  const launcherPath = ensureLauncherFile(copy.root, namespace);
  const pointerFile = runtimePointerPath(copy.root, namespace);
  const existing = readRuntimePointer(copy.root, namespace);
  const existingTarget = existing ? path.join(copy.runtimeRoot, existing.digest, 'index.cjs') : null;
  const existingHealthy = Boolean(existing && existingTarget && fs.statSync(existingTarget, { throwIfNoEntry: false })?.isFile());
  const nowIso = new Date().toISOString();

  if (options.pin) {
    return {
      nextPointer: {
        schemaVersion: 1,
        digest: copy.digest,
        version: copy.version,
        updatedAt: nowIso,
        pinned: {
          digest: copy.digest,
          version: copy.version,
          pinnedAt: nowIso,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
      result: {
        namespace,
        launcherPath,
        pointerFile,
        runtimePath: copy.runtimePath,
        digest: copy.digest,
        version: copy.version,
        action: existingHealthy ? 'updated' : 'installed',
        ...(existing && existingHealthy
          ? { incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned } }
          : {}),
        message: `Pinned ${namespace} runtime to ${copy.version} (${copy.digest.slice(0, 12)}).`,
      },
    };
  }

  if (!existing || !existingHealthy) {
    return {
      nextPointer: {
        schemaVersion: 1,
        digest: copy.digest,
        version: copy.version,
        updatedAt: nowIso,
      },
      result: {
        namespace,
        launcherPath,
        pointerFile,
        runtimePath: copy.runtimePath,
        digest: copy.digest,
        version: copy.version,
        action: existing ? 'updated' : 'installed',
        message: existing
          ? `Repaired dangling ${namespace} runtime pointer to ${copy.version} (${copy.digest.slice(0, 12)}).`
          : `Installed ${namespace} runtime ${copy.version} (${copy.digest.slice(0, 12)}).`,
      },
    };
  }

  if (existing.pinned && !options.unpin) {
    if (existing.pinned.digest === copy.digest && compareSemver(copy.version, existing.pinned.version) === 0) {
      return {
        nextPointer: null,
        result: {
          namespace,
          launcherPath,
          pointerFile,
          runtimePath: copy.runtimePath,
          digest: copy.digest,
          version: copy.version,
          action: 'noop',
          incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned },
          message: `Runtime ${namespace} already points to pinned ${copy.version}.`,
        },
      };
    }
    return {
      nextPointer: null,
      result: {
        namespace,
        launcherPath,
        pointerFile,
        runtimePath: existingTarget!,
        digest: existing.digest,
        version: existing.version,
        action: 'pinned-blocked',
        incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned },
        message: `Kept pinned ${namespace} runtime ${existing.version} (${existing.digest.slice(0, 12)}) instead of ${copy.version}.`,
      },
    };
  }

  const cmp = compareSemver(copy.version, existing.version);
  if (cmp === 1) {
    return {
      nextPointer: {
        schemaVersion: 1,
        digest: copy.digest,
        version: copy.version,
        updatedAt: nowIso,
      },
      result: {
        namespace,
        launcherPath,
        pointerFile,
        runtimePath: copy.runtimePath,
        digest: copy.digest,
        version: copy.version,
        action: 'updated',
        incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned },
        message: `Updated ${namespace} runtime from ${existing.version} to ${copy.version} (${copy.digest.slice(0, 12)}).`,
      },
    };
  }

  if (cmp === 0) {
    if (copy.digest === existing.digest) {
      if (existing.pinned && options.unpin) {
        return {
          nextPointer: {
            schemaVersion: 1,
            digest: existing.digest,
            version: existing.version,
            updatedAt: nowIso,
          },
          result: {
            namespace,
            launcherPath,
            pointerFile,
            runtimePath: copy.runtimePath,
            digest: copy.digest,
            version: copy.version,
            action: 'updated',
            incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned },
            message: `Unpinned ${namespace} runtime ${copy.version} (${copy.digest.slice(0, 12)}).`,
          },
        };
      }
      return {
        nextPointer: null,
        result: {
          namespace,
          launcherPath,
          pointerFile,
          runtimePath: copy.runtimePath,
          digest: copy.digest,
          version: copy.version,
          action: 'noop',
          incumbent: { digest: existing.digest, version: existing.version },
          message: `Runtime ${namespace} already points to ${copy.version} (${copy.digest.slice(0, 12)}).`,
        },
      };
    }
    return {
      nextPointer: null,
      result: {
        namespace,
        launcherPath,
        pointerFile,
        runtimePath: existingTarget!,
        digest: existing.digest,
        version: existing.version,
        action: 'kept-incumbent',
        incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned },
        message: `Kept incumbent ${namespace} runtime ${existing.version} (${existing.digest.slice(0, 12)}) with equal version and different hash (${copy.digest.slice(0, 12)}).`,
      },
    };
  }

  // Downgrade guard: never switch pointer back to an older version without an explicit pin.
  return {
    nextPointer: null,
    result: {
      namespace,
      launcherPath,
      pointerFile,
      runtimePath: existingTarget!,
      digest: existing.digest,
      version: existing.version,
      action: 'downgrade-blocked',
      incumbent: { digest: existing.digest, version: existing.version, pinned: existing.pinned },
      message: `Preserved newer ${namespace} runtime ${existing.version} (${existing.digest.slice(0, 12)}); refused downgrade to ${copy.version}.`,
    },
  };
}

/**
 * Atomically writes a validated pointer payload; caller MUST hold `runtimeUpdateLockResource` and `runtimeLockResource`.
 */
function publishRuntimePointerLocked(pointerFile: string, pointer: RuntimePointer): void {
  atomicWriteText(pointerFile, JSON.stringify(pointer, null, 2) + '\n', 0o600);
}

/**
 * Verifies an already-installed immutable `<sha256>` runtime copy on disk.
 */
function verifyInstalledRuntimeCopy(root: string, digest: string, explicitVersion?: string): InstalledRuntimeCopy {
  if (!SHA256_HEX.test(digest)) {
    throw new Error('Specify a valid 64-character runtime digest or runtime bundle to pin.');
  }
  const runtimeRoot = runtimeRootDir(root);
  const runtimeDir = path.join(runtimeRoot, digest);
  const runtimePath = path.join(runtimeDir, 'index.cjs');
  if (!fs.existsSync(runtimePath)) {
    throw new Error(`Runtime copy ${digest} is not installed.`);
  }
  const onDiskDigest = sha256(fs.readFileSync(runtimePath));
  if (onDiskDigest !== digest) {
    throw new Error(`Runtime copy ${digest} failed integrity verification.`);
  }
  const version = explicitVersion ?? extractVersionFromBundle(runtimePath);
  if (!version || !parseSemver(version)) {
    throw new Error(`Runtime copy ${digest} has no valid SemVer version.`);
  }
  return { root, runtimeRoot, digest, version, runtimeDir, runtimePath };
}

/**
 * Initializes a registered runtime and reads its tool catalog without claiming native host discovery.
 */
export async function probeRuntime(
  entry: { command: string; args: string[]; env?: Record<string, string> },
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string[]> {
  return withStdioRpc(
    entry.command,
    entry.args,
    async rpc => {
      const init = object(
        await rpc.request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'coagent8-setup', version: '1' },
        }),
      );
      if (object(init.serverInfo).name !== 'coagent8') throw new Error('Configured process is not CoAgent8.');
      rpc.notify('notifications/initialized');
      const tools = object(await rpc.request('tools/list', {})).tools;
      if (!Array.isArray(tools)) throw new Error('Invalid tool catalog.');
      const names = tools.map(tool => object(tool).name);
      if (!names.every(name => typeof name === 'string') || !names.includes('doctor')) {
        throw new Error('CoAgent8 doctor is unavailable.');
      }
      return names as string[];
    },
    { env: { ...env, ...entry.env }, cwd },
  );
}

function pointerStageKey(pointer: RuntimePointer): string {
  return `${pointer.digest}|${pointer.version}|${pointer.pinned?.digest ?? ''}|${pointer.pinned?.version ?? ''}`;
}

/**
 * Serializes runtime update transactions under `runtime-update` before any `runtime-lock` acquisition.
 * Lock order: `setup` (optional caller lock) -> `runtime-update` -> `runtime-lock`.
 */
function withRuntimeUpdateLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(runtimeUpdateLockResource(root), fn, RUNTIME_UPDATE_LOCK_TIMEOUT_MS);
}

/**
 * Shared verified selection path; caller MUST hold `runtimeUpdateLockResource(root)`.
 * Prepares and reserves candidate and incumbent copies under `runtime-lock`, probes the candidate and
 * staged launcher (`pointer.next.json`) outside `runtime-lock` before touching `pointer.json`, then
 * revalidates under the final `runtime-lock` and atomically publishes `pointer.json` only after both
 * probes succeed.
 */
async function selectVerifiedRuntimeCopyLocked(
  prepareCopyLocked: () => InstalledRuntimeCopy,
  options: {
    home: string;
    namespace?: RuntimeNamespace;
    allowDevInCurrent?: boolean;
    pin?: boolean;
    unpin?: boolean;
    reason?: string;
    nodePath?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    probeEnv?: Record<string, string>;
  },
): Promise<VerifiedRuntimeInstallResult> {
  const root = coagentRootForHome(options.home);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? options.home;
  const node = resolveCliCommand(options.nodePath || process.execPath, { env, cwd });

  let copy!: InstalledRuntimeCopy;
  let namespace!: RuntimeNamespace;
  let initialPlan!: { result: RuntimeInstallResult; nextPointer: RuntimePointer | null };
  let candidateProbed = false;
  let probedStageKey: string | null = null;
  let probedIncumbentDigest: string | null = null;
  let tools: string[] = [];
  const reservedDigests = new Set<string>();
  const reservationLeaseFiles: string[] = [];

  const reserveDigestLocked = (digest: string) => {
    if (!SHA256_HEX.test(digest) || reservedDigests.has(digest)) return;
    const leasesDir = runtimeLeasesDir(root);
    fs.mkdirSync(leasesDir, { recursive: true, mode: 0o700 });
    const leaseToken = randomUUID();
    const leasePath = path.join(leasesDir, `${process.pid}-reserve-${leaseToken}.json`);
    const linuxStartTime = readLinuxProcessStartTime(process.pid);
    const lease: RuntimeLease = {
      schemaVersion: 1,
      pid: process.pid,
      token: leaseToken,
      digest,
      execPath: process.execPath,
      createdAt: Date.now(),
      ...(typeof linuxStartTime === 'string' ? { linuxStartTime } : {}),
    };
    atomicWriteText(leasePath, JSON.stringify(lease) + '\n', 0o600);
    reservedDigests.add(digest);
    reservationLeaseFiles.push(leasePath);
  };

  const reservePointerTargetsLocked = (pointer: RuntimePointer | null, targetExists: boolean) => {
    if (!pointer) return;
    if (targetExists) reserveDigestLocked(pointer.digest);
    if (pointer.pinned) {
      const pinnedTarget = path.join(copy.runtimeRoot, pointer.pinned.digest, 'index.cjs');
      if (fs.statSync(pinnedTarget, { throwIfNoEntry: false })?.isFile()) {
        reserveDigestLocked(pointer.pinned.digest);
      }
    }
  };

  let stagedPointerFile = '';
  let stagedCleanupHandled = false;
  let bodyThrew = false;
  let result!: VerifiedRuntimeInstallResult;
  const cleanupWarnings: string[] = [];
  const recordCleanupWarning = (label: string, error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    cleanupWarnings.push(redactDiagnostic(`${label}: ${raw}`, 512));
  };

  try {
    await withFileLock(
      runtimeLockResource(root),
      async () => {
        copy = prepareCopyLocked();
        namespace = resolveRuntimeNamespace(copy.version, options);
        stagedPointerFile = path.join(path.dirname(runtimePointerPath(root, namespace)), STAGED_POINTER_NAME);
        const existingPointer = readRuntimePointer(root, namespace);
        const existingTarget = resolveStableTarget(root, namespace);

        reserveDigestLocked(copy.digest);
        reservePointerTargetsLocked(existingPointer, Boolean(existingTarget?.exists));

        initialPlan = planRuntimePointerSelectionLocked(copy, options);
        if (initialPlan.nextPointer) {
          publishRuntimePointerLocked(stagedPointerFile, initialPlan.nextPointer);
        } else {
          fs.rmSync(stagedPointerFile, { force: true });
        }
      },
      RUNTIME_LOCK_TIMEOUT_MS,
    );

    const probeCandidate = () =>
      probeRuntime({ command: node.command, args: [...node.argsPrefix, copy.runtimePath, 'mcp'], env: options.probeEnv }, env, cwd);
    const probeLauncher = (launcherPath: string, staged: boolean) =>
      probeRuntime(
        {
          command: node.command,
          args: [
            ...node.argsPrefix,
            ...(staged ? [launcherPath, `${PROBE_POINTER_ARG_PREFIX}${STAGED_POINTER_NAME}`, 'mcp'] : [launcherPath, 'mcp']),
          ],
          env: options.probeEnv,
        },
        env,
        cwd,
      );

    if (initialPlan.nextPointer) {
      await probeCandidate();
      candidateProbed = true;
      tools = await probeLauncher(initialPlan.result.launcherPath, true);
      probedStageKey = pointerStageKey(initialPlan.nextPointer);
    } else {
      tools = await probeLauncher(initialPlan.result.launcherPath, false);
      probedIncumbentDigest = initialPlan.result.digest;
    }

    const MAX_SELECTION_ATTEMPTS = 4;
    let selected!: RuntimeInstallResult;
    const pointerFile = runtimePointerPath(root, namespace);

    for (let attempt = 0; ; attempt++) {
      let pendingCandidateProbe = false;
      let pendingStagedLauncher: string | null = null;
      let pendingIncumbentLauncher: string | null = null;
      await withFileLock(
        runtimeLockResource(root),
        async () => {
          const currentPointerRaw = fs.existsSync(pointerFile) ? fs.readFileSync(pointerFile, 'utf8') : null;
          if (currentPointerRaw !== null) {
            try {
              const currentPointer = validateRuntimePointer(JSON.parse(currentPointerRaw));
              const prevTarget = path.join(copy.runtimeRoot, currentPointer.digest, 'index.cjs');
              const currentTargetExists = Boolean(fs.statSync(prevTarget, { throwIfNoEntry: false })?.isFile());
              reservePointerTargetsLocked(currentPointer, currentTargetExists);
            } catch {
              // Invalid current pointer cannot satisfy incumbent verification; re-evaluation will replace it after probing.
            }
          }
          const planAfter = planRuntimePointerSelectionLocked(copy, options);
          if (planAfter.nextPointer) {
            const afterKey = pointerStageKey(planAfter.nextPointer);
            if (candidateProbed && probedStageKey === afterKey) {
              publishRuntimePointerLocked(pointerFile, planAfter.nextPointer);
              selected = planAfter.result;
              stagedCleanupHandled = true;
              try {
                fs.rmSync(stagedPointerFile, { force: true });
              } catch (error) {
                recordCleanupWarning('Failed to remove staged runtime pointer', error);
              }
              return;
            }
            publishRuntimePointerLocked(stagedPointerFile, planAfter.nextPointer);
            pendingCandidateProbe = !candidateProbed;
            pendingStagedLauncher = planAfter.result.launcherPath;
            probedStageKey = afterKey;
            return;
          }
          if (probedIncumbentDigest === planAfter.result.digest) {
            selected = planAfter.result;
            stagedCleanupHandled = true;
            try {
              fs.rmSync(stagedPointerFile, { force: true });
            } catch (error) {
              recordCleanupWarning('Failed to remove staged runtime pointer', error);
            }
            return;
          }
          fs.rmSync(stagedPointerFile, { force: true });
          pendingIncumbentLauncher = planAfter.result.launcherPath;
          probedIncumbentDigest = planAfter.result.digest;
        },
        RUNTIME_LOCK_TIMEOUT_MS,
      );
      if (!pendingStagedLauncher && !pendingIncumbentLauncher) break;
      if (attempt + 1 >= MAX_SELECTION_ATTEMPTS) {
        throw new Error('Concurrent runtime pointer updates prevented verified selection.');
      }
      if (pendingStagedLauncher) {
        if (pendingCandidateProbe) {
          await probeCandidate();
          candidateProbed = true;
        }
        tools = await probeLauncher(pendingStagedLauncher, true);
      } else if (pendingIncumbentLauncher) {
        tools = await probeLauncher(pendingIncumbentLauncher, false);
      }
    }

    result = { ...selected, tools };
  } catch (error) {
    bodyThrew = true;
    throw error;
  } finally {
    for (const leaseFile of reservationLeaseFiles) {
      try {
        fs.rmSync(leaseFile, { force: true });
      } catch (error) {
        if (!bodyThrew) {
          recordCleanupWarning('Failed to release runtime reservation lease', error);
        }
      }
    }
    if (stagedPointerFile && !stagedCleanupHandled) {
      try {
        fs.rmSync(stagedPointerFile, { force: true });
      } catch (error) {
        if (!bodyThrew) {
          recordCleanupWarning('Failed to remove staged runtime pointer', error);
        }
      }
    }
  }

  return {
    ...result,
    ...(cleanupWarnings.length > 0 ? { cleanupWarning: redactDiagnostic(cleanupWarnings.join('; '), 1024) } : {}),
  };
}

/**
 * Installs, reserves candidate and incumbent copies against concurrent cleanup, probes the installed
 * candidate and stable launcher, and publishes the pointer under the updater lock, restoring the
 * incumbent pointer only if its target still exists on probe failure.
 */
export async function installAndSelectVerifiedRuntime(options: VerifiedRuntimeInstallOptions): Promise<VerifiedRuntimeInstallResult> {
  const root = coagentRootForHome(options.home);
  return withRuntimeUpdateLock(root, () => selectVerifiedRuntimeCopyLocked(() => installAndVerifyRuntimeCopy(options), options));
}

/**
 * Explicitly pins/rolls back a namespace pointer to a verified `<sha256>` copy or source bundle.
 *
 * @param options - Target home, namespace, digest or runtime source, optional reason, and probe configuration.
 * @returns Verified pointer selection result.
 */
export async function rollbackOrPinRuntime(options: {
  home: string;
  namespace?: RuntimeNamespace;
  digest?: string;
  runtimeSource?: string;
  version?: string;
  reason?: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  probeEnv?: Record<string, string>;
}): Promise<VerifiedRuntimeInstallResult> {
  const root = coagentRootForHome(options.home);
  const namespace = options.namespace ?? 'current';
  if (options.runtimeSource) {
    return installAndSelectVerifiedRuntime({
      home: options.home,
      runtimeSource: options.runtimeSource,
      version: options.version,
      namespace,
      allowDevInCurrent: true,
      pin: true,
      reason: options.reason ?? 'explicit-pin',
      nodePath: options.nodePath,
      env: options.env,
      cwd: options.cwd,
      probeEnv: options.probeEnv,
    });
  }
  const digest = options.digest ?? '';
  return withRuntimeUpdateLock(root, () =>
    selectVerifiedRuntimeCopyLocked(() => verifyInstalledRuntimeCopy(root, digest, options.version), {
      home: options.home,
      namespace,
      allowDevInCurrent: true,
      pin: true,
      reason: options.reason ?? 'explicit-pin',
      nodePath: options.nodePath,
      env: options.env,
      cwd: options.cwd,
      probeEnv: options.probeEnv,
    }),
  );
}

/**
 * Clears an explicit pin on a runtime namespace as a verified pointer update, probing the launcher
 * and restoring the previous pin on failure.
 *
 * @param home - User home directory.
 * @param namespace - Runtime namespace (`current` or `dev`).
 * @param options - Optional probe configuration.
 * @returns Updated pointer or `null` when no pointer exists.
 */
export async function unpinRuntime(
  home: string,
  namespace: RuntimeNamespace = 'current',
  options: { nodePath?: string; env?: NodeJS.ProcessEnv; cwd?: string; probeEnv?: Record<string, string> } = {},
): Promise<RuntimePointer | null> {
  const root = coagentRootForHome(home);
  return withRuntimeUpdateLock(root, async () => {
    const current = await withFileLock(runtimeLockResource(root), async () => readRuntimePointer(root, namespace), RUNTIME_LOCK_TIMEOUT_MS);
    if (!current || !current.pinned) return current;
    await selectVerifiedRuntimeCopyLocked(
      () => {
        const latest = readRuntimePointer(root, namespace);
        if (!latest) throw new Error(`Runtime pointer for ${namespace} no longer exists.`);
        return verifyInstalledRuntimeCopy(root, latest.digest, latest.version);
      },
      {
        home,
        namespace,
        allowDevInCurrent: true,
        unpin: true,
        nodePath: options.nodePath,
        env: options.env,
        cwd: options.cwd,
        probeEnv: options.probeEnv,
      },
    );
    return withFileLock(runtimeLockResource(root), async () => readRuntimePointer(root, namespace), RUNTIME_LOCK_TIMEOUT_MS);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLinuxProcessStartTime(pid: number): string | null | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const idx = raw.lastIndexOf(')');
    if (idx < 0) return undefined;
    const fields = raw.slice(idx + 2).split(' ');
    return fields[19] || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return undefined;
  }
}

function verifyAgedProcessIdentity(lease: RuntimeLease): 'alive' | 'dead' | 'uncertain' {
  if (process.platform === 'win32') {
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$p = Get-Process -Id ${lease.pid} -ErrorAction SilentlyContinue`,
      'if ($null -eq $p) { Write-Output "DEAD"; exit 0 }',
      '$startMs = [DateTimeOffset]($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
      '$path = ""',
      'try { $path = [string]$p.Path } catch {}',
      'Write-Output (@{ startMs = $startMs; path = $path } | ConvertTo-Json -Compress)',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    try {
      const res = cp.spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 2000,
      });
      if (res.status !== 0) return 'uncertain';
      const out = res.stdout.trim();
      if (out === 'DEAD') return 'dead';
      const parsed = JSON.parse(out) as { startMs?: unknown; path?: unknown };
      if (typeof parsed.startMs === 'number' && parsed.startMs > lease.createdAt + 5_000) return 'dead';
      if (typeof parsed.path === 'string' && parsed.path && lease.execPath) {
        if (path.resolve(parsed.path).toLowerCase() !== path.resolve(lease.execPath).toLowerCase()) return 'dead';
      }
      return 'alive';
    } catch {
      return 'uncertain';
    }
  }
  if (process.platform === 'darwin') {
    try {
      const res = cp.spawnSync('ps', ['-p', String(lease.pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
      });
      if (res.status !== 0) return res.stdout.trim() === '' ? 'dead' : 'uncertain';
      const startedMs = Date.parse(res.stdout.trim());
      if (Number.isFinite(startedMs) && startedMs > lease.createdAt + 5_000) return 'dead';
      return Number.isFinite(startedMs) ? 'alive' : 'uncertain';
    } catch {
      return 'uncertain';
    }
  }
  return 'uncertain';
}

/**
 * Evaluates whether a per-process runtime lease is still held by a live matching process.
 *
 * @param lease - Parsed lease record.
 * @param mtimeMs - Modification time of the lease file.
 * @param checkIdentity - Optional override for testing aged identity verification.
 * @returns `'alive'`, `'dead'`, or `'uncertain'` (uncertain counts as in use).
 */
export function evaluateRuntimeLease(
  lease: RuntimeLease,
  mtimeMs: number,
  checkIdentity: (lease: RuntimeLease) => 'alive' | 'dead' | 'uncertain' = verifyAgedProcessIdentity,
): 'alive' | 'dead' | 'uncertain' {
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return 'dead';
  if (!isPidAlive(lease.pid)) return 'dead';

  if (process.platform === 'linux' && lease.linuxStartTime) {
    const currentStart = readLinuxProcessStartTime(lease.pid);
    if (currentStart === null) return 'dead';
    if (typeof currentStart === 'string') {
      return currentStart === lease.linuxStartTime ? 'alive' : 'dead';
    }
    return 'uncertain';
  }

  const age = Date.now() - mtimeMs;
  if (age <= RUNTIME_LEASE_MAX_AGE_MS) return 'alive';
  return checkIdentity(lease);
}

function parseLeaseRecord(value: unknown): RuntimeLease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    obj.schemaVersion !== 1 ||
    typeof obj.pid !== 'number' ||
    !Number.isInteger(obj.pid) ||
    obj.pid <= 0 ||
    typeof obj.token !== 'string' ||
    !obj.token ||
    typeof obj.digest !== 'string' ||
    !SHA256_HEX.test(obj.digest) ||
    typeof obj.execPath !== 'string' ||
    typeof obj.createdAt !== 'number'
  ) {
    return null;
  }
  if (obj.linuxStartTime !== undefined && typeof obj.linuxStartTime !== 'string') return null;
  return {
    schemaVersion: 1,
    pid: obj.pid,
    token: obj.token,
    digest: obj.digest,
    execPath: obj.execPath,
    createdAt: obj.createdAt,
    ...(obj.linuxStartTime ? { linuxStartTime: obj.linuxStartTime } : {}),
  };
}

function sameOrInside(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Removes unused `<sha256>` runtime directories under `<root>/runtime/` using the shared lock
 * and per-process runtime leases.
 *
 * @remarks
 * Any uncertain or unreadable reference (host config, `installs.json`, `pointer.json`, shim,
 * or runtime lease file) aborts or preserves the affected copies rather than risking deletion of
 * an active runtime.
 *
 * @param root - Root directory containing `runtime/` (`~/.coagent8` or VS Code globalStorage).
 * @param home - User home directory used to inspect CLI host configs and `installs.json` when `root` is `~/.coagent8`.
 * @param env - Process environment for resolving client config paths.
 * @param options - Cleanup mode and timeout options.
 */
export async function cleanupUnreferencedRuntimes(
  root: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  options: RuntimeCleanupOptions = {},
): Promise<{ removed: string[]; kept: string[] }> {
  const resolvedRoot = path.resolve(root);
  const runtimes = runtimeRootDir(resolvedRoot);
  const sharedRoot = coagentRootForHome(home);
  const isSharedRoot = sameOrInside(resolvedRoot, sharedRoot) && resolvedRoot === sharedRoot;
  const removePreLeaseCopies = options.removePreLeaseCopies === true;

  const deadline = options.leaseTimeoutMs !== undefined ? Date.now() + Math.max(1, options.leaseTimeoutMs) : undefined;
  const outerTimeoutMs = deadline !== undefined ? Math.max(1, options.leaseTimeoutMs!) : RUNTIME_UPDATE_LOCK_TIMEOUT_MS;

  return withFileLock(
    runtimeUpdateLockResource(resolvedRoot),
    async () => {
      const innerTimeoutMs =
        deadline !== undefined
          ? (() => {
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw new LockTimeoutError();
              return Math.max(1, remaining);
            })()
          : RUNTIME_LOCK_TIMEOUT_MS;
      return withFileLock(
        runtimeLockResource(resolvedRoot),
        async () => {
          const referencedDigests = new Set<string>(options.extraReferencedDigests ?? []);
          const referencedNamespaces = new Set<RuntimeNamespace>();
          if (options.keepStableNamespaces) {
            referencedNamespaces.add('current');
            referencedNamespaces.add('dev');
          }
          let uncertainReference = false;

          const normalizeMatch = (value: string): string => {
            const unified = value.replace(/\\/g, '/');
            return process.platform === 'win32' ? unified.toLowerCase() : unified;
          };
          const runtimesNorm = normalizeMatch(runtimes);
          const isGlobalStorage = path.basename(path.dirname(resolvedRoot)).toLowerCase() === 'globalstorage';
          const rootHint = isSharedRoot
            ? '.coagent8/runtime'
            : isGlobalStorage
              ? normalizeMatch(path.join(path.basename(resolvedRoot), 'runtime'))
              : runtimesNorm;

          const recordRuntimeString = (rawValue: string, allowEmbedded: boolean, throwOnUnknown = false) => {
            const trimmed = rawValue.trim();
            if (!trimmed) return;
            const resolved = path.resolve(trimmed);
            if (sameOrInside(resolved, runtimes) && resolved !== runtimes) {
              const firstSegment = path.relative(runtimes, resolved).split(path.sep)[0];
              if (!firstSegment) return;
              if (SHA256_HEX.test(firstSegment)) {
                referencedDigests.add(firstSegment);
              } else if (firstSegment === 'current' || firstSegment === 'dev') {
                referencedNamespaces.add(firstSegment);
              } else if (throwOnUnknown) {
                throw new Error(`Uncertain runtime reference inside ${runtimes}`);
              } else {
                uncertainReference = true;
              }
              return;
            }
            if (!allowEmbedded) return;
            const normalized = normalizeMatch(trimmed);
            const mentionsRuntimeRoot =
              normalized.includes(runtimesNorm) || normalized.includes(rootHint) || (resolved === runtimes && !throwOnUnknown);
            if (!mentionsRuntimeRoot) return;
            const matches = [...trimmed.matchAll(/(?:^|[^a-z0-9_-])runtime(?:[\\/]([^\\/'\"\s;:,]+)|(?=[\\/\s'"]|$))/gi)];
            if (matches.length === 0) {
              uncertainReference = true;
              return;
            }
            for (const match of matches) {
              const segment = match[1]?.toLowerCase();
              if (!segment) {
                uncertainReference = true;
              } else if (SHA256_HEX.test(segment)) {
                referencedDigests.add(segment);
              } else if (segment === 'current' || segment === 'dev') {
                referencedNamespaces.add(segment);
              } else {
                uncertainReference = true;
              }
            }
          };

          const inspectEntryStrings = (value: unknown) => {
            if (typeof value === 'string') {
              recordRuntimeString(value, true);
              return;
            }
            if (Array.isArray(value)) {
              for (const item of value) inspectEntryStrings(item);
              return;
            }
            if (value && typeof value === 'object') {
              for (const nested of Object.values(value)) inspectEntryStrings(nested);
            }
          };

          const inspectServerEntry = (entry: unknown) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              uncertainReference = true;
              return;
            }
            const obj = entry as Record<string, unknown>;
            if (obj.command !== undefined && typeof obj.command !== 'string') {
              uncertainReference = true;
              return;
            }
            if (obj.args !== undefined && (!Array.isArray(obj.args) || !obj.args.every(arg => typeof arg === 'string'))) {
              uncertainReference = true;
              return;
            }
            if (obj.env !== undefined && (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env))) {
              uncertainReference = true;
              return;
            }
            inspectEntryStrings(obj);
          };

          // Inspect only the CLI host config locations that CoAgent8 setup itself writes (env-configured root and home default).
          for (const client of SETUP_CLIENTS as readonly SetupClient[]) {
            const candidates = new Set([configPath(client, home, env), configPath(client, home, {})]);
            for (const file of candidates) {
              try {
                const text = read(file);
                if (text === null) continue;
                const entries = servers(client, document(client, text));
                for (const entry of Object.values(entries)) {
                  inspectServerEntry(entry);
                }
              } catch {
                uncertainReference = true;
              }
            }
          }

          // Inspect VS Code profile mcp.json files (local globalStorage profile and any recorded in vscode-mcp.json).
          const mcpFiles = new Set<string>();
          if (isGlobalStorage) {
            mcpFiles.add(path.join(path.dirname(path.dirname(resolvedRoot)), 'mcp.json'));
          }
          const vscodeMcpFile = path.join(sharedRoot, 'vscode-mcp.json');
          if (fs.existsSync(vscodeMcpFile)) {
            try {
              const text = read(vscodeMcpFile);
              if (text === null) {
                uncertainReference = true;
              } else {
                const record = json(text);
                for (const profileFile of Object.keys(record)) {
                  mcpFiles.add(profileFile);
                }
              }
            } catch {
              uncertainReference = true;
            }
          }
          for (const mcpFile of mcpFiles) {
            try {
              const text = read(mcpFile);
              if (text === null) continue;
              const parsed = json(text);
              if (parsed.servers !== undefined) {
                if (!parsed.servers || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) {
                  uncertainReference = true;
                  continue;
                }
                for (const entry of Object.values(parsed.servers as Record<string, unknown>)) {
                  inspectServerEntry(entry);
                }
              }
            } catch {
              uncertainReference = true;
            }
          }

          const installsPath = path.join(sharedRoot, 'installs.json');
          if (fs.existsSync(installsPath)) {
            const raw = read(installsPath);
            if (raw === null) throw new Error('Unreadable installs.json');
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              throw new Error('Malformed installs.json');
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Malformed installs.json');
            for (const key of ['path', 'pathV2'] as const) {
              const pathRecord = (parsed as Record<string, unknown>)[key];
              if (pathRecord !== undefined) {
                const pRuntime = pathRecord && typeof pathRecord === 'object' ? (pathRecord as { runtime?: unknown }).runtime : undefined;
                if (typeof pRuntime !== 'string' || !pRuntime) throw new Error('Malformed PATH record in installs.json');
                recordRuntimeString(pRuntime, false, true);
              }
            }
          }

          const shimPath = path.join(sharedRoot, 'bin', 'coagent8.cmd');
          if (fs.existsSync(shimPath)) {
            let shimContent: string;
            try {
              shimContent = readBoundedFileSync(shimPath, POINTER_LIMIT);
            } catch {
              throw new Error('Unreadable PATH shim');
            }
            const matches = [...shimContent.matchAll(/runtime[\\/]([a-f0-9]{64}|current|dev)[\\/]/gi)];
            for (const match of matches) {
              const segment = match[1]!.toLowerCase();
              if (SHA256_HEX.test(segment)) referencedDigests.add(segment);
              else if (segment === 'current' || segment === 'dev') referencedNamespaces.add(segment);
            }
            const shimNorm = normalizeMatch(shimContent);
            if ((shimNorm.includes(runtimesNorm) || shimNorm.includes('.coagent8/runtime')) && matches.length === 0) {
              uncertainReference = true;
            }
          }

          // Inspect pointer files for referenced namespaces (or all namespaces if keeping stable namespaces).
          for (const ns of ['current', 'dev'] as const) {
            const pointerFile = runtimePointerPath(resolvedRoot, ns);
            if (!fs.existsSync(pointerFile)) continue;
            const pointer = readRuntimePointer(resolvedRoot, ns);
            if (!pointer) continue;
            if (referencedNamespaces.has(ns)) {
              referencedDigests.add(pointer.digest);
              if (pointer.pinned) referencedDigests.add(pointer.pinned.digest);
            }
          }

          // Inspect per-process runtime leases. Unreadable/uncertain leases count as in use.
          const leasesDir = runtimeLeasesDir(resolvedRoot);
          let uncertainLeasePresent = false;
          if (fs.existsSync(leasesDir)) {
            for (const entry of fs.readdirSync(leasesDir)) {
              const leasePath = path.join(leasesDir, entry);
              let stat: fs.Stats;
              try {
                stat = fs.statSync(leasePath);
              } catch {
                uncertainLeasePresent = true;
                continue;
              }
              if (!stat.isFile()) continue;
              if (entry.includes('.tmp.')) {
                if (Date.now() - stat.mtimeMs < 60_000) uncertainLeasePresent = true;
                else fs.rmSync(leasePath, { force: true });
                continue;
              }
              let parsed: RuntimeLease | null = null;
              try {
                parsed = parseLeaseRecord(JSON.parse(readBoundedFileSync(leasePath, LEASE_LIMIT)));
              } catch {
                uncertainLeasePresent = true;
                continue;
              }
              if (!parsed) {
                uncertainLeasePresent = true;
                continue;
              }
              const state = evaluateRuntimeLease(parsed, stat.mtimeMs, options.checkProcessIdentity);
              if (state === 'dead') {
                fs.rmSync(leasePath, { force: true });
              } else {
                referencedDigests.add(parsed.digest);
              }
            }
          }

          if (uncertainReference || uncertainLeasePresent) {
            // Uncertain host reference or lease cannot safely narrow down which copy is running: preserve all copies.
            const kept = fs.existsSync(runtimes) ? fs.readdirSync(runtimes).filter(name => SHA256_HEX.test(name)) : [];
            return { removed: [], kept };
          }

          const removed: string[] = [];
          const kept: string[] = [];
          if (fs.existsSync(runtimes)) {
            for (const name of fs.readdirSync(runtimes)) {
              const dirPath = path.join(runtimes, name);
              if (SHA256_HEX.test(name)) {
                if (referencedDigests.has(name)) {
                  kept.push(name);
                } else if (!removePreLeaseCopies && !isLeaseCapableCopy(dirPath)) {
                  // Copies without `.lease-capable` may still be executing in pre-lease processes (no leases);
                  // automatic and explicit runtime cleanups keep them indefinitely, and only full uninstall removes them.
                  kept.push(name);
                } else if (removeRuntimeDirectory(dirPath)) {
                  removed.push(name);
                } else {
                  kept.push(name);
                }
              } else if (name === 'current' || name === 'dev') {
                if (!referencedNamespaces.has(name)) {
                  fs.rmSync(dirPath, { recursive: true, force: true });
                } else {
                  try {
                    fs.rmSync(path.join(dirPath, STAGED_POINTER_NAME), { force: true });
                  } catch {}
                }
              }
            }
            try {
              if (fs.existsSync(leasesDir) && fs.readdirSync(leasesDir).length === 0) {
                fs.rmdirSync(leasesDir);
              }
              if (fs.readdirSync(runtimes).length === 0) {
                fs.rmdirSync(runtimes);
              }
            } catch {}
          }
          return { removed, kept };
        },
        innerTimeoutMs,
      );
    },
    outerTimeoutMs,
  );
}

/** Reads status summary for a runtime namespace (pointer, target health, and active leases). */
export function readRuntimeStatus(
  home: string,
  namespace: RuntimeNamespace = 'current',
): {
  namespace: RuntimeNamespace;
  launcherPath: string;
  launcherExists: boolean;
  pointer: RuntimePointer | null;
  targetPath: string | null;
  targetExists: boolean;
  installedCopies: string[];
  activeLeases: RuntimeLease[];
} {
  const root = coagentRootForHome(home);
  const launcherPath = stableLauncherPath(root, namespace);
  const launcherExists = fs.existsSync(launcherPath);
  const pointer = readRuntimePointer(root, namespace);
  const targetPath = pointer ? path.join(runtimeRootDir(root), pointer.digest, 'index.cjs') : null;
  const targetExists = targetPath ? fs.existsSync(targetPath) : false;
  const runtimes = runtimeRootDir(root);
  const installedCopies = fs.existsSync(runtimes) ? fs.readdirSync(runtimes).filter(n => SHA256_HEX.test(n)) : [];
  const activeLeases: RuntimeLease[] = [];
  const leasesDir = runtimeLeasesDir(root);
  if (fs.existsSync(leasesDir)) {
    for (const file of fs.readdirSync(leasesDir)) {
      if (file.includes('.tmp.')) continue;
      const full = path.join(leasesDir, file);
      try {
        const stat = fs.statSync(full);
        const parsed = parseLeaseRecord(JSON.parse(readBoundedFileSync(full, LEASE_LIMIT)));
        if (parsed && evaluateRuntimeLease(parsed, stat.mtimeMs) !== 'dead') {
          activeLeases.push(parsed);
        }
      } catch {
        // Ignore unreadable entries in status display.
      }
    }
  }
  return {
    namespace,
    launcherPath,
    launcherExists,
    pointer,
    targetPath,
    targetExists,
    installedCopies,
    activeLeases,
  };
}
