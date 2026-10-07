# CoAgent8 - MCP bridge to coding CLIs

<p align="center">
  <img src="assets/logo.png" width="128" height="128" alt="CoAgent8 logo" />
</p>

**Second opinions and Git reviews from local coding agents, inside your chat.**

By [Oktawian Wybieralski](https://oki.dev) | [Source code](https://github.com/oktawianwybieralski/coagent8)
| [Report a problem](https://github.com/oktawianwybieralski/coagent8/issues)

CoAgent8 connects VS Code's native MCP chat to **OpenAI Codex**, **Claude Code**
and **Google Antigravity** (`agy`). Ask another agent to examine a design,
investigate a bug or review a Git diff, then continue the discussion using the
returned session. Your chat remains in VS Code; the selected local CLI performs
the consultation or review.

This extension bundles the CoAgent8 MCP server. You do not need a separate global
CoAgent8 installation. Backend coding CLIs and their authentication are installed
separately. CoAgent8 also works with other stdio MCP hosts; VS Code is an optional
integration.

> **Development preview:** this VSIX is for testing. It is not an accepted
> production release. See [Known limitations](#known-limitations) before use.

## What you can do

- Get a second opinion on architecture, debugging or a proposed implementation.
- Review uncommitted changes, staged changes, commits, branches or commit ranges.
- Inspect backend availability, authentication evidence, models and quota.
- Continue an agent conversation and read its archived public messages.
- Cancel a known active session or prepare a sanitized bug report.
- Optionally connect selected local standalone chat clients using the setup command.

## Requirements

| Requirement | Details |
| --- | --- |
| VS Code | Version 1.101 or newer, with a chat agent that can call MCP tools |
| Node.js | Version 24 or newer, available to the extension host |
| Workspace | A trusted folder on a filesystem; virtual workspaces are unsupported |
| Backend CLI | At least one installed and authenticated CLI: `codex`, `claude` or `agy` |
| Claude Code | Version 2.1.289 or newer for the restricted execution profile |

Backend access and billing follow your CLI account or API configuration. The
extension does not include model access or sign you in to a backend.

For SSH or WSL, install the extension in the workspace's remote extension host.
Node.js and the backend CLIs must be available and authenticated there.

## Quick start

1. Open the Command Palette and run **Extensions: Install from VSIX...**.
   Select the development VSIX supplied for testing.
2. Open a trusted project folder. If prompted, reload VS Code.
3. Run **MCP: List Servers**, select **CoAgent8**, and start the server.
   Follow VS Code's server trust and tool approval prompts.
4. Open a chat agent that supports MCP tools and enable CoAgent8's tools in its
   tool picker if necessary.
5. Ask: **"Use CoAgent8 doctor to check the coding agents available for this
   workspace."** Resolve any missing CLI or authentication reported there.
6. Ask for a consultation or review using one of the examples below.

VS Code starts and stops the bundled MCP server. The extension registers its
provider during activation; it does not start an additional background server.
An existing manual CoAgent8 registration in the active profile or workspace
takes precedence over the provider.

## Example chat requests

You can ask in ordinary language; your chat agent supplies the tool arguments.
Name a backend when you want a specific agent.

> Use CoAgent8 consult with Codex to assess this retry strategy. Focus on
> concurrent writers and explain the failure cases.

> Use CoAgent8 review with Claude to review my uncommitted changes. Check error
> handling and compatibility, and cite the affected files.

> Ask Antigravity through CoAgent8 for a second opinion on this module design.
> Use the gemini backend.

> Continue the previous CoAgent8 session and ask how the proposed fix handles
> cancellation.

Consultation and implementation analysis propose changes within the backend's
read-only execution profile. A review's `READY` verdict is an agent conclusion;
it does not independently certify test results or release readiness.

## Available tools

Every MCP host receives the same six advertised tools.

| Tool | Purpose |
| --- | --- |
| `consult` | Ask a question or request architecture, debugging or implementation analysis |
| `review` | Review a Git snapshot with optional review instructions |
| `doctor` | Check installation, versions, auth evidence, models, efforts and quota; request full detail when needed |
| `session` | List sessions, page archived history or close a session |
| `cancel` | Cancel the active turn of a known session handle |
| `issue` | Prepare a sanitized report and prefilled issue link; it does not submit an issue |

Consultation and review return Markdown with the answer, backend, model,
duration and session handle where available. Pass that handle to continue the
conversation. The chat host controls tool visibility, progress and approvals.

## Settings and commands

| Setting | Default | Purpose |
| --- | --- | --- |
| `coagent8.nodePath` | `node` | Node.js 24+ executable used to start the bundled MCP server; machine-scoped |

If Node.js is unavailable on PATH, set an absolute executable path in VS Code's
settings. For example, on Windows:

```json
{
  "coagent8.nodePath": "C:\\Program Files\\nodejs\\node.exe"
}
```

Backend defaults, routing and model consent belong to the server configuration,
normally `~/.coagent8/config.json`. The extension does not provide a model picker
or a separate backend settings UI. See the
[runtime configuration reference](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/RUNTIME_CONTRACT.md#configuration-and-routing).

**CoAgent8: Set Up or Repair Chat Clients** connects selected installed local
standalone Codex CLI, Claude Code CLI and Antigravity CLI clients. The first local activation offers
this optional setup. Selected clients are remembered for repair; existing manual
registrations and unrelated settings are preserved. Standalone clients have
their own MCP registries, separate from VS Code's native provider.

External-client setup is unavailable on remote extension hosts. In a multi-root
window, use `coagent8 setup` from the intended project directory instead.
Details are in the
[integration guide](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/VSCODE_INTEGRATION.md).

## Privacy and model approval

The selected backend CLI processes the supplied prompt and workspace context
using its configured provider. This is not an offline inference extension.
Public answers redact recognized credential formats; diagnostics also redact
home paths and sensitive configuration patterns. Redaction cannot guarantee
that arbitrary private source content is removed.

Public conversation history is stored locally under `~/.coagent8` by default.
Archival is best-effort. `coagent8_HISTORY=off` disables archive files, while
session records and execution leases remain required. Retention and storage
bounds are specified in the
[runtime contract](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/RUNTIME_CONTRACT.md#4-sessions-events-and-archival-history).

The server requests user approval through MCP elicitation for models with unknown
or approximate prices, or prices at or above configured thresholds (by default,
20 USD per million output tokens or twice the backend default). Prices come from
OpenRouter's public model list and guide consent, not your actual billing.
Without accepted approval, a model turn that requires consent fails closed.
Host support for the approval form varies; see the limitations below.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| CoAgent8 is absent from the server list | Confirm VS Code 1.101+, a trusted filesystem workspace and the extension's enabled state on the correct local or remote host |
| Server cannot find Node.js | Check `node --version` on the extension host and set `coagent8.nodePath` to its absolute executable path |
| `CLI_NOT_FOUND` or `AUTH_REQUIRED` | Install or authenticate the reported backend on the same machine as the server, then run `doctor` again |
| `POLICY_DENIED` | The model needs approval and the host did not supply it; use a host that supports the form or choose a model allowed by your governance configuration |
| Tools look outdated after an update | Restart CoAgent8 through **MCP: List Servers** and refresh the tool list or start a new chat |
| Duplicate CoAgent8 extensions | Remove old development extensions `oktawianwybieralski.coagent8-mcp` and `oki-dev.coagent8-mcp`; this package uses `okidev.coagent8-mcp` |
| A standalone client cannot see CoAgent8 | Run the setup command for that client; the VS Code provider alone does not register it there |

For startup errors, inspect the server output available from VS Code's MCP
controls. For a reproducible problem, ask the chat agent to use `doctor` and
`issue`, then review the generated report before submitting it.

## Known limitations

- Codex and agy can inherit external MCP tools. Their sandbox flags alone do
  not establish complete read-only isolation; this remains a release blocker.
- Review input completeness and release hashes need independent verification.
- Model-approval forms have not been accepted across every chat host. Recorded
  headless and VS Code chat tests include clients that do not show the form.
- Execution timeout bounds the backend phase, not the complete MCP call.
- Remote external-client setup, virtual workspaces and untrusted workspaces
  are unsupported.
- Icons, tool grouping, native plugin loading and existing-chat refresh depend
  on the host. This extension cannot force their presentation.
- VSIX install/update/uninstall and chat UI acceptance remain partial. Package
  checks do not prove native backend readiness or a successful model turn.

Track current behavior in the
[runtime contract](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/RUNTIME_CONTRACT.md)
and remaining acceptance in the
[roadmap](https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0/docs/ROADMAP.md).

## Updates, support and license

Development VSIX files use a numeric VS Code version and its pre-release marker;
the bundled server retains its full npm prerelease version. Restart the MCP
server after replacing a development VSIX. The **Changelog** tab contains the
generated CoAgent8 project history, including changes shared with the server.

The extension's identifier is `okidev.coagent8-mcp`. **Oktawian Wybieralski** is
the author; **oki.dev** is the brand and website. The GitHub repository remains
under `oktawianwybieralski`.
Changing the publisher identifier creates a separate extension identity, so an
old development installation is not automatically replaced by this VSIX.
For an unpublished VSIX, VS Code can show the publisher ID `okidev` in the
header. The author's name above is separate from the publisher display name,
which is configured in the Marketplace account.

[Website](https://oki.dev) | [Issues and questions](https://github.com/oktawianwybieralski/coagent8/issues)
| [Source](https://github.com/oktawianwybieralski/coagent8)

Licensed under **GPL-3.0-only**. The VSIX includes `LICENSE` and bundled
dependency notices in `dist/THIRD_PARTY_NOTICES.txt`.
