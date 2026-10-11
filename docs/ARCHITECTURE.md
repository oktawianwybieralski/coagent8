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

Every current execution needs a workspace/provider-bound disk session and lease.
Explicit invalid/busy handles fail closed. Continuations retain model and effort;
changing model does not inherit effort. Idle records expire after two hours;
archive retention is seven days. No implicit auto-resume or ephemeral mode exists.
Close retains history unless delete_history is requested.

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

Setup/repair/status/cleanup live in the separate setup bundle. No-argument binaries
start stdio; public task execution CLI remains planned. Setup owns selected-host
registrations, immutable runtime copies, fingerprints, private backups, leases and
preview-bound cleanup. Preserve manual/edited entries and unrelated settings.
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
user-level editor settings). Ownership is the digest in
`~/.coagent8/vscode-mcp.json`; only when no record exists does that copy's path
shape identify the entry. A rewrite records the new digest as pending before it
writes the entry, so an interrupted write leaves either entry the extension's
and an edit or removal racing it the user's. An edited entry, even one still
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
`mcp.json` entries and other owned entries, skills and
data and preserves shared config, sign-ins and histories; native lifecycle
acceptance remains. Sources compare by real path, so an installer link to the
extension copy is that copy. Standalone removal deletes installer links, never
their targets' other files, then emptied installer folders and their user PATH
entries, keeping the registry value's type and unexpanded variables. An extension
removal shows the extension in the Extensions view (`workbench.extensions.search`),
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
