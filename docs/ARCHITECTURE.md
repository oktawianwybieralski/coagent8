# CoAgent8 architecture

This describes the local implementation inspected at `24052e3` on 2026-10-07,
including the documentation-only description corrections in the working tree.
It is not release acceptance. [ROADMAP.md](ROADMAP.md) owns future changes;
[RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) owns behavior and limitations.

CoAgent8 is a client-independent stdio MCP bridge to local CLI backends. The host
and backend are separate roles. MCP discovery does not require a recognized
client name. Optional setup's host list controls registration automation only.

## Request path

~~~mermaid
flowchart TD
    Host["MCP host"] --> Server["server.ts: schemas, roots, consent and resources"]
    Server --> Tools["tools/: task prompts, Git scope and responses"]
    Tools --> Controller["execution/controller.ts: turn lifecycle"]
    Controller --> Routing["backends/: probes, catalogs, routing and governance"]
    Controller --> Adapter["backends/provider/: native CLI translation"]
    Adapter --> Process["execution/process.ts: bounded owned process"]
    Process --> CLI["Local coding CLI"]
    Controller --> Sessions["sessions/: records and turn leases"]
    Controller --> History["sessions/history.ts: best-effort archive"]
    Controller --> Result["tools/result.ts: redaction, review gate and Markdown"]
    Result --> Host
~~~

| Owner | Current responsibility |
| --- | --- |
| `src/index.ts` | Dispatch explicit CLI subcommands or start stdio |
| `src/stdio-server.ts` | Connect transport, start background maintenance and coordinate shutdown |
| `src/server.ts` | Register six tools, validate arguments, resolve roots, request consent and serve workspace-scoped resources |
| `src/tools/` | Prompts, Git review scope, management handlers, legacy mappings and formatting |
| `src/execution/` | Turn lifecycle, cancellation, progress, subprocesses, stream bounds, CLI resolution and Git context |
| `src/backends/` | Registry, probes/catalogs, routing, governance, quota/cooldowns and native adapters/collectors/error mappings |
| `src/sessions/` | Workspace/provider identity, continuation, mutual exclusion, renewed locks, archive retention and pagination |
| `src/config.ts`, `src/paths.ts`, `src/conversation.ts`, `src/redaction.ts` | Configuration, canonical paths, event/error types and distinct answer/diagnostic redaction |
| `src/diagnostics/` | Evidence and sanitized issue reports |
| `src/integrations/` | Optional host configuration, runtime copies, backups, conflict checks and native acceptance probes |
| `extensions/vscode/` | Native MCP definition provider and optional setup UI |

## Lifecycle and current boundaries

A review first collects bounded Git input. The controller resolves any supplied
session, validates configuration, selects a backend, checks an explicit model or
effort when a catalog is available, and requests consent for the effective model.
Metadata probes can launch CLIs before consent, without a model turn.

After pruning and session acquisition, the controller creates a history writer
and starts its execution timer. It streams public events, reports progress,
validates the terminal result, and performs session/cooldown bookkeeping.
The adapter owns native translation and per-run profile verification; the
process runner owns protocol interruption and bounded forced cleanup. Typed
`ToolError` values cross boundaries without error-prefix parsing.

Every execution requires a disk session and lease. `coagent8_HISTORY=off`
disables archive files; otherwise archive failures become warnings. Session
acquisition/pruning and lease release remain required and can fail a call.
Post-turn metadata failures preserve secured output and disable continuation.
Cooldowns are recorded once per rate-limited turn.

Completed probes and catalogs are cached in memory for up to five minutes,
with selected environment and file stamps. Concurrent misses are not coalesced.
Routing reads cached quota and cooldowns; `doctor` performs native quota reads.
Automatic selection still writes the quota cache synchronously, so cache failure
can prevent execution.

`consult` has a plain prompt and no audit gate. `review` requests a State
Envelope and gates reported structure/findings. It does not verify input
completeness, the expected snapshot, or reported test results. Review input
truncation reaches the model as text rather than structured controller state.

Credential-format redaction applies to answers and archived assistant text.
Keyword and home-path rules additionally apply to diagnostics. MCP resources and
session tools enforce workspace ownership. These replace the redaction and
cross-workspace defects recorded in the earlier audit.

Codex verifies `readOnly`/`never` on its thread; Claude verifies read-only tools,
no MCP servers and `dontAsk` at startup. Codex and agy still inherit user MCP
configuration. A verified shell profile does not prove external MCP tools are
read-only. Normative requirements remain in the
[security rule](../.agents/rules/01-security-and-sandboxes.md).

## Optional integrations

Setup runs only for explicit commands, but remains imported and bundled through
the runtime entrypoint. It owns selected-host configuration, immutable runtime
copies, private backups and registration fingerprints. VSIX/plugin payloads are
assembled from the npm tarball. Package checks are separate from native
host/UI acceptance; see the [integration guide](VSCODE_INTEGRATION.md).

Splitting setup is planned. The core still needs a TOML parser for Codex backend
configuration; installer separation alone cannot remove that dependency.

## Names define responsibility

Use conventional TypeScript/MCP organization with clearly named owners.
Calling another owner's interface does not transfer ownership or justify
duplicating its implementation. Tools compose requests, adapters translate CLI
protocols, execution manages turns/processes, sessions protect continuation, and
integrations edit host registrations.

Move misplaced behavior, split a mixed responsibility, or precisely rename a
coherent owner. The ordinary target path is request, execution, adapter,
supervised CLI and public answer. Per-call ephemeral execution, persisted model
catalogs, price-based consent and a separate installer are proposals in the
roadmap. Changes must preserve safety and stored data or define a migration.
