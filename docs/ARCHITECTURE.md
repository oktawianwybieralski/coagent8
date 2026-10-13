---
title: Architecture
---

# CoAgent8 architecture

Updated 2026-10-09; SIMPLIFY-001 ownership and enforcement reflect the local
follow-up to `f97ffeb`. This document owns current runtime
contracts and the target orchestration design. [ROADMAP.md](ROADMAP.md) owns work
order and acceptance; [HANDOFF.md](HANDOFF.md) owns current evidence. Source
inspection is not native or release acceptance.

## Product boundary

CoAgent8's target is full agent orchestration through MCP, independent of the
client. Coordinator, planner, worker, verifier and reviewer are roles; backend,
model and reasoning effort are independent choices. Skills teach workflows;
the server enforces capabilities, limits and task state.

Today the server is a stdio MCP bridge to Codex, Claude Code and Antigravity
(`agy`). Consultation and review run with the profiles below. Writing,
command execution profiles, delegated coordinators and skill installation are
planned. Read-only remains useful for advice and independent review but cannot
complete implementation/check/fix workflows by itself.

## Request path and ownership

~~~mermaid
flowchart LR
    Host["MCP client"] --> Server["server: schemas, roots, consent"]
    Server --> Tools["tools: prompt, Git scope, result"]
    Tools --> Controller["execution: lifecycle"]
    Controller --> Backend["backends: discovery and adapter"]
    Backend --> Process["owned CLI process"]
    Controller --> Session["sessions: leases and optional archive"]
    Process --> Result["public result and evidence"]
    Result --> Host
~~~

| Owner | Responsibility |
| --- | --- |
| src/index.ts, src/mcp/stdio-server.ts | Entry dispatch, stdio transport, maintenance and shutdown |
| src/mcp/server.ts | Six tools, strict arguments, client roots, human elicitation, workspace resources |
| src/mcp/tools/, src/mcp/result.ts | Task prompts, management and transport result formatting |
| src/execution/ | Turn lifecycle, routing, model selection and consent orchestration |
| src/execution/runtime/, runtime primitives | Owned processes, cancellation, decoding and buffer bounds |
| src/backends/ | Registry, executable/catalog discovery, quota observations, adapters and collectors |
| src/models/ | Catalog/identifier rules, model/price policy and observed model storage |
| src/review/, src/workspace/ | Git scope, completeness, workspace identity and review verdict policy |
| src/sessions/ | Workspace/provider identity, continuation, leases, archive retention/pagination |
| src/config.ts, src/config-overrides.ts, src/paths.ts | File/editor configuration, effective overrides and canonical paths |
| src/security/, src/contracts/ | Answer/diagnostic redaction and shared event/error/result contracts |
| src/storage/ | File locking, atomic writes and bounded file reads |
| src/diagnostics/ | Doctor and sanitized issue reports |
| src/integrations/, extensions/vscode/ | Optional registration, backups/rollback, owned runtime and editor UI |

### Names define responsibility

Tools compose requests, adapters translate provider protocols, execution owns
turns/processes, sessions own continuation and integrations own registrations.
Calling another module does not transfer its responsibility. Extend these owners
for tasks; introduce a scheduler only for actual dependency/concurrency work.

### Dependency boundaries

