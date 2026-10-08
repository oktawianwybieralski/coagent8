# CoAgent8 runtime contract

**Implementation baseline:** `24052e3`, inspected on 2026-10-07, plus the
working-tree corrections to documentation and two parameter descriptions.
**Package label:** `1.0.0-beta.2`; not an accepted tester release.
This document describes current source behavior. Normative security requirements
remain in the [security rule](../.agents/rules/01-security-and-sandboxes.md);
implementation deviations are explicit in [section 7](#7-known-limitations-and-deviations).
[ROADMAP.md](ROADMAP.md) owns proposals and acceptance.

The owner-approved [full coagent direction](ROADMAP.md#full-coagent-direction)
(2026-10-08) adds planned write/execute profiles, configurable roles and client
skills. None of those capabilities is established by this runtime contract;
existing consultation, review and legacy alias behavior remains the baseline.

The CLI onboarding follow-up on `fix/vsix-presentation` isolates recognized setup
commands in `dist/setup.cjs`; no-argument invocation and unknown host arguments
start MCP. Shared executable discovery prefers overrides, PATH, then Codex/Claude
extension binaries. VS Code supplies fresh actual extension paths through
`coagent8_EXTENSION_PATHS`, without persisting vendor executable version paths.
These discovery changes do not relax per-turn sandbox or model-consent checks.
Optional registration/cleanup contracts and their pending native acceptance are
owned by the [integration guide](VSCODE_INTEGRATION.md).

## 1. Controller and tool surface

All clients receive `consult`, `review`, `doctor`, `session`, `cancel` and `issue`.
The deprecated `analyze`, `debug` and `implement` aliases and legacy `run`
gateway remain callable without appearing in `tools/list`. `run` accepts
`consult`, `review`, `issue` and the deprecated action aliases. `toolProfile`
is ignored.

| Tool | Inputs and behavior |
| --- | --- |
| `consult` | Required nonempty `proposal`; optional `task_type` (`architecture`, `debug`, `implementation`), `context_files`/`file_paths` and `specific_questions` |
| `review` | `scope`/`target`: uncommitted (default), staged, commit, branch or range; optional `instructions` |
| `doctor` | `detail`: summary (default) or full; optional concrete `backend` and `quota` (default true) |
| `session` | Required `action`: list, history or close; history/close need `session_handle`; history accepts `cursor`/`limit` (1-100, default 50); close accepts `delete_history` |
| `cancel` | Required `session_handle`; optional `workspace_path` |
| `issue` | Optional `error_message`, `context`, `include_doctor` (default true); prepare a report/link, never submit it |

Without a task type, consult passes a plain question with concise-answer
instructions. Task types add their analysis focus. Implementation analysis
does not grant write access. Context files are paths, not embedded contents.

Common execution arguments (`consult`/`review` and compatibility mappings):

| Argument | Current contract |
| --- | --- |
| `backend` | `auto` (default), `codex`, `claude`, `agy` or `smart_quota` |
| `model` | Optional validated identifier; defaults and aliases are resolved per adapter |
| `reasoning_effort` | Schema union `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; actual support is model/provider dependent |
| `session_handle` | Explicit continuation; cannot switch workspace/provider |
| `timeout_ms` | Integer 100-1,800,000; adapter default 900,000 ms |
| `workspace_path` | Optional existing directory, canonicalized before execution |

Unknown arguments, including removed `user_confirmed` and proposed
`session_mode`, are rejected. There is no per-call history or price-governance
parameter.

Initialization instructions explain when to consult/review, verification and
doctor's catalogs. The checked source budget is 512 instruction characters and
5,300 model-visible tool-definition bytes, excluding server icon metadata.
At the reviewed baseline these measured 482 characters and 5,222 bytes;
the corrected descriptions measure 5,256 bytes with the same instructions.
The offline icon is declared in `serverInfo` only; tools have no icons.
Host rendering and whether instructions enter a model's context are host policy.

### Workspace and resources

Resolution order:

1. Explicit `workspace_path`.
2. Client roots: one root, or the root containing the server working directory
   when several exist. Ambiguity asks for an explicit path.
3. Server working directory, excluding home, filesystem roots and system directories.

Roots are cached per connection and refreshed on `roots/list_changed`.
Execution responses add a workspace line only for the server-directory fallback;
they expose no `workspace` or `workspaceSource` fields.

`session` list/history/close enforce the resolved workspace. Session resources
`coagent8://sessions` and `coagent8://sessions/{id}/history` use the connection's
workspace, resolved with the same roots/fallback rules. An unresolved workspace
leaves only the index resource advertised; reading it fails validation.
Resource history reads are not the paginated `session history` interface.

`cancel` without `workspace_path` remains unscoped. It reports
`cancelled: true` only when an active or abandoned turn was stopped/released;
an idle session returns false with "nothing to cancel". A first call's handle
arrives in its terminal footer; use host request cancellation while it runs.

### Configuration and routing

Default file: `~/.coagent8/config.json`; override with `coagent8_CONFIG`.
Storage root: `coagent8_DIR` or `~/.coagent8`. The VS Code extension sets both for
the server it starts: `coagent8_DIR` to its global storage, which VS Code deletes
on uninstall, and `coagent8_CONFIG` to `coagent8.configPath` or config.json there.

~~~json
{
  "schemaVersion": 1,
  "defaultBackend": null,
  "routing": {
    "strategy": "fixed",
    "allowedBackends": ["codex", "claude", "agy"]
  },
  "backends": {
    "agy": { "defaultModel": "<model the first doctor recorded>" }
  }
}
~~~

`defaultBackend` accepts a concrete provider or `smart_quota`.
`backends.<id>.defaultModel` is the model a turn runs when neither the call nor
its session names one; it must be a valid model identifier.
The Antigravity backend is `agy`, the name of its CLI; `gemini` names only its
models. The VS Code setting is `coagent8.agy.defaultModel`.
`backends.<id>.executable` chooses the CLI: an absolute path, a path starting with
`~/`, or `vscode-extension` for the newest copy the vendor's VS Code extension
provides (`~/.gemini/bin/agy` for agy), which survives the versioned folders of
extension updates. Omitted, the CLI is found on PATH, then in the vendor's
extension. `CODEX_PATH`, `CLAUDE_PATH` and `AGY_PATH` take precedence.
A configured executable that cannot be found fails for that backend with
`CLI_NOT_FOUND`; it never falls back to another installation. Setup records the CLI
it finds at a client's first registration, without replacing an existing value. `governance`
(`priceMultiplier`, `askAbovePrice`, `alwaysAsk`, `neverAsk`) is described under
[model consent](#model-consent).
A server started by the VS Code extension also receives the CoAgent8 settings
the user set explicitly in VS Code user settings, in `coagent8_EDITOR_SETTINGS`
(defaults and workspace values are not passed). A scalar setting replaces the file
value; `coagent8.approval.alwaysAskModels` and `coagent8.approval.neverAskModels`
are added to `alwaysAsk` and `neverAsk`. Writes (a recorded default model, a
remembered approval) change only the file, never copying VS Code settings into
it; doctor does not record a default model over one set in VS Code. An invalid setting refuses execution like an invalid file,
naming the setting. The CLI and other MCP hosts read only the file.

`routing.strategy` accepts `fixed` or `smart_quota`. For `auto`, a configured
smart strategy takes precedence over the fixed default. An explicit provider
wins, subject to `allowedBackends`, installation and execution support.

With no fixed default, auto uses the single eligible backend directly; with
several it selects like smart_quota. Selection excludes observed rate limits,
prefers an eligible CLI other than the caller's own, and ranks by cached measured
headroom. Unknown headroom uses 50 as a ranking value, not a measurement.
Equal values retain `codex`, `agy`, `claude` order. The caller's self-reported
name only influences preference.

Routing does not mutate user configuration or retry a failed turn on another
provider. Native quota reads run in diagnostics, not automatic selection.
Selection writes a quota report to disk. A write or lock failure does not reject
the route: selection uses the last readable cache data and the result carries one
bounded warning; `doctor` lists the failure as a recommendation. Each native
measurement records `measuredAt`; one older than 15 minutes, or without that time,
ranks as unmeasured and is dropped on the next rewrite. Observed cooldowns are
kept until they expire. Explicit fixed-provider resolution does not read the cache.

Missing configuration uses defaults. An existing unreadable, malformed or invalid
file refuses execution with `POLICY_DENIED`. Discovery remains available;
doctor reports the error using diagnostic defaults. Unsupported configuration
properties are ignored and dropped when CoAgent8 writes the file.

## 2. Models, consent, results and errors

### Model and effort selection

The source names no model. A turn runs, in this order: the call's `model`; the
continued session's model; `backends.<id>.defaultModel` in `config.json`; the
CLI's own configured default (Codex top-level `model` in `config.toml`); the
default the CLI catalog declares (Codex `isDefault`); the first model the catalog
lists (agy, with its effort suffix); the model the CLI reports it runs without
one (Claude). With none of these the call fails with `MODEL_UNAVAILABLE` before
any model turn. Every adapter refuses a turn without a selected model, so agy's
interface state or Claude's account default never decides silently.

Claude Code resolves names itself (aliases, `ANTHROPIC_DEFAULT_*_MODEL`,
`[1m]` variants, its account default). Before consent the bridge asks it which
concrete model a name runs, from `system/init` of a local `/usage` run (no model
turn, zero cost; verified on 2.1.289, the minimum version). Consent and the turn
use that concrete model. A name Claude Code does not resolve is refused with
`MODEL_UNAVAILABLE` rather than governed by its spelling.

Explicit model or effort also triggers a best-effort CLI catalog check before a
model turn and before consent:

- Codex: visible `app-server` `model/list` entries and accepted efforts.
- agy: `agy models` entries grouped by effort suffix.
- Claude: no catalog.

When a usable catalog exists, an unknown model yields `MODEL_UNAVAILABLE`;
unsupported or missing required effort yields `INPUT_LIMIT` with accepted values.
Unavailable/empty catalogs permit the CLI to decide. Claude warns and ignores
unsupported efforts.

Completed probes are cached in memory for five minutes. Catalogs and observed
models are cached in memory for five minutes and in `~/.coagent8/models.json`
(observed state, not configuration) for a day, so a new server process does not
ask the CLI again. Concurrent misses share one probe, catalog read or model
request; a failure reaches every waiter and is not cached, so the next call asks
again. A `fresh` read (doctor) starts its own. The config file stamp is Codex's
`config.toml` under `CODEX_HOME` (or `CODEX_CONFIG_PATH`) and Claude Code's
`settings.json` under `CLAUDE_CONFIG_DIR`; project-level Claude settings are not
stamped. Keys hash the executable/config file stamps, `PATH`/home
variables and every variable with a provider prefix (`ANTHROPIC_`, `CLAUDE_`,
`CODEX_`, `OPENAI_`, `GEMINI_`, `AGY_`); the store holds only the hash. An
unreadable store is reported and rebuilt; a failed write is reported and never
fails the call. Doctor refreshes everything. Concurrent misses can still
duplicate processes, and the keys do not cover every provider setting.

Doctor reports each backend's default and its source. When the default is one
the CLI does not state itself (the first model agy lists, the model Claude Code
reports), the first doctor records it in `config.json` and says so, so a later
catalog order or account change cannot switch it silently. The summary marks a
default the governance policy asks for on every turn.

### Model consent

Governance decides by approximate price, not by name, for the concrete model a
turn runs (requested, resumed or default), on every turn. The user is asked when
the model:

1. is on `governance.alwaysAsk`;
2. has no price list to compare (asked until approved with "remember");
3. has no known price, or one matched only approximately, such as a `-thinking`
   or `-preview` name or a `[1m]` context variant (asked until approved with
   "remember");
4. costs at least `governance.askAbovePrice` USD per million output tokens
   (default 20; the backend default included; `null` disables);
5. costs at least `governance.priceMultiplier` (default 2) times the backend
   default's output price.

`governance.neverAsk` exempts a model unless it is also on `alwaysAsk`; an
approval with "remember" adds the model to it. Rules 4 and 5 ask on every turn
and offer no "remember".

Prices are OpenRouter's public API prices (`GET /api/v1/models`, no key, no user
data sent), or a list at `coagent8_PRICES_URL` (http(s) URL or local file). Reads
are bounded to 10 s and 4 MiB and validated; variants (`:batch`) and entries
without a fixed price are skipped. The output price of each model is stored in
`models.json`. A turn reads the list only when none is stored, shared by
concurrent turns and retried at most every five minutes after a failure; doctor
reads a list older than a week again. A stored list is used whatever its age.
Prices are matched by name: exactly, also without an effort (`-high`) or date
suffix; otherwise approximately when one name extends the other. Among several
entries the highest price counts. Prices decide only whether to ask; they are not
billing and say nothing about a model's safety.

The rule requires explicit user approval through MCP form elicitation.
The calling agent cannot grant consent. Unsupported elicitation, decline,
cancel or unchecked approval yields `POLICY_DENIED`. Only a decline or an
unchecked box is reported as the user's refusal; a cancel is reported as a
request the client closed without an answer, because some clients cancel without
showing the form (Codex 0.160.1, measured 2026-10-07). The request has a
five-minute timeout and follows caller cancellation. Consent binds to one model
and one turn; acquisition of a session and model execution follow consent.
Version, auth, catalog and model-resolution probes may launch metadata CLI
processes, and the price list may be read, before consent.

The form requires `approve`, and only an accepted form with `approve: true` is
consent. An accepted form without the field, with a non-boolean value or with
the box unchecked yields `POLICY_DENIED` (`CUR-003`, closed).
Interactive UI approval remains unverified. Measured Claude/agy headless clients
cancel form requests.

### Execution results

Execution tools return one Markdown text block plus `isError`, with no
`outputSchema` or `structuredContent`. Full doctor, session list/history, cancel and issue return data with
`structuredContent`; session close is text-only. Consult has no public verdict field.

Execution text contains:

1. On failure, `> Error [CODE]: message`, with `, retryable` where applicable,
   followed by any secured partial answer under `Partial response:`.
2. Public answer with ANSI stripping and credential-format redaction. Update
   banners quoted in answers remain. An empty completion says
   `CLI completed with no public text.`
3. Quoted footer paragraphs: backend, resolved model (or provider default),
   seconds, nonzero operation count and session handle/state where available.
   A ready handle supports continuation; a finished handle does not.
   Turns after the first show their number. Unarchived turns add "no history".
4. For review, `> Verdict: READY` or `> Verdict: BLOCKED (reason)`;
   failures carry their reason in the error line.
5. Truncation notice, warnings, selected diagnostic issue links and the optional
   server-directory workspace fallback.

Codex commentary leaves the public answer when a final answer arrives; history
keeps it. Truncation is tracked per message: commentary that was cut, or dropped
beyond the message-count budget, no longer marks the final answer as truncated
once it is removed. Without a final answer the cut commentary remains the output
and the result reports `BUFFER_LIMIT`.

Footer duration starts after session acquisition. It excludes Git collection,
workspace resolution, probes, catalog reads, consent and pruning. `timeout_ms`
bounds the backend process phase, not the entire MCP call; preparation and
cleanup can make total elapsed time longer. Progress heartbeats are not an
inactivity timeout and cannot extend a host's deadline.

### Typed errors

`CLI_NOT_FOUND`, `CLI_UNSUPPORTED`, `AUTH_REQUIRED`, `MODEL_UNAVAILABLE`,
`RATE_LIMITED`, `SESSION_INVALID`, `SESSION_BUSY`, `ABORTED`, `TIMEOUT`,
`SANDBOX_UNAVAILABLE`, `PROTOCOL_ERROR`, `BUFFER_LIMIT`, `INPUT_LIMIT`,
`PROCESS_ERROR`, `HISTORY_ERROR`, `POLICY_DENIED`.

`ToolError` carries the code. Validation uses `INPUT_LIMIT`; unknown failures
use `PROCESS_ERROR`. `ABORTED` means cancelled, `TIMEOUT` timed out, other
error codes failed. Error status and a review conclusion are separate concepts.

## 3. State Envelope and review gate

`review` composes bounded Git context and asks for:

~~~text
REVIEW: <turn>
SNAPSHOT: <snapshot>
COVERAGE: COMPLETE | PARTIAL
VERDICT: READY | BLOCKED
[P1|P2|P3] <file>:<line>
Problem: <one sentence>
Evidence: <at most two sentences, citing file:line>
Fix: <one sentence>
CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>
END_REVIEW
~~~

The prompt supplies HEAD with staged/uncommitted suffix, a commit/range,
branch merge-base range or `no-commit`, followed by a SHA-256 digest of the
collected diff, workspace input and omissions. Generated files marked `-diff`
in `.gitattributes` contribute binary notices and make input incomplete.

The gate requires the envelope fields and terminator, recognized coverage/verdict,
no response truncation, and no literal `[P1]` or `[P2]` anywhere in the answer.
A reported partial review or BLOCKED verdict stays blocked. Quoted severity
markers can also block.

`SNAPSHOT` must exactly match the supplied identity. CHECKS must name
typecheck/tests as PASS, FAIL or NOT_RUN; any FAIL blocks. Runtime scopes require
both PASS; prose-only scopes allow honest NOT_RUN. A check unavailable in the
restricted backend is NOT_RUN, not FAIL. The workspace/input is collected again
after the turn; changes or failed verification block READY.

**Limits:** the gate does not execute tests, verify a model's PASS claim, compare
release artifact hashes or prove coverage beyond the collected scope. Dist,
maps and lockfiles remain deliberately excluded; release review must verify
its complete scope separately. Required independent check evidence still applies.

Git stdout is bounded to 4 MiB per command, the composed snapshot to 3 MiB, and
individual untracked contents to 256 KiB. Omitted/truncated input is marked in
prompt text and structured completeness; any omission blocks READY. Independent release review
must verify complete scope and evidence; the gate alone is insufficient.

Review reads the current workspace. Commit/range/branch targets must match its
tracked files; staged review requires working files to match the index. Untracked
files prevent readiness for these scopes. A mismatch returns POLICY_DENIED before
any backend probe or turn. No additional checkout is created. Use uncommitted
review for the current working tree; full other-tree review remains unavailable.
Git path classification uses NUL-delimited names, including rename sources;
quoted filenames cannot hide runtime changes. Binary/gitlink contents and
unmerged entries make input incomplete. Submodules are not recursively collected.
assume-unchanged/skip-worktree flags refuse review because Git can hide working
changes behind them.

## 4. Sessions, events and archival history

Execution always acquires a workspace/provider-bound disk session and turn lease.
An explicit handle resumes native context if available; invalid/busy handles
fail closed. A continuation keeps the session's model and reasoning effort; a
call that names another model does not inherit the effort. Idle session records expire after two hours, separate from seven-day
archive retention. There is no implicit auto-resume or ephemeral mode today.
Closing keeps archived history unless `delete_history: true` was requested.

Public events include assistant deltas/messages, tool start/finish, status,
warning and error. The controller adds turn/user events. Private reasoning and
raw tool stdout/stderr are excluded. Identifiers/tool names have bounded validated
metadata.

Archive history is best-effort. Initial, periodic (250 ms) and final flush failures
produce redacted warnings and `historyAvailable: false` without blocking the CLI
or discarding its answer. `coagent8_HISTORY=off` suppresses archive files but
does not remove session storage/pruning/lease dependencies. Lease release failure
remains a hard `SESSION_INVALID` error. Metadata failure preserves output with a
warning and unavailable continuation.

Storage uses append-only coalesced deltas in `.jsonl` and atomic `.json`
snapshots on turn finish or nonstreaming batches containing user/assistant messages.
An initial user-message flush can materialize a snapshot before the backend turn. Torn log tails are repaired under a session lock; legacy snapshot logs
still load. Credential redaction buffers an uncommitted tail across stream batches.

| Bound | Behavior |
| --- | --- |
| Per-session log | 10 MiB |
| Global archive budget | 100 MiB, accounting for logs and materialized snapshots |
| Retention | Inactive sessions older than seven days pruned |
| Capacity | Evict oldest inactive whole archives; protect active turns |
| Unavailable capacity | Skip/fail archival with a warning; output retains its own independent byte bounds |
| History page | At most 100 events and 240 KiB |
| Fragmentation | UTF-8 boundaries with offset, total bytes and completion state |

Cursors are opaque and revision-bound; writes between pages yield
`HISTORY_CHANGED`. Resource reads are separate from pagination.
Per-session append locking coexists with a short global capacity-accounting lock.
Every write reserves its bytes in the 100 MiB total before it happens: log
headers, appends and the growth of a materialized JSON snapshot (`CUR-012`). A
refused reservation evicts the oldest other sessions first, then fails the archive
write, never the turn. The accounted total is the ceiling; an atomic snapshot
replacement briefly holds the old file and its temporary successor on disk.
The 60 KiB streaming regression measured about 1.05 times response bytes on
disk; it does not prove a universal CPU/memory complexity bound.

## 5. Processes and bounds

CLI processes use `shell: false`. Prompts use stdin. Cancellation/deadlines
interrupt Codex/Claude through their native protocol, then stop the owned process
if needed. agy has no supported headless interrupt and is force-stopped.

- Protocol grace: three seconds.
- Windows: kill only the owned root handle. Native backend descendants rely on
  backend cleanup; Windows Node-chain termination has fixture evidence.
- POSIX: own detached process group, SIGTERM then SIGKILL after 250 ms by
  default, or two seconds for agy.
- After root exit, inherited output pipes receive at most two seconds to drain.
- No PID/parent-PID/name selection, process snapshots or descendant polling.

Unexpected parent death on POSIX still needs a strategy. Fixtures do not prove
every native backend's descendant cleanup.

| Data | Bound |
| --- | --- |
| Process input | 4 MiB |
| Diagnostic channel | 512 KiB |
| Codex collector | 512 KiB total/per message, 50 messages |
| Claude collector | 512 KiB total/per message, 200 messages |
| agy collector | 512 KiB total, 256 KiB per message, 50 messages |
| History message assembly | 1 MiB per message, independent of smaller adapter bounds |
| Git stdout | 4 MiB per command; snapshot limits described above |

UTF-8 decoders retain split code points. A lower provider/collector bound can
apply before the independent history-message maximum.

## 6. Provider and diagnostic contracts

| Backend | Execution profile and protocol |
| --- | --- |
| Codex | `app-server -c sandbox_mode="read-only" -c approval_policy="never"` plus `-c features.<name>=false` for the tool features listed below; initialize, `config/read` for the turn directory, thread start/resume with every configured MCP server `enabled = false`, verify thread `readOnly` and `never`, verify the thread's features off and every MCP server `disabled`, then turn start; reject server approval requests; interrupt with `turn/interrupt` |
| agy / Gemini | Headless `--sandbox --output-format stream-json`, prompt on stdin, explicit model, native `--conversation` resume; unknown event types warn; known malformed events fail; every launch sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`, because agy's updater opens a console window that takes the focus on Windows |
| Claude Code | `-p --restricted --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none` with hooks disabled and strict empty MCP configuration; stream-json input/output; verify startup tools/no MCP/dontAsk before content; native session UUID/resume and control interrupt |

Inherited MCP servers (`CUR-002`):
- Claude's restricted profile passes an explicit empty MCP configuration.
- Codex (0.162, measured 2026-10-07) merges configuration layers, so an empty
  `mcp_servers` table, through `-c` or the thread's `config`, leaves every
  inherited server running. The adapter therefore reads the effective
  configuration with `config/read` (project layers of the turn directory
  included) and starts or resumes the thread with each named server
  `enabled = false`. The server also starts with `apps`, `plugins`,
  `remote_plugin`, `browser_use`, `browser_use_external`, `computer_use`,
  `in_app_browser`, `skill_mcp_dependency_install`, `tool_suggest`, `hooks`,
  `multi_agent` and `multi_agent_v2` off. Before `turn/start` the thread must
  report each of those features off (`experimentalFeature/list`) and every MCP
  server, plugin servers included, `disabled` with no tools
  (`mcpServerStatus/list`, all pages). Anything else, including a Codex without
  these requests, fails with `SANDBOX_UNAVAILABLE` and no turn starts. A
  recursive CoAgent8 registration is disabled like any other server.
- agy (1.3.1) has no switch for this. Its `--sandbox` turns load the servers of
  `~/.gemini/config/mcp_config.json` and of enabled plugins (measured
  2026-10-07). By owner decision (2026-10-08) this is a documented limitation:
  CoAgent8 runs agy in agy's own sandbox and does not answer for that third-party
  sandbox. Two measures are CoAgent8's own. Every backend turn runs with
  `COAGENT8_NESTED_TURN=1`, which agy passes to the MCP servers it starts
  (measured), so a CoAgent8 registered in agy refuses to start a turn
  (`POLICY_DENIED`) instead of recursing. `doctor` names the enabled agy MCP
  servers (`agy mcp list`) and the enabled plugins of `~/.gemini/config/plugins`,
  which `agy plugin list` omits.

Sandbox denial evidence
in agy is a warning and requires a real terminal result; a completed answer and
continuation can remain. Duplicate terminals and missing terminals still fail.

Claude probes version/auth status without a model turn. Its native local `/usage`
inspection is enabled only on verified versions 2.1.289+, rejects reported model
usage/cost, and keeps unavailable/API-billing quota unmeasured. agy native
`/usage` is sandboxed and runs only in diagnostics. Codex quota may be unavailable.
Quota cache reuse has a 60-second path, but automatic routing uses supplied probes
and refreshes the stored report without native reads.

Doctor's summary is bounded to 4,096 UTF-8 bytes; full structured data retains
catalogs and detailed evidence, with diagnostic redaction and a 2,048-byte bound
per string. It is not an unmodified dump of provider data. A quota measured in that doctor call can mark agy
ready even though its probe auth status is unknown. Claude reports native login
state; Codex currently infers authentication from credentials/file presence.
Readiness is diagnostic evidence, not proof of a successful model turn or a
complete security boundary.

Setup/native-host status is separate from backend readiness. Native Codex
registration checks have recorded acceptance. Managed Claude/agy updates and
VSIX/UI acceptance remain partial; see [VSCODE_INTEGRATION.md](VSCODE_INTEGRATION.md).

## 7. Known limitations and deviations

Evidence and reproduction provenance are in the
[current snapshot review](PROJECT_REVIEW_2026-10-05.md#review-at-24052e3-2026-10-07).
These are open implementation issues, not relaxed security requirements.

| ID | Current limitation | Roadmap owner |
| --- | --- | --- |
| CUR-002 | Accepted limitation for agy (owner decision 2026-10-08): `--sandbox` turns can use the MCP servers of `~/.gemini/config/mcp_config.json` and of enabled plugins; agy's built-in documentation states that its agent shell receives the language-server address and CSRF token (not measured). Recursion into CoAgent8 is refused and doctor names the inherited tools. Codex is isolated and verified per thread (section 6) | `WINDOWS-001` / `EXEC-001` |
| CUR-007 | Timeout and duration omit preparation; agy headless host has a measured 180-second limit | `CLI-INTERACT-001` / `CONTEXT-001` |
| CUR-008 | Sessions remain mandatory with archival disabled; first active handle is unavailable until return | `SESSION-001` / `HISTORY-002` |
| CUR-009 | Codex auth is inferred; live UI consent and several host integrations remain unverified | `DIAGNOSTICS-001` / `INSTALL-001` |
| CUR-011 | POSIX unexpected-parent-death cleanup is not implemented | `WINDOWS-001` |
| CUR-013 | Current-workspace guard implemented locally: other-tree review is refused before a turn; full review of another tree remains unavailable | `AUDIT-001` / `SURFACE-001` |

The original `c265cdf` audit remains historical evidence. Its process-identity,
answer-redaction, archive-integrity, typed-error and workspace-resource fixes are
present in this local stack; their presence does not close newer findings or
establish matrix/release acceptance. CUR-001 is closed locally by structured
input completeness, exact snapshot matching, check-outcome validation and a
post-turn workspace recheck; independent evidence remains mandatory.
