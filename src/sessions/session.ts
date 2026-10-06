import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionRecord, SessionResult, AcquireSessionResult, GetSessionOptions } from '../types/session.types.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock } from './lock.js';
import { PROVIDERS } from '../types/conversation.types.js';
import { readBoundedFileSync } from '../execution/stream.js';
import { pruneHistoryDirectory, invalidateHistoryCache } from './history.js';
import { canonicalPath, sanitizeHandle } from './identity.js';
export { canonicalPath, sanitizeHandle } from './identity.js';

export const DEFAULT_SESSION_TTL_MS = 2 * 3600 * 1000;
const ownedTurns = new Map<string, string>();
export function getSessionsDir(): string {
  const explicit = process.env.coagent8_SESSIONS_DIR || process.env.coagent8_SESSIONS;
  return explicit ? (explicit.endsWith('.json') ? path.join(path.dirname(explicit), 'sessions') : explicit) : path.join(getDataDir(), 'sessions');
}
export function isProcessAlive(pid?: number | null): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}
export function getSessionFilePath(handle: string): string | null { return sanitizeHandle(handle) ? path.join(getSessionsDir(), `${handle}.json`) : null; }
export function saveSessionFile(file: string, record: SessionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${crypto.randomUUID()}`;
  try { fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function parseSession(raw: unknown, handle: string): SessionRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as SessionRecord;
  if (s.sessionHandle !== handle || !sanitizeHandle(handle) || !PROVIDERS.includes(s.backend as typeof PROVIDERS[number]) || typeof s.workspace !== 'string' || !path.isAbsolute(s.workspace)) return null;
  if (!Number.isFinite(Date.parse(s.createdAt)) || !Number.isFinite(Date.parse(s.lastUsedAt))) return null;
  if (s.threadId != null && (typeof s.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(s.threadId))) return null;
  if (s.backend === 'gemini' && s.threadId != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s.threadId)) return null;
  if (s.activePid != null && (!Number.isSafeInteger(s.activePid) || s.activePid <= 0)) return null;
  if (s.activeTurnAt != null && (!Number.isFinite(s.activeTurnAt) || s.activeTurnAt < 0)) return null;
  if (s.state && !['idle', 'running', 'invalidated', 'closed'].includes(s.state)) return null;
  if (s.schemaVersion != null && s.schemaVersion !== 2) return null;
  if (s.turnToken != null && (typeof s.turnToken !== 'string' || !/^[a-f0-9-]{36}$/.test(s.turnToken))) return null;
  if (s.turnCount != null && (!Number.isSafeInteger(s.turnCount) || s.turnCount < 0)) return null;
  for (const value of [s.model, s.cliVersion, s.safetyProfile, s.lastErrorCode]) if (value != null && (typeof value !== 'string' || value.length > 256)) return null;
  return { ...s, schemaVersion: 2, state: s.state || (s.activePid ? 'running' : 'idle'), activePid: s.activePid ?? null, activeTurnAt: s.activeTurnAt ?? null, threadId: s.threadId ?? null, turnToken: s.turnToken ?? null, turnCount: s.turnCount ?? 0 };
}
export function readRecord(file: string, handle: string): SessionRecord | null {
  try { return parseSession(JSON.parse(readBoundedFileSync(file)), handle); } catch { return null; }
}
function active(s: SessionRecord): boolean { return isProcessAlive(s.activePid); }
export function getSession(handle: string, options: GetSessionOptions = {}): SessionRecord | null {
  const file = getSessionFilePath(handle); if (!file) return null;
  const s = readRecord(file, handle);
  if (!s || s.state === 'closed' || s.state === 'invalidated' || (!active(s) && Date.now() - Date.parse(s.lastUsedAt) > DEFAULT_SESSION_TTL_MS)) return null;
  if ((options.backend && s.backend !== options.backend) || (options.workspace && canonicalPath(s.workspace) !== canonicalPath(options.workspace))) return null;
  return s;
}
export async function withSessionLock<T>(handle: string, fn: (file: string) => T | Promise<T>): Promise<SessionResult<T>> {
  const file = getSessionFilePath(handle); if (!file) return { ok: false, error: 'Invalid session handle format' };
  try {
    return await withFileLock(file, async () => {
      return { ok: true, data: await fn(file) };
    });
  } catch (err) { return { ok: false, error: (err as Error).message }; }
}
export function createSession(backend: string, workspace = process.cwd(), threadId: string | null = null): SessionRecord {
  if (!PROVIDERS.includes(backend as typeof PROVIDERS[number])) throw new Error('Invalid session provider.');
  const handle = `syn_sess_${crypto.randomBytes(12).toString('hex')}`, now = new Date().toISOString();
  const s: SessionRecord = { schemaVersion: 2, sessionHandle: handle, backend, workspace: canonicalPath(workspace), threadId,
    state: 'idle', turnToken: null, turnCount: 0, activePid: null, activeTurnAt: null, createdAt: now, lastUsedAt: now };
  saveSessionFile(getSessionFilePath(handle)!, s);
  return s;
}
export async function acquireSessionTurn(handle: string): Promise<SessionResult<{ token: string }>> {
  const locked = await withSessionLock(handle, async file => {
    const s = getSession(handle); if (!s) return { ok: false, error: 'Invalid or expired session handle.' };
    if (active(s)) return { ok: false, error: 'Session is currently busy executing another turn.' };
    const token = crypto.randomUUID(); s.turnToken = token; s.activePid = process.pid; s.activeTurnAt = Date.now(); s.state = 'running'; s.turnCount = (s.turnCount || 0) + 1;
    s.lastUsedAt = new Date().toISOString(); await atomicWrite(file, JSON.stringify(s)); ownedTurns.set(handle, token);
    return { ok: true, data: { token } };
  });
  return locked.data || { ok: false, error: locked.error };
}
export async function releaseSessionTurn(handle: string, token = ownedTurns.get(handle)): Promise<SessionResult> {
  const locked = await withSessionLock(handle, async file => {
    const s = readRecord(file, handle); if (!s) return fs.existsSync(file) ? { ok: false, error: 'Invalid session record prevents verifying turn release.' } : { ok: true };
    if (!token || s.turnToken !== token || s.activePid !== process.pid) return { ok: false, error: 'Turn ownership mismatch.' };
    s.activePid = null; s.activeTurnAt = null; s.turnToken = null;
    if (s.state === 'running') s.state = 'idle';
    s.lastUsedAt = new Date().toISOString(); await atomicWrite(file, JSON.stringify(s)); ownedTurns.delete(handle); return { ok: true };
  });
  return locked.data || { ok: false, error: locked.error };
}
export async function updateSession(handle: string, updates: Partial<SessionRecord> = {}, token = ownedTurns.get(handle)): Promise<SessionRecord | null> {
  const locked = await withSessionLock(handle, async file => {
    const s = readRecord(file, handle); if (!s) return null;
    if (active(s) && (!token || token !== s.turnToken)) throw new Error('Turn ownership mismatch.');
    const allowed = ['threadId', 'model', 'cliVersion', 'safetyProfile', 'lastErrorCode', 'state'] as const;
    for (const key of Object.keys(updates)) if (!allowed.includes(key as typeof allowed[number])) throw new Error(`Immutable session field: ${key}`);
    const updated = parseSession({ ...s, ...updates, lastUsedAt: new Date().toISOString() }, handle);
    if (!updated) throw new Error('Invalid session update.');
    await atomicWrite(file, JSON.stringify(updated)); return updated;
  });
  if (!locked.ok) throw new Error(locked.error); return locked.data || null;
}
export async function closeSession(handle: string, workspace?: string): Promise<boolean> {
  const locked = await withSessionLock(handle, async file => {
    const s = readRecord(file, handle); if (!s) return false;
    if (workspace && canonicalPath(s.workspace) !== canonicalPath(workspace)) throw new Error('Session workspace mismatch.');
    if (s.state === 'closed') return false;
    if (active(s)) throw new Error('Cannot close session: busy executing another turn.');
    s.state = 'closed'; s.threadId = null; s.turnToken = null; await atomicWrite(file, JSON.stringify(s)); return true;
  });
  if (!locked.ok) throw new Error(locked.error);
  if (locked.data) {
    invalidateHistoryCache(handle);
    try { await pruneHistoryDirectory(); } catch {}
  }
  return locked.data || false;
}
export async function acquireAndResolveSession(handle?: string | null, backend = 'codex', workspace = process.cwd()): Promise<AcquireSessionResult> {
  const s = handle ? getSession(handle, { backend, workspace }) : createSession(backend, workspace);
  if (!s) return { error: 'Invalid or expired session handle (workspace/provider mismatch or invalidation).' };
  const acquired = await acquireSessionTurn(s.sessionHandle); if (!acquired.ok) return { error: acquired.error };
  return { session: getSession(s.sessionHandle)! };
}
export function resolveOrInitSession(handle?: string | null, backend = 'codex', workspace = process.cwd()): AcquireSessionResult {
  const s = handle ? getSession(handle, { backend, workspace }) : createSession(backend, workspace);
  return s ? { session: s } : { error: 'Invalid or expired session handle.' };
}

let executionCanceller: ((handle: string) => Promise<boolean> | boolean) | null = null;
export function setExecutionCanceller(fn: (handle: string) => Promise<boolean> | boolean): void {
  executionCanceller = fn;
}

export async function cancelSession(handle: string, workspace?: string): Promise<{ cancelled: boolean; message: string }> {
  const sanitized = sanitizeHandle(handle);
  if (!sanitized) throw new Error(`Invalid session handle: '${handle}'.`);

  const file = getSessionFilePath(sanitized);
  if (!file) throw new Error(`Invalid session handle: '${handle}'.`);

  const stored = readRecord(file, sanitized);
  if (!stored) {
    return { cancelled: false, message: `Session '${sanitized}' not found.` };
  }

  if (workspace && canonicalPath(stored.workspace) !== canonicalPath(workspace)) {
    throw new Error('Session workspace mismatch.');
  }

  const targetToken = stored.turnToken;

  // 1. Cancel active execution in this process and wait for clean turn release
  if (executionCanceller) {
    const settled = await executionCanceller(sanitized);
    if (!settled) {
      throw new Error(`Session '${sanitized}' execution cancellation timed out; active processes may still be running.`);
    }
  }

  // 2. Validate external process and reset running state under session lock
  const locked = await withSessionLock(sanitized, async f => {
    const s = readRecord(f, sanitized);
    if (!s) return;

    if (s.activePid && s.activePid !== process.pid && isProcessAlive(s.activePid)) {
      throw new Error(`Cannot cancel session '${sanitized}': actively running in another process (PID ${s.activePid}).`);
    }

    if (targetToken) {
      if (s.turnToken === targetToken) {
        s.state = 'idle';
        s.activePid = null;
        s.turnToken = null;
        s.activeTurnAt = null;
        s.lastUsedAt = new Date().toISOString();
        await atomicWrite(f, JSON.stringify(s));
      }
    } else if (!s.turnToken && (s.state === 'running' || s.activePid)) {
      s.state = 'idle';
      s.activePid = null;
      s.turnToken = null;
      s.activeTurnAt = null;
      s.lastUsedAt = new Date().toISOString();
      await atomicWrite(f, JSON.stringify(s));
    }

    if (targetToken && ownedTurns.get(sanitized) === targetToken) {
      ownedTurns.delete(sanitized);
    } else if (!targetToken && !s.turnToken) {
      ownedTurns.delete(sanitized);
    }
  });
  if (!locked.ok) {
    throw new Error(`Failed to lock session during cancellation: ${locked.error}`);
  }

  return {
    cancelled: true,
    message: `Session '${sanitized}' execution cancelled and resources released.`,
  };
}

export function listSessions(): SessionRecord[] {
  const dir = getSessionsDir();
  const results: SessionRecord[] = [];
  try {
    const files = fs.readdirSync(dir);
    for (const name of files) {
      if (!name.endsWith('.json') || !sanitizeHandle(name.slice(0, -5))) continue;
      const handle = name.slice(0, -5);
      const s = getSession(handle);
      if (s) results.push(s);
    }
  } catch {}
  return results;
}

async function sweepExpiredSessions(dir: string): Promise<void> {
  const gateFile = process.env.coagent8_MAINTENANCE_GATE;
  if (gateFile) {
    try {
      await fsp.writeFile(`${gateFile}.started`, 'started');
      const startWait = Date.now();
      while (Date.now() - startWait < 5000) {
        try {
          await fsp.access(`${gateFile}.release`);
          break;
        } catch {
          await new Promise(r => setTimeout(r, 20));
        }
      }
    } catch {}
  }
  const delayMs = parseInt(process.env.coagent8_MAINTENANCE_DELAY_MS || '0', 10);
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  try {
    for (const name of await fsp.readdir(dir)) {
      if (/^syn_sess_[A-Za-z0-9_-]{6,80}\.json\.lease$/.test(name)) {
        try {
          const raw = await fsp.readFile(path.join(dir, name), 'utf8');
          const lease = JSON.parse(raw);
          if (lease?.pid && !isProcessAlive(lease.pid)) {
            await fsp.rm(path.join(dir, name), { force: true });
          }
        } catch {}
        continue;
      }

      if (!name.endsWith('.json') || !sanitizeHandle(name.slice(0, -5))) continue;
      const handle = name.slice(0, -5);
      await withSessionLock(handle, async file => {
        const s = readRecord(file, handle);
        if (s && !active(s) && Date.now() - Date.parse(s.lastUsedAt) > DEFAULT_SESSION_TTL_MS) {
          await fsp.rm(file, { force: true });
          invalidateHistoryCache(handle);
        }
      });
    }
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
}
let lastPrunedDir = '', lastPrunedAt = 0, pruning: Promise<void> | undefined;
export async function pruneExpiredSessions(force = false): Promise<void> {
  const dir = getSessionsDir();
  if (pruning) { await pruning; if (dir === lastPrunedDir) return; }
  if (!force && dir === lastPrunedDir && Date.now() - lastPrunedAt < 60000) return;
  pruning = sweepExpiredSessions(dir);
  try { await pruning; lastPrunedDir = dir; lastPrunedAt = Date.now(); }
  finally { pruning = undefined; }
}
