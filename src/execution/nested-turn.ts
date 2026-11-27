/**
 * Guard against recursive turns (`CUR-002`).
 *
 * @remarks
 * agy starts every MCP server of the user's agy configuration in its turns, so a CoAgent8
 * registered in agy would start another CoAgent8 that can start another backend turn, and
 * so on. Every backend turn runs with {@link NESTED_TURN_ENV} set; agy passes its environment
 * to the MCP servers it starts (measured with agy 1.3.1), so a CoAgent8 started inside a turn
 * sees the variable and refuses to run another one. Diagnostics and history stay available.
 * Codex and Claude turns start no inherited MCP server at all.
 *
 * @packageDocumentation
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from '../contracts/index.js';

/** Set in the environment of every backend turn this server starts. */
export const NESTED_TURN_ENV = 'COAGENT8_NESTED_TURN';

/**
 * CoAgent8 path overrides replaced in every backend turn (`#248`).
 * Removing them alone would fall back to `~/.coagent8`, so the server process creates one
 * disposable directory under `os.tmpdir()` lazily on the first turn and reuses it.
 */
export const TURN_ISOLATED_PATH_ENV_VARS = [
  'coagent8_DIR',
  'coagent8_CONFIG',
  'coagent8_QUOTA_CACHE',
  'coagent8_SESSIONS_DIR',
  'coagent8_SESSIONS',
  'coagent8_END_NOTES_DIR',
] as const;

/**
 * CoAgent8 path overrides stripped without replacement in every backend turn (`#248`).
 * Unlike data paths, removing them does not fall back to `~/.coagent8`.
 */
export const TURN_STRIPPED_PATH_ENV_VARS = ['coagent8_EXTENSION_PATHS'] as const;

const TURN_DIR_PREFIX = 'coagent8-turn-';
const TURN_DIR_PATTERN = /^coagent8-turn-(\d+)-/;
const STALE_TURN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TURN_ENV_KEYS_TO_STRIP = new Set<string>([
  NESTED_TURN_ENV.toLowerCase(),
  ...TURN_ISOLATED_PATH_ENV_VARS.map(name => name.toLowerCase()),
  ...TURN_STRIPPED_PATH_ENV_VARS.map(name => name.toLowerCase()),
]);

const createdTurnDirs = new Set<string>();
let sharedTurnDir: { tmpdir: string; dir: string } | undefined;
let stalePruned = false;
let exitCleanupRegistered = false;

function isPidDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // Only ESRCH confirms no live process owns that PID; EPERM means it is still running.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function pruneStaleTurnDirs(tmpdir: string, now = Date.now()): void {
  try {
    for (const entry of fs.readdirSync(tmpdir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(TURN_DIR_PREFIX)) continue;
      const match = TURN_DIR_PATTERN.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const candidate = path.join(tmpdir, entry.name);
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isDirectory() && now - stat.mtimeMs > STALE_TURN_DIR_MAX_AGE_MS && isPidDead(pid)) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup of stale directories left by earlier dead processes.
      }
    }
  } catch {
    // Failure to scan tmpdir must never block turn isolation.
  }
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    for (const dir of createdTurnDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort removal on exit; never throw from an exit listener.
      }
    }
  });
}

function getOrCreateTurnDir(): string {
  const tmpdir = os.tmpdir();
  if (sharedTurnDir && sharedTurnDir.tmpdir === tmpdir && fs.existsSync(sharedTurnDir.dir)) {
    return sharedTurnDir.dir;
  }
  if (!stalePruned) {
    stalePruned = true;
    pruneStaleTurnDirs(tmpdir);
  }
  // Embed the owning PID so another process never deletes a long-running live server's directory.
  const dir = fs.mkdtempSync(path.join(tmpdir, `${TURN_DIR_PREFIX}${process.pid}-`));
  sharedTurnDir = { tmpdir, dir };
  createdTurnDirs.add(dir);
  registerExitCleanup();
  return dir;
}

/**
 * Environment for a backend turn: the given one with {@link NESTED_TURN_ENV} set and
 * every CoAgent8 path variable pointed at a shared per-process disposable directory under
 * `os.tmpdir()` (created lazily on the first turn and removed best-effort on process exit).
 * Backend profile variables (`USERPROFILE`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) stay untouched.
 * @param base - Environment to extend; defaults to this process's.
 * @returns A fresh environment object isolated from the user's CoAgent8 paths.
 */
export function turnEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const turnDir = getOrCreateTurnDir();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // Strip case-insensitive matches so Windows child processes never inherit an alternate-case user path.
    if (!TURN_ENV_KEYS_TO_STRIP.has(key.toLowerCase())) {
      env[key] = value;
    }
  }
  env[NESTED_TURN_ENV] = '1';
  env.coagent8_DIR = turnDir;
  env.coagent8_CONFIG = path.join(turnDir, 'config.json');
  env.coagent8_QUOTA_CACHE = path.join(turnDir, 'quota-cache.json');
  env.coagent8_SESSIONS_DIR = path.join(turnDir, 'sessions');
  env.coagent8_SESSIONS = path.join(turnDir, 'sessions.json');
  env.coagent8_END_NOTES_DIR = path.join(turnDir, 'end-notes');
  return env;
}

/**
 * Refuses a turn when this server was started from inside a backend turn.
 * @throws `POLICY_DENIED` when {@link NESTED_TURN_ENV} is set in this process's environment.
 */
export function assertNotNestedTurn(env: NodeJS.ProcessEnv = process.env): void {
  if (env[NESTED_TURN_ENV] === '1') {
    throw new ToolError(
      'POLICY_DENIED',
      'CoAgent8 was started by a backend inside a CoAgent8 turn (a CoAgent8 registration in that CLI) and does not start another turn from there.',
    );
  }
}
