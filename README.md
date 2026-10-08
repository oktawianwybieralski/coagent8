# CoAgent8 - MCP bridge to coding CLIs

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-light.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/logo.svg" />
    <img src="assets/logo.svg" width="128" height="128" alt="CoAgent8" />
  </picture>
</p>

CoAgent8 exposes Codex, Claude Code and Antigravity (`agy`, the `gemini`
backend) through a stdio MCP server. An agent in a compatible host can request a
second opinion or a Git review and receive the backend's public answer. The host
runs your chat; the backend CLI performs the requested task.

The checkout carries `1.0.0-beta.2`, the planned first release for testers.
`1.0.0-beta.1` remains the npm name placeholder. Local implementation does not
establish a published or accepted release. The
[roadmap](docs/ROADMAP.md)
owns the release sequence and remaining work.

Read-only CLI profiles, model consent, bounded buffers, credential redaction and
owned-process cleanup are implemented. Codex disables and verifies inherited
MCP servers per thread; agy still inherits external tools, an owner-accepted
third-party limitation. Review approval checks input completeness and identity.
See the
[runtime limitations](docs/RUNTIME_CONTRACT.md#7-known-limitations-and-deviations).
A model's `READY` verdict requires independent verification before release.

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
use. Backends resolve from PATH, then from executables installed by their VS
Code extensions (for agy, `~/.gemini/bin`); override with `CODEX_PATH`,
`CLAUDE_PATH` or `GEMINI_PATH`/`AGY_PATH`. The workspace comes from `workspace_path`, client
roots, or an eligible server working directory. Only the server-directory
fallback adds a workspace line to the result.

Set `backend` for a predictable provider. Otherwise `auto` uses configuration,
or selects among eligible providers using cached quota and cooldown evidence,
preferring another CLI than the calling client's own. It does not retry a failed
turn on another provider. Quota measurements can be stale; `doctor` can refresh
them; a measurement older than 15 minutes counts as unmeasured. If the quota
cache cannot be written, the automatic route continues with a warning.

To install a locally built package:

~~~bash
npm pack
npm install --omit=dev <tarball-path>
~~~

Both `coagent8` and `coagent8-mcp` start stdio with no arguments. Launch a
published version with `npx -y coagent8@<published-version>`; registry
availability is independent of the checkout's version label.

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
`cleanup` previews unchanged owned registrations; `cleanup --apply=<preview-token>`
removes only those entries with private backups. Manual/edited entries, runtime
files, credentials, histories and vendor extensions are retained.
See the
[integration guide](docs/VSCODE_INTEGRATION.md)
for ownership, rollback and host acceptance limits.

### VS Code commands

The VSIX adds these commands. Press `F1` (or `Ctrl+Shift+P`, `Cmd+Shift+P` on
macOS), type `CoAgent8` and select one:

| Command | What it does | Changes |
| --- | --- | --- |
| `CoAgent8: Open Settings` | Opens CoAgent8's backend, model and approval settings in VS Code's Settings editor | None |
| `CoAgent8: Open Configuration (config.json)` | Opens the runtime configuration, creating defaults only when absent; schema completion and validation cover the extension's storage and `~/.coagent8/config.json` | Creates a missing file; preserves existing contents |
| `CoAgent8: Reset Configuration (config.json)` | Replaces the configuration file with the defaults after a confirmation | Saves the previous file as `config.json.backup`, replacing an earlier backup; keeps VS Code settings |
| `CoAgent8: Show MCP Servers` | Opens VS Code's `MCP: List Servers` | None |
| `CoAgent8: Set Up Coding CLIs` | Checks Codex CLI, Claude Code CLI and Antigravity CLI. For a missing CLI it offers the vendor extension or the official standalone installer, waits until the CLI is found, then offers its sign-in command | Installs only what you choose, in the vendor's own location; registers no MCP server |
| `CoAgent8: Refresh CLI Status` | Checks versions, required controls and local sign-in again; **Show Details** opens the `CoAgent8 Setup` output | None |
| `CoAgent8: Reset Setup State` | Repeats onboarding after confirmation and checks readiness without restarting | Clears remembered CLI choices and welcome dismissal; preserves configuration and sign-ins |
| `CoAgent8: Register or Repair Native Chat Hosts` | Optionally adds CoAgent8 to the selected CLIs' own MCP configuration after a confirmation | Writes the selected hosts' configuration, with private backups |
| `CoAgent8: Preview and Remove Owned Registrations` | Previews the CoAgent8 registrations it owns and removes them after a confirmation | Removes only unchanged CoAgent8-owned entries |

The MCP server itself is controlled by VS Code: `F1` -> `MCP: List Servers` ->
`CoAgent8` starts, stops or restarts it and shows its output.

### Beta.2 tester guide

1. In a trusted project, run **Extensions: Install from VSIX...** and select the
   private VSIX supplied by the owner. Use Node.js 24+.
2. Run **CoAgent8: Set Up Coding CLIs**. Choose an installed CLI to check, or an
   offered installation and sign-in action. Then run **Refresh CLI Status**.
3. Start CoAgent8 through **MCP: List Servers**, enable its tools in your chat,
   and request doctor, a consultation, and a review of current workspace changes.
   Native-host registration is a separate optional command.
4. Configure backends, models and approval through **CoAgent8: Open Settings**.
   A changed setting takes precedence over `config.json` in VS Code; the CLI and
   other MCP hosts read only the file (**Open Configuration (config.json)**). Set
   `coagent8.configPath` to choose another file; empty uses the default. The welcome notification
   appears on activation until a CLI is ready or you choose **Don't Show Again**.
5. For a problem, ask for the issue tool's sanitized report and doctor output.
   Open the repository's [bug-report form](https://github.com/oktawianwybieralski/coagent8/issues/new?template=bug_report.yml)
   and include OS, Node, host and CLI versions, reproduction steps and expected
   versus actual behavior. Review pasted diagnostics before submitting.

See the [local release-note draft](docs/BETA_2_RELEASE_NOTES.md) for known issues.
The [VS Code acceptance checklist](docs/VSCODE_BETA_2_CHECKLIST.md) covers reinstall,
configuration selection, onboarding reset and native MCP lifecycle testing.
Apply VS Code's native Extensions view restart action when requested after
installation/update. VS Code stops a running CoAgent8 server when its definition
changes (a new bundle or changed settings) and starts it again on the next use.
The VSIX keeps its configuration, sessions and history in its own VS Code storage,
which uninstalling removes; the standalone CLI uses `~/.coagent8`. Review accepts staged/revision scopes only when their
files match the current workspace; otherwise use uncommitted changes.

## Current tools

| Tool | Purpose |
| --- | --- |
| `consult` | Plain second opinion; optional architecture, debugging or implementation analysis |
| `review` | Git changes reviewed with a State Envelope and a server-derived verdict |
| `doctor` | Installation, versions, auth evidence, models, efforts and quota/cooldowns; summary by default, `detail: "full"` for data |
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
duration and session handle where available. `review` adds its verdict.
Continuation uses `session_handle` from a prior footer.

Archival history is enabled by default and best-effort. `coagent8_HISTORY=off`
disables archive files, but executions still require session records and leases.
Per-call history controls and execution without disk sessions are planned.
A model priced at or above 20 USD per million output tokens, at least twice its
backend default, or without a known price runs only after the user approves it
through MCP form elicitation; `governance` in `config.json` tunes this. Prices
are read from OpenRouter's public model list (no key, no user data). Headless
clients measured on 2026-10-07 cancel elicitation, so such turns fail there. The
Codex and Antigravity chats in VS Code also answered without showing the form on
2026-10-07; name a cheaper model there.

## Documentation and contributing

The npm package does not ship `docs/` or the contributor rules; these relative
links resolve in the repository.

| Need | Document |
| --- | --- |
| Priorities and acceptance | [Roadmap](docs/ROADMAP.md) |
| Component responsibilities | [Architecture](docs/ARCHITECTURE.md) |
| Tools, configuration, errors and limits | [Runtime contract](docs/RUNTIME_CONTRACT.md) |
| Snapshot-bound findings and evidence | [Project review](docs/PROJECT_REVIEW_2026-10-05.md) |
| Optional host setup | [Integration guide](docs/VSCODE_INTEGRATION.md) |
| Contributor rules | [AGENTS.md](AGENTS.md) |
| Branches, PRs and releases | [Git workflow](.agents/rules/02-git-workflow.md) |
| Generated release history | [Changelog](CHANGELOG.md) |
| Checks by scope | [Quality gate](.agents/rules/04-quality-gate.md) |
| TSDoc and API reference | [Code documentation](docs/CODE_DOCUMENTATION.md) |

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
