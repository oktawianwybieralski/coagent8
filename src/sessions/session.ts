import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionRecord, SessionResult, AcquireSessionResult, GetSessionOptions, type CompletedReview, type ReviewIdentity } from './types.js';
import { getDataDir } from '../paths.js';
import { atomicWrite, withFileLock, combineSignals, type FileLockOptions } from '../storage/lock.js';
import { PROVIDERS, ToolError, type BackendReadContext, type ExecutionBudget } from '../contracts/index.js';
import { readBoundedFileSync } from '../storage/read.js';
import { pruneHistoryDirectory, invalidateHistoryCache } from './history/index.js';
import { canonicalPath } from '../workspace/identity.js';
import { sanitizeHandle } from './identity.js';
import { redactDiagnostic } from '../security/index.js';
import { getSessionsDir, isProcessAlive, getSessionFilePath } from './activity.js';

export { getSessionsDir, isProcessAlive, getSessionFilePath };

const DEFAULT_SESSION_TTL_MS = 2 * 3600 * 1000;
/** Longest stored review reason; the reference to it stays bounded. */
export const MAX_REVIEW_REASON_CHARS = 600;
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
/** A stored review outcome, or undefined when absent or malformed; a malformed one never invalidates the session. */
function parseCompletedReview(raw: unknown): CompletedReview | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as CompletedReview;
  if (!boundedString(r.snapshot, 512) || !boundedString(r.scope, 512) || (r.model !== null && !boundedString(r.model, 256))) return undefined;
  if ((r.verdict !== 'READY' && r.verdict !== 'BLOCKED') || !Number.isFinite(Date.parse(r.completedAt))) return undefined;
  if (r.reason !== undefined && !boundedString(r.reason, MAX_REVIEW_REASON_CHARS)) return undefined;
  if (r.coverage !== undefined && r.coverage !== 'COMPLETE' && r.coverage !== 'PARTIAL') return undefined;
  return { snapshot: r.snapshot, scope: r.scope, model: r.model, verdict: r.verdict, ...(r.coverage ? { coverage: r.coverage } : {}), ...(r.reason ? { reason: r.reason } : {}), completedAt: r.completedAt };
}
const ownedTurns = new Map<string, string>();
function saveSessionFile(file: string, record: SessionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp.${crypto.randomUUID()}`;
  try { fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function parseSession(raw: unknown, handle: string): SessionRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as SessionRecord;
  if (s.sessionHandle !== handle || !sanitizeHandle(handle) || !PROVIDERS.includes(s.backend as typeof PROVIDERS[number]) || typeof s.workspace !== 'string' || !path.isAbsolute(s.workspace)) return null;
  if (!Number.isFinite(Date.parse(s.createdAt)) || !Number.isFinite(Date.parse(s.lastUsedAt))) return null;
  if (s.threadId != null && (typeof s.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(s.threadId))) return null;
  if (s.backend === 'agy' && s.threadId != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s.threadId)) return null;
  if (s.activePid != null && (!Number.isSafeInteger(s.activePid) || s.activePid <= 0)) return null;
  if (s.activeTurnAt != null && (!Number.isFinite(s.activeTurnAt) || s.activeTurnAt < 0)) return null;
  if (s.state && !['idle', 'running', 'invalidated', 'closed'].includes(s.state)) return null;
  if (s.schemaVersion != null && s.schemaVersion !== 2) return null;
  if (s.turnToken != null && (typeof s.turnToken !== 'string' || !/^[a-f0-9-]{36}$/.test(s.turnToken))) return null;
  if (s.turnCount != null && (!Number.isSafeInteger(s.turnCount) || s.turnCount < 0)) return null;
  for (const value of [s.model, s.reasoningEffort, s.cliVersion, s.safetyProfile, s.lastErrorCode]) if (value != null && (typeof value !== 'string' || value.length > 256)) return null;
  const { lastReview: rawReview, ...rest } = s;
  const lastReview = parseCompletedReview(rawReview);
  return { ...rest, schemaVersion: 2, state: s.state || (s.activePid ? 'running' : 'idle'), activePid: s.activePid ?? null, activeTurnAt: s.activeTurnAt ?? null, threadId: s.threadId ?? null, turnToken: s.turnToken ?? null, turnCount: s.turnCount ?? 0, ...(lastReview ? { lastReview } : {}) };
}
function readRecord(file: string, handle: string): SessionRecord | null {
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
/**
 * Why a stored session of this workspace cannot continue, so a refusal can name it.
 * @param handle - Requested session handle.
 * @param workspace - Workspace of the request.
 * @returns `closed`, `invalidated` or `expired`; undefined when the session is usable, unknown or
 * belongs to another workspace, which a refusal must not reveal.
 */
export function unavailableSessionState(handle: string, workspace: string): 'closed' | 'invalidated' | 'expired' | undefined {
  const file = getSessionFilePath(handle); if (!file) return undefined;
  const s = readRecord(file, handle);
  if (!s || canonicalPath(s.workspace) !== canonicalPath(workspace)) return undefined;
  if (s.state === 'closed' || s.state === 'invalidated') return s.state;
  return !active(s) && Date.now() - Date.parse(s.lastUsedAt) > DEFAULT_SESSION_TTL_MS ? 'expired' : undefined;
}
function parseSessionOptions(
  options?: number | AbortSignal | FileLockOptions | BackendReadContext
): {
  budget?: ExecutionBudget;
  effectiveSignal?: AbortSignal | null;
} {
  if (options === undefined || options === null || typeof options === 'number') {
    return {};
  }
  if (typeof options === 'object' && 'aborted' in options && typeof (options as AbortSignal).addEventListener === 'function') {
    const sig = options as AbortSignal;
    return { effectiveSignal: sig };
  }
  if (typeof options === 'object') {
    const raw = options as FileLockOptions & BackendReadContext;
    const context = raw.context ?? (raw.budget || raw.abortSignal ? raw : undefined);
    const budget = raw.budget ?? context?.budget;
    const callerSignal = raw.abortSignal !== context?.abortSignal
      ? combineSignals(raw.abortSignal, context?.abortSignal) ?? undefined
      : raw.abortSignal ?? context?.abortSignal;
    const effectiveSignal = combineSignals(callerSignal, budget?.executionSignal);
    return { budget, effectiveSignal };
  }
  return {};
}

export function isBudgetExpired(budget?: ExecutionBudget): boolean {
  if (!budget) return false;
  return budget.isExecutionExpired() || budget.isTimedOut() || budget.remainingExecutionMs() <= 0;
}

export function isSessionExpired(
  effectiveSignal?: AbortSignal | null,
  budget?: ExecutionBudget
): boolean {
  if (effectiveSignal?.aborted) return true;
  return isBudgetExpired(budget);
}

export function assertSessionNotExpired(
  effectiveSignal?: AbortSignal | null,
  budget?: ExecutionBudget,
  phase = 'Session acquisition'
): void {
  if (effectiveSignal?.aborted) {
    if (isBudgetExpired(budget)) {
      throw new ToolError('TIMEOUT', `Execution budget expired during ${phase.toLowerCase()}.`);
    }
    throw new ToolError('ABORTED', `${phase} was aborted.`);
  }
  if (isBudgetExpired(budget)) {
    throw new ToolError('TIMEOUT', `Execution budget expired during ${phase.toLowerCase()}.`);
  }
}

async function withSessionLock<T>(
  handle: string,
  fn: (file: string) => T | Promise<T>,
  options?: number | AbortSignal | FileLockOptions | BackendReadContext
): Promise<SessionResult<T>> {
  const file = getSessionFilePath(handle);
  if (!file) return { ok: false, error: 'Invalid session handle format' };
  try {
    return await withFileLock(
      file,
      async () => {
        return { ok: true, data: await fn(file) };
      },
      options
    );
  } catch (err) {
    if (options !== undefined && typeof options !== 'number') {
      if (err instanceof ToolError) {
        const { budget } = parseSessionOptions(options);
        if (isBudgetExpired(budget)) {
          throw new ToolError('TIMEOUT', 'Execution budget expired while waiting for session lock.');
        }
        throw err;
      }
      const { effectiveSignal, budget } = parseSessionOptions(options);
      if (isSessionExpired(effectiveSignal, budget)) {
        assertSessionNotExpired(effectiveSignal, budget, 'Session lock');
      }
    }
    return { ok: false, error: (err as Error).message };
  }
}
export function createSession(backend: string, workspace = process.cwd(), threadId: string | null = null): SessionRecord {
  if (!PROVIDERS.includes(backend as typeof PROVIDERS[number])) throw new Error('Invalid session provider.');
  const handle = `syn_sess_${crypto.randomBytes(12).toString('hex')}`, now = new Date().toISOString();
  const s: SessionRecord = { schemaVersion: 2, sessionHandle: handle, backend, workspace: canonicalPath(workspace), threadId,
    state: 'idle', turnToken: null, turnCount: 0, activePid: null, activeTurnAt: null, createdAt: now, lastUsedAt: now };
  saveSessionFile(getSessionFilePath(handle)!, s);
  return s;
}

/**
 * Atomically acquires turn ownership on an idle session record, recording this
 * CoAgent8 server process (`process.pid`, not a backend CLI child PID) as `activePid`.
 *
 * Checks cancellation signals and execution budget before lock acquisition,
 * during the lock wait, and across synchronous boundaries immediately after write.
 * Atomic file writes (`atomicWrite` via `fs.rename`) represent uninterruptible OS
 * operations; if cancellation occurs across a write boundary, rollback to idle is
 * attempted and turn ownership is revoked. If rollback write fails due to OS I/O error,
 * the record remains until stale recovery reclaims it.
 *
 * @param handle - Valid session handle.
 * @param options - Optional timeout, cancellation signal, lock options, or read context (`EXEC-001-T09c`).
 * @returns Object with `ok: true` and `{ token }` on success, or `{ ok: false, error }` if busy/expired.
 * @throws ToolError if the acquisition wait is aborted or execution budget expired.
 */
export async function acquireSessionTurn(
  handle: string,
  options?: number | AbortSignal | FileLockOptions | BackendReadContext
): Promise<SessionResult<{ token: string }>> {
  const { effectiveSignal, budget } = parseSessionOptions(options);
  assertSessionNotExpired(effectiveSignal, budget, 'Session turn acquisition');

  const locked = await withSessionLock(handle, async file => {
    const s = getSession(handle);
    if (!s) return { ok: false, error: 'Invalid or expired session handle.' };
    if (active(s)) return { ok: false, error: 'Session is currently busy executing another turn.' };

    assertSessionNotExpired(effectiveSignal, budget, 'Session turn acquisition');

    const token = crypto.randomUUID();
    s.turnToken = token;
    s.activePid = process.pid;
    s.activeTurnAt = Date.now();
    s.state = 'running';
    s.turnCount = (s.turnCount || 0) + 1;
    s.lastUsedAt = new Date().toISOString();

    // Persist turn record atomically.
    // Note: atomicWrite and fs.rename are atomic OS operations that cannot be
    // interrupted mid-stream without risking corrupted temporary state on disk.
    await atomicWrite(file, JSON.stringify(s));

    // Verify cancellation status immediately across synchronous boundary after write
    if (isSessionExpired(effectiveSignal, budget)) {
      s.turnToken = null;
      s.activePid = null;
      s.activeTurnAt = null;
      s.state = 'idle';
      s.turnCount = Math.max(0, (s.turnCount || 1) - 1);
      s.lastUsedAt = new Date().toISOString();
      try {
        await atomicWrite(file, JSON.stringify(s));
      } catch (rollbackErr) {
        process.stderr.write(`Warning: failed to persist session rollback for ${handle}: ${(rollbackErr as Error).message}\n`);
      } finally {
        ownedTurns.delete(handle);
      }
      assertSessionNotExpired(effectiveSignal, budget, 'Session turn acquisition');
    }

    ownedTurns.set(handle, token);
    return { ok: true, data: { token } };
  }, options);

  if (!locked.ok) {
    assertSessionNotExpired(effectiveSignal, budget, 'Session turn acquisition');
    return { ok: false, error: locked.error };
  }

  return locked.data!;
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
    const allowed = ['threadId', 'model', 'reasoningEffort', 'cliVersion', 'safetyProfile', 'lastErrorCode', 'state', 'lastReview'] as const;
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
    // Closing succeeded; reclaiming history space is maintenance and only reported.
    try { await pruneHistoryDirectory(); }
    catch (err) { process.stderr.write(`Warning: history pruning after close failed: ${redactDiagnostic((err as Error).message)}\n`); }
  }
  return locked.data || false;
}
/**
 * Resolves or initializes a session and atomically acquires exclusive turn ownership.
 *
 * Checks cancellation signals and execution budget before creating or resolving session,
 * during lock acquisition waits, and across synchronous boundaries immediately after write.
 * Atomic file writes (`atomicWrite` via `fs.rename`) represent uninterruptible OS
 * operations; if cancellation occurs across a write boundary, rollback to idle is
 * attempted, any newly initialized empty session file is removed, and turn token is revoked.
 *
 * @param handle - Optional existing session handle to resume.
 * @param backend - Target CLI provider (default: 'codex').
 * @param workspace - Absolute canonical workspace path.
 * @param options - Optional cancellation signal, execution budget, read context, or lock options (`EXEC-001-T09c`).
 * @returns Resolved session record with active turn token, or error description.
 * @throws ToolError if acquisition is aborted or execution budget expired.
 */
export async function acquireAndResolveSession(
  handle?: string | null,
  backend = 'codex',
  workspace = process.cwd(),
  options?: number | AbortSignal | FileLockOptions | BackendReadContext
): Promise<AcquireSessionResult> {
  const { effectiveSignal, budget } = parseSessionOptions(options);
  assertSessionNotExpired(effectiveSignal, budget, 'Session acquisition');

  const isNewSession = !handle;
  const s = handle ? getSession(handle, { backend, workspace }) : createSession(backend, workspace);
  if (!s) return { error: 'Invalid or expired session handle (workspace/provider mismatch or invalidation).' };

  let acquired: SessionResult<{ token: string }>;
  try {
    acquired = await acquireSessionTurn(s.sessionHandle, options);
  } catch (err) {
    if (isNewSession) {
      const file = getSessionFilePath(s.sessionHandle);
      if (file) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore cleanup error */ }
      }
    }
    throw err;
  }

  if (!acquired.ok) {
    if (isNewSession) {
      const file = getSessionFilePath(s.sessionHandle);
      if (file) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore cleanup error */ }
      }
    }
    return { error: acquired.error };
  }

  if (isSessionExpired(effectiveSignal, budget)) {
    if (acquired.data?.token) {
      const rollbackTurn = async (file: string) => {
        const rec = readRecord(file, s.sessionHandle);
        if (rec && rec.turnToken === acquired.data?.token) {
          rec.activePid = null;
          rec.activeTurnAt = null;
          rec.turnToken = null;
          rec.state = 'idle';
          rec.turnCount = Math.max(0, (rec.turnCount || 1) - 1);
          rec.lastUsedAt = new Date().toISOString();
          await atomicWrite(file, JSON.stringify(rec));
          ownedTurns.delete(s.sessionHandle);
        }
      };
      let rollbackResult = await withSessionLock(s.sessionHandle, rollbackTurn);
      if (!rollbackResult.ok) {
        rollbackResult = await withSessionLock(s.sessionHandle, rollbackTurn);
      }
      ownedTurns.delete(s.sessionHandle);
      if (!rollbackResult.ok) {
        process.stderr.write(`Warning: failed to rollback session turn for ${s.sessionHandle}: ${rollbackResult.error}\n`);
      }
    }
    if (isNewSession) {
      const file = getSessionFilePath(s.sessionHandle);
      if (file) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore cleanup error */ }
      }
    }
    assertSessionNotExpired(effectiveSignal, budget, 'Session acquisition');
  }

  return { session: getSession(s.sessionHandle)! };
}
export function resolveOrInitSession(handle?: string | null, backend = 'codex', workspace = process.cwd()): AcquireSessionResult {
  const s = handle ? getSession(handle, { backend, workspace }) : createSession(backend, workspace);
  return s ? { session: s } : { error: 'Invalid or expired session handle.' };
}

/** Result of cancelling a session's execution in this process: none running, settled, or still running at the deadline. */
export type CancelOutcome = 'none' | 'settled' | 'timed_out';
/** Owned cancellation callback installed by the execution lifecycle owner. */
export type ExecutionCanceller = (handle: string) => Promise<CancelOutcome> | CancelOutcome;
let executionCanceller: ExecutionCanceller | null = null;
export function setExecutionCanceller(fn: ExecutionCanceller): void {
  executionCanceller = fn;
}

/**
 * Cancels the active turn of a session owned by this CoAgent8 server process, or
 * recovers a stale turn lease left by a dead owner process.
 *
 * @remarks
 * `activePid` on the session record identifies the CoAgent8 server process that
 * owns the turn lease, not the backend CLI child process. If `activePid` belongs
 * to another live CoAgent8 server process, cancellation is refused rather than
 * signalling a foreign process.
 */
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
  // Closing releases the turn, so a closed session never has one to cancel.
  if (stored.state === 'closed') {
    return { cancelled: false, message: `Session '${sanitized}' is closed; nothing to cancel.` };
  }

  const targetToken = stored.turnToken;

  // 1. Cancel active execution in this process and wait for clean turn release
  const outcome = executionCanceller ? await executionCanceller(sanitized) : 'none';
  if (outcome === 'timed_out') {
    throw new Error(`Session '${sanitized}' execution cancellation timed out; active processes may still be running.`);
  }
  let released = false;

  // 2. Validate external process and reset running state under session lock
  const locked = await withSessionLock(sanitized, async f => {
    const s = readRecord(f, sanitized);
    if (!s) return;

    if (s.activePid && s.activePid !== process.pid && isProcessAlive(s.activePid)) {
      throw new Error(`Cannot cancel session '${sanitized}': actively running in another CoAgent8 server process (PID ${s.activePid}).`);
    }

    if (targetToken ? s.turnToken === targetToken : !s.turnToken && (s.state === 'running' || s.activePid)) {
      s.state = 'idle';
      s.activePid = null;
      s.turnToken = null;
      s.activeTurnAt = null;
      s.lastUsedAt = new Date().toISOString();
      await atomicWrite(f, JSON.stringify(s));
      released = true;
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

  return outcome === 'settled' || released
    ? { cancelled: true, message: `Session '${sanitized}' execution cancelled and resources released.` }
    : { cancelled: false, message: `Session '${sanitized}' has no running turn; nothing to cancel.` };
}

/**
 * Lists the live sessions of one workspace.
 * @param workspace - Only sessions created in this workspace are returned.
 * @returns Live (not closed, invalidated or expired) sessions; none when no session was ever stored.
 */
export function listSessions(workspace: string): SessionRecord[] {
  const dir = getSessionsDir();
  let files: string[];
  try { files = fs.readdirSync(dir); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
  const results: SessionRecord[] = [];
  for (const name of files) {
    if (!name.endsWith('.json') || !sanitizeHandle(name.slice(0, -5))) continue;
    const s = getSession(name.slice(0, -5), { workspace });
    if (s) results.push(s);
  }
  return results;
}

/**
 * Finds the most recent completed review with this identity among the live sessions of one
 * workspace and backend (`AX-007c`).
 * @returns The session handle, stored outcome and whether the session can continue, or null when none matches.
 * @throws When the sessions directory cannot be read; an unreadable record counts as absent.
 */
export function findCompletedReview(
  workspace: string,
  backend: string,
  identity: ReviewIdentity
): { sessionHandle: string; review: CompletedReview; continuationAvailable: boolean } | null {
  let found: { sessionHandle: string; review: CompletedReview; continuationAvailable: boolean } | null = null;
  for (const s of listSessions(workspace)) {
    const r = s.lastReview;
    if (!r || s.backend !== backend || r.snapshot !== identity.snapshot || r.scope !== identity.scope || r.model !== identity.model) continue;
    // Only a completed review with complete coverage suppresses an unchanged repeat (FEEDBACK-061j).
    if (r.coverage !== 'COMPLETE') continue;
    if (!found || Date.parse(r.completedAt) > Date.parse(found.review.completedAt)) {
      found = { sessionHandle: s.sessionHandle, review: r, continuationAvailable: !active(s) && s.state === 'idle' && Boolean(s.threadId) };
    }
  }
  return found;
}

async function sweepExpiredSessions(dir: string): Promise<void> {
  try {
    for (const name of await fsp.readdir(dir)) {
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
