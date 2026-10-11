<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-light.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/logo.svg" />
    <img src="assets/logo.svg" width="128" height="128" alt="CoAgent8" />
  </picture>
</p>

# CoAgent8 - Cooperating coding agents

[![CI](https://img.shields.io/github/actions/workflow/status/oktawianwybieralski/coagent8/ci.yml?branch=develop&label=CI&logo=github)](https://github.com/oktawianwybieralski/coagent8/actions/workflows/ci.yml)
[![CI matrix](https://img.shields.io/badge/CI%20matrix-3%20OS%20%C3%97%20Node%2024%2F26-2088FF?logo=github)](.github/workflows/ci.yml)
[![Coverage gate](https://img.shields.io/badge/coverage%20gate-%E2%89%A570%25-brightgreen)](package.json)
[![npm next](https://img.shields.io/npm/v/coagent8/next?label=npm%20next&color=007ec6)](https://www.npmjs.com/package/coagent8?activeTab=versions)
[![Status](https://img.shields.io/badge/status-preview%20beta-orange)](docs/ROADMAP.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D%2024-5FA04E)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-black)](https://modelcontextprotocol.io)
[![Backends](https://img.shields.io/badge/backends-Codex%20%7C%20Claude%20Code%20%7C%20Antigravity-6f42c1)](#backends-and-read-only-profiles)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](.github/workflows/ci.yml)
[![API reference](https://img.shields.io/badge/docs-API%20reference-informational)](https://oktawianwybieralski.github.io/coagent8/)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-FE5196)](https://www.conventionalcommits.org)
[![Forks](https://img.shields.io/github/forks/oktawianwybieralski/coagent8?style=social)](https://github.com/oktawianwybieralski/coagent8/fork)
[![Stars](https://img.shields.io/github/stars/oktawianwybieralski/coagent8?style=social)](https://github.com/oktawianwybieralski/coagent8/stargazers)

CoAgent8 exposes Codex, Claude Code and Antigravity (backend `agy`, which runs
Gemini models) through a stdio MCP server. An agent in a compatible host can request a
second opinion or a Git review and receive the backend's public answer. The host
runs your chat; the backend CLI performs the requested task.

**Planned direction:** complete task delegation with configurable coordinator,
planner, worker, verifier and reviewer roles, plus client skill installation.
Any supported model may fill a role; model size and provider are not fixed.
Writing and delegated coordination are not available in the current bridge.
See the [full coagent plan](docs/ROADMAP.md#full-coagent-direction).

`0.6.0` (prepared as 1.0.0-beta.2) is the first release for testers. Every
version below 1.0.0 is a preview: a GitHub pre-release with the npm tarball, the
VS Code extension (a VS Code pre-release) and checksums, and npm `coagent8@next`.
npm, the extension and the Git tag carry the same version number. A
checkout of `develop` is a development build, not a release. The
[roadmap](docs/ROADMAP.md)
owns the release sequence and remaining work.

Read-only CLI profiles, model consent, bounded buffers, credential redaction and
owned-process cleanup are implemented. Codex disables and verifies inherited
MCP servers per thread; agy still inherits external tools, an owner-accepted
third-party limitation. Review approval checks input completeness and identity.
See the [known limitations](#known-limitations).
A model's `READY` verdict requires independent verification before release.

**Contents:**
[Features](#features) |
[Connect through MCP](#connect-through-mcp) |
[Skills](#skills) |
[VS Code commands](#vs-code-commands) |
[Tester guide](#tester-guide) |
[Tools](#tools) |
[Configuration](#configuration) |
[Limitations](#known-limitations) |
[Documentation](#documentation-and-contributing)

## Features

### At a glance

- **One MCP server, three coding CLIs.** Codex, Claude Code and Antigravity
  behind the same six tools, for any stdio MCP host. No recognized client name,
  setup command or VSIX is required.
- **Read-only profiles.** Every backend runs in a read-only profile; for Codex
  and Claude Code the bridge verifies it and refuses a turn it cannot confirm.
- **Second opinion and independent review.** Plain `consult` answers, or a
  `review` of Git changes with a State Envelope and a server-derived verdict.
- **The user decides on expensive models.** Consent by price, requested from the
  user through MCP elicitation; the calling agent cannot grant it. A call can
  also set a strict price limit.
- **Quiet, bounded processes.** No shell, owned process handles only, protocol
  interrupts, bounded buffers and one deadline for the whole call.
- **Sessions you can continue.** Native backend resume through a session handle,
  with paginated, workspace-scoped history.
- **Self-diagnosing.** `doctor` reports models, efforts, prices and backend
  health; `issue` prepares a sanitized bug report.
- **Skills and editor integration.** Optional setup registers CoAgent8 in the
  CLIs' own chats and installs one skill per function; the VS Code extension
  adds an MCP provider, CLI management, skill management and uninstall cleanup.

### Backends and read-only profiles

| Backend | Execution profile |
| --- | --- |
| **Codex** | `app-server` with `sandbox_mode="read-only"` and `approval_policy="never"`; the thread's read-only state is verified, every inherited MCP server is disabled and verified per thread, server approval requests are rejected, interrupt via `turn/interrupt` |
| **Claude Code** (2.1.289+) | `-p --restricted --tools Read,Glob,Grep --permission-mode dontAsk`, hooks disabled, strict empty MCP configuration; startup tools, MCP and permission mode verified before any content; native session resume and control interrupt; subscription login or API key |
| **Antigravity** (`agy`) | Headless `--sandbox --output-format stream-json`, prompt on stdin, explicit model, native `--conversation` resume; inherits the user's MCP servers and plugins (accepted limitation), recursion into CoAgent8 refused |

### Routing

- `backend`: `auto` (default), `codex`, `claude`, `agy` or `smart_quota`.
- A fixed default backend or the `smart_quota` strategy in `config.json`,
  limited by `allowedBackends`.
- `auto` with several eligible backends excludes observed rate limits, prefers a
  CLI other than the caller's own and ranks by cached measured quota headroom.
- A rate-limited turn records a cooldown once. A failed turn is never silently
  retried on another provider.

### Models, prices and consent

- The source names no model. A turn uses the call's `model`, then the session's
  model, then `backends.<id>.defaultModel`, then the CLI's own default or catalog.
- `reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or
  `max`, validated per model where a catalog exists (Codex `model/list`,
  `agy models`; Claude Code resolves its aliases itself).
- Catalogs are cached in `~/.coagent8/models.json`. Prices
  come from OpenRouter's public model list (no key, no user data) or from
  `coagent8_PRICES_URL`; they decide whether to ask, they are not billing.
- The user is asked before a model listed in `governance.alwaysAsk`, without a
  known or exact price, priced at or above `governance.askAbovePrice` (default
  20 USD per million output tokens), or at least `governance.priceMultiplier`
  (default 2) times the backend default. `governance.neverAsk` exempts a model.
- `output_price_below` is a strict limit; without `model` the server picks a
  qualifying model and states its price in the footer, see
  [choosing a model under a price limit](#choosing-a-model-under-a-price-limit).

### Review gate

- Scopes: uncommitted (default), staged, commit, branch or range, plus optional
  instructions. Bounded Git context: 4 MiB per Git command, 3 MiB snapshot.
- The backend answers in a State Envelope (`REVIEW`, `SNAPSHOT`, `COVERAGE`,
  `VERDICT`, findings with `[P1|P2|P3] file:line`, `CHECKS`, `END_REVIEW`).
- The server derives `READY` or `BLOCKED (reason)`: an incomplete envelope,
  partial coverage, truncation, another snapshot, a `[P1]`/`[P2]` finding, or
  required checks it did not observe block.
- A review of unchanged code with the same scope, backend and model starts no
  new turn and returns the earlier verdict.

### Sessions and history

- Workspace- and provider-bound sessions with turn leases; continuation through
  `session_handle` keeps the session's model and effort.
- `session` lists sessions, pages archived history (up to 100 events and
  240 KiB per page) and closes a session, optionally deleting its history.
- MCP resources `coagent8://sessions` and `coagent8://sessions/{id}/history`,
  scoped to the connection's workspace.
- Best-effort archive: 10 MiB per session, 100 MiB in total, seven-day
  retention. `coagent8_HISTORY=off` disables archive files. Private reasoning
  and raw tool output are never archived or returned.

### Process safety and bounds

- `shell: false`; prompts go through stdin, at most 4 MiB.
- Cancellation and deadlines interrupt Codex and Claude Code through their
  native protocol, then stop only the owned process (Windows: owned root handle;
  POSIX: owned process group). No PID, parent-PID or name selection.
- Bounded output (512 KiB per backend stream, 1 MiB public answer); UTF-8 code
  points stay intact across chunks.
- `timeout_ms` from 100 ms to 30 minutes (default 15 minutes) covers Git,
  preparation, consent, the CLI turn and teardown, with progress notifications.

### Results, redaction and errors

- Markdown results: answer or typed error, then backend, model, duration and
  session handle; `review` adds its verdict, a price limit adds price evidence.
- ANSI stripping and credential-format redaction in answers and archives;
  diagnostics additionally redact keywords and home-directory paths.
- Typed errors: `CLI_NOT_FOUND`, `CLI_UNSUPPORTED`, `AUTH_REQUIRED`,
  `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `SESSION_INVALID`, `SESSION_BUSY`,
  `ABORTED`, `TIMEOUT`, `SANDBOX_UNAVAILABLE`, `PROTOCOL_ERROR`, `BUFFER_LIMIT`,
  `INPUT_LIMIT`, `PROCESS_ERROR`, `HISTORY_ERROR`, `POLICY_DENIED`,
  `PRICE_LIMIT`.

### Integrations

- Any stdio MCP host, including Codex, Claude Code, agy and
  [Continue](#continue).
- Optional `coagent8 setup|repair|status|cleanup|skills` for local registrations
  and skills, with backups, conflict checks and preview-bound changes.
- Native VS Code extension (MCP server definition provider, setup, skill
  management and uninstall) and a Codex plugin, both built from the npm tarball.
- Offline server icon embedded in `serverInfo`; no network fetch.

## Connect through MCP

Use Node.js 24+ and at least one separately installed and authenticated backend
CLI. Building a checkout requires Node 24.11+ or Node 26+. Claude Code execution
requires 2.1.289+; its restricted profile supports subscription login or an API
key. Codex and agy must support the adapter protocols; their minimum versions are
not currently enforced by the bridge.

~~~bash
npm ci
npm run build
~~~

`dist/` is ignored by Git. Rebuild after pulling source changes. A running MCP
process retains the bundle it started with; restart it after rebuilding.

Add a stdio definition to your host's MCP configuration:

~~~json
{
  "mcpServers": {
    "coagent8": {
      "command": "node",
      "args": ["<absolute-path-to-coagent8>/dist/index.cjs"]
    }
  }
}
~~~

Use your host's configuration format. Codex registrations should include
`tool_timeout_sec = 1800` in `[mcp_servers.coagent8]`; optional `coagent8 setup`
adds it. Host deadlines can be shorter than the bridge deadline. A measured agy
1.3.1 headless client stopped calls after 180 seconds even with progress
notifications; interactive IDE behavior has not been measured.

No setup command, recognized client name or VSIX is required for ordinary MCP
use. Backends resolve from `backends.<id>.executable` in `config.json` (an
absolute path, `~/...`, or `vscode-extension` for the vendor extension's newest
copy), else from PATH, then from executables installed by their VS Code extensions
(for agy, `~/.gemini/bin`). `CODEX_PATH`, `CLAUDE_PATH` and `AGY_PATH` override all
of them. The workspace comes from `workspace_path`, client
roots, or an eligible server working directory. Only the server-directory
fallback adds a workspace line to the result.

Set `backend` for a predictable provider. Otherwise `auto` uses configuration,
or selects among eligible providers using cached quota and cooldown evidence,
preferring another CLI than the calling client's own. It does not retry a failed
turn on another provider. Quota measurements can be stale; `doctor` with `scope: "health"` can refresh
them; a measurement older than 15 minutes counts as unmeasured. If the quota
cache cannot be written, the automatic route continues with a warning.

To install a locally built package:

~~~bash
npm pack
npm install --omit=dev <tarball-path>
~~~

Both `coagent8` and `coagent8-mcp` start stdio with no arguments. Launch the
newest preview with `npx -y coagent8@next`, or a fixed version with
`npx -y coagent8@0.6.0`. Plain `coagent8` (npm `latest`) is not a
supported channel before 1.0.0.

### Continue

Continue supports stdio MCP in Agent mode. Merge a server block into its active
configuration, following
[Continue's MCP guide](https://docs.continue.dev/customize/deep-dives/mcp):

~~~yaml
mcpServers:
  - name: CoAgent8
    type: stdio
    command: node
    args:
      - "<absolute-path-to-coagent8>/dist/index.cjs"
~~~

This is the documented protocol configuration. Real Continue UI acceptance
remains open. Hosts control tool visibility, approval, refresh and icons.

### Optional setup and editor integrations

`setup` and `repair` explicitly register selected local-default native hosts;
`status` checks all three CLIs and reports readiness separately from registration.
The VS Code provider works independently. Its CLI onboarding offers installation
and sign-in actions, while external MCP registration requires a separate choice.
`cleanup` previews unchanged owned registrations and skills; `cleanup --apply=<preview-token>`
removes only those entries, with private backups, and those skills. Manual/edited entries, runtime
files, credentials, histories and vendor extensions are retained.
See the
[integration contract](docs/ARCHITECTURE.md#optional-integrations)
for ownership, rollback and host acceptance limits.

### Skills

Setup and repair initially install one skill per CoAgent8 function into each
client whose registration works, then honor your saved selection. Codex lists skills in
`/skills` and invokes them as `$coagent8-review`; Claude Code and the
Antigravity CLI offer them as `/coagent8-review` commands.

| Skill | Use it to |
| --- | --- |
| `coagent8-consult` | Ask another agent for a second opinion on a question, design, plan or bug |
| `coagent8-review` | Have another agent review Git changes and read the verdict |
| `coagent8-doctor` | See models, efforts and prices, apply a price limit, check backend health |
| `coagent8-session` | List, read, continue, cancel or close sessions |
| `coagent8-issue` | Prepare a sanitized CoAgent8 bug report |
| `coagent8-loop` | Plan, get the plan reviewed, implement, run checks and get an independent review |

| Client | Skill directory |
| --- | --- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.agents/skills/` |
| Antigravity | `~/.gemini/config/skills/` |

**CoAgent8: Manage Skills** lets you choose the client, Install / Update,
Uninstall, Enable or Disable (only actions with packages to change), then one or
all packages; **Back** returns one step. It keeps the CLI and
MCP connection. Disable retains packages outside discovery in
`~/.coagent8/disabled-skills/<client>/`; enable restores them. Updates preserve
disabled choices. Start a new chat after changes; native visibility settings
and other discovered copies still apply. Shared-directory changes can affect
other consumers, including VS Code chat.

The CLI uses the same manager. Mutations first return a preview; repeat the
same command with `--apply=<token>` using its returned `token` to apply it:

```sh
coagent8 skills status --clients=agy
coagent8 skills uninstall --clients=agy
coagent8 skills install --clients=agy --skills=coagent8-review
coagent8 skills disable --clients=agy --skills=coagent8-review
coagent8 skills enable --clients=agy --skills=coagent8-review
```

Choices persist in `backends.<client>.skills` in CoAgent8's `config.json`, so
repair does not reinstall removed packages or enable disabled ones. An explicit
empty selection installs none; an explicit selection does not gain newly added
catalog packages. Conflicts preserve edited/foreign files and report actual
state separately. Interrupted file operations recover on the next apply or
setup/repair/cleanup; later user edits stop recovery instead of being overwritten.

Setup writes only `coagent8-*` directories that are missing or still hold the
copy it installed; a directory you changed is kept and reported. `cleanup`
previews and removes the unchanged skills together with the registrations.
Uninstalling the VS Code extension removes what the extension installed. npm
runs no script on `npm uninstall`, so run `coagent8 cleanup` and
`coagent8 cleanup --apply=<preview-token>` before `npm uninstall -g coagent8`.
VS Code chat also reads `~/.claude/skills/` and `~/.agents/skills/`, so with
both Claude Code and Codex set up it lists each skill twice. Native discovery
in each client is still being accepted ([SKILLS-001](docs/ROADMAP.md#skills-001-client-skills-installed-with-the-registration)).

### VS Code commands

The VSIX adds these commands. Press `F1` (or `Ctrl+Shift+P`, `Cmd+Shift+P` on
macOS), type `CoAgent8` and select one:

| Command | What it does | Changes |
| --- | --- | --- |
| `CoAgent8: Open Settings` | Opens CoAgent8's backend, model and approval settings in VS Code's Settings editor | None |
| `CoAgent8: Open Configuration (config.json)` | Opens the runtime configuration, creating defaults only when absent; schema completion and validation cover `~/.coagent8/config.json` | Creates a missing file; preserves existing contents |
| `CoAgent8: Reset Configuration (config.json)` | Replaces the configuration file with the defaults after a confirmation | Saves the previous file as `config.json.backup`, replacing an earlier backup; keeps VS Code settings |
| `CoAgent8: Show MCP Servers` | Opens VS Code's `MCP: List Servers` | None |
| `CoAgent8: Manage Coding CLIs` | Lists Codex CLI, Claude Code CLI and Antigravity CLI with their state and chat entry, plus actions for all CLI chats at once. A CLI's menu names the installation in use and selects an installation (stored in `config.json`), installs a VS Code extension or official standalone CLI beside another, chooses an executable after a compatibility check, signs in, adds, updates or removes CoAgent8 in its chat, manages its skills, and removes what CoAgent8 installed | Changes only what you choose, in the vendor's own location; writes the CLIs' configuration with private backups; removes only unchanged CoAgent8-owned entries and what CoAgent8 installed; chat changes end with one notice offering **Restart Extensions** |
| `CoAgent8: Manage Skills` | Selects a client, action and packages: install/update, uninstall, enable or disable | Preserves the CLI and MCP; persists choices for repair; preserves edited packages |

The MCP server itself is controlled by VS Code: `F1` -> `MCP: List Servers` ->
`CoAgent8` starts, stops or restarts it and shows its output.

### Tester guide

1. Download `coagent8-mcp-0.6.0.vsix` and `SHA256SUMS` from the
   [GitHub release](https://github.com/oktawianwybieralski/coagent8/releases/tag/v0.6.0)
   and check the file's SHA-256 against `SHA256SUMS`. With the GitHub CLI you
   can also check that the release workflow built it:
   `gh attestation verify coagent8-mcp-0.6.0.vsix --repo oktawianwybieralski/coagent8`.
   In a trusted project, run
   **Extensions: Install from VSIX...** and select it. Use Node.js 24+.
2. The first activation shows one notice: the ready CLIs, or an offer to set them
   up. Run **CoAgent8: Manage Coding CLIs** at any time to install or sign in a
   CLI and to add CoAgent8 to the CLIs' own chats, one CLI menu at a time.
3. Start CoAgent8 through **MCP: List Servers**, enable its tools in your chat,
   and request doctor, a consultation, and a review of current workspace changes.
4. Configure backends, models and approval through **CoAgent8: Open Settings**.
   A changed setting takes precedence over `config.json` in VS Code; the CLI and
   other MCP hosts read only the file (**Open Configuration (config.json)**). Set
   `coagent8.configPath` to choose another file; empty uses the default.
5. For a problem, ask for the issue tool's sanitized report and doctor output.
   Open the repository's [bug-report form](https://github.com/oktawianwybieralski/coagent8/issues/new?template=bug_report.yml)
   and include OS, Node, host and CLI versions, reproduction steps and expected
   versus actual behavior. Review pasted diagnostics before submitting.

See the [known limitations](#known-limitations).
The [VS Code acceptance checklist](docs/ROADMAP.md#native-vs-code-acceptance) covers reinstall,
configuration selection, onboarding reset and native MCP lifecycle testing.
Apply VS Code's native Extensions view restart action when requested after
installation/update. VS Code stops a running CoAgent8 server when its definition
changes (a new bundle or changed settings) and starts it again on the next use.
The VSIX shares `~/.coagent8/config.json` with the standalone CLI and keeps sessions
and history in its own VS Code storage, which uninstalling removes. Review accepts staged/revision scopes only when their
files match the current workspace; otherwise use uncommitted changes.

## Tools

| Tool | Purpose |
| --- | --- |
| `consult` | Plain second opinion; optional architecture, debugging or implementation analysis |
| `review` | Git changes reviewed with a State Envelope and a server-derived verdict |
| `doctor` | By default the cached model view: models, efforts, output prices, defaults and approval per backend; `scope: "health"` for installation, versions, auth evidence and quota/cooldowns; `detail: "full"` for data |
| `session` | List sessions, page archived history or close a session |
| `cancel` | Cancel the active turn of a known session |
| `issue` | Prepare a sanitized report and prefilled issue link |

The deprecated `analyze`, `debug` and `implement` aliases and the legacy `run`
gateway remain callable but are not advertised. `toolProfile` is ignored. All
clients receive the same six tools and short initialization instructions.

~~~json
{
  "proposal": "Is this retry loop safe with concurrent writers? <code>",
  "backend": "codex",
  "workspace_path": "<absolute-path-to-project>"
}
~~~

`context_files` sends paths for the backend to read, not file contents.
Implementation analysis proposes changes within the read-only profile.
Execution tools return Markdown: answer or typed error, then backend, model,
duration and session handle where available. `review` adds its verdict, and a
call with a price limit adds the model's price evidence.
The footer shows `session_handle=<handle> (<state>)`; pass that handle for a
follow-up on the same topic. A call without it starts a fresh agent that rereads
everything. A review of unchanged code with the same scope, backend and model
starts no new turn; the earlier verdict is returned.

Archival history is enabled by default and best-effort. `coagent8_HISTORY=off`
disables archive files, but executions still require session records and leases.
Per-call history controls and execution without disk sessions are planned.
A model priced at or above 20 USD per million output tokens, at least twice its
backend default, or without a known price runs only after the user approves it
through MCP form elicitation; `governance` in `config.json` tunes this. Prices
are read from OpenRouter's public model list (no key, no user data). Headless
clients measured on 2026-10-07 cancel elicitation, so such turns fail there. The
Codex and Antigravity chats in VS Code also answered without showing the form on
2026-10-07. If an explicit model needs approval, report the unmet requirement;
do not silently substitute another model or change approval configuration.

### Choosing a model under a price limit

For ordinary questions, call `consult` with just a self-contained `proposal`.
When the user sets a price limit, pass it as `output_price_below`: USD per million
output tokens, strict, so `5` means below 5 and excludes a model priced at 5.
Without `model`, the server chooses: the backend's default if it qualifies, else
the highest-priced qualifying model it lists. One call is enough:

~~~json
{
  "proposal": "Calculate 17 * 23. Reply only with the result.",
  "output_price_below": 5
}
~~~

Only an exact price from a price list younger than seven days qualifies; an
unknown, approximate or stale price never does. If no model qualifies, the call
fails with `PRICE_LIMIT` and each backend's reason instead of running another
model. The footer's `Price` line states the price, its list and date. A model
within the limit may still need the user's approval; approval and `neverAsk` do
not satisfy a limit. Prices are public list prices per output token, not a
request estimate or a bill.

To choose yourself, call `doctor`: by default it lists, from cached data, each
backend's models with accepted efforts, output price (`~` approximate,
`?` unknown), the default and why a model asks for approval (`backend` narrows
it; `detail: "full"` returns the same rows as data). Claude Code's aliases appear
with the concrete model they run. A named model needs no `backend`: `auto` runs
it where it is listed. For an explicit model use its ID or alias and an accepted
effort, keeping the limit:

~~~json
{
  "proposal": "Calculate 17 * 23. Reply only with the result.",
  "backend": "codex",
  "model": "<exact model ID from doctor>",
  "reasoning_effort": "low",
  "output_price_below": 5
}
~~~

An explicit model over the limit fails with the reason; it is never replaced.
Use `low` only if listed for that model. The footer names the model that answered;
its elapsed time excludes preparation. Continue with its `session_handle` when
needed. No repository access, web price lookup or full diagnostic dump is needed.

## Configuration

The shared file is `~/.coagent8/config.json`, used by every host, the CLI and
the VS Code extension (**CoAgent8: Open Configuration (config.json)** creates
it with defaults and validates it). A missing file uses the defaults; an
unreadable or invalid file refuses execution with `POLICY_DENIED` while
`doctor` stays available. In VS Code, settings you change in **CoAgent8: Open
Settings** take precedence over the file.

~~~json
{
  "schemaVersion": 1,
  "defaultBackend": null,
  "routing": {
    "strategy": "fixed",
    "allowedBackends": ["codex", "claude", "agy"]
  },
  "backends": {
    "agy": { "executable": "vscode-extension", "defaultModel": "<model the first doctor recorded>" }
  },
  "governance": {
    "priceMultiplier": 2,
    "askAbovePrice": 20,
    "alwaysAsk": [],
    "neverAsk": []
  }
}
~~~

| Variable | Effect |
| --- | --- |
| `coagent8_CONFIG` | Configuration file path |
| `coagent8_DIR` | Storage root for sessions, history and caches (default `~/.coagent8`) |
| `coagent8_HISTORY` | `off` disables archive files |
| `coagent8_PRICES_URL` | Price list URL or local file instead of OpenRouter |
| `coagent8_QUOTA_CACHE` | Quota cache file |
| `CODEX_PATH`, `CLAUDE_PATH`, `AGY_PATH` | Backend executables; they override `backends.<id>.executable` |
| `CODEX_HOME`, `CODEX_CONFIG_PATH`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME` | Backend configuration locations; setup and cleanup support only the defaults |

The [architecture](docs/ARCHITECTURE.md) states every contract, bound and error.

## Known limitations

Open issues tracked in the
[architecture](docs/ARCHITECTURE.md#known-limitations) and the
[roadmap](docs/ROADMAP.md), not relaxed security requirements:

- agy inherits the user's MCP servers and plugins; recursion into CoAgent8 is
  refused (accepted third-party limitation).
- Cancelling or timing out a call stops the owned CLI process, but a native
  descendant of agy that lives outside it can keep running until the MCP server
  exits (WINDOWS-001a, Windows).
- After an unexpected parent death on POSIX, owned processes are not cleaned up.
- Every execution keeps a session record on disk, and the first session handle
  is returned only with the result.
- Review of a tree other than the workspace is refused, not implemented.
- Headless clients measured on 2026-10-07 cancel elicitation, so turns that need
  consent fail there; approval in interactive clients is still being accepted.
- Native acceptance in each host (setup, skills, uninstall) is still in progress
  for 0.6.0; local tests use hermetic CLI fixtures.

## Documentation and contributing

The npm package does not ship `docs/` or the contributor rules; these relative
links resolve in the repository.

| Need | Document |
| --- | --- |
| Priorities and acceptance | [Roadmap](docs/ROADMAP.md) |
| Current contracts, limitations and target design | [Architecture](docs/ARCHITECTURE.md) |
| Current work, evidence and next action | [Handoff](docs/HANDOFF.md) |
| Contributor rules | [AGENTS.md](AGENTS.md) |
| Branches (`develop`, release lines `X.Y.x`), PRs and releases | [Git workflow](.agents/rules/02-git-workflow.md) |
| Generated release history | [Changelog](CHANGELOG.md) |
| Checks by scope | [Quality gate](.agents/rules/04-quality-gate.md) |
| Online API reference and documents | [oktawianwybieralski.github.io/coagent8](https://oktawianwybieralski.github.io/coagent8/) (latest release) |
| TSDoc and API reference | [Code documentation](docs/ARCHITECTURE.md#code-documentation-and-package-evidence) |

These three project documents replace the separate runtime contract, feature
plans and historical reports. Optional `docs/.local/` investigations are ignored
and are not required reading. Historical versions remain in Git.

Markdown edits require content/link review and `git diff --check`. TSDoc edits
also require documentation lint and generation. Runtime changes need focused
behavioral checks; releases need a fresh build, exact-package consumer checks,
coverage, all six OS/Node CI jobs and independent review. The suite uses hermetic
CLI fixtures. Most tests load `src/`; setup tests use `dist/`, and consumer smoke
checks the installed tarball. A green suite alone does not prove bundle freshness
or live backend compatibility.

## License

Copyright (c) 2026 Oktawian Wybieralski (oki.dev).

Licensed under [GNU General Public License, version 3 only](LICENSE)
(`GPL-3.0-only`). Distributed derivative works must comply with GPLv3 and its
source-distribution requirements. See LICENSE for the full terms and warranty
disclaimer. Copies previously distributed under MIT retain those terms.

Created by [Oktawian Wybieralski](https://oki.dev).
[GitHub repository](https://github.com/oktawianwybieralski/coagent8).
