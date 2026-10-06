/**
 * Represents a persistent multi-turn agent conversation session.
 */
export interface SessionRecord {
  schemaVersion?: 2;
  state?: 'idle' | 'running' | 'invalidated' | 'closed';
  turnToken?: string | null;
  turnCount?: number;
  model?: string;
  cliVersion?: string;
  safetyProfile?: string;
  lastErrorCode?: string;
  /** Public session handle identifier. */
  sessionHandle: string;
  /** CLI backend used for this session ('codex' or 'claude'). */
  backend: string;
  /** CLI-native thread ID or conversation token for resuming turns. */
  threadId: string | null;
  /** Canonical workspace path bound to this session. */
  workspace: string;
  /** PID of the worker process currently executing an active turn. */
  activePid: number | null;
  /** Timestamp when the currently active turn started execution. */
  activeTurnAt: number | null;
  /** ISO timestamp when the session was created. */
  createdAt: string;
  /** ISO timestamp when the session was last accessed or updated. */
  lastUsedAt: string;
}

/**
 * Data stored in a filesystem lock file protecting active session turns.
 */
export interface SessionLockData {
  /** Unique token identifying turn ownership. */
  token: string;
  /** Process ID holding the lock. */
  pid: number;
  /** Timestamp when the lock was acquired. */
  time: number;
}

/**
 * Generic result wrapper for session operations.
 */
export interface SessionResult<T = void> {
  /** Whether the session operation succeeded. */
  ok: boolean;
  /** Error message if operation failed. */
  error?: string;
  /** Payload returned on success. */
  data?: T;
}

/**
 * Result of attempting to acquire exclusive turn ownership on a session.
 */
export interface AcquireSessionResult {
  /** Session record if successfully acquired. */
  session?: SessionRecord;
  /** Error message describing contention or validation failure. */
  error?: string;
}

/**
 * Query criteria for retrieving a session.
 */
export interface GetSessionOptions {
  /** Target backend filter. */
  backend?: string;
  /** Workspace directory filter. */
  workspace?: string;
}
