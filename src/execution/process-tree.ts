/**
 * Pure process tree resolution and Windows process identity management.
 *
 * @remarks
 * ## Process Identity Invariants (WINDOWS-001 / AUD-P0-1)
 * - Process identity is defined strictly as `(PID, creationTime)`.
 * - Windows FILETIME values are parsed into microseconds since the Unix epoch using
 *   lossless BigInt arithmetic to avoid exceeding `Number.MAX_SAFE_INTEGER`.
 * - Child processes are attributed to the most recent holder of their `ParentProcessId`
 *   created at or before the child's own creation time.
 * - Stale parent PIDs from recycled PIDs are safely rejected.
 * - Orphaned descendants of intermediate processes that have already exited are
 *   reliably discovered and attributed to their deceased ancestor.
 *
 * @packageDocumentation
 */

/**
 * Windows FILETIME epoch difference from Unix epoch (1601-01-01 to 1970-01-01) in 100-nanosecond intervals.
 */
const WINDOWS_TO_UNIX_EPOCH_100NS = 116444736000000000n;

/**
 * Represents a single process entry captured in a process snapshot.
 */
export interface ProcessRow {
  /** OS Process ID. */
  pid: number;
  /** Parent Process ID reported by the operating system. */
  ppid: number;
  /** Creation time in microseconds since Unix epoch. */
  created: number;
}

/**
 * Represents a known process identity tracked by the process supervisor.
 */
export interface KnownIdentity {
  /** OS Process ID. */
  pid: number;
  /** Creation time in microseconds since Unix epoch. */
  created: number;
  /**
   * First snapshot timestamp (in microseconds since Unix epoch) where this process
   * was observed to no longer be alive.
   */
  goneBy?: number;
}

/**
 * Normalizes a 64-bit Windows FILETIME decimal string into microseconds since the Unix epoch.
 *
 * @remarks
 * Standard JavaScript `Number` loses precision on 64-bit FILETIME values (~1.34e17 vs MAX_SAFE_INTEGER 9e15).
 * We perform the epoch shift and division by 10 (100ns to 1µs) using `BigInt` before converting to `number`.
 *
 * @param fileTimeString - String representing decimal FILETIME (100ns ticks since 1601-01-01).
 * @returns Microseconds since Unix epoch (safe integer until year 2255), or `null` if invalid.
 */
export function parseWindowsFileTime(fileTimeString: string): number | null {
  if (!fileTimeString) return null;
  const trimmed = fileTimeString.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  try {
    const raw = BigInt(trimmed);
    if (raw < WINDOWS_TO_UNIX_EPOCH_100NS) return null;
    const usSinceEpoch = (raw - WINDOWS_TO_UNIX_EPOCH_100NS) / 10n;
    const result = Number(usSinceEpoch);
    return Number.isSafeInteger(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Parses snapshot output emitted by the Windows PowerShell helper.
 *
 * @param output - Raw stdout from the PowerShell snapshot command.
 * @returns Parsed snapshot timestamp and collection of valid process rows.
 */
export function parseProcessSnapshot(output: string): { snapshotAt: number; rows: ProcessRow[] } {
  const rows: ProcessRow[] = [];
  let snapshotAt = Date.now() * 1000; // fallback in microseconds

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('# SNAPSHOT_AT ')) {
      const tsStr = line.slice('# SNAPSHOT_AT '.length).trim();
      const parsed = parseWindowsFileTime(tsStr);
      if (parsed !== null) {
        snapshotAt = parsed;
      }
      continue;
    }

    // Format: <pid> <ppid> <fileTime> or legacy/mock single <pid>
    const parts = line.split(/\s+/);
    if (parts.length === 1 && /^\d+$/.test(parts[0])) {
      const pid = parseInt(parts[0], 10);
      if (Number.isSafeInteger(pid) && pid > 4) {
        rows.push({ pid, ppid: 0, created: snapshotAt });
      }
      continue;
    }
    if (parts.length < 3) continue;

    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const created = parseWindowsFileTime(parts[2]);

    // Skip pseudo-processes (PID <= 4) and rows with unparsable timestamps
    if (!Number.isSafeInteger(pid) || pid <= 4 || !Number.isSafeInteger(ppid) || created === null) {
      continue;
    }

    rows.push({ pid, ppid, created });
  }

  return { snapshotAt, rows };
}

/**
 * Pure function that selects the owned descendant tree from a process snapshot.
 *
 * @remarks
 * ## Selection Rules (AUD-P0-1)
 * 1. Each row is attributed to the most recent holder of its `ppid` created at or before the row.
 * 2. If that holder is an unrelated process (PID reuser), the row is attributed to the reuser and rejected.
 * 3. If that holder is a dead known identity, the row must have been created before the snapshot
 *    where the ancestor was first observed missing (`goneBy`).
 * 4. The search starts from all known identities (both live and deceased ancestors), allowing
 *    orphaned grandchildren of exited intermediate processes to be discovered.
 * 5. Only currently live rows present in `rows` are returned in the final collection.
 *
 * @param rows - Current snapshot of live processes on the system.
 * @param known - All tracked process identities (active and deceased ancestors).
 * @param snapshotAt - Timestamp of the current snapshot in microseconds since Unix epoch.
 * @returns Array of live `ProcessRow` instances belonging to the owned tree.
 */
export function selectOwnedTree(
  rows: ProcessRow[],
  known: KnownIdentity[],
  snapshotAt: number
): ProcessRow[] {
  if (known.length === 0 || rows.length === 0) {
    return [];
  }

  const liveKey = new Set(rows.map(r => `${r.pid}:${r.created}`));

  // Index every holder of each PID: live snapshot rows plus recorded known ancestors that are now dead
  const holders = new Map<number, Array<{ created: number; goneBy?: number }>>();
  const addHolder = (pid: number, h: { created: number; goneBy?: number }) => {
    let list = holders.get(pid);
    if (!list) {
      list = [];
      holders.set(pid, list);
    }
    list.push(h);
  };

  for (const r of rows) {
    addHolder(r.pid, { created: r.created });
  }

  for (const k of known) {
    if (!liveKey.has(`${k.pid}:${k.created}`)) {
      const goneBy = k.created === 0 ? undefined : (k.goneBy ?? snapshotAt);
      addHolder(k.pid, { created: k.created, goneBy });
    }
  }

  // Find the authoritative parent identity for a given process row
  const parentOf = (r: ProcessRow): string | undefined => {
    const list = holders.get(r.ppid);
    if (!list || list.length === 0) return undefined;

    let best: { created: number; goneBy?: number } | undefined;
    for (const h of list) {
      // Must be created at or before child
      if (h.created <= r.created) {
        if (!best || h.created > best.created) {
          best = h;
        }
      }
    }

    if (!best) return undefined;
    // If the best parent is dead, child cannot have been created after parent disappeared
    if (best.goneBy !== undefined && r.created > best.goneBy) {
      return undefined;
    }

    return `${r.ppid}:${best.created}`;
  };

  const owned = new Set<string>(known.map(k => `${k.pid}:${k.created}`));
  const result = new Map<string, ProcessRow>();

  // Fixed-point traversal: tolerates arbitrary row ordering and cyclical PPID graphs
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) {
      const key = `${r.pid}:${r.created}`;
      if (r.pid <= 4 || result.has(key)) continue;

      const pKey = parentOf(r);
      if (owned.has(key) || (pKey && owned.has(pKey))) {
        owned.add(key);
        result.set(key, r);
        changed = true;
      }
    }
  }

  return Array.from(result.values());
}
