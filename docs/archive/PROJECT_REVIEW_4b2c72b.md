# CoAgent8 earlier project review - snapshot `4b2c72b` (archived)

> Historical snapshot. Original findings, plans, commands and version labels
> are preserved as evidence; they do not define current policy or release status.
> Use the [active roadmap](../ROADMAP.md), [runtime contract](../RUNTIME_CONTRACT.md)
> and [archive index](README.md). Historical source references describe their
> original tree, including modules that no longer exist.


> **Archived historical evidence.** This review was moved verbatim from
> [PROJECT_REVIEW_2026-10-05.md](../PROJECT_REVIEW_2026-10-05.md) during the
> post-audit documentation consolidation on 2026-10-05. Only relative links were
> adjusted for the new location. It describes snapshot `4b2c72b`, not the current
> tree, and does not define current policy or priorities; the
> [roadmap](../ROADMAP.md) does. Its incident facts, failed-run records and
> registration-preservation requirements remain valid historical evidence.

## Earlier review - historical snapshot

The remaining sections retain the earlier investigation and its original evidence.
Their test results and source inventory apply to the recorded snapshot, not the
current tree. They are not a second implementation plan.

## Scope and evidence

This review covers product assumptions, MCP installation, source dependencies,
unnecessary complexity, tests, and documentation. The inspected base commit is
`4b2c72b20310ec556ef6f94aac03a1e153a4a76a` on `chore/gpl-v3-license`. Existing
README edits and the uncommitted `TESTS-001` plan belong to the working tree and
are preserved. Runtime source and test assertions were not changed by this review.

Findings distinguish source inspection, reproduced behavior, and proposed work.
The implementation sequence is maintained in [ROADMAP.md](../ROADMAP.md), rather
than in another competing implementation plan. Historical plans remain archived.

## What the product actually does

CoAgent8 is a local stdio MCP bridge. An MCP **host** asks it to run a local CLI
**backend** for consultation, review, analysis, debugging, or an implementation
proposal. Codex, agy/Gemini, and Claude Code can be hosts and backends, but those
are separate roles. Registering CoAgent8 in Codex does not install the Codex
backend, authenticate it, or register CoAgent8 in VS Code.

The runtime starts bounded subprocesses, applies read-only execution profiles,
normalizes their public output and errors, streams activity, and manages native
resume handles, session leases, history, cancellation, and diagnostics. The
`implement` tool returns proposed code without granting filesystem write access.
The canonical surface advertises nine tools; the compact surface advertises four.
Claude currently has neither native resume nor public event streaming support.

The essential product requirements are:

1. Installation makes the server discoverable in the selected supported hosts.
2. A user can consult another installed backend without copying configuration.
3. Read-only execution, model consent, bounded buffers, cancellation, and owned
   process cleanup remain enforceable for every backend.
4. Public answers, Markdown, typed failures, and session continuity survive the
   bridge. Private reasoning and credentials stay out of returned diagnostics.
5. Diagnostics distinguish registration, connection, advertised tools, backend
   installation, and verified execution. A configuration file alone proves none
   of the later stages.

An agent orchestration platform, general plugin framework, database abstraction,
consensus engine, or autonomous editor is not needed to satisfy these requirements.

## MCP incident: established facts

Before repair, Codex's effective user configuration contained Context7 but no
CoAgent8 MCP registration. Its installed-plugin inventory also lacked CoAgent8.
VS Code had a manual CoAgent8 MCP registration. agy had a global definition and
a manually installed plugin defining the same server. No stable VS Code CoAgent8
extension installation was found in the inspected extension inventory.

[The VS Code extension](../../extensions/vscode/src/extension.ts) only registers
`vscode.lm.registerMcpServerDefinitionProvider` and observes `coagent8.nodePath`.
It has no cross-client installation, repair, or status flow. The activation event
is tied to MCP provider discovery, rather than a general first-run setup flow.
The root portable plugin manifest is valid in principle, but merely having a
manifest in a checkout does not install it into a host.

