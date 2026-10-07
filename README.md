# CoAgent8 - MCP bridge to local coding CLIs

<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="CoAgent8" />
</p>

CoAgent8 exposes Codex, Claude Code and Antigravity (`agy`, the `gemini`
backend) through a stdio MCP server. An agent in a compatible host can request a
second opinion or a Git review and receive the backend's public answer. The host
runs your chat; the backend CLI performs the requested task.

The checkout carries `1.0.0-beta.1`, the npm name placeholder. `1.0.0-beta.2` is
the planned first release for testers. Local implementation does not establish a
published or accepted release. The
[roadmap](docs/ROADMAP.md)
owns the release sequence and remaining work.

Read-only CLI profiles, model consent, bounded buffers, credential redaction and
owned-process cleanup are implemented. Release blockers remain: the review gate
can accept incomplete input, omitted consent fields can be accepted, and Codex
and agy can inherit external MCP tools. See the
[runtime limitations](docs/RUNTIME_CONTRACT.md#7-known-limitations-and-deviations).
A model's `READY` verdict requires independent verification before release.

## Connect through MCP

Use Node.js 24+ and at least one separately installed and authenticated backend
CLI. Building a checkout requires Node 24.11+ or Node 26+. Claude Code execution
requires 2.1.259+; its restricted profile supports subscription login or an API
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
use. Backends resolve from PATH; override with `CODEX_PATH`, `CLAUDE_PATH` or
`GEMINI_PATH`/`AGY_PATH`. The workspace comes from `workspace_path`, client
roots, or an eligible server working directory. Only the server-directory
fallback adds a workspace line to the result.

Set `backend` for a predictable provider. Otherwise `auto` uses configuration,
or selects among eligible providers using cached quota and cooldown evidence,
preferring another CLI than the calling client's own. It does not retry a failed
turn on another provider. Quota measurements can be stale; `doctor` can refresh
them. The automatic route currently requires a writable quota cache.

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

`setup`, `repair` and `status` support selected local-default Codex, Claude Code
and agy registrations. The VS Code extension provides native MCP registration
and an optional shared setup flow. Existing manual registrations are preserved.
See the
[integration guide](docs/VSCODE_INTEGRATION.md)
for ownership, rollback and host acceptance limits.

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
Governed models require MCP form elicitation; headless clients measured on
2026-10-07 cancel those requests, so governed turns fail there.

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