The table below describes the realized ownership and dependency direction
completed in [SIMPLIFY-001](ROADMAP.md#simplify-001-module-boundary-migration).
It implements the
[P0 boundary rules](../.agents/rules/00-core-invariants.md#dependency-and-responsibility-boundaries)
and is enforced by automated verification (`scripts/check-dependencies.cjs`, `npm run check:dependencies`).

| Target owner | Responsibility and dependency direction |
| --- | --- |
| index.ts and explicit composition modules | Wire concrete implementations and dispatch startup; no domain policy. Keep optional setup loading lazy. |
| mcp/ | Server, stdio lifecycle, schemas, MCP handlers, resources, elicitation and Markdown envelopes. Calls application operations; no application/domain module imports it. |
| execution/ | Application turn lifecycle and selection orchestration; composes models, backends, sessions and review operations. Returns neutral results/evidence; consent and progress use narrow callbacks. |
| execution/runtime/ | Owned process handles/groups, CLI command resolution, decoding and bounded streams. Shared by adapters and integrations; never imports the controller or application policy. |
| models/ | Catalog/identifier rules, price evidence, model comparison, consent decisions and observed model storage. Uses contracts, storage and narrowly scoped configuration/security helpers; no concrete adapter registry or native CLI discovery. |
| backends/ | Provider adapters, registry, native discovery, probe caching and quota observations. Depends on contracts, runtime primitives and model rules/storage; does not import application selection or transport handlers. |
| sessions/ | Continuation, leases and history. Uses contracts, storage, security and workspace identity; no controller/transport dependency. |
| review/ | Review input completeness, snapshot identity and verdict evaluation. Uses workspace/contracts; neither depends on MCP nor formats its envelope. |
| config/ | Validated file/editor overrides and data/config locations. Uses contracts (including shared syntax validators), storage and security; no models/backends implementation, session service or policy execution. |
| workspace/ | Workspace choice, canonical paths and bounded Git evidence collection. Uses contracts and runtime primitives; no sessions or MCP imports. MCP roots arrive as neutral data. |
| storage/ | File locking, atomic writes and bounded file reads. No configuration, models, sessions, transports or application policy. |
| security/ | Credential/diagnostic redaction, including safe stream boundaries. No history store, provider selection or transport dependencies. |
| contracts/ | Shared provider identity, errors, events and execution/catalog/policy contracts. No implementation or SDK imports; domain-local types stay with their owner. |
| diagnostics/ | Readiness and sanitized issue evidence composed from domain services/adapters. No MCP envelopes or dependency back from execution to diagnostic presentation. |
| integrations/, extensions/vscode/ | Optional installation, registrations and editor UI using shared configuration and runtime mechanisms. Core execution never imports client setup/UI. |

Keep generated assets in generated/ and branding metadata in brand.ts;
tool names belong to MCP. Do not create empty directories for future milestones.
The same direction applies to transitive runtime imports and type dependencies;
an allowed import must not transitively load the caller or optional installer.

Historical migration debt (controller -> tools/result, config/model-cache ->
sessions/lock, session/history cycles, and setup type cycles) has been fully
eliminated across S1 through S5. S6 enforces the module graph with 0 allowed
legacy exemptions, 0 dependency cycles, and automated boundary verification in CI.

The checker retains external dependency identities and rejects MCP/editor SDK
imports outside their owners, including type imports, type queries, dynamic
imports, require calls and re-exports. The generated server icon is an explicitly
owned MCP asset. Transport and optional setup isolation also covers complete
dependency paths, with the path reported for each indirect violation. Unassigned
source files receive no entrypoint privileges; only src/index.ts composes startup.
The retired src/constants.ts forwarding module has no compatibility exemption.

## Current MCP contract

| Tool | Contract |
| --- | --- |
| consult | Plain second opinion; proposal required, optional architecture/debug/implementation analysis |
| review | Bounded Git review, State Envelope and server-derived READY/BLOCKED |
| doctor | Default model view (cached): per backend its models, efforts, output prices, default and approval need; scope health: installation/auth/profile evidence, defaults, quotas |
| session | Workspace-scoped list/history/close; continuation uses session_handle |
| cancel | Stops a known active/abandoned session turn; idle returns false |
| issue | Sanitized report and prefilled GitHub issue link; does not submit it |

Deprecated analyze/debug/implement and legacy run remain callable, unadvertised.
Implement still means read-only advice. Unknown arguments are rejected; there is
no task API, per-call history or session_mode argument today. Execution tools
accept output_price_below ([price limit](#price-limit)).
Client-independent discovery requires no installer or recognized client name.

Execution results are one Markdown block plus isError, without outputSchema or
structuredContent: answer or typed error/secured partial answer; backend, resolved
model, duration, operation count and session state; review verdict when applicable;
price evidence when the call set a price limit; warnings and fallback workspace. Full doctor, session list/history, cancel and
issue return structured data; session close is text-only.

The footer duration (`durationMs` / `totalMs` in `ExecutionMeta`) reflects total elapsed
wall-clock time from root call entry through completion, including preparation, Git
collection, consent, execution, and teardown/cleanup overruns. In the event of early
failure during tool preparation, Git collection, or cancelled consent prompts, error
footers report actual elapsed monotonic time rather than `0.0s`. `timeout_ms` bounds the
complete call via `ExecutionBudget`, reserving teardown allowance for cleanup.
Progress cannot extend a host deadline. A measured agy 1.3.1 headless host cancelled
after 180 seconds; this is not a universal claim about IDE clients.

Workspace precedence: explicit workspace_path; one client root or the deepest
root containing the server directory; eligible server directory. Ambiguous roots
require an explicit path. Home/filesystem roots/system directories are not implicit
workspaces. Roots refresh on roots/list_changed. Only a server-directory fallback
adds the workspace line.

Session list/history/close and coagent8://sessions resources enforce workspace
ownership. Resource history is not the paginated session API. Cancel without
workspace_path remains unscoped; an initial session handle arrives only at return,
so use host request cancellation during the first call.

The source surface budget is 512 initialization characters and 5,800 model-visible
tool-definition bytes (server icon excluded; owner decision 2026-10-10 for actionable
issue telemetry instructions); Codex loads definitions with every
request, so each byte is paid per turn there. Hosts control ToolSearch, instruction
visibility, UI rendering and cached schemas. A skill is not required for a plain call.

## Configuration and routing

Config resolution is coagent8_CONFIG, otherwise config.json under the data root
(coagent8_DIR or ~/.coagent8). With no overrides it is ~/.coagent8/config.json.
The latest VSIX explicitly supplies the shared config path and its own data root,
keeps its data in VS Code global storage and preserves config on uninstall.
Old/manual registrations can still set a different coagent8_CONFIG; source
defaults do not establish what an already running process reads.

Explicit VS Code user settings arrive through coagent8_EDITOR_SETTINGS and
override the file. Approval rules (governance) have no VS Code setting: every
client's server reads them from the file, and the VS Code command Manage Model
Approvals edits them there. Workspace/default editor settings are not passed. Recorded defaults and remembered approvals write
only to the file. Other hosts/CLI read the file, not VS Code settings. Unknown
file properties are ignored and dropped on write; malformed/unreadable/invalid
existing config blocks execution with POLICY_DENIED. Discovery remains available.

Core fields are schemaVersion: 1, defaultBackend, routing.strategy
(fixed or smart_quota), routing.allowedBackends (codex/claude/agy), per-backend
defaultModel/executable, and governance. The pre-release gemini backend alias and
GEMINI_PATH were removed by owner decision; agy/AGY_PATH are current.

Executable precedence: CODEX_PATH/CLAUDE_PATH/AGY_PATH; configured executable
(absolute, ~/ path or vscode-extension); PATH; vendor extension copy. A configured
missing executable fails rather than silently selecting another. Setup records
the first discovered choice without replacing an existing one.

An explicit backend wins subject to allowedBackends, installation and execution
support. Auto uses the configured route; absent a fixed default, one eligible
backend runs directly, otherwise smart_quota behavior applies. A named model with
auto runs on a backend whose catalog lists it (id or alias, compared without case,
provider prefix or dot/dash difference), else on one whose CLI decides itself
(runs unlisted names or lists none); a price limit narrows auto the same way. The
configured default is kept when eligible and otherwise does not block the route.
The provider prefix of a price entry never picks a backend: agy also serves
Anthropic and OpenAI models. It excludes
observed cooldowns, prefers another CLI than the caller's and ranks cached native
headroom. Unknown headroom ranks as 50, not a measured value; equal ranks retain
codex/agy/claude order. Caller identity affects preference only.

Routing never retries a failed turn on another backend. Native quota reads occur
in diagnostics. Measurements older than 15 minutes or without measuredAt rank as
unknown; cooldowns survive until expiry. Optional cache lock/write failures yield
a bounded warning and use readable data. Explicit fixed-provider resolution
does not read the quota cache.

## Models, prices and consent

Model precedence: request, continued session, configured backend default, CLI
configured default, catalog default, first listed model, CLI-observed model.
An unresolved choice fails before a turn. A listed id or alias becomes the exact
listed model before consent. Codex uses model/list; agy groups models by effort
suffix; Claude answers a stream-json initialize request with each accepted name,
the concrete model it resolves to, its efforts and the account default, without a
user message or turn (0.9 s, 2.1.294). Claude also runs names it does not list;
such a name is resolved through system/init of the local /usage run.
A usable catalog rejects unknown models (except Claude's) and unsupported/missing
required effort. Without a usable catalog the CLI decides.

Probes cache for five minutes. Catalogs/resolved models cache in memory for five
minutes and models.json for a day, keyed by hashed executable/config stamps and
provider environment. Concurrent ordinary misses coalesce; fresh doctor reads
are separate. Not every provider/project setting is represented in the key.
Failures are not cached as successes; optional store failures are reported.

Doctor records an observed/first-listed default in config when one is absent,
so later account/catalog ordering does not silently change it. This diagnostic
can therefore write defaults and caches; it is not purely observational.

### Model consent

The current price list is OpenRouter's public API or coagent8_PRICES_URL
(HTTP(S) or local file). Fetches are bounded to 10 s/4 MiB. Only the models the
backends offer, and names a call needs, are stored in models.json (schema 2):
output, uncached input and cached input USD per million tokens with the matched
entry, or null when checked without a match. The whole list is not kept;
variant IDs such as :batch/:free are excluded. A unit price is not a request estimate.

Governance uses exact name matching, including normalized effort/date suffixes,
then approximate extension matches; the highest matched price wins. An exact
name match does not establish billing accuracy or handling of all context tiers.
List prices change rarely: a stored list is used at once and read again in the
background after a day. A call waits only when none is stored, when it needs an
unchecked model, or with a price limit when the list is a week old; doctor health
waits for a day-old list. Reads are shared, a failure is retried after five
minutes and graceful shutdown waits for a background read (fetch-bounded).

Consent is evaluated for the concrete model on every turn:

1. The user's governance.models lists decide first, in the allow/ask/deny
   convention: deny never runs the model, ask requires approval every turn
   whatever it costs, allow runs it without asking (the user's standing approval);
   deny wins over ask and ask over allow. An entry naming an id also covers its
   effort variants (<id>-<effort>); an entry naming a variant also applies when
   the call or its session passes that effort as reasoning_effort, in the deny
   check, the approval, its revalidation and price-limit choice. agy drops a
   model's own effort suffix and runs the passed effort's variant, so its rules
   see only that variant; Codex and Claude run the model as named. A denied model is refused with POLICY_DENIED
   and the list as the reason, before any catalog read or approval request; a
   price limit never chooses one. Every reason states the known price.
2. Missing list, missing price or approximate match requires approval, with an
   option for the user to remember it in models.allow.
3. Output price at least askAbovePrice (default USD 20; null disables) or at
   least priceMultiplier (default 2) times the backend default requires approval
   every turn, without remember.

A misspelt models list fails configuration validation.

Only accepted MCP elicitation with explicit boolean approve: true grants consent.
Missing capability/content, unchecked box, decline, cancel or timeout fails closed.
The calling agent cannot approve. Cancel is reported as unanswered, not a user's
refusal. Consent is request/model-bound and precedes session acquisition/model
execution; metadata probes may precede it. The form wait is bounded to five minutes
and follows cancellation. Real UI display still needs client-specific acceptance.
A refusal tells the caller to inform the user and to switch models only if the
user asks; it never advises another model by itself (AX-003). When no form
reached the user, it names the user's own ways out (a client that shows MCP
forms, or models.allow) and forbids the caller to change that setting. Before a
call, the model parameter description and the client skills tell the caller to
ask the user about a model doctor tags ask, so the form is expected, and not to
call one tagged deny.

The absence of an approval prompt does not prove that a model meets a user's price
limit. models.allow, thresholds, default-model ratios and price staleness make those
separate questions; the price limit below answers the user's question.

### Price limit

output_price_below on consult, review and the unadvertised execution aliases is
the user's limit in USD per million output tokens. It is strict: 5 excludes a
model priced at 5. It is a list unit price, not a request estimate, measured
usage, quota or bill; request estimates remain open in AX-001.

- Only an exact match from a list younger than seven days meets a limit. Unknown,
  approximate (including context variants such as [1m]) and stale prices never do;
  several exact entries count at their highest price. A constrained call reads a
  stale list again (shared, retried after five minutes); if that fails the call
  fails. A null or empty list price is no price, not zero.
- The check is separate from consent. models.allow, an approval or the absence of a
  prompt cannot satisfy it, and a model within the limit still asks where
  governance says so (models.ask, askAbovePrice, priceMultiplier, unknown).
- A named model (request or session continuation) is checked as resolved, aliases
  included. If it does not meet the limit the call fails with PRICE_LIMIT and the
  reason; it is never replaced. A continuation keeps its model.
- Without a named model the backend default runs when it meets the limit;
  otherwise the highest-priced catalog model below the limit, as a capability
  proxy, accepting the call's reasoning_effort (an agy model needing an effort
  gets its first). An explicit backend stays fixed; auto keeps the configured
  default when it has a qualifying model and otherwise chooses among backends
  that have one, then as usual. Claude's catalog lists its aliases, so they qualify
  like other listed models.
  No qualifying model is PRICE_LIMIT with each backend's reason.
- The controller checks the concrete model before consent and again right before
  session acquisition, so a price list or configuration changed while the user
  decided is honored. The footer then carries a Price line with the unit price,
  list source/date and the limit. Without the argument calls behave as before.

The selection view in model-selection.ts (listModelCandidates, choosePricedModel)
is the single owner for doctor, execution and the planned CLI models command.

### Doctor and readiness

doctor defaults to scope models: the model view from cached probes, catalogs and
prices (runModelReport). It reads no quota, records nothing and refreshes only an
expired cache. scope health runs runDoctor: it forces backend/catalog refresh,
reads quota, records an absent default and reads a day-old price list again.
Backend narrows either; the former quota argument is removed. detail full returns
the same report as structured data with redacted strings bounded to 2,048 bytes. prices adds stale; selection lists every model of the
installed diagnosed backends: backend, model, efforts/effortRequired, defaultSource
on the default row, price (output USD per million tokens, matched entry,
exact/approximate/unknown, list source, fetchedAt, stale) and approval
(required, rule basis, reason, rememberable). Without a catalog only the default
is listed. The summary renders the same rows (~ approximate, ? unknown, default
and asks: rule tags) and is bounded to 3,900 bytes, under agy's inline result
threshold; it drops whole rows from the longest list and counts them.

Ready combines execution/profile/auth evidence and available quota. A native quota
read can supply auth evidence, explaining agy's cold not-ready/success discrepancy.
Codex auth is inferred from file/environment presence and its 5-hour/weekly
windows come from app-server account/rateLimits/read (ChatGPT sign-in, no thread);
Claude uses native login status. Unknown readiness is not proof that a turn will fail; successful execution
does not prove universal profile isolation. AX-004/005 separate these facts.

## Review contract

Review collects bounded Git input and supplies a snapshot identifier incorporating
SHA-256 of diff/workspace input/omissions. The requested envelope is:

~~~text
REVIEW: <turn>
SNAPSHOT: <snapshot>
COVERAGE: COMPLETE | PARTIAL
VERDICT: READY | BLOCKED
[P1|P2|P3] <file>:<line>
Problem: <description>
Evidence: <file:line evidence>
Fix: <action>
CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>
END_REVIEW
~~~

The gate requires complete input/output, exact snapshot, recognized fields and
terminator, COMPLETE/READY and no literal [P1]/[P2]. Any FAIL blocks. Runtime
scopes require both checks; a read-only reviewer cannot run them, so its honest
NOT_RUN does not block and the server verdict names the checks it did not run:
`Verdict: READY (typecheck and tests not run)`. A reported PASS is not evidence
either; the author runs the checks locally and CI on the pull request (owner
decision 2026-10-11, replacing the AX-007a BLOCKED verdict).
A judged review (complete, untruncated envelope for the collected snapshot)
stores its snapshot, scope, model and server verdict in its session record. A
later request in the same workspace with the same snapshot, scope, resolved
backend and model, while that session is live (2 h retention), starts no model
turn, asks no consent and answers with a bounded reference to that session and
its verdict. The record exists with history off; an unreadable sessions
directory adds a warning and the review runs (AX-007c).
The workspace is collected again after the turn; changes or failure block readiness.
The gate does not run checks or prove the model's PASS claim, comprehensive scope
or release artifact hashes. Independent evidence is still required.

Git stdout: 4 MiB per command; composed snapshot: 3 MiB; each untracked file:
256 KiB. Omissions/truncation block READY. Dist/maps/lockfiles are deliberately
excluded and require separate release coverage. Binary/gitlink contents, unmerged
entries and submodule limitations prevent complete approval; hidden index flags
refuse review. Changed-path classification uses NUL-delimited paths/rename sources.

Review reads the current workspace. Revision/range/branch tracked files must match
it; staged files must match the index and untracked files prevent readiness for
these scopes. A mismatch fails before a backend probe. No alternate checkout is
created; full other-tree review is pending.

## Sessions and history

Every current execution needs a workspace/provider-bound disk session and lease;
`activePid` records the CoAgent8 server process owning the active turn, not the
backend CLI child PID. Explicit invalid/busy handles fail closed. Continuations
retain model and effort; changing model does not inherit effort. Idle records
expire after two hours; archive retention is seven days. No implicit auto-resume
or ephemeral mode exists. Close retains history unless delete_history is requested.

Archive writes are best-effort. Initial/periodic/final failures warn and preserve
execution/answer; coagent8_HISTORY=off suppresses archives only. Session acquisition
and turn leases remain required; lease release failure is SESSION_INVALID.
Post-turn metadata failure preserves output but disables continuation.

Append-only coalesced .jsonl deltas and atomic .json snapshots preserve legacy
reads, repair torn tails under lock and buffer split credential tails. Private
reasoning/raw tool stdout/stderr are excluded. Bounds: 10 MiB per session,
100 MiB accounted global archive, 100 events/240 KiB per history page; UTF-8-safe
fragments and revision-bound cursors (HISTORY_CHANGED on intervening writes).
Evict oldest inactive whole archives, protect active turns. Every write reserves
capacity first; atomic replacement temporarily holds both old and temporary files,
so accounted capacity is not an instantaneous physical disk ceiling.

## Processes and backend profiles

Processes use shell: false, prompts on stdin and hidden Windows launches.
Interrupt Codex/Claude through their protocol, then force-stop owned processes
after bounded grace; agy has no supported headless interrupt. Windows targets only
the owned root handle; native descendants depend on backend cleanup. POSIX owns
a detached process group, SIGTERM then SIGKILL. Never select by PID/PPID/name or
poll descendants. Unexpected POSIX parent-death cleanup remains open.

Protocol grace is three seconds; POSIX forced cleanup follows 250 ms (agy two
seconds); inherited pipes drain for at most two seconds after root exit.
Process input is bounded to 4 MiB, diagnostics to 512 KiB. Codex collector:
512 KiB total/per message, 50 messages; Claude: 512 KiB, 200 messages; agy:
512 KiB total/256 KiB per message, 50 messages. History assembly has its own 1 MiB
message bound. UTF-8 decoders preserve split characters. Codex final text replaces
commentary without carrying discarded commentary truncation into the final result.

| Backend | Current enforced profile |
| --- | --- |
| Codex | app-server read-only/never; disable tool features, read effective config, disable each inherited MCP server per thread, verify readOnly/never, features off and every MCP server disabled before turn/start. Empty MCP tables alone do not isolate merged config. |
| Claude | restricted Read/Glob/Grep, dontAsk, no permission prompts, hooks disabled and strict empty MCP config; verify startup tools/no MCP/permission mode; stream-json, native resume and interrupt. Verified local /usage path requires 2.1.289+. |
| agy | Native --sandbox, explicit model, stream-json/stdin and conversation resume. Unknown events warn; malformed known events fail. Every launch disables its auto-updater to prevent focus-stealing windows. Inherited MCP/plugins remain accessible. |

Every turn sets COAGENT8_NESTED_TURN; nested CoAgent8 refuses execution before
probes. Codex verifies isolation; agy's inherited-tool limitation was accepted by
the owner on 2026-10-08 and is named by doctor. It is not permission to claim
isolation or remove the recursion guard. User hooks/plugins in Claude need further
native acceptance. Security requirements belong to
[rule 01](../.agents/rules/01-security-and-sandboxes.md).

Answer/history redaction targets credential formats; diagnostics also redact
keyword credentials and home paths. Ordinary code such as token variable names
must retain meaning. ANSI controls are removed.

Typed errors: CLI_NOT_FOUND, CLI_UNSUPPORTED, AUTH_REQUIRED, MODEL_UNAVAILABLE,
RATE_LIMITED, SESSION_INVALID, SESSION_BUSY, ABORTED, TIMEOUT, SANDBOX_UNAVAILABLE,
PROTOCOL_ERROR, BUFFER_LIMIT, INPUT_LIMIT, PROCESS_ERROR, HISTORY_ERROR, POLICY_DENIED.
Validation uses INPUT_LIMIT; unknown failures use PROCESS_ERROR. Execution error
status is separate from a review conclusion.

## Optional integrations

Setup/repair/status/cleanup live in the separate setup bundle. Legacy registrations
invoke the runtime bundle directly without a subcommand; modern registrations
pass the explicit `mcp` subcommand (see [Registration migration and coexistence](#registration-migration-and-coexistence)).
Setup owns selected-host registrations, immutable runtime copies, fingerprints,
private backups, leases and preview-bound cleanup. Preserve manual/edited entries
and unrelated settings.
Without a recorded fingerprint, as after `setup.json` was lost, an entry is setup's
when it starts a runtime copy in `~/.coagent8/runtime/<sha256>/index.cjs` and holds
only the fields setup writes; a data directory in VS Code global storage
`okidev.coagent8-mcp` marks the extension's. An owned entry whose runtime copy is
gone is replaced without the checks that protect a working connection.
Status reads registration files without running every registered host's doctor.

VS Code lists only `mcp.json` entries and gallery installs as installed MCP
servers; a definition provider's server appears only under "Extensions" in the
Agent Customizations editor (source of 1.141, 2026-10-11). The extension
therefore keeps one stdio entry `CoAgent8` in its profile `mcp.json` (beside its
global storage), started from `<global storage>/runtime/<sha256>/index.cjs` so
the entry outlives an extension update until the new version activates and
rewrites it. Activation, `coagent8` setting changes, vendor extension changes and
`mcp.json` changes resynchronize command, copy and environment (current
extension paths for the shared executable resolver, data directory, config file,
user-level editor settings). The windows of a profile share the entry: an
`mcp.json` change keeps a complete entry another window recorded instead of
writing this window's back, and an entry recorded by a newer extension version is
never replaced by an older one, nor its runtime copy deleted, so windows running
different builds or environments never rewrite it in turn. Each synchronization
and the uninstall cleanup run under one lease in `~/.coagent8`, so copying a
runtime, writing the entry and record, and pruning copies are one step and no
window prunes a copy another is registering. Ownership is the digest in
`~/.coagent8/vscode-mcp.json`; only when no record exists does that copy's path
shape identify the entry. Every write, the first included, records the new digest
as pending before it writes the entry, so an interrupted write leaves either entry
the extension's, recorded for the uninstall, and an edit or removal racing it the
user's; a record of only a pending digest is an unfinished write, never a removal. An edited entry, even one still
starting the copy, or
another CoAgent8 entry in the profile is the user's and suppresses the
extension's; an entry the user removed in VS Code is not added back until
**Show MCP Servers** restores it on request. VS Code lists a workspace
`.vscode/mcp.json` server beside the profile's (collections are keyed by file,
not by name), so the entry is not added while the window's workspace registers
CoAgent8; an existing entry serves the profile's other windows and is never
removed for one workspace, which would make windows rewrite it in turn. The
window then says once per workspace that VS Code lists CoAgent8 twice. The definition provider stays as the
fallback when the entry cannot be kept and steps aside while any `mcp.json`
entry or a removal provides CoAgent8. **Manage Coding CLIs** (CLIMGMT-001) lists the three CLIs; each CLI's
menu handles its installations, installation, login, registration, skills and
removal of what CoAgent8 installed, and reopens with fresh checks after each
action. `listInstallations` finds installations without starting them: the vendor
extension's copy, each PATH folder, the official installers' folders in the user
profile and the configured file; it never scans the disk. `checkExecutable` accepts
a chosen file only as a compatible CLI of its client before the selection is
written. A selection is `backends.<id>.executable` in config.json, never a VS Code
setting, because the CLI chats start the runtime without VS Code settings.
Removing the installation in use moves a selection to the remaining installation or
clears it. Vendor extensions are installed machine-scoped (`donotSync`), so VS
Code does not ask about Settings Sync and does not sync them; their removal from
the menu needs no confirmation, as in the Extensions view. The record of installed dependencies is
`~/.coagent8/installs.json`, outside the extension storage VS Code deletes, so an
Extensions-view uninstall cannot orphan them; only recorded dependencies are
offered for removal. The `vscode:uninstall` hook removes unchanged profile
`mcp.json` entries of its own installation (each record names the extensions
folder of the VS Code installation that wrote it; Stable and Insiders share
`~/.coagent8`; a profile it cannot read or write keeps its entry and record and
is reported without stopping the others) and other owned entries, skills and
data and preserves shared config, sign-ins and histories. VS Code stops the hook
after five seconds, so it waits at most 1.5 s for the profile lease a window
holds and as long for the setup lease of a running setup; what a lease still
held protects stays, the hook reports it, and the rest of the cleanup runs. Native lifecycle acceptance remains. Sources compare by real path, so an installer link to the
extension copy is that copy. Standalone removal deletes installer links, never
their targets' other files, then emptied installer folders and their user PATH
entries, keeping the registry value's type and unexpanded variables. An extension
removal opens the extension's page (`extension.open`),
where the native Uninstall and Restart Extensions apply it to every host; no
public command does that restart, and a developer extension-host restart does not
apply the Extensions view's internal add/remove delta. The extension records the
pending removal in its state and finishes its part (record, selection, agy
download) when `extensions.onDidChange` or the next activation no longer finds
the extension; an extension still installed at activation was kept. VS Code deletes the extension's files and storage on its next start, which
no removal waits for.

Client skills (`src/integrations/skills.ts`, SKILLS-001/002) share setup ownership.
The catalog is `skills/` of the npm package and the VSIX: one directory per
CoAgent8 function holding only a SKILL.md, read and validated before setup
changes a client. After a client's registration is installed, updated or
preserved, setup writes the packages into that client's user-scope directory
(`~/.claude/skills`, `~/.agents/skills`, `~/.gemini/config/skills`) when missing
or still holding the recorded copy, and records their SHA-256 digests and the
per-package origin in `setup.json`. Changed, multi-file, linked or foreign
`coagent8-*` entries are preserved and unrecorded; other tools' skills in shared
directories are never read. Cleanup previews recorded packages in the same token,
removes unchanged ones and re-checks them on apply; the VS Code origin limits
the uninstall to packages the extension wrote. npm runs no uninstall script, so
`coagent8 cleanup` precedes `npm uninstall`. Skills grant no capability and no
package script runs.

Independent management (`skill-management.ts`) serves the CLI `coagent8 skills`
and VS Code's Manage Skills command without starting a backend or touching MCP
registrations. Status distinguishes actual enabled/disabled/absent/conflicting
packages from desired state. `backends.<client>.skills` holds explicit `installed`
and `disabled` name lists in shared user config, separate from ownership. Omitted
preferences retain setup's full-catalog default; management initially selects
only recorded packages. Empty installed lists opt out, and explicit selections
do not gain new catalog names. Setup/repair/update honor the selection. Catalog
removals delete only unchanged owned packages; edited copies are preserved.

Disable moves an unchanged package outside discovery into
`~/.coagent8/disabled-skills/<client>/<name>/SKILL.md`; enable restores it to the
existing root. Install/update retains disabled state. This portable operation
does not edit native activation overrides. Other discovered copies and shared
directory consumers still apply; no change erases existing conversation content.
New-chat refresh and the agy loader path retain the native acceptance limits.

Apply binds client, desired state, catalog digests, observed bytes, config and
ownership to a preview digest. The setup lease serializes mutations; the config
lease rejects changed config snapshots. Desired intent is saved first, so repair
can retry failed file changes. `skill-transaction.ts` journals bounded package
snapshots in `~/.coagent8/skill-transaction.json` before file effects and commits
ownership last. Failures roll files back; setup/repair/cleanup/management recover
interrupted writes under the same lease. Changed ownership or user-edited files
stop recovery and retain the journal. Per-package `skillOwners` preserves CLI
versus extension ownership within one client's active and disabled sets; legacy
`skillOrigin` records remain accepted. Cleanup includes disabled packages and
filters each package by origin.

VSIX/plugin payloads derive from the npm tarball. Backend readiness, runtime
initialize/tools-list, native host calls, UI/skill discovery and install/update/
uninstall are separate acceptance claims. Preliminary owner evidence does not
establish support for every host/version. The roadmap owns outstanding checks.

## Public CLI and dispatch specification (target design)

> Target specification pending implementation across Phase 1 (CLI-FIRST-001b through 001e). Current baseline runtime dispatch is defined in `src/index.ts`.

CoAgent8 exposes a command-line interface via npm package executable `coagent8`
([CLI-FIRST-001](ROADMAP.md#cli-first-001-public-cli-and-mcp-adapter)). The CLI
shares engine, diagnostic, session and integration services with the MCP server
while providing deterministic command routing, lazy bundle loading, structured
JSON output and explicit process exit codes.

### Execution entry point and binary aliases

The package declares binary entry points in `package.json`:
- `coagent8`: primary command (`dist/index.cjs`).
- `coagent8-mcp`: backward-compatible alias pointing to `dist/index.cjs`.

All invocations enter `src/index.ts`. Root argument parsing and command routing
execute synchronously before loading optional subsystem bundles or initializing
backend adapters.

### Bare invocation, explicit MCP and legacy fallback (Option D)

Bare invocation and transport routing follow owner decision Option D
(2026-10-13, Codex consultation `syn_sess_dbbaad3b7fd79cadbb8e15dc`):

1. **Recognized commands and root flags** (`--help`, `--version`, `models`,
   `doctor`, `session`, `setup`, `repair`, `status`, `cleanup`, `skills`, `mcp`):
   Dispatched immediately, independent of stream or TTY state.
2. **Zero arguments (bare `coagent8`)**:
   - When both `process.stdin.isTTY === true` and `process.stdout.isTTY === true`:
     prints root help text to stdout and exits with code 0 (future: opens an
     interactive terminal UI once accepted).
   - When either `stdin` or `stdout` is non-TTY (redirected, piped or spawned by an
     MCP host): starts the legacy MCP stdio server.
3. **Explicit `coagent8 mcp`**:
   - Always starts the MCP stdio server regardless of TTY status. New client
     registrations (setup, the VS Code extension, sample configurations) use
     this explicit command.
   - Any unrecognized arguments passed to `coagent8 mcp` are rejected with exit
     code 2 and an error message to stderr.
4. **Legacy fallback (unrecognized root invocation)**:
   - When both `stdin` and `stdout` are TTYs: rejected as an unknown command with
     exit code 2 and a usage hint written to stderr.
   - When either stream is non-TTY: to preserve compatibility with legacy MCP
     hosts that pass unexpected arguments, the arguments are ignored, a single
     bounded, redacted diagnostic warning is emitted to stderr, and the legacy
     MCP stdio server starts.

| Invocation | Stdin TTY | Stdout TTY | Dispatched action | Exit code |
| --- | --- | --- | --- | --- |
| `coagent8` (bare) | Yes | Yes | Print root help (future: open TUI) | 0 |
| `coagent8` (bare) | No | Yes | Start legacy MCP stdio server | 0 (clean shutdown) |
| `coagent8` (bare) | Yes | No | Start legacy MCP stdio server | 0 (clean shutdown) |
| `coagent8` (bare) | No | No | Start legacy MCP stdio server | 0 (clean shutdown) |
| `coagent8 mcp` | Any | Any | Start MCP stdio server | 0 (clean shutdown) |
| `coagent8 <known-cmd>` | Any | Any | Dispatch subcommand | Per command |
| `coagent8 <unknown>` | Yes | Yes | Print usage error to stderr | 2 |
| `coagent8 <unknown>` | No (either) | Any | Stderr warning, start legacy MCP stdio | 0 (clean shutdown) |

### Dispatch and lazy loading boundaries

Root dispatch enforces strict isolation to prevent unnecessary initialization overhead:
- `--help` / `-h` and `--version` / `-v` load neither the setup bundle (`setup.cjs`),
  nor the MCP server (`stdio-server.ts`), nor backend CLI adapters (`src/backends/`).
- `coagent8 mcp` loads the MCP transport and execution pipeline, but never loads the
  optional setup bundle.
- Information commands (`models`, `doctor`, `session`) load only their respective
  diagnostic or session owners; they never load `setup.cjs` or start the MCP server.
- Management commands (`setup`, `repair`, `status`, `cleanup`, `skills`) lazily load
  `setup.cjs` on first dispatch.

### Global flags and argument parsing

The root parser recognizes the following global flags:
- `--help`, `-h`: displays command usage and exits with code 0. When passed alongside
  a recognized subcommand, displays that command's help.
- `--version`, `-v`: displays the current package version and exits with code 0.
- `--json`: requests machine-readable JSON output on stdout for commands that support
  structured reporting (`models`, `doctor`, `session`, `setup`, `status`, `cleanup`,
  `skills`).

Argument parsing rules:
- Options accepting values support both space-separated (`--flag value`) and
  equals-separated (`--flag=value`) syntax.
- Flags are case-sensitive.
- For scalar flags repeated on the command line, the last occurrence takes precedence.
- The double dash (`--`) terminates option parsing; subsequent arguments are treated
  as positional arguments.

### Command inventory

#### Information and inspection commands

- `coagent8 --help` / `-h`: root help text listing available commands and options.
- `coagent8 --version` / `-v`: prints version string (e.g. `0.7.0`).
- `coagent8 models [--backend codex|claude|agy] [--json]`:
  Queries cached model catalog data (`src/diagnostics/models-cli.ts`, `AX-001`).
  Lists offered models, supported reasoning efforts, output token prices, and
  governance approval tags (`allow`, `ask`, `deny`). Default output is human-readable
  text summary; `--json` emits the model report JSON preserving the shape consumed
  by VS Code Manage Model Approvals.
- `coagent8 doctor [--scope models|health] [--backend codex|claude|agy] [--json]`:
  Runs diagnostics (`src/diagnostics/doctor.ts`). Default scope is `models` (cached
  catalog view); scope `health` verifies CLI discovery, authentication status, and
  quota headroom. Creates no execution sessions, preserves diagnostic redaction, and
  exits cleanly on SIGINT. Default output is human text; `--json` emits the full
  diagnostic report.
- `coagent8 session list [--json]`:
  Lists known active and historical sessions for the current workspace
  (defaults to `process.cwd()`, aligning with MCP workspace resolution). Default output
  is a human-readable table/summary; `--json` emits an array of session metadata.
- `coagent8 session history <handle> [--cursor <cursor>] [--limit <n>] [--json]`:
  Inspects paginated turn history for a session handle (`src/sessions/`). Bounded by
  `--limit` (1 to 100, default 20). Rejects invalid handles or unknown cursors with
  errors matching MCP `session`. Default output is human text; `--json` emits paginated
  turn records.

#### Management and integration commands

Loaded lazily from `setup.cjs` (`src/integrations/setup-cli.ts`):
- `coagent8 setup [--clients=codex,claude,agy]`:
  Registers CoAgent8 with the specified native hosts and reconciles client skills.
- `coagent8 repair [--clients=codex,claude,agy]`:
  Verifies and restores missing or corrupted owned host registrations and skills.
- `coagent8 status [--clients=codex,claude,agy]`:
  Inspects installation and registration status across hosts without running full doctor.
- `coagent8 cleanup [--clients=codex,claude,agy] [--apply=<token>]`:
  Previews owned registration and skill removals; applies removals only when passed
  a valid preview token via `--apply=<token>`.
- `coagent8 skills status|install|uninstall|enable|disable [--clients=codex,claude,agy] [--skills=...] [--apply=<token>]`:
  Manages client skills. Status takes only `--clients`. Mutations produce preview tokens
  that must be applied with `--apply=<token>`. Applying a mutation preview requires
  targeting exactly one client.

#### Server command

- `coagent8 mcp`:
  Starts the standard MCP JSON-RPC server over stdio. Protocol traffic uses stdout;
  diagnostics and operational logging use stderr.

### Exit codes

| Exit code | Meaning | Conditions |
| --- | --- | --- |
| `0` | Success | Command completed successfully; `--help` or `--version` executed; clean MCP shutdown. |
| `1` | Operational failure / domain refusal | Business logic refusal or unfulfilled prerequisite: `status` reports no ready clients; `cleanup` has blocked/conflicting items; skill action encounters conflicts; review evaluates to BLOCKED. |
| `2` | Syntax or usage error | Invalid arguments, unknown command or option, missing required argument (e.g. missing `<handle>` for `session history`), malformed flag syntax. |
| `130` | Interrupted by user | Received SIGINT (Ctrl+C). Guaranteed process teardown and file lock cleanup complete before exit. |

### Output streams, redaction and buffer bounds

- **Standard output (stdout)**:
  Reserved exclusively for command results (human-readable text or JSON) or MCP
  protocol messages. Total buffered stdout for CLI commands is bounded by
  `maxBufferBytes` (512 KB) to prevent unbounded memory allocation. Output lines are
  strictly newline-terminated.
- **Standard error (stderr)**:
  Reserved for error messages, warnings, and diagnostic telemetry. All output written
  to stderr passes through `redactDiagnostic` to strip API keys, auth tokens, and
  user home directory paths.
- **JSON contract**:
  When `--json` is specified, stdout contains strictly valid JSON followed by a
  trailing newline. Errors encountered during `--json` execution format structured
  error representations or emit diagnostic errors to stderr with exit code 2 or 1.

### Invocation examples

```bash
# Display root help (TTY terminal)
coagent8
coagent8 --help

# Query version
coagent8 --version

# Run explicit MCP server over stdio
coagent8 mcp

# Inspect available models and prices as human text
coagent8 models

# Query models in JSON format for scripting or editor integration
coagent8 models --backend codex --json

# Run doctor health checks in JSON
coagent8 doctor --scope health --json

# List active sessions in current repository
coagent8 session list

# View paginated session turn history
coagent8 session history syn_sess_5aaa080be2d8f37fb564ca08 --limit 10

# Check client registration status (JSON output)
coagent8 status --clients=codex,claude,agy --json

# Preview cleanup of owned registrations and skills
coagent8 cleanup --clients=codex

# Apply previewed cleanup with token
coagent8 cleanup --clients=codex --apply=3f7b2a9e...

# Syntax error example (exits with code 2)
coagent8 models --invalid-opt
# stderr: Unknown argument '--invalid-opt'. Usage: coagent8 models [--backend codex|claude|agy] [--json]

# Domain failure example (exits with code 1)
coagent8 status --clients=codex
# stdout: [...] (no ready clients found) -> exit code 1
```

### Registration migration and coexistence

CoAgent8 registrations across native hosts (Codex CLI, Claude Code, Antigravity,
and VS Code) transition from legacy direct runtime bundle invocation to the
explicit `mcp` subcommand (`CLI-FIRST-001a2`).

#### Supported registration shapes

1. **Legacy registration shape (direct invocation without subcommand)**:
   - Node-invoked runtime bundle:
     ```json
     {
       "command": "<nodePath>",
       "args": ["<root>/runtime/<sha256>/index.cjs"],
       "env": { "coagent8_CONFIG": "...", "coagent8_DIR": "..." }
     }
     ```
   - Binary invocation (shim or global executable):
     ```json
     {
       "command": "coagent8",
       "args": []
     }
     ```
   - Transport behavior: Connected hosts stream JSON-RPC over non-TTY stdio pipes.
     Option D routes unadorned non-TTY invocations directly to the legacy MCP
     server without human interaction.

2. **Modern registration shape (explicit `mcp` subcommand)**:
   - Node-invoked runtime bundle:
     ```json
     {
       "command": "<nodePath>",
       "args": ["<root>/runtime/<sha256>/index.cjs", "mcp"],
       "env": { "coagent8_CONFIG": "...", "coagent8_DIR": "..." }
     }
     ```
   - Binary invocation:
     ```json
     {
       "command": "coagent8",
       "args": ["mcp"]
     }
     ```
   - Transport behavior: Always initializes and starts the MCP JSON-RPC server
     over stdio regardless of terminal or pipe state.

3. **Host configuration formats**:
   - **Codex CLI**: `[mcp_servers.coagent8]` in `~/.codex/config.toml` (TOML
     table; preserves `tool_timeout_sec = 1800`).
   - **Claude Code**: `mcpServers.coagent8` in `~/.claude.json`.
   - **Antigravity**: `mcpServers.coagent8` in `~/.gemini/config/mcp_config.json`.
   - **VS Code editor profile**: `servers.CoAgent8` in profile `mcp.json`
     (case-sensitive server key `CoAgent8`).
   - **VS Code provider fallback**: `McpStdioServerDefinition("CoAgent8", nodePath, [runtime, "mcp"], env)`
     in `extension.ts`.
   - **Shipped template**: Root `mcp.json` packaged for distribution and workspace
     reference.

#### Runtime path extraction and validation contract

Runtime path extraction in the integration layer (`src/integrations/setup-storage.ts`)
is governed by a single validated helper (`extractRuntimePath`), eliminating ad-hoc
indexing and preventing duplicated `.args.at(-1)` assumptions:

1. **Argument layout inspection**:
   - If `entry.args.at(-1) === "mcp"`: the runtime candidate is `entry.args.at(-2)`.
   - If `entry.args.at(-1)` is a path ending with `index.cjs`: the runtime candidate
     is `entry.args.at(-1)` (legacy shape).
   - Any other argument layout yields `null`.
2. **Strict containment and path validation**:
   - The candidate path must be absolute and resolve inside the owned runtime root:
     `~/.coagent8/runtime/<sha256>/index.cjs` for standalone clients, or
     `<globalStorage>/okidev.coagent8-mcp/runtime/<sha256>/index.cjs` for VS Code.
   - The subdirectory name must be exactly 64 hexadecimal characters (`/^[a-f0-9]{64}$/`),
     and the file basename must be `index.cjs`.
3. **Command and argument bounds (anti-widening invariant)**:
   - The executable `entry.command` must resolve to Node (`process.execPath` or
     the candidate `nodePath`), never an arbitrary shell, script or system utility.
   - Permitted `args` are strictly `[...node.argsPrefix, runtimePath]` (legacy)
     or `[...node.argsPrefix, runtimePath, "mcp"]` (modern). No additional flags,
     trailing options, or foreign tokens are permitted.
   - Binary (`command: "coagent8"`) and `npx` entries have no pinned runtime path
     in `args`; `setupShapedEntry` and `extensionShaped` never claim ownership
     over them. They are classified as manual entries.

#### Owned-entry migration semantics

Owned registrations migrate automatically to the explicit `mcp` shape:

1. **Migration triggers**:
   - `coagent8 setup`: when registering or updating clients.
   - `coagent8 repair`: when restoring or reconciling owned registrations.
   - **VS Code extension update / activation**: when synchronizing profile
     `mcp.json` entries.
2. **Ownership identification**:
   - **Standalone clients**: Ownership requires matching the SHA-256 fingerprint
     recorded in `~/.coagent8/setup.json` (`saved.owned[client]`), or matching
     the strict `setupShapedEntry` fallback when `setup.json` is absent.
   - **VS Code profile**: Ownership requires matching the entry digest recorded
     in `~/.coagent8/vscode-mcp.json` (`recorded.entry` or `recorded.pending`),
     or `extensionShaped` only when no record exists. Entries recorded by a
     newer extension version are never replaced by an older version.
3. **Pre-mutation verification**:
   - The candidate bundle is written to its immutable runtime path and probed:
     `probeRuntime` initializes the server over stdio and reads the tool list.
   - Codex host-level call verification (`probeCodex`) executes where supported.
     Claude Code and Antigravity update upon verified runtime probe
     (owner decision 2026-10-09).
4. **Checked atomic replacement and rollback**:
   - Updates write through `writeChecked` under the integration lease (`~/.coagent8`
     or `~/.coagent8/vscode-mcp`), writing to a temporary file (`.tmp`) and
     renaming atomically while verifying expected before-content.
   - Private tagged backups are written to `~/.coagent8/setup-backups/<origin>-<uuid>/`.
   - On Codex, `tool_timeout_sec = 1800` is preserved on the CoAgent8 table.
   - If candidate checks fail or concurrent modification occurs, rollback
     restores only the unchanged previous entry, preserving external edits and
     retaining backups if restoration conflicts.

#### Manual entries and user guidance

1. **Strict preservation of user-managed entries**:
   - Manual entries (entries created by the user, pointing to custom wrappers,
     or containing unrecorded environments/flags) are never overwritten,
     mutated, or deleted by setup, repair, or the extension.
   - `coagent8 status` reports them as `state: "manual"`.
2. **Compatibility and transition guidance**:
   - Legacy manual entries remain functional over non-TTY stdio through Option D.
   - Documentation and `coagent8 status` provide actionable guidance:
     ```text
     Manual CoAgent8 entry detected in ~/.claude.json.
     To update to modern syntax, change your entry to invoke 'mcp':
       "args": [".../index.cjs", "mcp"]
     ```

#### Pinned copies and npx pattern

1. **Pinned runtime copies**:
   - CLI runtime copies in `~/.coagent8/runtime/<sha256>/index.cjs` are immutable
     and content-addressed. They remain pinned and are not overwritten; older
     copies are removed only during explicit `coagent8 cleanup`.
   - The VS Code extension prunes unreferenced bundle copies in its global
     storage (`pruneRuntimes`) during synchronization, keeping active copies intact.
2. **The `npx` pattern for manual or ephemeral use**:
   - For users, CI pipelines, or foreign environments invoking CoAgent8 via npx
     without global installation, the supported invocation pattern is:
     ```bash
     npx -y coagent8@<version> mcp
     ```
   - Always specify the exact package version (e.g. `coagent8@0.7.0`) and the
     explicit `mcp` subcommand.
   - `npx` is user-facing documentation guidance; setup and the extension never
     download packages or run `npx` dynamically.

### VS Code extension PATH opt-in and lifecycle specification

#### Strict opt-in invariant

CoAgent8 never changes the user's `PATH` environment variable or creates a binary shim without an explicit, interactive "Yes" confirmation from the human user in the VS Code extension.

- **No programmatic granting**: No CLI flag, command argument, configuration setting, environment variable, or AI agent capability can grant permission to modify `PATH` or install shims.
- **Fail-safe default**: In the absence of an explicit user affirmative action, no system or environment modifications occur.

#### Opt-in prompt lifecycle

1. **Triggering conditions**:
   - The opt-in prompt is presented at most **once** per VS Code installation, immediately following a successful initial setup or CLI connection where at least one coding CLI is verified and ready.
   - It is never shown when running in remote editor environments (e.g. `vscode.env.remoteName`).
2. **Wording and choices**:
   - **Notification message**:
     ```text
     Add 'coagent8' to your user PATH so you can run it from any terminal?
     ```
   - **Interactive actions**:
     - `Yes`: Installs the owned shim, adds the directory to user `PATH` (on Windows), records ownership in `~/.coagent8/installs.json`, and records `pathPrompt: "accepted"` in `setup-state.json`.
     - `No`: Dismisses the prompt and records `pathPrompt: "declined"` in `setup-state.json`.
     - **Dismissal** (closing notification or timeout): Handled identically to refusal and recorded as `pathPrompt: "dismissed"` in `setup-state.json`.
3. **No automatic re-prompting**:
   - Both "No" and dismissal persist in the extension's onboarding state (`setup-state.json`). The extension will never automatically prompt the user again.
4. **On-demand user commands**:
   - Explicit VS Code commands are registered to allow users to inspect, enable, or disable PATH integration at any time:
     - `CoAgent8: Add to PATH` (`coagent8.addPath`): Prompts the user, creates the shim, and updates `PATH`.
     - `CoAgent8: Remove from PATH` (`coagent8.removePath`): Removes the owned shim and `PATH` entry, updating ownership records.
   - The status is also displayed in the **Manage Coding CLIs** interface.

#### Binary shim topology per operating system

1. **Windows**:
   - **Shim directory**: `%USERPROFILE%\.coagent8\bin` (added to user `PATH`).
   - **Shim executable**: `%USERPROFILE%\.coagent8\bin\coagent8.cmd`.
   - **Invocation contract**: The shim invokes Node.js with the immutable, content-addressed runtime copy:
     ```bat
     @echo off
     "node" "<storage>/runtime/<sha256>/index.cjs" %*
     ```
     (or configured Node binary if explicit).
2. **POSIX (macOS / Linux)**:
   - **Shim location**: `~/.local/bin/coagent8` (a single executable shell script).
   - **PATH behavior**: If `~/.local/bin` is already present on the user's `PATH`, no environment modification is made. If `~/.local/bin` is not on `PATH`, the extension does not edit user shell startup files (`.bashrc`, `.zshrc`, `.profile`); instead, it surfaces actionable guidance for the user to add `~/.local/bin` to their profile manually. POSIX implementation is deferred to subsequent platform acceptance cards.
3. **Runtime copy targeting, extension updates and installation handoff**:
   - The shim targets the shared, content-addressed runtime copy in `~/.coagent8/runtime/<sha256>/index.cjs` (or the active installation's runtime in `<globalStorage>/runtime/<sha256>/index.cjs`), **never** the versioned extension installation directory (e.g. `~/.vscode/extensions/okidev.coagent8-mcp-0.6.0/...`).
   - Because VS Code deletes older version folders upon extension upgrade, pointing to versioned extension folders would immediately break the shim.
   - Targeting content-addressed storage in `~/.coagent8/runtime` ensures the runtime copy is shared across editor installations (Stable, Insiders) and survives an individual editor's storage deletion.
   - When an extension installation updates to a new version, activation verifies that the on-disk shim still exactly matches the recorded `shimHash` and belongs to this installation before updating it. If and only if the shim is unmodified, activation rewrites the shim to target the new runtime copy and updates `shimHash` in `~/.coagent8/installs.json`. If the user has edited or replaced the shim (`hash(file) !== shimHash`), the extension strictly preserves the user's shim and leaves it untouched.
   - When multiple installations share the shim, the runtime copy referenced by `path` in `~/.coagent8/installs.json` is protected from pruning while `path.installations` is non-empty. If an uninstalled installation targeted its own global-storage runtime, the uninstall hook atomically retargets the unchanged shim to a remaining installation's verified runtime copy and updates `shimHash` before finishing cleanup.

#### Ownership record in `~/.coagent8/installs.json`

To survive extension uninstalls and prevent orphaned artifacts, PATH ownership is tracked in the shared state file `~/.coagent8/installs.json` alongside other setup installations. Multiple VS Code installations (such as Stable and Insiders) share this record safely via installation reference tracking.

```json
{
  "path": {
    "shimPath": "C:\\Users\\User\\.coagent8\\bin\\coagent8.cmd",
    "pathEntry": "C:\\Users\\User\\.coagent8\\bin",
    "runtime": "C:\\Users\\User\\.coagent8\\runtime\\<sha256>\\index.cjs",
    "addedToPath": true,
    "shimHash": "<sha256-hex-digest>",
    "installations": [
      "<extensions-folder-path>"
    ]
  }
}
```

- **Recorded attributes**:
  - `shimPath`: Absolute path to the generated shim file.
  - `pathEntry`: Exact directory string configured for the user `PATH`.
  - `runtime`: Path to the content-addressed runtime copy targeted by the shim.
  - `addedToPath`: Boolean flag indicating whether CoAgent8 actually inserted `pathEntry` into `HKCU\Environment Path`. If `pathEntry` was already present on `PATH` before opt-in, `addedToPath` is `false`.
  - `shimHash`: SHA-256 cryptographic digest of the shim file contents when generated.
  - `installations`: List of canonical extensions directory paths of VS Code installations that have opted in. A second installation opting in appends its installation path to this list without overwriting the record or corrupting the shared shim.
- **Integrity invariant**:
  - Only recorded, unmodified artifacts are ever removed. If the shim file has been modified or replaced by the user (`hash(file) !== shimHash`), it is strictly preserved.
  - An existing user `PATH` entry that CoAgent8 did not insert (`addedToPath === false`) is never deleted.
  - Runtime pruning reads `installs.json` first: when it is unreadable, not a JSON object, or holds a `path` record without a readable `runtime`, nothing is pruned, since that record may still guard a shim's runtime.

#### Windows registry write and environment broadcast

1. **Registry target**:
   - `HKCU\Environment`, value `Path`.
   - `HKCU\Environment` belongs to the signed-in account, so enable and uninstall cleanup act on it only for that account's profile directory, taken from the process token (`os.userInfo().homedir`), never from `HOME` or `USERPROFILE`. A redirected home, such as a test fixture, is refused before any file or registry change.
2. **Value type preservation (`REG_EXPAND_SZ` vs `REG_SZ`)**:
   - The existing value kind is inspected (`GetValueKind('Path')`).
   - If the value is `REG_EXPAND_SZ` (containing unexpanded environment variables such as `%USERPROFILE%` or `%SystemRoot%`), it must be read without expansion (`DoNotExpandEnvironmentNames`) and written back strictly as `REG_EXPAND_SZ`.
   - `REG_SZ` is preserved as `REG_SZ`.
3. **Preservation, deduplication and ownership recording**:
   - All existing entries are preserved in their original sequence.
   - Deduplication uses case-insensitive, trailing-slash-normalized comparison (e.g. `C:\Users\User\.coagent8\bin` matches `c:\users\user\.coagent8\bin\`).
   - If the directory already exists in `Path`, no redundant entry is appended and `addedToPath` is recorded as `false`. If appended, `addedToPath` is recorded as `true`.
   - Every write is read back. A write that fails or times out may still have reached the registry, so enable reads `Path` again and takes its entry out; when that cannot be confirmed, the shim and the ownership record stay, enable reports the failure, and Remove from PATH or the uninstall hook removes the entry later. Writing an empty value deletes `Path`, and the deletion is verified.
4. **Prohibition of `setx`**:
   - The legacy `setx` utility is strictly forbidden because it silently truncates variables longer than 1024 characters, corrupting user environments.
5. **Change broadcast**:
   - Upon updating `HKCU\Environment`, the extension broadcasts `WM_SETTINGCHANGE` with `lParam = "Environment"` (`HWND_BROADCAST`, `SMTO_ABORTIFHUNG`) so active shells and Windows Explorer update their environment without requiring a system sign-out.
   - The broadcast runs in an owned, awaited child process (never detached) whose whole lifetime, including PowerShell start, is bounded: 5000 ms after enable, at most 1500 ms of the remaining budget during uninstall. A broadcast that cannot start or finish in time does not fail the operation; the result reports `environmentNotified: false` and the notice tells the user that a sign-out applies the change.
6. **No visible console window**:
   - All registry manipulation and broadcast calls run quietly without showing a console or terminal window (Node `windowsHide`, which gives a non-detached child `CREATE_NO_WINDOW`; a detached child would not get it).

#### Uninstallation lifecycle cleanup

The native `vscode:uninstall` hook (`dist/uninstall.cjs`) performs automatic cleanup:

1. **Execution constraints and time bounding**:
   - Runs in Node.js after extension uninstall and VS Code restart, without the VS Code API.
   - Enforces VS Code's 5-second termination deadline.
   - Acquires the shared file lock (`withFileLock`) in `~/.coagent8` with a maximum wait of 1.5 seconds (`LEASE_TIMEOUT_MS = 1500`).
   - Any environment broadcast during uninstall is awaited and bounded to at most 1500 ms of the remaining budget, ensuring ample time remains within the 5-second limit for state persistence and other cleanup steps (profile `mcp.json` and client skills).
2. **Installation isolation and reference counting**:
   - Reads `~/.coagent8/installs.json`.
   - Matches the current uninstall against `path.installations`. If this installation is not in the list, PATH artifacts are left untouched.
   - Removes this installation from `path.installations`.
   - If other installations remain in `path.installations`, the shim and `PATH` entry remain active for those installations and are preserved. If the uninstalled installation's local storage held the targeted runtime, the hook retargets the unchanged shim to a remaining installation's verified runtime and updates `shimHash`.
3. **Artifact verification and removal (when no installations remain)**:
   - When `path.installations` becomes empty:
     - Verifies the shim file at `shimPath`:
       - If the shim was modified by the user (`hash(file) !== shimHash`), the shim is left on disk, the `PATH` entry is preserved (even if `addedToPath === true`), and the recorded runtime copy at `path.runtime` is explicitly protected from deletion and future pruning so the user command remains functional. The ownership record is updated to record persistent user retention (`userRetained: true`, `installations: []`), and this retention is reported in the uninstall log.
       - If the shim is unmodified and matches `shimHash`, the shim file is deleted. If empty, the parent directory (`~/.coagent8/bin`) is removed.
       - If and only if the shim was successfully removed and `addedToPath === true`, reads `HKCU\Environment` `Path`, removes the exact recorded `pathEntry` (normalized), writes back the updated value preserving its `REG_EXPAND_SZ` type, and broadcasts the environment update within the remaining budget (at most 1500 ms). A removal that cannot finish keeps the shim and the record and reports `blocked`; Remove from PATH shows that reason instead of reporting success or a missing integration. If `addedToPath === false`, the registry `Path` is left untouched.
       - When the shim is removed, the unreferenced runtime copy at `path.runtime` may be pruned if no other registration references it, and the `path` property is removed from `~/.coagent8/installs.json`.
4. **Failure isolation**:
   - Registry or file access errors during PATH cleanup do not abort uninstallation of MCP profile registrations or client skills. All errors are caught, sanitized via `redactDiagnostic`, and recorded in the uninstall JSON envelope.

#### Coexistence with global npm installations (`npm install -g coagent8`)

Both `npm install -g coagent8` (installed into npm's global prefix, e.g. `%APPDATA%\npm` or a Scoop/Homebrew prefix) and the VS Code extension's shim (`%USERPROFILE%\.coagent8\bin\coagent8.cmd` on Windows, or `~/.local/bin/coagent8` on POSIX) can exist simultaneously on the system `PATH`:

1. **Resolution order**:
   - The operating system shell searches directories in the exact sequence they appear in the merged `PATH` variable (system PATH followed by user PATH, or user profile shell config).
   - Whichever directory appears earlier in the active `PATH` wins when running `coagent8` without an absolute path.
2. **Version divergence**:
   - The npm registry version and the VS Code extension version may differ (for example, a stable release like `0.6.1` installed globally via npm while a preview version like `0.7.0` is installed via VSIX).
   - `where.exe coagent8` on Windows or `which -a coagent8` on POSIX lists all available binaries in precedence order.
   - `coagent8 --version` prints only the package version and `coagent8 doctor` does not report the executable path, so `where.exe` or `which -a` is the way to tell which binary a shell runs.
3. **Independent lifecycles and uninstallation separation**:
   - Uninstalling the VS Code extension removes only its owned shim (`~/.coagent8/bin`) and its owned user PATH entry; it never modifies npm's global prefix or deletes the npm-installed binary.
   - Conversely, running `npm uninstall -g coagent8` removes the global npm package but leaves the VS Code extension shim and its ownership records in `~/.coagent8/installs.json` intact.

## Target orchestration design (not implemented)

MCP will adapt to the matching packaged execution CLI under CLI-FIRST-001.
Both enter the same task engine, policy, adapters and session owners. Task inputs
describe objective, role, scope, acceptance, profile, context, dependencies and
optional model/effort. Stable IDs and idempotent request handling precede writers.

~~~mermaid
flowchart TD
    Host["Client coordinator"] --> MCP["MCP adapter"]
    MCP --> CLI["Matching packaged execution CLI"]
    Direct["Direct CLI user"] --> CLI
    CLI --> Engine["Shared task engine and policy"]
    Engine --> Worker["Verified worker profile"]
    Engine --> Checks["Checks and independent review"]
    Worker --> Gateway["Scoped delegation gateway"]
    Gateway --> Engine
    Engine --> Ledger["Root limits, leases and evidence"]
~~~

States: queued, running, waiting for input, succeeded, failed, cancelled and
interrupted. Results carry actual backend/model/profile, task/root/parent identity,
workspace/candidate identity, changes/artifact references, checks, usage availability
and next actions. Worker completion does not establish root acceptance.

Read-only, workspace-write and bounded command profiles are distinct from role.
One writer per canonical workspace is default; authorized disjoint/separate
workspaces permit parallel work. Preserve dirty baselines/partial work, reject
escaping writes and detect integration conflicts. Skills cannot authorize tools.

Reserve root limits atomically before each call/child launch. Retries share time/
call/depth/concurrency budgets and require reconciliation after lost responses.
No silent explicit-model fallback or claimed monetary cap unsupported by a backend.
Approval comes from user policy, never a planner/worker/skill assertion.

Task leases/state survive with history off. Disconnect cancels by default; detached
execution requires owned supervision and recovery. Interrupted writes are inspected
before retry. Checks run in the actual candidate and record commands/exits/logs;
agent-reported checks stay distinguished from server-observed evidence. Review
sessions are separate; candidate changes invalidate previous approval.

Delegation requires a narrow server-validated gateway, root/parent identity and
bounded capabilities. Keep current nested refusal until gateway acceptance.
Cycles, replay, cancellation races and native unobservable fan-out require explicit
handling. Any model can coordinate; no fixed provider pairing is built into policy.

Workflow skills extend the [current single-file packages](#optional-integrations)
into versioned portable packages with owned manifests, conflict detection,
atomic update/rollback and scoped client installation. No bundled script execution.
Detect real client loaders and remote/local path boundaries; verify actual discovery
and use. Plain MCP remains usable without a skill or repository knowledge.

## Owner decisions

These decisions explain behavior that could otherwise look accidental. Change them
only with a new owner decision; details and evidence remain in Git history.

| Date | Decision |
| --- | --- |
| 2026-10-06 | Regenerate the changelog before every push and check the PR title before opening a PR ([rule 02](../.agents/rules/02-git-workflow.md)). |
| 2026-10-07 | Markdown content is the only result channel, without structuredContent for execution results: Claude Code 2.1.289 showed the model only structuredContent when present, so the answer and footer did not reach it. |
| 2026-10-07 | Consent comes only from the user through MCP elicitation; a calling agent cannot assert it. An absolute 20 USD output limit applies to every model, the default included, besides the 2x relative rule. |
| 2026-10-07 | No model literals in source: defaults come from catalogs, configuration or the CLI. Claude's default is the model Claude Code reports in system/init. |
| 2026-10-07 | An ambiguous auto selects like smart_quota instead of returning an onboarding error; the server directory is the last workspace fallback, never home, a filesystem root or a system directory. |
| 2026-10-07 | An agy sandbox denial is a warning that keeps the answer, as Claude permission denials are: a denial shows that the sandbox works. Adapter warnings reach the result. |
| 2026-10-07 | CLIs are installed only through vendor extensions or official installers in vendor locations, never into a CoAgent8 directory. |
| 2026-10-07 | A public execution CLI with MCP as its adapter precedes RC 1 (CLI-FIRST-001); a TUI is optional. |
| 2026-10-07 | Agents prepare candidates locally; the owner performs Git integration, releases and npm publication. No live Codex calls were made to verify turn/interrupt. |
| 2026-10-08 | agy's inherited MCP servers and plugins are an accepted third-party limitation (CUR-002); agy runs in its own --sandbox, is never described as isolated, and nested turns are refused. |
| 2026-10-08 | The backend id is agy, not gemini. Nothing was published, so no gemini alias, GEMINI_PATH or former onboarding keys are kept. |
| 2026-10-08 | The CLI is chosen by backends.<id>.executable after *_PATH overrides and before PATH and vendor copies; a configured missing CLI fails without fallback. |
| 2026-10-08 | Explicit VS Code user settings override config.json scalars and add to its model lists; writes go only to the file. The VSIX shares ~/.coagent8/config.json with the CLI and keeps it on uninstall. |
| 2026-10-08 | One Set Up Coding CLIs list installs, signs in and registers per CLI; unchanged acceptance does nothing. The welcome notice repeats until a CLI is ready or Don't Show Again is chosen. |
| 2026-10-08 | Uninstall removes only unchanged registrations, runtime copies and tagged backups owned by the extension, and offers only recorded dependencies. |
| 2026-10-08 | The product becomes full client-independent agent orchestration with independent roles and models and installable client skills, replacing the consultation-only boundary and any blanket sandbox opt-out. |
| 2026-10-08 | Native VS Code acceptance in the owner's VS Code precedes beta.2 ([checklist](ROADMAP.md#native-vs-code-acceptance)). |
| 2026-10-08 | A price limit without a named model runs the default when it qualifies, else the highest-priced qualifying model; approval rules still apply to it. Without a catalog only the default qualifies; aliases are named by the caller, never by source literals. |
| 2026-10-08 | The model-visible tool-definition budget rises to 5,500 bytes for the price limit, and the doctor summary bound falls to 3,900 bytes so agy shows it inline. |
| 2026-10-08 | Model lists come from the CLIs (Claude through stream-json initialize); prices are kept only for offered models and refreshed daily; a named model routes by catalog, never by a price entry's provider. |
| 2026-10-08 | doctor defaults to the cached model view; health is a scope and the quota argument is removed. Consent refusals no longer advise another model. |
| 2026-10-09 | Setup updates its own unchanged Claude and agy registrations once the new runtime starts and lists its tools, as a first registration; only a host setup can check (Codex) must also call it. The previous runtime stays until cleanup. After an update the VSIX offers Set Up CLIs once per runtime when a CLI chat still starts another version. |
| 2026-10-10 | Every CoAgent8 function has a client skill. Setup installs a client's skills with its registration; cleanup and the VS Code uninstall remove them. Only the VSIX and the npm package install them, and they ship in beta.2 (SKILLS-001). |
| 2026-10-10 | Git model as PrestaShop: `develop` (default) plus release lines `X.Y.x`, no `main`. Every commit on them is a GitHub-signed squash commit of one PR; fixes are backported by squash PRs, never merged back. A release tag starts a workflow that drafts the GitHub Release with verified artifacts; the owner publishes it and the npm tarball (`next` for previews). Migration: [REPO-002](ROADMAP.md#repo-002-branch-model-and-release-workflow). |
| 2026-10-11 | Set Up Coding CLIs becomes Manage Coding CLIs, a list of CLIs with one menu per CLI built like Manage Skills; Uninstall CoAgent8 is removed in favour of per-CLI removal and the uninstall hook; vendor extensions stay machine-scoped, because the install command can avoid VS Code's sync question only by excluding them from Sync; only what CoAgent8 installed is offered for removal (CLIMGMT-001). |
| 2026-10-11 | Release artifacts carry signed build provenance (GitHub artifact attestations) next to `SHA256SUMS`. After beta.2, which is published by hand, npm publishing moves to a workflow started by the published release: npm trusted publishing (OIDC, no token) with provenance, gated by the owner's approval of the `npm` environment, publishing the verified release tarball (REPO-002g). |
| 2026-10-11 | One numeric version without pre-release suffixes for npm, the VSIX and the Git tag (`vX.Y.Z`), because VS Code accepts only numeric extension versions and offers Restart Extensions only when the number changes. Every version below 1.0.0 is a preview (VS Code and GitHub pre-release, npm `next`); each preview raises the minor. 0.5.0 is skipped: the npm name placeholder 1.0.0-beta.1 held it and is withdrawn, with no tag, GitHub Release or changelog entry. The candidate prepared as beta.2 becomes 0.6.0 and the final release is 1.0.0 (REPO-003). |
| 2026-10-11 | The user's model rules follow the allow/ask/deny convention (governance.models): deny refuses a model with the reason, ask asks every turn and states the price, allow is standing approval; deny wins over ask, ask over allow. They replace alwaysAsk/neverAsk without aliases: nothing was published with them. Approval stays the server's MCP form only: an answer the calling agent relays from chat is not consent. The model-visible tool-definition budget rises to 5,900 bytes so the model parameter tells the caller to ask the user before a model doctor tags ask. |
| 2026-10-11 | Approval rules live only in config.json, which every client's server reads; their VS Code settings are removed. The VS Code command Manage Model Approvals lists price rules and each backend's models with prices and tags from `coagent8 models --json` (the doctor model view) and writes one rule per model. Clients without MCP form elicitation (Antigravity, Codex 0.160.1, headless) fail closed; the user allows a model there instead. |
| 2026-10-13 | Bare `coagent8` follows Option D: when stdin and stdout are both terminals it prints help; otherwise it starts the legacy MCP server over stdio; `coagent8 mcp` always starts the server. Unknown arguments in terminals exit 2; non-TTY fallback emits a stderr warning and starts MCP. |
| 2026-10-13 | Registration migration (CLI-FIRST-001a2): owned registrations migrate to the explicit 'mcp' subcommand on setup, repair, and extension update; runtime path extraction in the integration layer recognizes both legacy and 'mcp' shapes under strict argument and path bounds without widening ownership; manual entries remain untouched; pinned copies are preserved; npx guidance recommends 'npx -y coagent8@<version> mcp'. |
| 2026-10-13 | VS Code extension PATH opt-in and lifecycle (CLI-FIRST-001h): CoAgent8 never changes PATH or creates a shim without an explicit 'Yes' from the user in the extension. No CLI flag, setting or agent can grant it. The prompt appears once after successful setup; 'No' and dismissal are stored in setup state and never asked again; a command allows adding or removing it later. On Windows, ~/.coagent8/bin is added to HKCU\Environment Path preserving value type (REG_EXPAND_SZ) without setx or visible console window; on POSIX, ~/.local/bin holds an owned shim without modifying PATH if already present. The shim targets the stable runtime copy, surviving extension updates. Ownership is recorded in ~/.coagent8/installs.json; the vscode:uninstall hook removes only recorded, unchanged artifacts and registry entries within the 5 s lease limit. |
| 2026-10-14 | `CHANGELOG.md` is regenerated only in release PRs (`npm run changelog -- --tag vX.Y.Z`), replacing the 2026-10-06 regeneration before every push: on a topic branch the file listed branch commits that the squash removes and could not list the PR itself. Topic branches run `npm run changelog:check` and the title preview only. PR scope follows coherent results; line count is no reason to split. |

## Known limitations

| ID | Limitation | Plan owner |
| --- | --- | --- |
| CUR-002 | agy inherits external tools; accepted limitation, recursion refused | COAGENT-002/006 |
| CUR-007 | Preparation excluded from timeout/footer | EXEC-001, CLI-INTERACT-001 |
| CUR-008 | Mandatory disk session; first handle only at return | SESSION-001, COAGENT-004 |
| CUR-009 | Auth/profile/UI evidence incomplete | DIAGNOSTICS-001, AX-003/005 |
| CUR-011 | POSIX unexpected-parent-death cleanup absent | WINDOWS-001 |
| CUR-013 | Other-tree review refused, not implemented | COAGENT-004, SURFACE-001 |
| AX-001, AX-003 through 006 | Request estimates, config/approval/readiness/first-use gaps | Roadmap agent usability acceptance |

CUR-001/003/004/005/006/007/010/012 have local fixes for review identity/completeness,
explicit consent, quota-cache failure, commentary truncation, coalesced probes,
call-wide budget/timing accounting, catalog/price governance and capacity reservation.
Historical audits predate them; neither this list nor a READY string is a release approval.

## Code documentation and package evidence

English TSDoc describes meaningful constraints, units, ownership, side effects,
errors and cancellation; do not restate types. Use @param name - description,
@remarks and valid symbol links. Module introductions use @packageDocumentation.
Exported contract types must appear in the reference; do not suppress warnings.

npm run lint:docs validates source comments; npm run docs generates
.artifacts/api-docs using the isolated tooling/documentation dependencies.
The site's home page is README.md; docs/ARCHITECTURE.md, docs/ROADMAP.md,
docs/HANDOFF.md, CHANGELOG.md and the Git workflow rule are project documents
named by their front matter title, and tooling/documentation/mermaid.js renders
their mermaid blocks (mermaid 11.4.1 from jsDelivr; the source stays readable
without it). Heading anchors must agree between GitHub and TypeDoc: headings use
`ID: title`, not `ID - title`. Publishing a GitHub Release deploys the site to
GitHub Pages (docs.yml).
Install those dependencies with npm ci --prefix tooling/documentation.
The tooling pins a compatible TypeScript separately from the project compiler;
do not bypass peer checks. Generated output is not a stable public JS API.

Tool descriptions are executable strings: changes need focused surface/budget
checks. Prose uses content/link/diff checks; source comments/tooling also require
lint/generation. Runtime/package changes need their scope's checks in the
[quality gate](../.agents/rules/04-quality-gate.md).

The Node 24 server bundle uses tsdown; the extension uses esbuild. Historical
Windows Defender timing motivated the server choice; remeasure cold starts before
changing bundler/minification. Ship generated third-party notices. Source tests,
fresh bundle, tarball consumer fixtures and native host evidence prove different
things; keep candidate/artifact identity with each result.
