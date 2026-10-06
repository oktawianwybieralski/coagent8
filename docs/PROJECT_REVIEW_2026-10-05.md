# CoAgent project review — 2026-10-05

This document owns source findings and their evidence, each bound to the snapshot
it inspected. [ROADMAP.md](ROADMAP.md) owns the resulting work items, order and
acceptance; it references the `AUD-*` finding IDs defined here. A finding describes
its snapshot, not later trees, and a historical result is not fresh validation.

| Section | Snapshot | Status |
| --- | --- | --- |
| [Independent audit](#independent-audit-at-c265cdf) | `c265cdf` on `feat/routing-migrate-quota` | Current; verdict `BLOCKED` |
| [Product reassessment](#product-reassessment-at-2e87bc4) | `2e87bc4` | Superseded where the audit disagrees |

## Independent audit at c265cdf

**Date:** 2026-10-05. **Auditor:** Claude Code in the Reviewer role, at the owner's
request. **Snapshot:** `c265cdf` with a clean working tree.
**Verdict:** `BLOCKED` — 3 P0 and 11 P1 findings.

### Method and evidence boundaries

- Every file under `src/` (about 7,800 lines) was read, together with the VS Code
  extension, build scripts, CI workflow, manifests, contributor rules and plans.
  Tests were inspected for coverage of each finding.
- Findings marked **[reproduced]** were confirmed with small `tsx` probes that
  import the source modules and use temporary `coagent8_DIR` and
  `coagent8_QUOTA_CACHE` directories. No backend AI CLI was invoked.
- The Windows teardown code was **not** executed against the live desktop. Its
  hazard is established from source plus two read-only observations: the
  `taskkill` exit code for an impossible PID, and a CIM listing of processes whose
  parent PID is dead.
- Audit severity: **P0** — OS/process safety, data corruption or loss of the whole
  tool; **P1** — architectural flaw, error masking or contract violation;
  **P2** — robustness debt, duplication or over-engineering; **P3** — nits.
  Audit P0 and P1 correspond to State Envelope P1 and block release candidates under
  [03-author-reviewer](../.agents/rules/03-author-reviewer.md). The roadmap's
  [release sequence](ROADMAP.md#release-sequence) makes the order-1 findings (all
  P0 plus AUD-P1-1, AUD-P1-2, AUD-P1-3 and AUD-P1-10) a gate for the first beta.
  P2 items are scheduled before RC 1 unless the roadmap explicitly defers them.

### Executive assessment

- The product idea is sound and several foundations hold (see
  [what to keep](#what-to-keep)). The problem is not the number of layers. Around
  the simple operation "run a CLI read-only and return its answer", heuristics
  have accumulated that corrupt data or endanger the host:
  - Windows supervision identifies "descendants" by `ParentProcessId` alone and
    terminates them with `Stop-Process -Force`.
  - Secret redaction rewrites ordinary code in model answers.
  - The history archive grows quadratically and can disable every backend for
    up to seven days.
  - Error codes misreport causes; the default for an unknown failure is
    `INPUT_LIMIT`.
  - `QUOTA-001`, recorded as complete, does not work in production because the
    controller overwrites the parsed cooldown.
- Optional features can fail a successful execution: history persistence and
  session metadata updates convert a completed CLI answer into an error. The same
  controller already handles cooldown-cache failures correctly, as a warning
  ([controller.ts:221-226](../src/execution/controller.ts#L221-L226)).
- Process documentation (about 2,100 lines of rules, roadmap, review and handoff)
  outweighs verification. Several roadmap and handoff completion claims are false
  (see [corrected claims](#documentation-claims-corrected-by-this-audit)). Some
  tests cement defects: the test described as "O(1) appends" never measures size.
- The committed `dist/index.cjs` is two functional commits behind the source,
  and review diffs exclude `dist/**`. The code that runs is not the code reviewed.
- TypeScript integrity is not the main problem: there are three explicit `any`
  annotations. The problems are a stringly typed error protocol and 37 empty
  `catch {}` blocks.

### Findings summary (P0/P1)

| ID | Finding | Evidence |
| --- | --- | --- |
| AUD-P0-1 | Windows teardown identifies descendants by parent PID only and can terminate unrelated user processes; the sweep runs after **every** child exit | `taskkill` exit 128 observed; 21 stale-parent processes on the audit machine |
| AUD-P0-2 | Secret redaction rewrites code in public model answers | [reproduced] |
| AUD-P0-3 | Streamed answers grow history 50–110×; a successful turn becomes `HISTORY_ERROR`; above 100 MiB every new execution fails before the CLI starts | [reproduced] |
| AUD-P1-1 | Rate-limit cooldown is recorded twice; a parsed 3-day reset becomes 45 s | [reproduced] |
| AUD-P1-2 | Unknown errors are reported as `INPUT_LIMIT`; errors travel as string prefixes | source |
| AUD-P1-3 | A session-metadata write failure discards a successful answer | source |
| AUD-P1-4 | 3–5 extra subprocesses per call; each costs about 0.4 s of PowerShell on Windows | measured |
| AUD-P1-5 | Any new agy event type fails every Gemini call | source |
| AUD-P1-6 | `model` reaches CLI argv unvalidated | source |
| AUD-P1-7 | Top-tier model consent is a flag set by the calling agent | source |
| AUD-P1-8 | MCP resources bypass workspace isolation | source |
| AUD-P1-9 | An empty lease locks a resource forever; liveness is PID-only; session sweep deletes leases outside the token protocol | source |
| AUD-P1-10 | Committed `dist/` is stale and excluded from review | [reproduced] |
| AUD-P1-11 | Codex configuration is parsed with a regex that matches commented lines | [reproduced] |

### P0 findings

#### AUD-P0-1 Windows teardown can terminate unrelated processes

1. **How descendants are found.** The breadth-first searches in both PowerShell
   scripts ([process.ts:185](../src/execution/process.ts#L185),
   [process.ts:362](../src/execution/process.ts#L362)) treat every process with
   `ParentProcessId == curr` as a child.
   - Windows does not clear `ParentProcessId` when a parent exits, and PIDs are
     reused.
   - If a CoAgent child receives the PID of a long-dead process, every orphan of
     that dead process becomes its "descendant".
   - The tracking poll records them, and the fallback sweep runs
     `Stop-Process -Force` on them ([process.ts:378](../src/execution/process.ts#L378)).
2. **The sweep runs after practically every child.** On the `exit` event
   ([process.ts:556](../src/execution/process.ts#L556)) the supervisor runs
   `taskkill /PID <dead pid> /T /F`. For a PID that no longer exists, `taskkill`
   returns **128** (observed). `code !== 0` then starts the CIM fallback
   ([process.ts:417](../src/execution/process.ts#L417)). This happens after every
   `--version` probe and every `git diff`.
3. **Real candidates exist.** The audit machine had 21 processes whose parent PID
   was dead, including `nextcloud.exe`, `Focusrite Notifier.exe`,
   `RtkAudUService64.exe` and `SecurityHealthSystray.exe` (all with PPID 10224).
   None is on the name denylist. `explorer.exe` is the textbook stale-parent orphan
   because its parent, `userinit.exe`, exits at logon. Commit `ab04a59` starts its
   denylist with `explorer`, which is consistent with this mechanism.
4. **The name denylist treats the symptom**
   ([process.ts:177](../src/execution/process.ts#L177),
   [process.ts:353](../src/execution/process.ts#L353)). It does not protect any
   user application.
5. **Scope.** The same tracker and sweep run in the test runner
   ([tests/run.cjs](../tests/run.cjs)) and the MCP test harness
   ([tests/helpers/stdio.cjs](../tests/helpers/stdio.cjs)), so running the suite
   on a developer desktop has the same exposure.
6. **Unverified part.** Whether `taskkill /T` itself validates creation time was
   not checked. If it does not, the timeout and cancel paths share the hazard.

Proposed fix: process identity is the pair (PID, creation time), never a PID alone.
Move tree selection out of PowerShell strings into a pure, unit-testable
TypeScript function. PowerShell only emits a snapshot.

```ts
// before: process.ts — descendants keyed by PID; PowerShell decides what to kill
export const trackedDescendants = new Map<ChildProcess, Set<number>>();
// PS: if ($p.ParentProcessId -eq $curr) { enqueue; later Stop-Process -Force }

// after: snapshot rows come from
//   Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }
interface ProcessRow { pid: number; ppid: number; created: number }
interface ProcessIdentity { pid: number; created: number }
export const trackedDescendants = new Map<ChildProcess, Map<number, number>>(); // pid -> created

/** Roots: the child (identity captured while alive) plus previously verified descendants. */
export function selectOwnedTree(rows: ProcessRow[], roots: ProcessIdentity[]): ProcessIdentity[] {
  const live = (id: ProcessIdentity) => rows.some(row => row.pid === id.pid && row.created === id.created);
  const queue = roots.filter(live);
  const owned = new Map(queue.map(id => [id.pid, id] as const));
  while (queue.length) {
    const parent = queue.shift() as ProcessIdentity;
    for (const row of rows) {
      // A child created before its "parent" is a stale-PPID orphan, not ours.
      if (row.ppid !== parent.pid || row.created < parent.created || owned.has(row.pid)) continue;
      const child = { pid: row.pid, created: row.created };
      owned.set(child.pid, child);
      queue.push(child);
    }
  }
  return [...owned.values()];
}
```

- **Capturing the root.** Record the root's creation time at the first snapshot,
  and accept it only if it is not earlier than the spawn time minus a small clock
  allowance.
- **Clean exits.** When the root exited cleanly and no descendant was ever
  observed, skip the sweep entirely:
  `if (code === 128 && !trackedDescendants.get(proc)?.size) return finish();`
- **Killing.** Kill each verified identity individually (`taskkill /PID <pid> /F`
  without `/T`) after re-checking its creation time. A residual check-to-kill
  window of milliseconds remains.
- **Target.** A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` removes
  polling, the residual window and orphans after a server crash. This is the
  demonstrated need that `WINDOWS-001` required before evaluating Job Objects.
- **Regression test.** A synthetic snapshot in which an unrelated process has
  `ppid == root pid` but was created before the root must not be selected. Do not
  validate the sweep against a live desktop.

#### AUD-P0-2 Redaction rewrites code in public answers [reproduced]

| Input in a model answer | Returned text |
| --- | --- |
| `const token = getToken(req);` | `const token = ***[REDACTED]***` |
| `interface User { password: string; secret: Buffer }` | `interface User { password: ***[REDACTED]*** secret: ***[REDACTED]*** }` |
| `max_token = 4096` | `max_token = ***[REDACTED]***` |
| `const auth = useAuth();` | `const auth = ***[REDACTED]***` |

- **Where.** The keyword=value rules in
  [redaction.ts:24-31](../src/redaction.ts#L24-L31) are applied to the public
  answer at [controller.ts:188](../src/execution/controller.ts#L188) and
  [common.ts:295](../src/tools/common.ts#L295), and to stored history at
  [history.ts:82](../src/sessions/history.ts#L82).
- **Impact.** For a code-consultation tool this silently corrupts the main
  product. A host agent can receive mangled code and apply it.

Proposed fix: separate output redaction from diagnostic redaction.

```ts
// before
output: protocolTrusted ? redactSecrets(raw.output || '') : ''
// after: public answers keep their content; only high-confidence credential formats
// (sk-…, ghp_…, github_pat_…, AKIA…, PEM private keys, Bearer tokens) are replaced
output: protocolTrusted ? redactCredentialFormats(raw.output || '') : ''
// keyword=value rules (token=, password:, auth=) move into redactDiagnostic(),
// which handles stderr, error messages, doctor output and issue reports
```

Regression: the four inputs above must round-trip unchanged, while a real `sk-…`
key inside an answer is still replaced.

#### AUD-P0-3 The history archive disables the tool [reproduced]

- **Quadratic growth.** For every delta, `accept()` builds a snapshot of the whole
  message so far ([history.ts:414-419](../src/sessions/history.ts#L414-L419)). The
  250 ms flush ([controller.ts:177](../src/execution/controller.ts#L177)) appends
  that full snapshot to the JSONL log.
- **Measurements** (40-byte deltas, one flush per 250 ms):

  | Answer | Stream duration | JSONL size | Result |
  | --- | --- | --- | --- |
  | 20 KiB | 30 s | 1.05 MiB (54×) | stored |
  | 60 KiB | 60 s | 6.55 MiB (112×) | stored |
  | 120 KiB | 90 s | 10.00 MiB | `History session limit reached.` |

  In the last case the controller returns a successful Gemini answer as
  `HISTORY_ERROR` ([controller.ts:213-214](../src/execution/controller.ts#L213-L214)).
- **Whole-tool lockout.** With about 105 MiB of history younger than seven days,
  the first flush of a **new** session fails with `History total limit reached.`
  (reproduced). That flush is the first statement in the controller's `try`
  block, before the CLI is launched
  ([controller.ts:169](../src/execution/controller.ts#L169)). Every call to every
  backend then ends in `PROCESS_ERROR`, with a "report on GitHub" link, until the
  files are older than seven days.
- **Tests cement it.** [v1_phase2.test.js:289](../tests/v1_phase2.test.js#L289)
  states ".jsonl MUST have grown with O(1) appends" but only checks
  `includes('delta-5')`.

Proposed fix:

```ts
// before (history.ts): queue a full redacted snapshot of the accumulated text per delta
const text = (assembled.get(id) || '') + event.text; /* … */
pending.push({ type: 'assistant_message', messageId: id, text: redactSecrets(bounded) });
// after: append only the delta; load() concatenates deltas per messageId and a final
// assistant_message replaces them; materialize the .json snapshot once, on turn_finished
if (event.type === 'assistant_delta') { pending.push(sanitize(event)); return; }
```
```ts
// before (controller.ts:213): archive and lease failures share HISTORY_ERROR
if ((historyError || !released.ok) && !aborted) result = { ...result, isError: true, status: 'failed', error: { code: 'HISTORY_ERROR', /* … */ } };
// after: the lease fails closed, the archive is best-effort
if (!released.ok) result = { ...result, isError: true, status: 'failed', error: { code: 'SESSION_INVALID', /* … */ } };
if (historyError) warnings.push(`History not saved: ${redactDiagnostic(historyError.message, 512)}`);
// the initial flush must not throw: await writer.flush().catch(error => { historyError = error; });
// capacity: evict the oldest sessions (LRU) instead of refusing every new turn
```

Regression: persisted bytes for a streamed answer stay within a small constant
factor of the answer size, and a full archive never prevents a CLI launch.

### P1 findings

#### AUD-P1-1 Cooldown recorded twice [reproduced]

- **Where.** [controller.ts:193](../src/execution/controller.ts#L193) records the
  parsed reset, then [controller.ts:222](../src/execution/controller.ts#L222)
  records it again without a duration.
- **Effect.** The second call takes the next backoff tier.
- **Measured.** `"…try again in 3 days."` yields 4,320 minutes after the first
  call and **0.7 minutes** after the second.
- **Test gap.** Tests call `checkAndRecordRateLimit` directly and never exercise
  the controller sequence.

```ts
// after: one owner, one write; remove checkAndRecordRateLimit from both try and catch
if (result.error?.code === 'RATE_LIMITED') {
  const reset = parseResetTimestamp(result.error.message);
  await recordQuotaCooldown(backend.id, reset?.cooldownMs, result.error.message);
} else if (result.status === 'completed') await resetQuotaCooldown(backend.id);
```

#### AUD-P1-2 Error codes misreport causes

- **Default code.** [server.ts:311](../src/server.ts#L311) reports any exception
  without a known `CODE:` prefix as `INPUT_LIMIT`.
- **First-run example.** `ONBOARDING_REQUIRED` is not in `ERROR_CODES`, so every
  user with two or more CLIs and no configured default receives `INPUT_LIMIT`.
- **Other examples.** "All permitted providers have observed rate limits" (should
  be `RATE_LIMITED`), lock timeouts and `ENOENT` get the same treatment.

```ts
// before
throw new Error('SESSION_INVALID: A session cannot switch provider.');
const code = ERROR_CODES.find(c => message.startsWith(c + ':')) || 'INPUT_LIMIT';
// after
export class ToolError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly retryable = false) { super(message); }
}
throw new ToolError('SESSION_INVALID', 'A session cannot switch provider.');
const code = err instanceof ToolError ? err.code : 'PROCESS_ERROR';
```

#### AUD-P1-3 A metadata failure discards a successful answer

- **Where.** `updateSession` ([controller.ts:189](../src/execution/controller.ts#L189))
  runs inside the same `try` as the CLI call.
- **Effect.** If it throws (for example a 5 s lock timeout), the `catch`
  ([controller.ts:198](../src/execution/controller.ts#L198)) replaces the result
  with `output: ''`.
- **Fix.** Move post-processing out of the `try`. A failure becomes a warning with
  `continuationAvailable: false`.

#### AUD-P1-4 Subprocess churn contradicts the quiet-Windows priority

- **Probes on every request.** Routing probes on every call
  ([routing.ts:15](../src/backends/routing.ts#L15)).
  - Gemini: `--version` plus `/usage` — a network call made **without**
    `--sandbox` ([gemini.adapter.ts:119](../src/backends/gemini.adapter.ts#L119)) —
    and `execute` repeats `--version`
    ([gemini.adapter.ts:209](../src/backends/gemini.adapter.ts#L209)).
  - Claude: `--version` plus `--bare --help`, and `execute` repeats
    `--bare --help` ([claude.adapter.ts:19](../src/backends/claude.adapter.ts#L19),
    [claude.adapter.ts:35](../src/backends/claude.adapter.ts#L35)).
  - Review adds four or five `git` processes.
- **Cost per process on Windows.** Each one costs `taskkill` plus a hidden
  `powershell.exe` CIM query, and `close` awaits them before resolving
  ([process.ts:565](../src/execution/process.ts#L565)). One CIM helper launch
  measured about 400 ms.
- **Polling.** Each live child is polled every 500 ms
  ([process.ts:258](../src/execution/process.ts#L258)), so a 10-minute Codex run
  launches PowerShell on the order of a thousand times.
- **The `/usage` result is unused for routing.** An explicit backend ignores it,
  and `selectSmartQuotaBackend` ignores headroom
  ([availability.ts:176](../src/backends/availability.ts#L176)). The handoff
  claimed "proactive headroom scoring"; [config.test.js:128](../tests/config.test.js#L128)
  asserts the opposite: Gemini with 90% headroom loses to Codex.
- **Fix.**
  - Cache probe evidence per backend, keyed by resolved path and mtime, with a TTL.
  - No probes inside `execute`.
  - `/usage` only in `doctor`.
  - No tracker for short commands such as `--version` and `git`.
  - No sweep after a clean exit with nothing observed.

#### AUD-P1-5 Gemini parser fails on unknown event types

- **Where.** [gemini.collector.ts:254](../src/backends/gemini.collector.ts#L254)
  throws for an unknown event type.
- **Effect.** Any agy release that adds an event type turns every Gemini call into
  `PROTOCOL_ERROR`. The Codex collector already ignores unknown types.
- **Fix.** Ignore unknown types and emit a warning; fail only on invalid known
  events.

#### AUD-P1-6 Unvalidated model in argv

- **Where.** `-m model` / `--model model` reaches argv unvalidated
  ([codex.adapter.ts:153](../src/backends/codex.adapter.ts#L153),
  [gemini.adapter.ts:222](../src/backends/gemini.adapter.ts#L222),
  [claude.adapter.ts:43](../src/backends/claude.adapter.ts#L43)).
- **Inconsistency.** The Codex thread ID is checked for a leading `-`
  ([codex.adapter.ts:148](../src/backends/codex.adapter.ts#L148)); the model is
  not.
- **Risk.** The value comes from a calling agent, which is a prompt-injection
  surface. Whether a value such as `--yolo` becomes a flag depends on each CLI's
  parser. agy's parser was not verified, so this is defense in depth.
- **Fix.** Validate the identifier in the schema with
  `pattern: '^[A-Za-z0-9][A-Za-z0-9._:/\\[\\]-]{0,127}$'`, and repeat the check in
  each adapter.

#### AUD-P1-7 Consent is an agent assertion

- **Where.** `user_confirmed: true` is a boolean set by the calling model
  ([policy.ts:14](../src/backends/policy.ts#L14)). The server cannot distinguish a
  user decision from a fabricated one.
- **Gap.** The default Gemini model (no `model` argument) is not governed at all.
- **Fix.** MCP provides `elicitation/create` for exactly this. When the client
  supports elicitation, ask the user. Otherwise fail with `POLICY_DENIED` and
  instructions.

#### AUD-P1-8 MCP resources bypass workspace isolation

- **Where.** `coagent8://sessions` lists the sessions of every workspace.
  `ReadResource` returns the full history of any handle without a workspace check
  ([server.ts:254](../src/server.ts#L254)).
- **Contradiction.** The `session` tool enforces workspace ownership, so one of
  the two contracts is false.
- **Fix.** Either scope resources to the server's roots or document resources as
  an intentional, cross-workspace owner view.

#### AUD-P1-9 Lease integrity

- **Empty lease.** A crash between `open('wx')` and `writeFile`
  ([lock.ts:130-131](../src/sessions/lock.ts#L130-L131)) leaves an empty lease
  that is never reclaimed, because an unparsable owner skips reclamation
  ([lock.ts:145](../src/sessions/lock.ts#L145)). For `history/store` that blocks
  every execution.
- **PID-only liveness.** Owner liveness is checked by PID alone, so a reused PID
  keeps a stale lease alive.
- **Sweep race.** `sweepExpiredSessions` deletes `.lease` files outside the token
  protocol ([session.ts:243-248](../src/sessions/session.ts#L243-L248)). It can read
  an old lease and delete a newer one.
- **Fix.**
  - Write leases atomically (temporary file, then link or rename).
  - Treat an empty or unreadable lease older than a bounded age as stale, and add
    a maximum age based on `createdAt`.
  - Remove lease deletion from the session sweep; `withFileLock` already reclaims.

#### AUD-P1-10 Stale committed bundle [reproduced]

- **Stale contents.** `dist/index.cjs` last changed in `58b7df5`. It lacks
  `-WindowStyle Hidden`, the process denylist and the Gemini quota parser:
  `grep` finds 0 occurrences there versus 1 in a fresh build of the same source.
- **What depends on it.** It is what `index.js`, `mcp.json`
  (`${PLUGIN_ROOT}/dist/index.cjs`) and `package.json` `bin` execute.
- **Review gap.** Review diffs exclude `dist/**`
  ([git.ts:14](../src/execution/git.ts#L14)).
- **Fix.** Remove `dist/` from Git and build it in `prepack` and CI. Distribute
  plugins from the built tarball.

#### AUD-P1-11 Codex configuration parsed with a regex [reproduced]

- **Where.** [codex.adapter.ts:45](../src/backends/codex.adapter.ts#L45) takes
  `# model = "o3"` from a comment as the default model, so every call passes
  `-m o3`. The same regex also matches `review_model = …`.
- **Fix.** `smol-toml` is already a dependency. Parse the top-level `model` key
  with it, or omit `-m` when the caller did not request a model and govern the
  model the CLI reports.

### P2 findings — debt and over-engineering

| ID | Finding | Location | Proposed direction |
| --- | --- | --- | --- |
| AUD-P2-1 | Heuristic classification [reproduced]: `"line 429"` → `RATE_LIMITED`; `"author field"` → `AUTH_REQUIRED`; `"disk quota check"` → `RATE_LIMITED`; `"try again in 20ms"` → 20 minutes; `"1.5s"` not parsed. `smart_quota` then avoids a healthy backend | [codex-errors.ts:6](../src/backends/codex-errors.ts#L6), [rate-limit.ts:66](../src/backends/rate-limit.ts#L66) | Classify structured payloads; for stderr use anchored provider phrases; parse `ms` before `m` and decimals |
| AUD-P2-2 | Fabricated data: `"Task completed cleanly with no textual output."` returned and stored as the model's answer; missing `remaining_fraction` treated as 100% headroom; Codex `authStatus: 'authenticated'` from file presence | [stream-reducer.ts:358](../src/execution/stream-reducer.ts#L358), [gemini.adapter.ts:48](../src/backends/gemini.adapter.ts#L48), [codex.adapter.ts:90](../src/backends/codex.adapter.ts#L90) | Empty stays empty; missing data is `null`; file presence is unverified evidence |
| AUD-P2-3 | Test hooks in production: a 5 s busy-wait and a file write to an environment-supplied path (`coagent8_MAINTENANCE_GATE`), plus `coagent8_MAINTENANCE_DELAY_MS` | [session.ts:222-240](../src/sessions/session.ts#L222-L240) | Remove; inject the maintenance dependency in tests |
| AUD-P2-4 | Duplication: two error extractors are about 90% copies with dead `codeVal`/`typeVal`; deprecated alias mapping exists twice (three `*.tool.ts` files and `run`); arguments are validated three times | [codex-errors.ts:17-18](../src/backends/codex-errors.ts#L17-L18), [run.tool.ts:130-173](../src/tools/run.tool.ts#L130-L173) | One parameterized extractor; aliases as one table; validate once at the server boundary |
| AUD-P2-5 | Gemini has a second timeout around `runCommand`'s own timeout | [gemini.adapter.ts:289](../src/backends/gemini.adapter.ts#L289) | Keep only the `runCommand` deadline |
| AUD-P2-6 | Dead code: half of `StreamReducer` (`pushChunk`, `recordActivity`, `recordError`, `recordFallbackLine`); `killProcessSafely` ("for the adapter being migrated by the other author", no callers); `getProgressStage`; `getToolProfile`; `CONFIG_FILE`; `DEFAULT_CONFIG_DIR`; `resolveCodexCommand`; `SessionLockData`; a check for a truncation string `runCommand` never produces | [process.ts:438](../src/execution/process.ts#L438), [git.ts:57](../src/execution/git.ts#L57) | Delete; move remaining test-only behavior into tests |
| AUD-P2-7 | 37 empty `catch {}` blocks; `ensureConfigDir` still swallows errors (`ERRORS-001`) | [config.ts:39](../src/config.ts#L39) | Review individually; distinguish absence from I/O failure |
| AUD-P2-8 | Contract fiction: `doctor` advertises `repair` and `workspace_path` but ignores them; `resources.listChanged: true` is never emitted; doctor hardcodes `read_only_sandbox_guard: true` | [doctor.tool.ts:12](../src/tools/doctor.tool.ts#L12), [server.ts:199](../src/server.ts#L199) | Remove from the contract or implement |
| AUD-P2-9 | No MCP roots: without `workspace_path` the CLI runs in the server's working directory (Codex also with `--skip-git-repo-check`) | [policy.ts](../src/backends/policy.ts) | Use `roots/list` or require `workspace_path` |
| AUD-P2-10 | The installer (375 lines plus RPC, TOML and JSONC parsers) is bundled into the core server; any argument other than `setup`, `repair` or `status` exits the server with code 1 | [setup-cli.ts](../src/integrations/setup-cli.ts) | Separate entrypoint and bundle |
| AUD-P2-11 | A malformed `config.json` makes `tools/list` throw, hiding every tool (contradicts `MCP-001`) | [config.ts](../src/config.ts) | Fall back to defaults with a visible warning |
| AUD-P2-12 | One global `history/store` lock plus an atomic `.capacity.meta` rewrite every 250 ms per active execution | [history.ts:426](../src/sessions/history.ts#L426) | Per-session lock; compute capacity lazily |
| AUD-P2-13 | Redaction gaps: `gho_`, `ghu_`, `ghs_`, `glpat-`, `ya29.`, bare JWT `eyJ…`, `sk_live_`, `npm_`, `hf_` | [redaction.ts](../src/redaction.ts) | Add formats to the credential-format list |
| AUD-P2-14 | Orphans after a server crash: POSIX `detached: true` and no Windows Job Object. The stdin-EOF and SIGTERM paths are handled | [process.ts](../src/execution/process.ts) | Job Object (Windows); parent-death handling (POSIX) |
| AUD-P2-15 | CI runs the full suite twice per job; about 2,100 lines of process documentation with false completion marks | [ci.yml](../.github/workflows/ci.yml) | Coverage once; short status and changelog |

### P3 findings

- `.filter(l => l.length > 0 || l === '')` is a no-op
  ([common.ts:228](../src/tools/common.ts#L228)).
- `formatExecutionResult` is `async` without `await`
  ([common.ts:268](../src/tools/common.ts#L268)).
- Progress messages are redacted three times.
- `stripCliBanners` runs on text extracted from JSON events and can drop a
  legitimate answer line starting with `npm notice`.
- Tool descriptions still name `claude-3-opus`.
- `cancel` returns `cancelled: true` even when nothing was running.
- `session list` returns absolute workspace paths without home redaction.

### Coverage of the audit mandate

| Area | Result |
| --- | --- |
| Architecture | Request path is not over-layered; the cost lies in mandatory side mechanisms: probes, archive, supervision polling and envelope parsing (AUD-P1-4, AUD-P0-3, AUD-P2-10) |
| Spaghetti and duplication | `process.ts` embeds two PowerShell programs as strings; `controller.ts` mixes execution, archive and cooldown ownership; error extractors and alias mappings are duplicated (AUD-P2-4) |
| TypeScript integrity | Three explicit `any` (`parseGeminiUsage`); handlers receive values narrowed by a custom schema validator; no `as any` found |
| Error handling | Error masking (AUD-P1-2), discarded output (AUD-P1-3), archive failures failing turns (AUD-P0-3), 37 empty catches (AUD-P2-7) |
| Windows windows and focus | Source spawns use `windowsHide` and `-WindowStyle Hidden`; the committed bundle does not (AUD-P1-10) |
| Process safety and orphans | AUD-P0-1; orphans after a server crash (AUD-P2-14); normal EOF and SIGTERM shutdown are handled |
| Buffer bounds | stdout/stderr 512 KiB, line 512 KiB, prompt 4 MiB, public output 1 MiB are enforced. Remaining costs: `collect()` re-truncates the whole buffer per chunk (CPU) and the torn-tail check reads the whole log |
| Concurrency and locks | AUD-P1-9; global store lock contention (AUD-P2-12) |
| Sandboxing and security | Read-only flags hold on the execution path; the agy `/usage` probe runs without `--sandbox` (AUD-P1-4); argv validation (AUD-P1-6); consent (AUD-P1-7); redaction corrupts output (AUD-P0-2) and has gaps (AUD-P2-13) |

### What to keep

- Resolution of npm shims to `node <entry.js>` without `cmd.exe`, which avoids the
  BatBadBut class of Windows argument-injection issues.
- UTF-8-safe byte truncation, the bounded line decoder and the input limits.
- Codex sandbox flags placed before `resume`; Claude
  `--bare --tools Read,Glob,Grep --strict-mcp-config`.
- Atomic writes through a temporary file and rename.
- History pagination with revision-bound cursors.

### Simplification and deletion plan

1. **Delete:**
   - the three deprecated `*.tool.ts` files (keep aliases as a ten-line table);
   - dead exports and the unused half of `StreamReducer`;
   - production test hooks;
   - `dist/` from Git;
   - regex TOML parsing;
   - banner stripping for JSON-backed adapters.
2. **Process supervision:** (PID, creation time) identity, no sweep after a clean
   exit, polling only for long-running tasks. Target a Job Object.
3. **Probes:** one cached probe per backend, no probes inside `execute`, `/usage`
   only in `doctor`.
4. **History:** append-only deltas and best-effort persistence with warnings and
   LRU eviction. `session_mode: "none"` becomes the default for `consult`.
5. **Errors:** a typed `ToolError` everywhere and no prefix parsing.
6. **Redaction:** separate public-answer redaction (credential formats only) from
   diagnostic redaction.
7. **Consent:** MCP elicitation instead of the `user_confirmed` flag.
8. **Setup and VSIX:** a separate bundle; the core server without TOML or JSONC.
9. **Documentation:** no completion mark without a reference to evidence that
   measures it.

### Documentation claims corrected by this audit

| Claim | Location before consolidation | Reality at `c265cdf` |
| --- | --- | --- |
| Teardown sweeps "never target system processes or desktop shell under any circumstances" | `HANDOFF.md` | Only listed names are protected; identity is never validated (AUD-P0-1) |
| `smart_quota` "combines proactive headroom scoring (Gemini)" | `HANDOFF.md` | Headroom is ignored; a test asserts the opposite (AUD-P1-4) |
| Parsed reset timestamps record precise cooldowns | `ROADMAP.md`, `QUOTA-001` | Overwritten by the second write (AUD-P1-1) |
| Misleading synthetic telemetry removed | `ROADMAP.md`, `QUOTA-001` | Fabricated headroom and answers remain (AUD-P2-2) |
| Authentication evidence is explicitly unverified | `ROADMAP.md`, `DIAGNOSTICS-001`; `RUNTIME_CONTRACT.md` | Codex reports `authenticated` from file presence (AUD-P2-2) |
| `CimMutex` and `taskkill` "achieve zero orphan leaks" | `ROADMAP.md`, `WINDOWS-001` | Crash orphans remain; teardown identity is unsafe (AUD-P0-1, AUD-P2-14) |
| `consult` requires an audit envelope; plain consult is planned | `README.md`, `ARCHITECTURE.md`, `RUNTIME_CONTRACT.md` | Implemented in `CONSULT-001`: consult returns `verdict: "NOT_APPLICABLE"` |
| Startup prunes sessions before connecting | `ARCHITECTURE.md` | Pruning runs in the background after connect (`STARTUP-001`) |
| `tests/run.cjs` always appends the full inventory | `04-quality-gate.md` | Positional files select only those files (`VERIFY-SCOPE-001`) |
| Repository link `github.com/nyupyu/coagent8` | `README.md` | `oktawianwybieralski/coagent8` |

### Verdict

**VERDICT: BLOCKED.** Minimum to unblock: AUD-P0-1, AUD-P0-2, AUD-P0-3, AUD-P1-1,
AUD-P1-2, AUD-P1-3 and AUD-P1-10, each with a regression test derived from the
reproduction above. Work items and acceptance are in the
[roadmap](ROADMAP.md#audit-remediation-index).

## Product reassessment at 2e87bc4

**Inspected snapshot:** `2e87bc4` plus the existing README title edit.
**Method:** Read-only source/document inspection; no runtime tests, backend AI
calls, desktop reproduction or performance measurements in this reassessment.
The user subsequently requested integration of these conclusions into the plan
and consolidation of documentation. [ROADMAP.md](ROADMAP.md) owns the resulting
priorities and acceptance criteria. Where this section disagrees with the
[independent audit](#independent-audit-at-c265cdf), the audit supersedes it.

The core is a useful MCP-to-CLI bridge. The avoidable complexity is the mandatory
path through advisory audit formatting, archival storage and repeated probes,
combined with installer-first product assumptions and blanket verification rules.
Preserve process safety and privacy while making these responsibilities explicit.

| Finding | Source evidence | Consequence / roadmap item |
| --- | --- | --- |
| Generic clients are not rejected by name | [server.ts](../src/server.ts) handles tools/list without client-name checks; [setup.ts](../src/integrations/setup.ts) limits only automatic registration targets | Distinguish installer support from protocol compatibility (`MCP-001`). No real Continue UI connection was verified. |
| Windows tests can create visible descendants | [v1_phase1.test.js](../tests/v1_phase1.test.js) uses nested Start-Process without WindowStyle Hidden and execSync probes without windowsHide | Strong source explanation for reported windows, not a reproduced focus-stealing incident (`WINDOWS-001`). |
| Process supervision is duplicated | [process.ts](../src/execution/process.ts) polls CIM through PowerShell with recurring 500 ms opportunities and an in-flight guard; [run.cjs](../tests/run.cjs) and the [MCP helper](../tests/helpers/stdio.cjs) also create trackers | Hidden helpers still have launch/scan cost; measure and consolidate ownership without losing teardown guarantees (`WINDOWS-001`). |
| Local rules required a full gate for any push/PR | Earlier quality-gate text had no prose-only exception; [CI](../.github/workflows/ci.yml) runs npm test and then the coverage suite on all six jobs | Scope local checks by risk and separately implement CI/runner selection (`VERIFY-SCOPE-001`). Rules are revised by this consolidation; CI is unchanged. |
| Focused runner file selection is missing | [run.cjs](../tests/run.cjs) appends discoverTests() after caller arguments | Passing a file does not replace the full inventory; implement explicit selection rather than repeat all tests. |
| Advice is forced into release-style reporting | [consult.tool.ts](../src/tools/consult.tool.ts) requires SNAPSHOT/COVERAGE/VERDICT/CHECKS; [common.ts](../src/tools/common.ts) checks envelope text | A normal question should not require an audit report or imply checks ran (`CONSULT-001`). |
| Archive persistence is on every execution path | [controller.ts](../src/execution/controller.ts) creates and flushes history and can return HISTORY_ERROR after successful backend execution | Separate optional archive failures from ownership/lease safety (`HISTORY-002`). |
| Capability probes repeat before work | [routing.ts](../src/backends/routing.ts) probes the adapter; [claude.adapter.ts](../src/backends/claude.adapter.ts) checks bare help in both probe and execution | Deduplicate with bounded, correctly invalidated capability evidence (`EXEC-001`). |
| Installer correctness has become a broad product obligation | [setup.ts](../src/integrations/setup.ts) owns native checks, configuration parsing, runtime copies and rollback | Keep safeguards in optional setup; do not require more installer adapters for ordinary MCP use (`INSTALL-001`). |

Continue documents stdio registration and Agent-mode MCP use in its
[MCP guide](https://docs.continue.dev/customize/deep-dives/mcp). The
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
defines discovery through tools/list, not a mandatory host-brand integration.
Microsoft documents the new-window default and WindowStyle for
[Start-Process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-7.5).
[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
are a candidate for supervision, subject to sandbox/nested-job compatibility and
native distribution costs; they are not an implemented fix or an approved dependency.

The earlier review at `4b2c72b` treated
selected-host installation and durable history as core requirements. Those product
assumptions and the installation-first work order are superseded. Historical
incident evidence, failed-run records and registration-preservation requirements
remain relevant. Completed fixes and outstanding verification are summarized in the
roadmap; do not rerun old work merely because a historical finding still appears.