VS Code can bridge registered MCP servers to its supported integrated Copilot
CLI and Claude agents. This does not establish that a standalone Codex client,
Claude Code extension, or agy reads the same registry. See the
[VS Code release notes](https://code.visualstudio.com/updates/v1_113) and
[extension provider API](https://code.visualstudio.com/api/extension-guides/ai/mcp).
Codex documents its own configuration and plugin loading in its
[MCP documentation](https://developers.openai.com/codex/mcp).

The installed VS Code 1.140 runtime was inspected as well: it still supports the
positional `McpStdioServerDefinition` constructor used by this repository. The
different constructor shown in current documentation is not evidence of a local
constructor incompatibility. Do not change this API blindly.

The local repair registered the existing bundle in Codex, Claude Code, agy, and
VS Code, and in an existing VS Code Insiders profile. Unrelated settings were
compared structurally and preserved. The redundant agy plugin was disabled, with
its files retained. Each of the five stored definitions initialized successfully
and advertised the nine canonical tools; Claude's native `mcp get` also reported
a connected user-scope server. The Insiders executable was not found: validating
its stored definition is not proof that an Insiders application is installed.

Backups and private verification evidence are stored under
`~/.coagent8/setup-backups/2026-10-04T22-26-46-967Z/`. Configuration contents and
credentials must not be committed. The initial repair referenced this development
checkout. It was then updated to the verified standalone bundle at
`~/.coagent8/runtime/index.cjs`; checks confirmed that only CoAgent8 command/args
changed, all five definitions still initialized and advertised nine tools, and
the stable copy matched the built artifact SHA-256. Its backup/evidence subdirectory
is `stable-runtime/`. The discovered Claude backend executable still lives inside
a versioned extension directory and needs update-aware resolution. This local
installation does not implement the product's missing VSIX onboarding lifecycle.

The ongoing Codex conversation retained its original tool catalog. An SDK client
was therefore used to initialize and invoke the actual CoAgent8 MCP server.
That verifies the MCP runtime, not native discovery in the existing chat UI.
The user subsequently clarified that an agent removed the working manual MCP
registration and tested the VSIX. This explains the missing Codex registration:
the replacement VSIX only registered its own VS Code provider and did not restore
Codex's separate connection. The deletion history is user-provided evidence; the
missing registration and the VSIX's limited replacement scope were independently
checked. This was an incomplete installation migration with missing verification
and rollback, rather than a failure to start the standalone MCP server.

### Relationship to the icon/chat integration feature

The user's hypothesis was checked against commit
`fc10a5794266eb5d7f4c968d754d30c5ab1be24c`
(`feat(mcp): add branding and VS Code integration`, 2026-10-04 at 15:55 +02:00),
its parent, and the later release snapshots. That feature introduced the current
integration split:

| Before/after change | What it establishes |
| --- | --- |
| Generic top-level plugin logo/prompts moved to `extensions.com.openai.interface`; composer/logo PNG paths were added. | Codex-specific presentation metadata changed. It does not by itself install or enable the plugin. |
| Root `mcp.json` was introduced with `${PLUGIN_ROOT}/dist/index.cjs`. | A plugin loader has an MCP definition to consume after plugin installation. |
| Native VSIX provider and package were introduced. | VS Code can discover the bundled stdio server through its provider API. |
| Server/tool `icons` metadata and generated embedded PNG were added. | Connected MCP hosts receive icon metadata; each host chooses how it renders it. |
| Consumer asset assertions and one mocked VS Code provider test were added. | Packaging and provider construction were checked; real installation across chat clients was not. |

The feature's own integration document explicitly stated that the VS Code
provider did not configure Codex or Claude Code. The before/after runtime and
build scripts contain no registration/removal flow for those clients. The
inspected later snapshots retain that limitation. The feature's integration scope
was incomplete relative to the user's expectation. The later user clarification
identifies the agent's deletion of the prior registration during VSIX testing as
the operational trigger; no automatic deletion in the feature's source is claimed.

Installation and branding acceptance should be tracked together: a selected host
must discover callable tools after installation, and its supported presentation
mechanism must load the name/icon from an actually installed provider/plugin.
Do not treat an icon file, valid manifest, or a mocked API as evidence that an
agent can invoke the integration. The local manual MCP repair establishes
connectivity but does not install Codex plugin composer presentation metadata.

## Findings and simplification decisions

| ID | Finding and evidence | Required action |
| --- | --- | --- |
| INSTALL-001 | The VSIX provider does not configure standalone hosts. The sole extension test mocks VS Code; consumer smoke starts the bundle directly. Neither proves installation into a real chat host. | Make supported-host setup part of installation/onboarding, with one shared registration flow, stable paths, deduplication, preservation, and per-host connection status. |
| MIGRATION-001 | **User-reported trigger, independently confirmed replacement gap:** an agent removed the working manual registration to test the VSIX, which did not replace the Codex connection. | Preserve the old effective registration until its replacement is callable in that same host. Restore it after failed/test-only installation; validate every previously working selected client before removing duplicates. |
| GEMINI-001 | **Reproduced:** agy 1.2.16 emits a sandbox-denial warning on stderr, followed by one real stdout terminal result. `executeInternal` injects a synthetic terminal result for the warning; the collector then rejects the real result as a duplicate. A real MCP consultation returned `PROTOCOL_ERROR`. | Track sandbox denial separately from terminal protocol state. Preserve the denial error and disable continuation. Keep rejection of genuinely duplicated native terminal results. Add the observed stderr/stdout sequence to the production adapter fixture. |
| ARCH-001 | `history.service.ts` imports `canonicalPath`/`sanitizeHandle` from `session.service.ts`; session imports history pruning/cache functions. This is a source dependency cycle. | Move identity primitives to a leaf module and compose session/history lifecycle operations explicitly. |
| ARCH-002 | `execution.service.ts` imports `tools/common.ts`. `formatExecutionResult` updates persistent cooldown state. Cancellation is installed by `setExecutionCanceller(...)` at module evaluation in execution. | Put state transitions in the execution coordinator; make presentation formatting pure. Wire cancellation at server composition, rather than import time. |
| ROUTING-001 | `inspectQuotas` produces unknown/null usage and headroom, and cache sanitation resets them. Production routing cannot exercise the headroom rankings that override-based tests demonstrate. | Keep installation/allowlist checks and observed rate-limit backoff. Retire speculative measured-quota branches; preserve or explicitly migrate the existing `smart_quota` configuration contract. |
| PARSER-001 | `formatCodexActivity` and `createCodexStreamCollector` have test consumers but the live Codex executor uses a separate parser. | Transfer behavioral assertions to the actual production parser before removing the unused path. A smaller test-only API must not substitute for runtime verification. |
| HISTORY-001 | `HistoryWriter.accept` assembles the growing assistant message and queues a complete message snapshot. Repeated flushes append growing snapshots to JSONL. | Correct the unconditional O(1)-per-delta claim. Measure bytes copied/written against answer size before changing persistence. Preserve torn-tail recovery, ownership, pagination revisions, and existing stored histories. |
| DOCS-001 | Only 37 of 130 exported function declarations have attached JSDoc. Current lint validates syntax, not documentation coverage or truth. The old roadmap claimed comprehensive TSDoc and an outdated branch/test count. | Document input constraints, meaningful parameters/returns, errors, side effects, cancellation, and ownership; replace stale completion claims with recorded evidence. |
| TYPES-001 | 34 explicit `any` annotations include unvalidated MCP arguments, configuration and native event boundaries. Strict mode does not reject explicit `any`. | Accept `unknown` at untrusted boundaries, narrow it once, and pass validated types inward. Avoid repeated assertions or a second schema system. |
| ERRORS-001 | `ensureConfigDir` suppresses all directory creation errors. Some other catches deliberately tolerate absent optional/cache files. | Report actionable permission/I/O failures and distinguish expected absence from corruption. Review catches individually; do not remove useful recovery behavior indiscriminately. |
| DIAGNOSTICS-001 | Codex/Gemini probes infer `authenticated` from local files, while evidence says credentials are unverified. `doctor` has no host registration/discovery report. Claude remains only partially verified. | Report evidence strength explicitly. Separate host connectivity from backend readiness and do not call a file-presence probe a successful authenticated execution. |
| REDACTION-001 | **Reproduced:** `redactDiagnostic(home)` hides the home path, while the JSON-escaped Windows home path survives. This also appeared in actual doctor output. | Cover structured and escaped diagnostics and partial credentials. Do not log raw host configuration or dump assertion operands containing secrets. |
| TESTS-001 | Chronological phase suites mix behaviors; root fixtures and consumer scripts are dispersed. The MCP harness lacks bounded pending requests and reliable awaited cleanup. | Execute the existing preserved test consolidation plan and regroup by capability. Retain every assertion and strengthen failure-path cleanup. |
| VERIFY-001 | One full local run reported 133/134 passing; an unchanged rerun passed 134/134. The first failure's complete diagnostic was not retained. | Keep complete logs on subsequent runs and identify the intermittent failure before claiming repeatable release readiness. The rerun does not explain or fix it. |

`GEMINI-001` and `REDACTION-001` are observed robustness failures. The structural
findings are based on source inspection; they do not imply that every affected
runtime path currently fails. Installation into all desired hosts remains a
product requirement even when the individual stdio runtime is healthy.

### Gemini reproduction

The real agy invocation used `--sandbox --output-format stream-json`, a bounded
deadline, and a read-only request to execute `git status --short`. The observed
order was:

```text
stdout: init
stdout: step_update (run_command)
stderr: jetski: ... auto-denied ...
stdout: result (status=SUCCESS, denied_actions count=1)
```

Applying the adapter's existing stderr handling to that trace produces
`Invalid or duplicate Gemini terminal result.` The fixture's `sandbox-denied`
mode sends only the terminal result, so its current passing assertion misses
the actual two-stream sequence. Simple prompts and reading a file with `view_file`
completed without a protocol error. No sandbox restriction was bypassed.

### Complexity worth retaining

Process tree cleanup on Windows/POSIX, UTF-8 byte limits, bounded input, atomic
leases, cross-process locks, cancellation and terminal validation, history
ownership, redaction, and explicit model consent solve concrete requirements.
Extract smaller readable functions around them; preserve their guarantees.

The five-line concrete adapter registry is sufficient. Do not replace it with a
provider plugin framework. A separate TypeScript 6 documentation toolchain has a
documented compiler-API compatibility reason; deduplicating it into the TypeScript
7 application toolchain without resolving compatibility would introduce failures.

Interactive auto-confirm, idle-timeout replacement, SQLite backends, generated
diff UI, and automated consensus need a demonstrated use case and evidence before
entering the implementation queue. Folder moves alone do not resolve the observed
coupling, speculative routing, or integration gaps.

## Minimal target ownership

Keep the stdio server and concrete adapters. Move files in small verified steps,
breaking dependency direction before renaming everything. Do not add parallel
controller/service/repository/factory layers for the same operation.

| Owner | Existing code to own | Boundary |
| --- | --- | --- |
| `src/server.ts`, `src/tools/` | MCP schemas, handlers, resources, envelopes and result presentation | Translate validated requests/results; compose dependencies; no cooldown/storage writes during formatting. |
| `src/execution/` | execution, process, progress, stream reducer/decoder, git context | Coordinate a turn, supervise owned processes, and publish bounded public events. |
| `src/backends/` | current adapters, CLI resolver, registry, router, policy, quota/rate-limit handling | Concrete CLI protocols and observed provider availability/cooldowns. |
| `src/sessions/` | session, history, identity primitives, leases and storage locks | Workspace ownership, session lifecycle, persistence and revisions. |
| `src/integrations/` | new host detection and shared setup/repair | Host registration and stable installed-runtime lifecycle; reusable from VSIX and CLI. |
| `src/diagnostics/` | doctor and issue reporting | Explain observed host/backend state; build sanitized local reports. |
| Named root modules | config, data paths, redaction | Small shared policies with explicit names; no new miscellaneous `services` or `utils` directory. |
| `extensions/vscode/` | native provider and installation/onboarding commands | VS Code adapter; reuse setup logic rather than implement a second installer. |

Preserve public MCP tool names, profiles, error semantics, configuration migration,
history compatibility, package entrypoints and sandbox guarantees. Internal source
module paths are contributor interfaces, not a published stable JavaScript API.

## Documentation inventory

AST inspection excludes generated source and counts physical lines including
comments and blank lines. It counts function declarations, methods and constructors;
anonymous arrow functions are excluded. Attached JSDoc is counted, not judged for
semantic completeness. Export counts below cover exported function declarations.

| Metric | Observed count |
| --- | ---: |
| Handwritten `src` TypeScript files | 43 |
| Physical source lines | 6,463 |
| Flat `src/services` files | 20 |
| Explicit `any` annotations | 34 |
| Named function/method/constructor declarations | 195 |
| Declarations with attached JSDoc | 47 |
| Exported function declarations | 130 |
| Exported functions with attached JSDoc | 37 |
| Exported functions with `@param` | 25 |
| Exported functions with `@returns` | 21 |
| Existing root test files | 20 |

Start contract documentation with adapters/parsers, configuration validation,
routing, server composition and execution. Existing process/history/lease comments
provide useful examples, but each claim must match implementation. Do not add
empty tags to void/no-argument functions merely to increase counts.

## Independent perspective and validation limits

An actual CoAgent8 MCP `consult` call to Gemini completed successfully after the
verified facts were provided inline and tool use was excluded. Its envelope was
`COVERAGE: PARTIAL`, `VERDICT: BLOCKED`, with checks explicitly `NOT_RUN`. It is an
advisory second opinion, not an independent repository audit or release approval.
It supported the ownership/coupling findings and warned against silent global
configuration changes on every extension activation. Its suggested paths and
severities were checked against source rather than copied as verified facts.

The accepted installation direction is automatic native VS Code registration and
one installation/onboarding operation for selected standalone clients, with
discoverable status and repair. Already authorized targets should not require
repeated confirmation. A generic background installer, blind npm postinstall
mutation, and mechanisms claiming to refresh another host's active chat catalog
are unnecessary; use each host's actual supported refresh behavior.

Local evidence at this snapshot:

- `npm run typecheck`: passed, including extension source.
- `npm run build`: passed; the built standalone bundle was installed at the
  stable local runtime entrypoint and its copy hash verified.
- `npm run lint:docs`: passed; this checks syntax, not comment coverage.
- `npm test`: first run 133/134; unchanged logged rerun 134/134.
- `npm run test:consumer`: passed; installed production-only package, bundled SDK,
  both npm bin aliases, MCP handshake and Codex/Gemini fixture turns/history were
  verified. This does not execute real backend CLIs or a host plugin loader.
- `npm pack --dry-run --json`: passed after including this linked review in the
  package file list; 63 files, with test/fixture/artifact directories excluded.
- Five stored MCP definitions: initialize and tools/list passed.
- Claude host connection check: passed; Claude backend authentication/read-only
  readiness remains unverified.
- Real Gemini MCP consultation: completed; real sandbox-denial parser failure
  independently reproduced.
- Existing chat UI discovery, visual branding, VSIX installation/update/uninstall,
  and the six-job upstream CI matrix: not verified by these checks.

No release-ready assertion follows from this review. Work remains in the
consolidated roadmap, especially installation, the reproduced parser/redaction
failures, and repeatable test evidence.
